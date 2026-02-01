import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  pyodide: null;

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
  fsReadBinary: (path: string) => Promise<OutMsg<Uint8Array>>;
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

type WorkerRequest = {
  id: number;
  type: string;
  payload?: any;
};

type WorkerResponse =
  | { id: number; ok: true; data?: any }
  | { id: number; ok: false; error: string; stack?: string };

export function PyodideH5Provider({ children }: { children: React.ReactNode }) {
  const workerRef = useRef<Worker | null>(null);
  const requestIdRef = useRef(0);
  const pendingRef = useRef(new Map<number, (msg: WorkerResponse) => void>());

  const [fileName, setFileName] = useState<string | null>(null);
  const [hasH5, setHasH5] = useState(false);

  const globalMessageHandlers = useRef<
    Record<string, Record<string, (data: any) => any>>
  >({});

  useEffect(() => {
    return () => {
      if (workerRef.current) workerRef.current.terminate();
      workerRef.current = null;
      pendingRef.current.clear();
    };
  }, []);

  function ensureWorker() {
    if (!workerRef.current) {
      const worker = new Worker(
        new URL("../workers/pyodideWorker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<WorkerResponse | any>) => {
        const msg = event.data;
        if (msg?.type === "globalMessage") {
          if (
            msg.id in globalMessageHandlers.current &&
            msg.state_id in globalMessageHandlers.current[msg.id]
          ) {
            globalMessageHandlers.current[msg.id][msg.state_id](msg.data);
          }
          return;
        }
        if (msg && typeof msg.id === "number") {
          const resolver = pendingRef.current.get(msg.id);
          if (resolver) {
            pendingRef.current.delete(msg.id);
            resolver(msg as WorkerResponse);
          }
        }
      };
      workerRef.current = worker;
    }
    return workerRef.current;
  }

  async function callWorker<T>(
    type: string,
    payload?: any,
    transfer?: Transferable[],
  ): Promise<OutMsg<T>> {
    const worker = ensureWorker();
    const id = (requestIdRef.current += 1);
    const message: WorkerRequest = { id, type, payload };
    const response = new Promise<WorkerResponse>((resolve) => {
      pendingRef.current.set(id, resolve);
    });
    worker.postMessage(message, transfer ?? []);
    const res = await response;
    if (res.ok) return { ok: true, data: res.data as T };
    return { ok: false, error: res.error, stack: res.stack };
  }

  const loadH5 = async (file: File): Promise<OutMsg<void>> => {
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await callWorker<void>(
        "loadH5",
        { name: file.name, bytes },
        [bytes.buffer],
      );
      if (!res.ok) throw new Error(res.error);

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
      if (!hasH5) throw new Error("No HDF5 loaded");
      return await callWorker<void>("ensureAppFromFsGroup");
    } catch (e) {
      return toErr(e);
    }
  };

  const run = async <T,>(
    code: string,
    tmpGlobs?: Record<string, any> | undefined,
  ): Promise<OutMsg<T>> => {
    try {
      return await callWorker<T>("run", { code, tmpGlobs });
    } catch (e) {
      return toErr(e);
    }
  };

  // Runs app.main.hierarchy() and returns a JS-safe hierarchy tree
  const getHierarchyTree = async (): Promise<
    OutMsg<Record<string, HierNode>>
  > => {
    try {
      if (!hasH5) throw new Error("No HDF5 loaded");

      // Must ensure /app exists and is current mirror of fs group
      const ensured = await ensureAppFromFsGroup();
      if (!ensured.ok) return ensured as OutMsg<any>;

      return await callWorker<Record<string, HierNode>>("getHierarchyTree");
    } catch (e) {
      return toErr(e);
    }
  };

  const fsReadText = async (path: string): Promise<OutMsg<string>> => {
    try {
      return await callWorker<string>("fsReadText", { path });
    } catch (e) {
      return toErr(e);
    }
  };

  const fsReadBinary = async (
    path: string,
  ): Promise<OutMsg<Uint8Array>> => {
    try {
      return await callWorker<Uint8Array>("fsReadBinary", { path });
    } catch (e) {
      return toErr(e);
    }
  };

  const fsWriteText = async (
    path: string,
    text: string,
  ): Promise<OutMsg<void>> => {
    try {
      return await callWorker<void>("fsWriteText", { path, text });
    } catch (e) {
      return toErr(e);
    }
  };

  const fsListTree = async (root: string): Promise<OutMsg<AppTreeNode[]>> => {
    try {
      return await callWorker<AppTreeNode[]>("fsListTree", { root });
    } catch (e) {
      return toErr(e);
    }
  };

  const writeAppFile = async (
    relPath: string,
    text: string,
  ): Promise<OutMsg<void>> => {
    return await callWorker<void>("writeAppFile", { relPath, text });
  };

  const mkdirAppDir = async (relDir: string): Promise<OutMsg<void>> => {
    try {
      return await callWorker<void>("mkdirAppDir", { relDir });
    } catch (e) {
      return toErr(e);
    }
  };

  const rmAppPath = async (relPath: string): Promise<OutMsg<void>> => {
    try {
      return await callWorker<void>("rmAppPath", { relPath });
    } catch (e) {
      return toErr(e);
    }
  };

  const exportEditedH5 = async (
    outName?: string,
  ): Promise<OutMsg<{ filename: string; bytes: Uint8Array }>> => {
    try {
      if (!hasH5 || !fileName) throw new Error("No HDF5 loaded");

      const base = fileName.replace(/\.(h5|hdf5)$/i, "");
      const filename = outName ?? `${base}_edited.h5`;
      return await callWorker<{ filename: string; bytes: Uint8Array }>(
        "exportEditedH5",
        { filename },
      );
    } catch (e) {
      return toErr(e);
    }
  };

  const value = useMemo<Ctx>(
    () => ({
      fileName,
      hasH5,
      pyodide: null,
      loadH5,
      ensureAppFromFsGroup,
      run,
      getHierarchyTree,
      fsReadText,
      fsReadBinary,
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
