import React, {
  createContext,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { loadPyodide, type PyodideInterface } from "pyodide";
import * as THREE from "three";

export type Ok<T> = { ok: true; data: T };
export type Err = { ok: false; error: string; stack?: string };
export type OutMsg<T> = Ok<T> | Err;

function toErr(e: unknown): Err {
  if (e instanceof Error)
    return { ok: false, error: e.message, stack: e.stack };
  return { ok: false, error: String(e) };
}

export type AppTreeNodeKind = "dir" | "file";
export type AppTreeNode = {
  id: string; // full path
  name: string;
  kind: AppTreeNodeKind;
  children?: AppTreeNode[];
};

// --- Analyze hierarchy types (JS-safe)
export type HierNode =
  | { type: "dir"; children: Record<string, HierNode> }
  | { type: "study"; args?: Record<string, unknown> };

type Ctx = {
  fileName: string | null;
  hasH5: boolean;
  pyodide: PyodideInterface | null;

  loadH5: (file: File) => Promise<OutMsg<void>>;

  // Mirrors HDF5 /fs group into Pyodide FS /app (as a python package)
  ensureAppFromFsGroup: () => Promise<OutMsg<void>>;

  // Run python and get JS-converted result (toJs if possible)
  run<T = unknown>(
    code: string,
    tmpGlobs?: Record<string, any> | undefined,
  ): Promise<OutMsg<T>>;

  // Build hierarchy from /app/main.py -> app.main.hierarchy()
  getHierarchyTree: () => Promise<OutMsg<Record<string, HierNode>>>;

  // FS helpers
  fsReadText: (path: string) => Promise<OutMsg<string>>;
  fsWriteText: (path: string, text: string) => Promise<OutMsg<void>>;
  fsListTree: (root: string) => Promise<OutMsg<AppTreeNode[]>>;

  // /app helpers (convenience)
  writeAppFile: (relPath: string, text: string) => Promise<OutMsg<void>>;
  mkdirAppDir: (relDir: string) => Promise<OutMsg<void>>;
  rmAppPath: (relPath: string) => Promise<OutMsg<void>>;

  // Create downloadable h5 with new fs from /app
  exportEditedH5: (
    outName?: string,
  ) => Promise<OutMsg<{ filename: string; bytes: Uint8Array }>>;

  onGlobalMessage: (
    id: string,
    state_id: string,
    callback: (data: any) => any,
  ) => void;
  offGlobalMessage: (id: string, state_id: string) => void;
};

const PyodideH5Context = createContext<Ctx | null>(null);

let pyodidePromise: Promise<PyodideInterface> | null = null;

async function getPyodide(): Promise<PyodideInterface> {
  if (!pyodidePromise) {
    pyodidePromise = loadPyodide({
      indexURL: "https://cdn.jsdelivr.net/pyodide/v0.29.2/full/",
      stdout: (s) => console.log("[py]", s),
      stderr: (s) => console.error("[py]", s),
    });
  }
  return pyodidePromise;
}

// --- JS-side tree builder using Pyodide FS API (ignores __pycache__)
function buildFsTree(FS: any, root: string): AppTreeNode[] {
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

  function walk(dirPath: string): AppTreeNode {
    const entries: string[] = FS.readdir(dirPath).filter(
      (x: string) => x !== "." && x !== ".." && x !== "__pycache__",
    );

    const children: AppTreeNode[] = [];

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

export function PyodideH5Provider({ children }: { children: React.ReactNode }) {
  const pyRef = useRef<PyodideInterface | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [hasH5, setHasH5] = useState(false);

  const globalMessageHandlers = useRef<
    Record<string, Record<string, (data: any) => any>>
  >({});

  async function ensurePy(): Promise<PyodideInterface> {
    if (!pyRef.current) {
      const py = await getPyodide();

      py.globals.set("THREE", THREE);
      py.globals.set(
        "globalMessage",
        (id: string, state_id: string, mres: any) => {
          if (
            id in globalMessageHandlers.current &&
            state_id in globalMessageHandlers.current[id]
          ) {
            let mdata: unknown = mres as unknown;
            if (mres && typeof (mres as any).toJs === "function") {
              mdata = (mdata as any).toJs({
                dict_converter: Object.fromEntries,
              });
            }
            //if (mres && typeof (mres as any).destroy === "function")
            //  (mres as any).destroy();

            return globalMessageHandlers.current[id][state_id](mdata);
          }

          return null;
        },
      );

      pyRef.current = py;
    }
    return pyRef.current!;
  }

  const loadH5 = async (file: File): Promise<OutMsg<void>> => {
    try {
      const py = await ensurePy();
      await py.loadPackage(["numpy", "h5py", "matplotlib"]);

      const bytes = new Uint8Array(await file.arrayBuffer());
      const path = `/work/${file.name}`;
      py.FS.mkdirTree("/work");
      py.FS.writeFile(path, bytes);

      py.globals.set("H5_PATH", path);
      await py.runPythonAsync(`
import h5py
try:
    _h5.close()
except Exception:
    pass
_h5 = h5py.File(H5_PATH, "r")
`);

      setFileName(file.name);
      setHasH5(true);
      return { ok: true, data: undefined };
    } catch (e) {
      setFileName(null);
      setHasH5(false);
      return toErr(e);
    }
  };
  // Replace your ensureAppFromFsGroup with this version.
  // Behavior: ONLY mirrors HDF5 /fs -> /app if /app does NOT already exist.
  // If /app exists, it does nothing (except still ensures the H5 is loaded).

  const ensureAppFromFsGroup = async (): Promise<OutMsg<void>> => {
    try {
      const py = await ensurePy();
      if (!hasH5) throw new Error("No HDF5 loaded");

      // If /app already exists, do NOT overwrite it.
      try {
        const st = py.FS.stat("/app");
        const isDir = (st.mode & 0x4000) === 0x4000;
        if (isDir) {
          return { ok: true, data: undefined };
        }
        // If /app exists but is a file, treat as "needs init"
      } catch {
        // /app doesn't exist -> we will create it below
      }

      // Create /app (fresh) because it does not exist
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

      return { ok: true, data: undefined };
    } catch (e) {
      return toErr(e);
    }
  };

  const run = async <T,>(
    code: string,
    tmpGlobs?: Record<string, any> | undefined,
  ): Promise<OutMsg<T>> => {
    let py: PyodideInterface = undefined!;
    try {
      py = await ensurePy();
    } catch (e) {
      return toErr(e);
    }

    try {
      if (tmpGlobs !== undefined) {
        for (const gkey of Object.keys(tmpGlobs)) {
          py.globals.set(gkey, tmpGlobs[gkey]);
        }
      }

      const res = await py.runPythonAsync(code);

      let data: unknown = res as unknown;
      if (res && typeof (res as any).toJs === "function") {
        data = (res as any).toJs({ dict_converter: Object.fromEntries });
      }
      if (res && typeof (res as any).destroy === "function")
        (res as any).destroy();

      return { ok: true, data: data as T };
    } catch (e) {
      return toErr(e);
    } finally {
      if (tmpGlobs !== undefined) {
        for (const gkey of Object.keys(tmpGlobs)) {
          py.globals.delete(gkey);
        }
      }
    }
  };

  // Runs app.main.hierarchy() and returns a JS-safe hierarchy tree
  const getHierarchyTree = async (): Promise<
    OutMsg<Record<string, HierNode>>
  > => {
    try {
      const py = await ensurePy();
      if (!hasH5) throw new Error("No HDF5 loaded");

      // Must ensure /app exists and is current mirror of fs group
      const ensured = await ensureAppFromFsGroup();
      if (!ensured.ok) return ensured as OutMsg<any>;

      const res = await py.runPythonAsync(`
import sys
import importlib

# FIRST ADD THE APP TO THE PATH (we want import app.main to work)
# app package lives at /app, so sys.path must include /
if "/" not in sys.path:
    sys.path.insert(0, "/")

# force reload if user edited /app
import app.main
importlib.reload(app.main)

raw = app.main.hierarchy()

def _sanitize(node):
    # node can be dict: {name: {...}}, or leaf object with "type"
    if isinstance(node, dict) and "type" not in node:
        out = {}
        for k, v in node.items():
            out[str(k)] = _sanitize(v)
        return out

    if not isinstance(node, dict):
        # unexpected leaf -> treat as study with no args
        return {"type": "study"}

    t = node.get("type", None)
    if t == "dir":
        ch = node.get("children", {}) or {}
        if not isinstance(ch, dict):
            ch = {}
        return {"type": "dir", "children": _sanitize(ch)}
    elif t == "study":
        # keep args if present (must be JSON-ish)
        args = node.get("args", None)
        if isinstance(args, dict):
            # convert keys to str and keep values as-is
            args2 = {str(k): v for k, v in args.items()}
        else:
            args2 = None
        return {"type": "study", "args": args2}
    else:
        # unknown type
        return {"type": "study"}

san = _sanitize(raw)
san
`);

      // convert PyProxy -> JS object
      let data: any = res as any;
      if (res && typeof (res as any).toJs === "function") {
        data = (res as any).toJs({ dict_converter: Object.fromEntries });
      }
      if (res && typeof (res as any).destroy === "function")
        (res as any).destroy();

      return { ok: true, data };
    } catch (e) {
      return toErr(e);
    }
  };

  const fsReadText = async (path: string): Promise<OutMsg<string>> => {
    try {
      const py = await ensurePy();
      const bytes = py.FS.readFile(path);
      const text = new TextDecoder("utf-8").decode(bytes);
      return { ok: true, data: text };
    } catch (e) {
      return toErr(e);
    }
  };

  const fsWriteText = async (
    path: string,
    text: string,
  ): Promise<OutMsg<void>> => {
    try {
      const py = await ensurePy();
      const parts = path.split("/").filter(Boolean);
      if (parts.length > 1) {
        const dir = "/" + parts.slice(0, -1).join("/");
        py.FS.mkdirTree(dir);
      }
      py.FS.writeFile(path, new TextEncoder().encode(text));
      return { ok: true, data: undefined };
    } catch (e) {
      return toErr(e);
    }
  };

  const fsListTree = async (root: string): Promise<OutMsg<AppTreeNode[]>> => {
    try {
      const py = await ensurePy();
      const data = buildFsTree(py.FS, root);
      return { ok: true, data };
    } catch (e) {
      return toErr(e);
    }
  };

  const writeAppFile = async (
    relPath: string,
    text: string,
  ): Promise<OutMsg<void>> => {
    const clean = relPath.replace(/^\/+/, "");
    return fsWriteText(`/app/${clean}`, text);
  };

  const mkdirAppDir = async (relDir: string): Promise<OutMsg<void>> => {
    try {
      const py = await ensurePy();
      const clean = relDir.replace(/^\/+/, "").replace(/\/+$/, "");
      py.FS.mkdirTree(`/app/${clean}`);
      return { ok: true, data: undefined };
    } catch (e) {
      return toErr(e);
    }
  };

  const rmAppPath = async (relPath: string): Promise<OutMsg<void>> => {
    try {
      const py = await ensurePy();
      const clean = relPath.replace(/^\/+/, "");
      const full = `/app/${clean}`;

      const st = py.FS.stat(full);
      const isDir = (st.mode & 0x4000) === 0x4000;
      if (!isDir) {
        py.FS.unlink(full);
        return { ok: true, data: undefined };
      }
      // recursively delete dir contents
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
      return { ok: true, data: undefined };
    } catch (e) {
      return toErr(e);
    }
  };

  const exportEditedH5 = async (
    outName?: string,
  ): Promise<OutMsg<{ filename: string; bytes: Uint8Array }>> => {
    try {
      const py = await ensurePy();
      if (!hasH5 || !fileName) throw new Error("No HDF5 loaded");

      const base = fileName.replace(/\.(h5|hdf5)$/i, "");
      const filename = outName ?? `${base}_edited.h5`;
      const outPath = `/work/${filename}`;

      py.globals.set("OUT_PATH", outPath);
      await py.runPythonAsync(`
import os
import h5py

def _walk_app_dir(base="/app"):
    out = []
    for root, dirs, files in os.walk(base):
        # ignore __pycache__
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
    # Copy everything except 'fs'
    for key in list(_h5.keys()):
        if key == "fs":
            continue
        _h5.copy(key, out)

    fs = out.require_group("fs")

    items = _walk_app_dir("/app")

    # Create dirs first (preserve empty folders)
    for rel, kind in items:
        if kind == "dir":
            _ensure_group(fs, rel)

    # Create files as string datasets
    str_dt = h5py.string_dtype("utf-8")
    for rel, kind in items:
        if kind != "file":
            continue
        full = os.path.join("/app", rel)
        # do not serialize compiled caches
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
      return { ok: true, data: { filename, bytes } };
    } catch (e) {
      return toErr(e);
    }
  };

  const value = useMemo<Ctx>(
    () => ({
      fileName,
      hasH5,
      pyodide: pyRef.current,
      loadH5,
      ensureAppFromFsGroup,
      run,
      getHierarchyTree,
      fsReadText,
      fsWriteText,
      fsListTree,
      writeAppFile,
      mkdirAppDir,
      rmAppPath,
      exportEditedH5,
      onGlobalMessage: (id, state_id, callback) => {
        if (!(id in globalMessageHandlers.current)) {
          globalMessageHandlers.current[id] = {};
        }

        globalMessageHandlers.current[id][state_id] = callback;
      },
      offGlobalMessage: (id, state_id) => {
        if (!(id in globalMessageHandlers.current)) return;

        if (state_id in globalMessageHandlers.current[id]) {
          delete globalMessageHandlers.current[id][state_id];
        }
      },
    }),
    [fileName, hasH5],
  );

  return (
    <PyodideH5Context.Provider value={value}>
      {children}
    </PyodideH5Context.Provider>
  );
}

export function usePyodideH5() {
  const ctx = useContext(PyodideH5Context);
  if (!ctx)
    throw new Error("usePyodideH5 must be used within PyodideH5Provider");
  return ctx;
}
