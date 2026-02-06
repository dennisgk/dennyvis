import { loadPyodide, type PyodideInterface } from "pyodide";
import * as THREE from "three";

type RequestMessage = {
  id: number;
  type: string;
  payload?: any;
};

type ResponseMessage =
  | { id: number; ok: true; data?: any }
  | { id: number; ok: false; error: string; stack?: string };

const ctx = self as any;

let pyodidePromise: Promise<PyodideInterface> | null = null;
let pyodide: PyodideInterface | null = null;
let globalMessageReqId = 0;
const pendingGlobalMessages = new Map<
  number,
  { resolve: (data: any) => void; reject: (error: Err) => void }
>();

type Err = { error: string; stack?: string };

function toErr(e: unknown): Err {
  if (e instanceof Error) return { error: e.message, stack: e.stack };
  return { error: String(e) };
}

async function ensurePy(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.2/full/",
      stdout: (s) => console.log("[py]", s),
      stderr: (s) => console.error("[py]", s),
    });
  }
  if (!pyodide) {
    pyodide = await pyodidePromise;
    pyodide.globals.set("THREE", THREE);
    pyodide.globals.set(
      "globalMessage",
      async (id: string, state_id: string, mres: any) => {
        let mdata: unknown = mres as unknown;
        if (mres && typeof (mres as any).toJs === "function") {
          mdata = (mres as any).toJs({
            dict_converter: Object.fromEntries,
          });
        }
        const reqId = (globalMessageReqId += 1);
        ctx.postMessage({
          type: "globalMessage",
          id,
          state_id,
          reqId,
          data: mdata,
        });
        const jsResult = await new Promise((resolve, reject) => {
          pendingGlobalMessages.set(reqId, { resolve, reject });
        });
        return pyodide!.toPy(jsResult);
      },
    );
  }
  return pyodide;
}

function buildFsTree(FS: any, root: string) {
  const norm = (p: string) =>
    p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;

  function statPath(p: string) {
    try {
      return FS.stat(p);
    } catch {
      return null;
    }
  }

  function isDir(mode: number) {
    return (mode & 0x4000) === 0x4000;
  }

  function walk(dirPath: string) {
    const entries: string[] = FS.readdir(dirPath).filter(
      (x: string) => x !== "." && x !== ".." && x !== "__pycache__",
    );

    const children: any[] = [];

    for (const name of entries) {
      const full = norm(dirPath === "/" ? `/${name}` : `${dirPath}/${name}`);
      const st = statPath(full);
      if (!st) continue;

      if (isDir(st.mode)) {
        children.push(walk(full));
      } else {
        children.push({ id: full, name, kind: "file" });
      }
    }

    children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return {
      id: norm(dirPath),
      name: dirPath === "/" ? "/" : dirPath.split("/").pop() || dirPath,
      kind: "dir",
      children,
    };
  }

  const st = statPath(root);
  if (!st) return [];
  const node = walk(norm(root));
  return node.children ?? [];
}

