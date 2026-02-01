// src/pages/EditPage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import Editor from "@monaco-editor/react";

import { usePyodideH5, type AppTreeNode } from "../contexts/PyodideH5Context";
import { AppTreeView, type TreeItem } from "../components/AppTreeView";

// In-memory representation of /app
type MemNode =
  | { kind: "dir"; children: Record<string, MemNode> }
  | { kind: "file"; text: string };

type ModalMode = "add-file" | "add-folder";

function normPath(p: string) {
  if (p.length > 1 && p.endsWith("/")) return p.slice(0, -1);
  return p;
}

function joinPath(a: string, b: string) {
  a = normPath(a);
  b = b.replace(/^\/+/, "");
  if (a === "/") return `/${b}`;
  return `${a}/${b}`;
}

function ensureDir(root: MemNode, relDir: string) {
  if (root.kind !== "dir") throw new Error("Root must be dir");
  const parts = relDir.split("/").filter(Boolean);

  let cur: MemNode = root;
  for (const part of parts) {
    if (cur.kind !== "dir") throw new Error("Path hits file");
    cur.children[part] ??= { kind: "dir", children: {} };
    cur = cur.children[part];
  }
  if (cur.kind !== "dir") throw new Error("Not a dir");
  return cur;
}

function setFile(root: MemNode, relFile: string, text: string) {
  if (root.kind !== "dir") throw new Error("Root must be dir");
  const parts = relFile.split("/").filter(Boolean);
  const name = parts.pop();
  if (!name) throw new Error("Bad file path");
  const dir = ensureDir(root, parts.join("/"));
  dir.children[name] = { kind: "file", text };
}

function getNode(root: MemNode, relPath: string): MemNode | null {
  if (root.kind !== "dir") return null;
  const parts = relPath.split("/").filter(Boolean);
  let cur: MemNode = root;
  for (const part of parts) {
    if (cur.kind !== "dir") return null;
    const nxt: any = cur.children[part];
    if (!nxt) return null;
    cur = nxt;
  }
  return cur;
}

function deleteNode(root: MemNode, relPath: string): boolean {
  if (root.kind !== "dir") return false;
  const parts = relPath.split("/").filter(Boolean);
  if (parts.length === 0) return false;
  let cur: MemNode = root;
  for (const part of parts.slice(0, -1)) {
    if (cur.kind !== "dir") return false;
    const nxt = cur.children[part];
    if (!nxt || nxt.kind !== "dir") return false;
    cur = nxt;
  }
  if (cur.kind !== "dir") return false;
  const name = parts[parts.length - 1];
  if (!cur.children[name]) return false;
  delete cur.children[name];
  return true;
}

function memToTreeItems(mem: MemNode, base: string): TreeItem[] {
  if (mem.kind !== "dir") return [];
  const out: TreeItem[] = [];

  const entries = Object.entries(mem.children).filter(
    ([name]) => name !== "__pycache__",
  );

  entries.sort((a, b) => {
    const ak = a[1].kind;
    const bk = b[1].kind;
    if (ak !== bk) return ak === "dir" ? -1 : 1;
    return a[0].localeCompare(b[0]);
  });

  for (const [name, child] of entries) {
    const id = joinPath(base, name);
    if (child.kind === "dir") {
      out.push({
        id,
        name,
        kind: "dir",
        children: memToTreeItems(child, id),
      });
    } else {
      out.push({ id, name, kind: "file" });
    }
  }
  return out;
}

function monacoLanguageForPath(fullPath: string): string {
  const p = fullPath.toLowerCase();
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".jsx")) return "javascript";
  return "plaintext";
}

