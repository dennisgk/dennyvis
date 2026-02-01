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

const ctx = self as DedicatedWorkerGlobalScope;

let pyodidePromise: Promise<PyodideInterface> | null = null;
let pyodide: PyodideInterface | null = null;

function toErr(e: unknown): { error: string; stack?: string } {
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
      (id: string, state_id: string, mres: any) => {
        let mdata: unknown = mres as unknown;
        if (mres && typeof (mres as any).toJs === "function") {
          mdata = (mres as any).toJs({
            dict_converter: Object.fromEntries,
          });
        }
        if (mres && typeof (mres as any).destroy === "function")
          (mres as any).destroy();

        ctx.postMessage({
          type: "globalMessage",
          id,
          state_id,
          data: mdata,
        });
        return null;
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
            f.write("")
    main_path = "/app/main.py"
    if not os.path.exists(main_path):
        with open(main_path, "w", encoding="utf-8") as f:
            f.write("def hierarchy():\\n    return {}\\n")

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
    init_path = "/app/__init__.py"
    if not os.path.exists(init_path):
        with open(init_path, "w", encoding="utf-8") as f:
            f.write("")
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

raw = app.main.hierarchy()

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