async function handleLoadH5(payload: { name: string; bytes: Uint8Array }) {
  const py = await ensurePy();
  await py.loadPackage(["numpy", "h5py", "matplotlib"]);

  const path = `/work/${payload.name}`;
  py.FS.mkdirTree("/work");
  py.FS.writeFile(path, payload.bytes);

  py.globals.set("H5_PATH", path);
  await py.runPythonAsync(`
import h5py
try:
    _h5.close()
except Exception:
    pass
_h5 = h5py.File(H5_PATH, "r")
`);

    await handleRun({
      code: `
import sys, types
import importlib.util

_name = "backend_offscreen_gui"

mod = types.ModuleType(_name)
mod.__file__ = f"<pyodide:{_name}>"
mod.__package__ = _name.rpartition(".")[0]
mod.__spec__ = importlib.util.spec_from_loader(_name, loader=None)

sys.modules[_name] = mod
exec(_BACKEND_OFFSCREEN_GUI_SOURCE, mod.__dict__)      
`,
      tmpGlobs: {
        "_BACKEND_OFFSCREEN_GUI_SOURCE": `
# py/backend_offscreen_gui.py

from __future__ import annotations
from dataclasses import dataclass
import matplotlib as mpl
from matplotlib import cbook
from matplotlib.backend_bases import (
    _Backend,
    FigureManagerBase,
    NavigationToolbar2,
    ResizeEvent,
    CloseEvent,
)
from matplotlib.backends.backend_agg import FigureCanvasAgg

from js import ImageData, Uint8Array, Uint8ClampedArray


@dataclass
class OffscreenInfo:
    width_px: int
    height_px: int
    dpr: float


class FigureCanvasOffscreenGUI(FigureCanvasAgg):
    """
    GUI-like Agg canvas:
      - draw() renders Agg then blits to OffscreenCanvas
      - draw_idle() marks dirty, tick() flushes it
      - drawRectangle() overlays Qt-like dashed rubberband box
      - hover tooltip overlay (Qt-status-like message) on motion events
    """
    required_interactive_framework = "offscreen"
    manager_class = mpl._api.classproperty(lambda cls: FigureManagerOffscreenGUI)

    def __init__(self, figure=None):
        super().__init__(figure=figure)
        self.mlcanvas = None
        self._ctx2d = None
        self._info = OffscreenInfo(1, 1, 1.0)

        self._draw_pending = False
        self._is_drawing = False

        # Last rendered image (so we can draw overlays without re-rendering Agg)
        self._last_img = None  # JS ImageData
        self._rubberband_rect = None  # (x, y, w, h) in CANVAS coords (origin top-left)

        # Toolbar/status text storage
        self._status_message = ""

        # -------------------------
        # Hover tooltip overlay state
        # -------------------------
        self._hover_text: str | None = None
        self._hover_xy: tuple[int, int] | None = None  # CANVAS coords (origin top-left)
        self._hover_enabled: bool = True
        self._hover_max_len: int = 140  # avoid huge strings

    def set_offscreen_canvas(self, mlcanvas, width_px: int, height_px: int, dpr: float):
        self.mlcanvas = mlcanvas
        self._ctx2d = mlcanvas.getContext("2d", {"alpha": True, "desynchronized": True})
        self._info = OffscreenInfo(int(width_px), int(height_px), float(dpr))

        self.mlcanvas.width = self._info.width_px
        self.mlcanvas.height = self._info.height_px

        dpi = self.figure.dpi
        self.figure.set_size_inches(self._info.width_px / dpi, self._info.height_px / dpi, forward=False)

        ResizeEvent("resize_event", self)._process()
        self.draw_idle()

    def draw(self):
        if self._is_drawing:
            return
        with cbook._setattr_cm(self, _is_drawing=True):
            super().draw()
        self._blit_full()

    def draw_idle(self):
        self._draw_pending = True

    def _maybe_draw(self):
        if self._draw_pending:
            self._draw_pending = False
            self.draw()
        else:
            # Even if no redraw, overlays may have changed
            if self._rubberband_rect is not None or self._hover_text is not None:
                self._redraw_from_last_with_overlay()

    def tick(self):
        self._maybe_draw()

    # -------------------------
    # Rubberband overlay API
    # -------------------------

    def drawRectangle(self, rect):
        """
        Qt backend calls this from toolbar rubberband logic.
        rect is either None or [x, y, w, h] in CANVAS coords (origin top-left).
        """
        self._rubberband_rect = tuple(rect) if rect is not None else None
        self._redraw_from_last_with_overlay()

    # -------------------------
    # Hover tooltip overlay API
    # -------------------------

    def set_hover(self, x_canvas: int, y_canvas: int, text: str | None):
        """
        Store hover tooltip state and redraw overlays.
        x_canvas/y_canvas are CANVAS coords (origin top-left).
        """
        if not self._hover_enabled:
            return

        if text is not None:
            text = text.strip()
            if not text:
                text = None
            elif len(text) > self._hover_max_len:
                text = text[: self._hover_max_len - 1] + "…"

        new_xy = (int(x_canvas), int(y_canvas)) if text is not None else None

        # Avoid repaint churn if nothing changed
        if text == self._hover_text and new_xy == self._hover_xy:
            return

        self._hover_text = text
        self._hover_xy = new_xy
        self._redraw_from_last_with_overlay()

    def clear_hover(self):
        if self._hover_text is None and self._hover_xy is None:
            return
        self._hover_text = None
        self._hover_xy = None
        self._redraw_from_last_with_overlay()

    # -------------------------
    # Overlay composition
    # -------------------------

    def _redraw_from_last_with_overlay(self):
        if self._ctx2d is None or self._last_img is None:
            return
        # restore last rendered pixels
        self._ctx2d.putImageData(self._last_img, 0, 0)

        # overlay rubberband if active
        if self._rubberband_rect is not None:
            self._draw_rubberband_overlay(*self._rubberband_rect)

        # overlay hover tooltip if active
        if self._hover_text is not None and self._hover_xy is not None:
            self._draw_hover_tooltip(self._hover_xy[0], self._hover_xy[1], self._hover_text)

    def _draw_rubberband_overlay(self, x, y, w, h):
        ctx = self._ctx2d
        if ctx is None:
            return

        # Draw two dashed rectangles (black then white offset) like Qt
        ctx.save()
        try:
            ctx.lineWidth = 1
            ctx.setLineDash([3, 3])

            ctx.lineDashOffset = 0
            ctx.strokeStyle = "black"
            ctx.strokeRect(x + 0.5, y + 0.5, w, h)

            ctx.lineDashOffset = 3
            ctx.strokeStyle = "white"
            ctx.strokeRect(x + 0.5, y + 0.5, w, h)
        finally:
            ctx.restore()

    def _draw_hover_tooltip(self, x: int, y: int, text: str):
        """
        Draw a small tooltip near the cursor, Qt-like (dark translucent box + light text).
        Coordinates are CANVAS coords (origin top-left).
        """
        ctx = self._ctx2d
        if ctx is None:
            return

        # Placement: slightly offset from cursor, clamped to canvas bounds.
        pad = 6
        offset_x = 12
        offset_y = 18

        # Basic font; keep it readable and consistent.
        font_px = 12
        max_width = int(self._info.width_px * 0.75)

        ctx.save()
        try:
            ctx.font = f"{font_px}px sans-serif"
            ctx.textBaseline = "top"

            # crude wrapping: split by spaces to fit max_width
            words = text.split()
            lines = []
            cur = ""
            for w in words:
                test = (cur + " " + w).strip()
                if ctx.measureText(test).width <= max_width or not cur:
                    cur = test
                else:
                    lines.append(cur)
                    cur = w
            if cur:
                lines.append(cur)

            # measure box
            line_h = font_px + 3
            text_w = 0
            for ln in lines:
                mw = ctx.measureText(ln).width
                if mw > text_w:
                    text_w = mw
            box_w = int(text_w + pad * 2)
            box_h = int(line_h * len(lines) + pad * 2)

            bx = x + offset_x
            by = y + offset_y

            # clamp to canvas bounds (keep tooltip fully visible)
            if bx + box_w > self._info.width_px:
                bx = max(0, self._info.width_px - box_w - 1)
            if by + box_h > self._info.height_px:
                by = max(0, self._info.height_px - box_h - 1)

            # background
            ctx.globalAlpha = 0.85
            ctx.fillStyle = "black"
            # rounded rect fallback: just rect (works everywhere)
            ctx.fillRect(bx, by, box_w, box_h)

            # border (subtle)
            ctx.globalAlpha = 1.0
            ctx.lineWidth = 1
            ctx.strokeStyle = "rgba(255,255,255,0.35)"
            ctx.strokeRect(bx + 0.5, by + 0.5, box_w - 1, box_h - 1)

            # text
            ctx.fillStyle = "white"
            tx = bx + pad
            ty = by + pad
            for ln in lines:
                ctx.fillText(ln, tx, ty)
                ty += line_h
        finally:
            ctx.restore()

    # -------------------------
    # Agg -> OffscreenCanvas blit
    # -------------------------

    def _blit_full(self):
        if self.mlcanvas is None or self._ctx2d is None or ImageData is None:
            return

        w, h = self.get_width_height()

        rgba = self.buffer_rgba()
        try:
            flat = rgba.cast("B")
        except Exception:
            flat = rgba.tobytes()

        u8 = Uint8Array.new(flat)
        clamped = Uint8ClampedArray.new(u8.buffer, u8.byteOffset, u8.byteLength)

        img = ImageData.new(clamped, w, h)
        self._last_img = img  # store last full frame

        self._ctx2d.putImageData(img, 0, 0)

        # Re-apply overlays
        if self._rubberband_rect is not None:
            self._draw_rubberband_overlay(*self._rubberband_rect)
        if self._hover_text is not None and self._hover_xy is not None:
            self._draw_hover_tooltip(self._hover_xy[0], self._hover_xy[1], self._hover_text)


class NavigationToolbar2Offscreen(NavigationToolbar2):
    """
    Implements the missing Qt toolbar behaviors:
      - draw_rubberband / remove_rubberband
      - set_message (status/header text)
      - (we also use its message formatting for hover tooltip)
    """
    toolitems = NavigationToolbar2.toolitems

    def set_message(self, s):
        # Store on canvas for JS header to read (poll via tick response if you want)
        if hasattr(self.canvas, "_status_message"):
            self.canvas._status_message = s

    def draw_rubberband(self, event, x0, y0, x1, y1):
        # Matplotlib passes coords in MPL pixel coords (origin bottom-left).
        # Canvas overlay wants origin top-left.
        height = self.canvas.figure.bbox.height
        y0c = height - y0
        y1c = height - y1

        left = min(x0, x1)
        right = max(x0, x1)
        top = min(y0c, y1c)
        bottom = max(y0c, y1c)

        rect = [int(left), int(top), int(right - left), int(bottom - top)]
        self.canvas.drawRectangle(rect)

    def remove_rubberband(self):
        self.canvas.drawRectangle(None)


class FigureManagerOffscreenGUI(FigureManagerBase):
    _toolbar2_class = NavigationToolbar2Offscreen

    def __init__(self, canvas, num):
        super().__init__(canvas, num)
        self.toolbar = self._toolbar2_class(canvas) if self._toolbar2_class else None

        # -------------------------
        # Hook motion events to paint a Qt-like hover tooltip on the canvas.
        # -------------------------
        canvas.mpl_connect("motion_notify_event", self._on_motion)
        canvas.mpl_connect("figure_leave_event", self._on_leave)

    def _on_motion(self, event):
        """
        event.x / event.y are pixel coords with origin bottom-left (mpl coords).
        We convert to CANVAS coords (origin top-left) and draw a tooltip.
        """
        if event is None or event.x is None or event.y is None:
            return

        # Generate the same message that Qt normally shows in its status bar.
        msg = None
        if self.toolbar is not None:
            try:
                msg = self.toolbar._mouse_event_to_message(event)
            except Exception:
                msg = None

            # also keep the "status bar" string in sync for your JS header if desired
            if msg is not None:
                try:
                    self.toolbar.set_message(msg)
                except Exception:
                    pass

        # Convert to CANVAS coords (origin top-left)
        height = int(self.canvas.figure.bbox.height)
        x_canvas = int(event.x)
        y_canvas = int(height - event.y)

        # If nothing meaningful, clear tooltip
        if msg is None or not str(msg).strip():
            self.canvas.clear_hover()
            return

        self.canvas.set_hover(x_canvas, y_canvas, str(msg))

    def _on_leave(self, event):
        # Clear tooltip when cursor exits the figure.
        self.canvas.clear_hover()

    def show(self):
        pass

    def destroy(self, *args):
        CloseEvent("close_event", self.canvas)._process()
        super().destroy()


@_Backend.export
class _BackendOffscreenGUI(_Backend):
    FigureCanvas = FigureCanvasOffscreenGUI
    FigureManager = FigureManagerOffscreenGUI
    mainloop = None
`
      }
    });
}