function downloadBytes(filename: string, bytes: Uint8Array) {
  const blob = new Blob([bytes as any], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function flattenFiles(nodes: AppTreeNode[]): string[] {
  const out: string[] = [];
  const walk = (n: AppTreeNode) => {
    if (n.name === "__pycache__") return;
    if (n.kind === "file") out.push(n.id);
    if (n.children) n.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}

// Simple Bootstrap modal (no alerts/prompts)
function Modal({
  show,
  title,
  children,
  onClose,
  onOk,
  okText = "OK",
  okDisabled,
}: {
  show: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onOk: () => void;
  okText?: string;
  okDisabled?: boolean;
}) {
  if (!show) return null;

  return (
    <>
      <div className="modal show d-block" tabIndex={-1} role="dialog">
        <div className="modal-dialog" role="document">
          <div className="modal-content">
            <div className="modal-header">
              <div className="modal-title fw-semibold">{title}</div>
              <button
                type="button"
                className="btn-close"
                aria-label="Close"
                onClick={onClose}
              />
            </div>
            <div className="modal-body">{children}</div>
            <div className="modal-footer">
              <button className="btn btn-outline-secondary" onClick={onClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={onOk}
                disabled={okDisabled}
              >
                {okText}
              </button>
            </div>
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}

export function EditPage() {
  const nav = useNavigate();
  const {
    hasH5,
    fileName,
    ensureAppFromFsGroup,
    fsListTree,
    fsReadText,
    run,
    exportEditedH5,
  } = usePyodideH5();

  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // In-memory /app snapshot
  const appStateRef = useRef<MemNode>({ kind: "dir", children: {} });

  // Tree items derived from appStateRef
  const [treeItems, setTreeItems] = useState<TreeItem[]>([]);

  // Selection vs open file (selection can be folder even if a file is open)
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openFileId, setOpenFileId] = useState<string | null>(null);

  // Monaco editor refs (avoid remounting)
  const monacoEditorRef = useRef<any | null>(null);
  const monacoApiRef = useRef<any | null>(null);
  const settingValueRef = useRef(false);

  // Current text (always in-memory; editor writes here)
  const editorDirtyRef = useRef<string>("");

  // Modal state for add file/folder
  const [modalShow, setModalShow] = useState(false);
  const [modalMode, setModalMode] = useState<ModalMode>("add-file");
  const [modalParentDir, setModalParentDir] = useState("/app");
  const [modalName, setModalName] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  function refreshTreeFromRef() {
    const items = memToTreeItems(appStateRef.current, "/app");
    setTreeItems(items);
  }

  function relFromApp(full: string) {
    const p = normPath(full);
    if (!p.startsWith("/app")) return p.replace(/^\/+/, "");
    return p.replace(/^\/app\/?/, "");
  }

  async function loadWholeAppIntoRef() {
    const t = await fsListTree("/app");
    if (!t.ok) throw new Error(t.error);

    const files = flattenFiles(t.data).filter(
      (p) =>
        !p.includes("/__pycache__/") &&
        !p.endsWith(".pyc") &&
        p !== "/app/__pycache__",
    );

    const mem: MemNode = { kind: "dir", children: {} };

    // Create dirs from tree (preserve empties)
    const addDirs = (n: AppTreeNode) => {
      if (n.name === "__pycache__") return;
      if (n.kind === "dir") {
        const rel = relFromApp(n.id);
        if (rel) ensureDir(mem, rel);
        (n.children ?? []).forEach(addDirs);
      }
    };
    t.data.forEach(addDirs);

    // Fill file contents
    for (const fullPath of files) {
      const rel = relFromApp(fullPath);
      if (!rel) continue;

      const r = await fsReadText(fullPath);
      if (!r.ok) throw new Error(r.error);

      setFile(mem, rel, r.data);
    }

    appStateRef.current = mem;
    refreshTreeFromRef();
  }

  function showAddModal(mode: ModalMode, parentDirId: string) {
    setModalMode(mode);
    setModalParentDir(parentDirId);
    setModalName(mode === "add-file" ? "new_file.py" : "new_folder");
    setModalShow(true);
  }

  function upsertFolder(parentDirFull: string, name: string) {
    const relParent = relFromApp(parentDirFull);
    const relNew = relParent ? `${relParent}/${name}` : name;
    ensureDir(appStateRef.current, relNew);
    refreshTreeFromRef();
  }

  function upsertFile(parentDirFull: string, name: string) {
    const relParent = relFromApp(parentDirFull);
    const relNew = relParent ? `${relParent}/${name}` : name;
    setFile(appStateRef.current, relNew, "");
    refreshTreeFromRef();
  }

  function deleteByFullPath(fullPath: string) {
    if (!fullPath || fullPath === "/app") return;
    flushEditorToMemory();
    const rel = relFromApp(fullPath);
    if (!rel) return;
    const removed = deleteNode(appStateRef.current, rel);
    if (!removed) return;

    const normalized = normPath(fullPath);
    const isOpenDeleted =
      openFileId &&
      (normPath(openFileId) === normalized ||
        normPath(openFileId).startsWith(`${normalized}/`));

    if (isOpenDeleted) {
      setOpenFileId(null);
      editorDirtyRef.current = "";
      const ed = monacoEditorRef.current;
      if (ed) {
        settingValueRef.current = true;
        ed.setValue("");
        settingValueRef.current = false;
      }
    }

    if (
      selectedId &&
      (normPath(selectedId) === normalized ||
        normPath(selectedId).startsWith(`${normalized}/`))
    ) {
      setSelectedId(null);
    }

    refreshTreeFromRef();
  }

  function requestDelete(fullPath: string) {
    if (!fullPath || fullPath === "/app") return;
    setConfirmDeleteId(fullPath);
  }

  // Persist whatever is currently in the editor into the in-memory tree
  function flushEditorToMemory() {
    if (!openFileId) return;
    const rel = relFromApp(openFileId);
    const node = getNode(appStateRef.current, rel);
    if (node && node.kind === "file") {
      node.text = editorDirtyRef.current;
    }
  }

  async function openFile(fullPath: string) {
    // save current file text first
    flushEditorToMemory();

    const rel = relFromApp(fullPath);
    const node = getNode(appStateRef.current, rel);
    if (!node || node.kind !== "file") return;

    setOpenFileId(fullPath);
    setSelectedId(fullPath);

    const text = node.text ?? "";
    editorDirtyRef.current = text;

    const ed = monacoEditorRef.current;
    if (ed) {
      settingValueRef.current = true;
      ed.setValue(text);
      settingValueRef.current = false;
      ed.focus();
    }
  }

  async function saveWholeRefToApp(): Promise<void> {
    // ensure memory has latest editor content
    flushEditorToMemory();

    const json = JSON.stringify(appStateRef.current);
    const b64 = btoa(unescape(encodeURIComponent(json)));

    const py = `
import os, json, base64, shutil

if os.path.exists("/app"):
    shutil.rmtree("/app")
os.makedirs("/app", exist_ok=True)

data = json.loads(base64.b64decode("${b64}").decode("utf-8"))

def write_node(base, node):
    if node.get("kind") == "dir":
        os.makedirs(base, exist_ok=True)
        for name, child in (node.get("children") or {}).items():
            if name == "__pycache__":
                continue
            write_node(os.path.join(base, name), child)
    else:
        os.makedirs(os.path.dirname(base), exist_ok=True)
        with open(base, "w", encoding="utf-8") as f:
            f.write(node.get("text") or "")

write_node("/app", data)

init_path = "/app/__init__.py"
if not os.path.exists(init_path):
    with open(init_path, "w", encoding="utf-8") as f:
        f.write("from . import main")

main_path = "/app/main.py"
if not os.path.exists(main_path):
    with open(main_path, "w", encoding="utf-8") as f:
        f.write("def hierarchy(h5):\\n    return {}\\n")
`;
    const r = await run(py);
    if (!r.ok) throw new Error(r.error);
  }

  async function onSaveClick() {
    try {
      setBusy(true);
      setErr(null);
      await saveWholeRefToApp();
      setBusy(false);
    } catch (e: any) {
      setBusy(false);
      setErr(e?.message ?? String(e));
    }
  }

  async function onDownloadClick() {
    try {
      setBusy(true);
      setErr(null);

      await saveWholeRefToApp();

      const r = await exportEditedH5();
      if (!r.ok) throw new Error(r.error);

      downloadBytes(r.data.filename, r.data.bytes);
      setBusy(false);
    } catch (e: any) {
      setBusy(false);
      setErr(e?.message ?? String(e));
    }
  }

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!hasH5) {
          nav("/", { replace: true });
          return;
        }

        setBusy(true);
        setErr(null);

        const ensured = await ensureAppFromFsGroup();
        if (!ensured.ok) throw new Error(ensured.error);

        await loadWholeAppIntoRef();

        if (!alive) return;
        setBusy(false);
      } catch (e: any) {
        if (!alive) return;
        setBusy(false);
        setErr(e?.message ?? String(e));
        nav("/", { replace: true });
      }
    })();

    return () => {
      alive = false;
    };
  }, [hasH5, ensureAppFromFsGroup, nav]);

  // Update memory on editor changes (ignore programmatic sets)
  function onEditorChange(val: string | undefined) {
    if (settingValueRef.current) return;

    const t = val ?? "";
    editorDirtyRef.current = t;

    if (!openFileId) return;
    const rel = relFromApp(openFileId);
    const node = getNode(appStateRef.current, rel);
    if (node && node.kind === "file") node.text = t;
  }

  const modalOkDisabled = useMemo(() => {
    const name = modalName.trim();
    if (!name) return true;
    if (name.includes("/") || name.includes("\\")) return true;
    if (name === "__pycache__") return true;
    if (
      modalMode === "add-file" &&
      !(name.endsWith(".py") || name.endsWith(".jsx"))
    )
      return true;
    return false;
  }, [modalName, modalMode]);

  return (
    <div className="container-fluid py-3">
      <div className="d-flex align-items-center justify-content-between mb-2 px-2">
        <div>
          <div className="h5 mb-0">Edit</div>
          <div className="text-muted">{fileName ?? "(no file)"}</div>
        </div>
        <div className="d-flex gap-2">
          <button
            className="btn btn-outline-secondary"
            onClick={() => nav("/analyze")}
            disabled={busy}
          >
            Back
          </button>
          <button
            className="btn btn-outline-primary"
            onClick={onSaveClick}
            disabled={busy}
          >
            Save to /app
          </button>
          <button
            className="btn btn-primary"
            onClick={onDownloadClick}
            disabled={busy}
          >
            Download
          </button>
        </div>
      </div>

      {err && (
        <div
          className="alert alert-danger mx-2"
          role="alert"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {err}
        </div>
      )}

      <div className="row g-2 px-2">
        <div className="col-4">
          <div className="h-100 position-relative">
            <AppTreeView
              data={treeItems}
              selectedId={selectedId}
              height={Math.max(500, Math.floor(window.innerHeight * 0.8))}
              onSelect={(id) => setSelectedId(id)}
              onOpenFile={(fileId) => void openFile(fileId)}
              onAddFolder={(parentDirId) =>
                showAddModal("add-folder", parentDirId)
              }
              onAddFile={(parentDirId) => showAddModal("add-file", parentDirId)}
              onDelete={(targetId) => requestDelete(targetId)}
            />
          </div>
        </div>

        <div className="col-8">
          <div className="border rounded h-100 d-flex flex-column">
            <div className="border-bottom p-2">
              <div className="fw-semibold text-truncate">
                {openFileId ?? "Select a .py file"}
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0 }}>
              {openFileId ? (
                <Editor
                  theme="vs-dark"
                  language={
                    openFileId ? monacoLanguageForPath(openFileId) : "python"
                  }
                  onMount={(editor, monacoApi) => {
                    monacoEditorRef.current = editor;
                    monacoApiRef.current = monacoApi as any;

                    // initialize editor with current file contents
                    const rel = relFromApp(openFileId);
                    const node = getNode(appStateRef.current, rel);
                    const text = node && node.kind === "file" ? node.text : "";

                    editorDirtyRef.current = text ?? "";

                    settingValueRef.current = true;
                    editor.setValue(text ?? "");
                    settingValueRef.current = false;
                  }}
                  onChange={onEditorChange}
                  options={{
                    minimap: { enabled: false },
                    fontSize: 14,
                    wordWrap: "on",
                  }}
                />
              ) : (
                <div className="p-3 text-muted">No file selected.</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <Modal
        show={modalShow}
        title={modalMode === "add-file" ? "Add file" : "Add folder"}
        onClose={() => setModalShow(false)}
        onOk={() => {
          const name = modalName.trim();
          if (!name) return;

          if (modalMode === "add-file") {
            upsertFile(modalParentDir, name);
            const full = joinPath(modalParentDir, name);
            void openFile(full);
          } else {
            upsertFolder(modalParentDir, name);
          }

          setModalShow(false);
        }}
        okText="Create"
        okDisabled={modalOkDisabled}
      >
        <div className="mb-2 text-muted small">
          Parent: <code>{modalParentDir}</code>
        </div>
        <label className="form-label">
          {modalMode === "add-file" ? "Filename (.py or .jsx)" : "Folder name"}
        </label>
        <input
          className="form-control"
          value={modalName}
          onChange={(e) => setModalName(e.target.value)}
          autoFocus
        />
        <div className="form-text">
          No slashes. <code>__pycache__</code> is ignored.
        </div>
      </Modal>
      <Modal
        show={!!confirmDeleteId}
        title="Delete item"
        onClose={() => setConfirmDeleteId(null)}
        onOk={() => {
          if (confirmDeleteId) deleteByFullPath(confirmDeleteId);
          setConfirmDeleteId(null);
        }}
        okText="Delete"
      >
        <p className="mb-0">
          Are you sure you want to delete{" "}
          <code>{confirmDeleteId ?? ""}</code>?
        </p>
      </Modal>
    </div>
  );
}
