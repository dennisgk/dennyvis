import { useEffect, useMemo, useRef, useState } from "react";
import { Tree } from "react-arborist";
import { ChevronDown, ChevronRight, FilePlus, FolderPlus } from "lucide-react";

export type TreeItemKind = "dir" | "file";

export type TreeItem = {
  id: string; // full path like /app/foo/bar.py
  name: string;
  kind: TreeItemKind;
  children?: TreeItem[];
};

type CtxMenuState =
  | { open: false }
  | {
      open: true;
      x: number;
      y: number;
      targetId: string | null; // null => empty space
      targetKind: TreeItemKind | null;
    };

export type AppTreeViewProps = {
  data: TreeItem[];
  selectedId: string | null;

  onOpenFile: (fileId: string) => void;
  onSelect: (id: string | null) => void;

  onAddFile: (parentDirId: string) => void;
  onAddFolder: (parentDirId: string) => void;

  height?: number;
};

function isDir(item: TreeItem) {
  return item.kind === "dir";
}

function parentDirOf(path: string) {
  const parts = path.split("/").filter(Boolean);
  if (parts.length <= 1) return "/app";
  return "/" + parts.slice(0, -1).join("/");
}

export function AppTreeView({
  data,
  selectedId,
  onOpenFile,
  onSelect,
  onAddFile,
  onAddFolder,
  height = 700,
}: AppTreeViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState>({ open: false });

  const rootParentId = useMemo(() => "/app", []);
  const treeHeight = Math.max(200, height - 36); // 36 for header

  // Close context menu on global click/scroll/resize/escape
  useEffect(() => {
    const close = () => setCtxMenu({ open: false });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  function openCtxMenuAt(clientX: number, clientY: number, target?: TreeItem) {
    const rect = containerRef.current?.getBoundingClientRect();
    const x = rect ? clientX - rect.left : clientX;
    const y = rect ? clientY - rect.top : clientY;

    setCtxMenu({
      open: true,
      x,
      y,
      targetId: target ? target.id : null,
      targetKind: target ? target.kind : null,
    });
  }

  // Parent resolution for context-menu actions
  function resolveParentFromCtx(): string {
    if (!ctxMenu.open) return rootParentId;
    if (!ctxMenu.targetId || !ctxMenu.targetKind) return rootParentId;

    if (ctxMenu.targetKind === "dir") return ctxMenu.targetId;
    return parentDirOf(ctxMenu.targetId);
  }

  // Parent resolution for header icon actions
  function resolveParentFromSelection(): string {
    if (!selectedId) return rootParentId;
    // If selected is a dir, parent = selected dir
    // If selected is a file, parent = its folder
    // We can infer by path; but we need kind. We'll do a cheap rule:
    // if it ends with "/", no; instead just assume files have an extension or not.
    // Better: if selected exists as a dir in this tree, we know by traversing.
    // We'll do a traversal map once.
    const kind = kindById.get(selectedId);
    if (kind === "dir") return selectedId;
    if (kind === "file") return parentDirOf(selectedId);
    return rootParentId;
  }

  // Build id->kind map (for selection-based actions)
  const kindById = useMemo(() => {
    const m = new Map<string, TreeItemKind>();
    const walk = (items: TreeItem[]) => {
      for (const it of items) {
        m.set(it.id, it.kind);
        if (it.children) walk(it.children);
      }
    };
    walk(data);
    return m;
  }, [data]);

  return (
    <div
      ref={containerRef}
      className="border rounded h-100 p-2 position-relative d-flex flex-column"
      style={{
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onClick={(e) => {
        // left-click blank space clears selection (but doesn't close open file)
        // row clicks stopPropagation; so if we get here, it was empty space
        e.preventDefault();
        onSelect(null);
      }}
      onContextMenu={(e) => {
        // right-click empty space opens menu (parent = /app)
        e.preventDefault();
        e.stopPropagation();
        openCtxMenuAt(e.clientX, e.clientY, undefined);
      }}
      onMouseDown={(e) => {
        // prevent drag-selection highlight in the container
        if (e.button === 0) e.preventDefault();
      }}
    >
      {/* Header actions */}
      <div className="d-flex justify-content-end gap-2 mb-2">
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          title="Add folder"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddFolder(resolveParentFromSelection());
          }}
        >
          <FolderPlus size={16} />
        </button>
        <button
          type="button"
          className="btn btn-sm btn-outline-secondary"
          title="Add file"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onAddFile(resolveParentFromSelection());
          }}
        >
          <FilePlus size={16} />
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0 }}>
        <Tree
          data={data}
          openByDefault={false}
          width={"100%"}
          height={treeHeight}
          indent={18}
          rowHeight={30}
        >
          {({ node, style }) => {
            const item = (node as any).data as TreeItem;
            const open = !!(node as any).isOpen;
            const toggle = () => (node as any).toggle?.();
            const isSelected = selectedId === item.id;
            const level = node.level;
            const INDENT = 18;

            return (
              <div
                style={{
                  ...style,
                  display: "flex",
                  alignItems: "center",
                  paddingLeft: 8 + level * INDENT,
                  paddingRight: 8,
                  borderRadius: 6,
                  cursor: "default",
                  background: isSelected ? "rgba(13,110,253,0.22)" : undefined,
                }}
                onMouseDown={(e) => {
                  // prevent text selection; also stop container blank-space handler
                  e.preventDefault();
                  e.stopPropagation();
                }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  // Selecting folder while file is open is allowed (open file remains in editor)
                  onSelect(item.id);

                  if (isDir(item)) {
                    toggle(); // allow opening folders
                  } else {
                    onOpenFile(item.id); // open file on single click
                  }
                }}
                onDoubleClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();

                  if (isDir(item)) toggle();
                  else onOpenFile(item.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openCtxMenuAt(e.clientX, e.clientY, item);
                }}
                onMouseEnter={(e) => {
                  const el = e.currentTarget;
                  if (!isSelected)
                    el.style.background = "rgba(255,255,255,0.07)";
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget;
                  if (!isSelected) el.style.background = "";
                }}
              >
                {/* Chevron for directories */}
                <div
                  style={{ width: 18, display: "flex", alignItems: "center" }}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (isDir(item)) toggle();
                  }}
                >
                  {isDir(item) ? (
                    open ? (
                      <ChevronDown size={16} />
                    ) : (
                      <ChevronRight size={16} />
                    )
                  ) : (
                    <span style={{ width: 16 }} />
                  )}
                </div>

                <div className="text-truncate" style={{ flex: 1 }}>
                  {item.name}
                </div>
              </div>
            );
          }}
        </Tree>
      </div>

      {/* Bootstrap dropdown context menu (dark-mode friendly) */}
      {ctxMenu.open && (
        <div
          className="dropdown-menu show shadow"
          style={{
            position: "absolute",
            left: ctxMenu.x,
            top: ctxMenu.y,
            zIndex: 2000,
            minWidth: 170,
          }}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="dropdown-item"
            type="button"
            onClick={() => {
              setCtxMenu({ open: false });
              onAddFolder(resolveParentFromCtx());
            }}
          >
            Add folder
          </button>
          <button
            className="dropdown-item"
            type="button"
            onClick={() => {
              setCtxMenu({ open: false });
              onAddFile(resolveParentFromCtx());
            }}
          >
            Add file
          </button>
        </div>
      )}
    </div>
  );
}