async function handleEnsureAppFromFsGroup() {
  const py = await ensurePy();
  try {
    const st = py.FS.stat("/app");
    const isDir = (st.mode & 0x4000) === 0x4000;
    if (isDir) return;
  } catch {
    // /app doesn't exist
  }

  py.FS.mkdirTree("/app");

  await py.runPythonAsync(`
import os
import h5py

def _ensure_module_skeleton():
    os.makedirs("/app", exist_ok=True)
    init_path = "/app/__init__.py"
    if not os.path.exists(init_path):
        with open(init_path, "w", encoding="utf-8") as f:
            f.write("from . import main")
    main_path = "/app/main.py"
    if not os.path.exists(main_path):
        with open(main_path, "w", encoding="utf-8") as f:
            f.write("async def hierarchy(h5):\\n    return {}\\n")

def _write_fs_group_to_app(fsgrp, base="/app"):
    # fsgrp is an h5py.Group; keys become file/dir names.
    for key in fsgrp.keys():
        obj = fsgrp[key]
        if isinstance(obj, h5py.Group):
            os.makedirs(os.path.join(base, key), exist_ok=True)
            _write_fs_group_to_app(obj, os.path.join(base, key))
        else:
            content = obj[()]
            if isinstance(content, bytes):
                content = content.decode("utf-8", errors="replace")
            else:
                content = str(content)

            out_path = os.path.join(base, key)
            out_dir = os.path.dirname(out_path)
            if out_dir:
                os.makedirs(out_dir, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(content)

try:
    fsgrp = _h5.get("fs", None)
except Exception:
    fsgrp = None

if fsgrp is None:
    _ensure_module_skeleton()
else:
    os.makedirs("/app", exist_ok=True)
    _write_fs_group_to_app(fsgrp, "/app")
    _ensure_module_skeleton()
`);
}

async function handleRun(payload: {
  code: string;
  tmpGlobs?: Record<string, any>;
}) {
  const py = await ensurePy();
  const tmpGlobs = payload.tmpGlobs;
  try {
    if (tmpGlobs) {
      for (const gkey of Object.keys(tmpGlobs)) {
        py.globals.set(gkey, tmpGlobs[gkey]);
      }
    }

    const res = await py.runPythonAsync(payload.code);

    let data: unknown = res as unknown;
    if (res && typeof (res as any).toJs === "function") {
      data = (res as any).toJs({ dict_converter: Object.fromEntries });
    }
    if (res && typeof (res as any).destroy === "function")
      (res as any).destroy();

    return data;
  } finally {
    if (tmpGlobs) {
      for (const gkey of Object.keys(tmpGlobs)) {
        py.globals.delete(gkey);
      }
    }
  }
}

async function handleGetHierarchyTree() {
  const py = await ensurePy();
  const res = await py.runPythonAsync(`
import sys
import importlib

if "/" not in sys.path:
    sys.path.insert(0, "/")

import app.main
importlib.reload(app.main)

raw = await app.main.hierarchy(_h5)

def _sanitize(node):
    if isinstance(node, dict) and "type" not in node:
        out = {}
        for k, v in node.items():
            out[str(k)] = _sanitize(v)
        return out

    if not isinstance(node, dict):
        return {"type": "study"}

    t = node.get("type", None)
    if t == "dir":
        ch = node.get("children", {}) or {}
        if not isinstance(ch, dict):
            ch = {}
        return {"type": "dir", "children": _sanitize(ch)}
    elif t == "study":
        args = node.get("args", None)
        if isinstance(args, dict):
            args2 = {str(k): v for k, v in args.items()}
        else:
            args2 = None
        return {"type": "study", "args": args2}
    else:
        return {"type": "study"}

san = _sanitize(raw)
san
`);

  let data: any = res as any;
  if (res && typeof (res as any).toJs === "function") {
    data = (res as any).toJs({ dict_converter: Object.fromEntries });
  }
  if (res && typeof (res as any).destroy === "function")
    (res as any).destroy();

  return data;
}

async function handleExportEditedH5(payload: { filename: string }) {
  const py = await ensurePy();
  const outPath = `/work/${payload.filename}`;

  py.globals.set("OUT_PATH", outPath);
  await py.runPythonAsync(`
import os
import h5py

def _walk_app_dir(base="/app"):
    out = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        rel_root = os.path.relpath(root, base)
        if rel_root == ".":
            rel_root = ""

        for d in dirs:
            out.append((os.path.join(rel_root, d).replace("\\\\","/"), "dir"))

        for f in files:
            if f.endswith(".pyc"):
                continue
            if f == "__pycache__":
                continue
            out.append((os.path.join(rel_root, f).replace("\\\\","/"), "file"))
    return out

def _ensure_group(g, rel_dir):
    cur = g
    if not rel_dir:
        return cur
    for part in rel_dir.split("/"):
        if part == "":
            continue
        cur = cur.require_group(part)
    return cur

with h5py.File(OUT_PATH, "w") as out:
    for key in list(_h5.keys()):
        if key == "fs":
            continue
        _h5.copy(key, out)

    fs = out.require_group("fs")

    items = _walk_app_dir("/app")

    for rel, kind in items:
        if kind == "dir":
            _ensure_group(fs, rel)

    str_dt = h5py.string_dtype("utf-8")
    for rel, kind in items:
        if kind != "file":
            continue
        full = os.path.join("/app", rel)
        if "/__pycache__/" in full.replace("\\\\","/"):
            continue
        with open(full, "r", encoding="utf-8", errors="replace") as f:
            content = f.read()
        parent = os.path.dirname(rel).replace("\\\\","/")
        name = os.path.basename(rel)
        grp = _ensure_group(fs, parent)
        if name in grp:
            del grp[name]
        grp.create_dataset(name, data=content, dtype=str_dt)
`);

  const bytes = py.FS.readFile(outPath);
  return { filename: payload.filename, bytes };
}

ctx.addEventListener("message", async (event: MessageEvent<RequestMessage>) => {
  const { id, type, payload } = event.data;
  try {
    let data: any;
    switch (type) {
      case "globalMessageResponse": {
        const entry = pendingGlobalMessages.get(payload.reqId);
        if (entry) {
          pendingGlobalMessages.delete(payload.reqId);
          if (payload.ok) {
            entry.resolve(payload.data);
          } else {
            entry.reject({ error: payload.error, stack: payload.stack });
          }
        }
        return;
      }
      case "loadH5":
        await handleLoadH5(payload);
        data = undefined;
        break;
      case "ensureAppFromFsGroup":
        await handleEnsureAppFromFsGroup();
        data = undefined;
        break;
      case "run":
        data = await handleRun(payload);
        break;
      case "getHierarchyTree":
        data = await handleGetHierarchyTree();
        break;
      case "fsReadText": {
        const py = await ensurePy();
        const bytes = py.FS.readFile(payload.path);
        data = new TextDecoder("utf-8").decode(bytes);
        break;
      }
      case "fsReadBinary": {
        const py = await ensurePy();
        data = py.FS.readFile(payload.path);
        break;
      }
      case "fsWriteText": {
        const py = await ensurePy();
        const parts = payload.path.split("/").filter(Boolean);
        if (parts.length > 1) {
          const dir = "/" + parts.slice(0, -1).join("/");
          py.FS.mkdirTree(dir);
        }
        py.FS.writeFile(payload.path, new TextEncoder().encode(payload.text));
        data = undefined;
        break;
      }
      case "fsListTree": {
        const py = await ensurePy();
        data = buildFsTree(py.FS, payload.root);
        break;
      }
      case "writeAppFile": {
        const py = await ensurePy();
        const clean = payload.relPath.replace(/^\/+/, "");
        const path = `/app/${clean}`;
        const parts = path.split("/").filter(Boolean);
        if (parts.length > 1) {
          const dir = "/" + parts.slice(0, -1).join("/");
          py.FS.mkdirTree(dir);
        }
        py.FS.writeFile(path, new TextEncoder().encode(payload.text));
        data = undefined;
        break;
      }
      case "mkdirAppDir": {
        const py = await ensurePy();
        const clean = payload.relDir.replace(/^\/+/, "").replace(/\/+$/, "");
        py.FS.mkdirTree(`/app/${clean}`);
        data = undefined;
        break;
      }
      case "rmAppPath": {
        const py = await ensurePy();
        const clean = payload.relPath.replace(/^\/+/, "");
        const full = `/app/${clean}`;

        const st = py.FS.stat(full);
        const isDir = (st.mode & 0x4000) === 0x4000;
        if (!isDir) {
          py.FS.unlink(full);
          data = undefined;
          break;
        }
        const rmRec = (p: string) => {
          const st2 = py.FS.stat(p);
          const isDir2 = (st2.mode & 0x4000) === 0x4000;
          if (!isDir2) {
            py.FS.unlink(p);
            return;
          }
          const entries: string[] = py.FS.readdir(p).filter(
            (x: string) => x !== "." && x !== "..",
          );
          for (const name of entries) rmRec(`${p}/${name}`);
          py.FS.rmdir(p);
        };
        rmRec(full);
        data = undefined;
        break;
      }
      case "exportEditedH5":
        data = await handleExportEditedH5(payload);
        break;
      default:
        throw new Error(`Unknown worker request: ${type}`);
    }

    if (data instanceof Uint8Array) {
      ctx.postMessage({ id, ok: true, data }, [data.buffer]);
    } else if (data?.bytes instanceof Uint8Array) {
      ctx.postMessage({ id, ok: true, data }, [data.bytes.buffer]);
    } else {
      ctx.postMessage({ id, ok: true, data });
    }
  } catch (e) {
    ctx.postMessage({ id, ok: false, ...toErr(e) } satisfies ResponseMessage);
  }
});
