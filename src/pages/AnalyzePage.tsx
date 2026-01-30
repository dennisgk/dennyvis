// src/pages/AnalyzePage.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  Folder,
  Play,
  Square,
  Pencil,
  ListTree,
  FilePlay,
  ChevronDown,
  ChevronRight,
} from "lucide-react";

import { usePyodideH5, type OutMsg } from "../contexts/PyodideH5Context";
import { compileJsx, evaluateToComponent } from "../utils/JSXToJS";

type StudyArg =
  | { type: "string"; defaultValue: string }
  | { type: "int"; defaultValue: number }
  | { type: "float"; defaultValue: number }
  | { type: "dropdown"; values: string[]; defaultValue: string };

type HierNode =
  | { type: "dir"; children: Record<string, HierNode> }
  | {
      type: "study";
      args?: Record<string, StudyArg>;
      description?: string;
      autostart?: "TRUE" | "PROMPT" | "FALSE";
    };

type StudyTreeNode =
  | { kind: "dir"; id: string; name: string; children: StudyTreeNode[] }
  | {
      kind: "study";
      id: string;
      name: string;
      description?: string;
      args?: Record<string, StudyArg>;
      autostart?: "TRUE" | "PROMPT" | "FALSE";
    };

function toErrMsg(r: OutMsg<any>) {
  if (r.ok) return null;
  return r.stack ? `${r.error}\n\n${r.stack}` : r.error;
}

function encodeArgsToQuery(
  args: Record<string, unknown> | null,
): string | null {
  if (!args) return null;
  try {
    const json = JSON.stringify(args);
    const b64 = btoa(unescape(encodeURIComponent(json)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
    return b64;
  } catch {
    return null;
  }
}

function makePyVarName(prefix = "v") {
  // Python identifier rules:
  // - letters, numbers, underscores
  // - cannot start with a number

  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";

  // Generate cryptographically secure random characters
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let rand = "";

  for (const b of bytes) {
    rand += chars[b % chars.length];
  }

  // ensure it starts with a letter or underscore
  return `${prefix}_${rand}`;
}

function decodeArgsFromQuery(
  b64url: string | null,
): Record<string, unknown> | null {
  if (!b64url) return null;
  try {
    const b64 =
      b64url.replace(/-/g, "+").replace(/_/g, "/") +
      "===".slice((b64url.length + 3) % 4);
    const json = decodeURIComponent(escape(atob(b64)));
    const obj = JSON.parse(json);
    if (obj && typeof obj === "object") return obj;
    return null;
  } catch {
    return null;
  }
}

function readUrlState(): {
  studyId: string | null;
  args: Record<string, unknown> | null;
  auto: "TRUE" | "PROMPT" | "FALSE" | null;
} {
  const sp = new URLSearchParams(window.location.search);
  const studyId = sp.get("study");
  const args = decodeArgsFromQuery(sp.get("args"));
  const a = (sp.get("autostart") ?? "").toUpperCase();
  const auto =
    a === "TRUE" || a === "PROMPT" || a === "FALSE" ? (a as any) : null;
  return { studyId, args, auto };
}

function writeUrlReplace(
  studyId: string | null,
  args: Record<string, unknown> | null,
) {
  const sp = new URLSearchParams(window.location.search);
  if (studyId) sp.set("study", studyId);
  else sp.delete("study");

  const enc = encodeArgsToQuery(args);
  if (enc) sp.set("args", enc);
  else sp.delete("args");

  sp.delete("autostart");

  const qs = sp.toString();
  const url = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function writeUrlPush(studyId: string | null) {
  const sp = new URLSearchParams(window.location.search);
  if (studyId) sp.set("study", studyId);
  else sp.delete("study");
  // we intentionally do NOT set args here (defaults will be replaceState later)
  sp.delete("args");
  sp.delete("autostart");

  const qs = sp.toString();
  const url = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname;
  window.history.pushState(null, "", url);
}

function consumeAutoParamNow() {
  const sp = new URLSearchParams(window.location.search);
  if (!sp.has("autostart")) return;
  sp.delete("autostart");
  const qs = sp.toString();
  const url = qs
    ? `${window.location.pathname}?${qs}`
    : window.location.pathname;
  window.history.replaceState(null, "", url);
}

function Modal({
  show,
  title,
  children,
  onClose,
  footer,
  size = "lg",
}: {
  show: boolean;
  title: React.ReactNode;
  children: React.ReactNode;
  onClose: () => void;
  footer?: React.ReactNode;
  size?: "sm" | "lg" | "xl";
}) {
  if (!show) return null;
  return (
    <>
      <div className="modal show d-block" tabIndex={-1} role="dialog">
        <div className={`modal-dialog modal-${size}`} role="document">
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
            {footer && <div className="modal-footer">{footer}</div>}
          </div>
        </div>
      </div>
      <div className="modal-backdrop show" />
    </>
  );
}

function buildStudyTree(root: Record<string, HierNode>): StudyTreeNode[] {
  function walk(
    children: Record<string, HierNode>,
    prefix: string,
  ): StudyTreeNode[] {
    const entries = Object.entries(children);
    entries.sort((a, b) => {
      if (a[1].type !== b[1].type) return a[1].type === "dir" ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });

    const out: StudyTreeNode[] = [];
    for (const [name, node] of entries) {
      const id = prefix ? `${prefix}/${name}` : name;
      if (node.type === "dir") {
        out.push({
          kind: "dir",
          id,
          name,
          children: walk(node.children ?? {}, id),
        });
      } else {
        out.push({
          kind: "study",
          id,
          name,
          description: node.description ?? "",
          args: node.args ?? {},
          autostart: node.autostart ?? "FALSE",
        });
      }
    }
    return out;
  }
  return walk(root, "");
}

function findStudyById(
  tree: StudyTreeNode[],
  id: string,
): StudyTreeNode | null {
  for (const n of tree) {
    if (n.id === id) return n;
    if (n.kind === "dir") {
      const f = findStudyById(n.children, id);
      if (f) return f;
    }
  }
  return null;
}

function collectAllStudies(
  tree: StudyTreeNode[],
): Array<Extract<StudyTreeNode, { kind: "study" }>> {
  const out: Array<Extract<StudyTreeNode, { kind: "study" }>> = [];
  const walk = (nodes: StudyTreeNode[]) => {
    for (const n of nodes) {
      if (n.kind === "study") out.push(n);
      else walk(n.children);
    }
  };
  walk(tree);
  return out;
}

function StudyTreeView({
  nodes,
  selectedStudyId,
  onSelectStudy,
  showRootOption,
}: {
  nodes: StudyTreeNode[];
  selectedStudyId: string | null;
  onSelectStudy: (studyId: string | null) => void;
  showRootOption?: boolean;
}) {
  const [openDirs, setOpenDirs] = useState<Set<string>>(() => new Set());

  function toggleDir(id: string) {
    setOpenDirs((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function Row({ node, depth }: { node: StudyTreeNode; depth: number }) {
    const isSelected = node.kind === "study" && selectedStudyId === node.id;
    const indentPx = 12 + depth * 16;

    return (
      <div
        className="d-flex align-items-center rounded px-2 py-1"
        style={{
          cursor: "default",
          userSelect: "none",
          WebkitUserSelect: "none",
          paddingLeft: indentPx,
          background: isSelected ? "rgba(13,110,253,0.22)" : undefined,
        }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (node.kind === "dir") toggleDir(node.id);
          else onSelectStudy(node.id);
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget;
          if (!isSelected) el.style.background = "rgba(255,255,255,0.07)";
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget;
          if (!isSelected) el.style.background = "";
        }}
      >
        {node.kind === "dir" ? (
          <>
            <span
              className="me-2"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleDir(node.id);
              }}
            >
              {openDirs.has(node.id) ? (
                <ChevronDown size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </span>
            <Folder size={16} className="me-2" />
            <span className="fw-semibold">{node.name}</span>
          </>
        ) : (
          <>
            <span className="me-2" style={{ width: 16 }} />
            <FilePlay size={16} className="me-2" />
            <div className="flex-grow-1">
              <div className="fw-semibold">{node.name}</div>
              {!!node.description && (
                <div className="small text-muted">{node.description}</div>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  function RenderNodes({
    nodes,
    depth,
  }: {
    nodes: StudyTreeNode[];
    depth: number;
  }) {
    return (
      <>
        {nodes.map((n) => (
          <div key={n.id} className="mb-1">
            <Row node={n} depth={depth} />
            {n.kind === "dir" && openDirs.has(n.id) && (
              <RenderNodes nodes={n.children} depth={depth + 1} />
            )}
          </div>
        ))}
      </>
    );
  }

  return (
    <div>
      {showRootOption && (
        <button
          type="button"
          className={`btn w-100 text-start mb-2 ${
            selectedStudyId == null ? "btn-primary" : "btn-outline-secondary"
          }`}
          onClick={() => onSelectStudy(null)}
        >
          Root (no study)
        </button>
      )}
      <RenderNodes nodes={nodes} depth={0} />
    </div>
  );
}

export function AnalyzePage() {
  const nav = useNavigate();
  const {
    hasH5,
    fileName,
    ensureAppFromFsGroup,
    run,
    onGlobalMessage,
    offGlobalMessage,
  } = usePyodideH5();

  const [hier, setHier] = useState<Record<string, HierNode> | null>(null);
  const studyTree = useMemo(() => (hier ? buildStudyTree(hier) : []), [hier]);

  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [selectedStudyName, setSelectedStudyName] = useState<string | null>(
    null,
  );
  const [selectedStudyArgsSchema, setSelectedStudyArgsSchema] = useState<
    Record<string, StudyArg>
  >({});
  const [argsDraft, setArgsDraft] = useState<Record<string, unknown>>({});
  const [StudyComp, setStudyComp] = useState<React.ComponentType<any> | null>(
    null,
  );

  const [runningStudyId, setRunningStudyId] = useState<string | null>(null);
  const [runningStateId, setRunningStateId] = useState<string | null>(null);

  const [showStudyModal, setShowStudyModal] = useState(false);
  const [showArgsModal, setShowArgsModal] = useState(false);
  const [showErrorModal, setShowErrorModal] = useState(false);
  const [errorModalText, setErrorModalText] = useState<string>("");

  // URL init snapshot (study/args/autostart override)
  const urlInitRef = useRef(readUrlState());

  // one-shot override: if URL had ?autostart=..., apply it only once then revert to per-study autostart
  const autoOverrideOnceRef = useRef<"TRUE" | "PROMPT" | "FALSE" | null>(
    urlInitRef.current.auto,
  );

  // avoid double-firing autostart for the same selection
  const autoHandledForStudyRef = useRef<string | null>(null);

  // track why selection changed (init/user/pop) so we can skip auto on popstate
  const selectionSourceRef = useRef<"init" | "user" | "pop">("init");

  // keep latest argsDraft for safe reads inside effects
  const argsDraftRef = useRef<Record<string, unknown>>({});
  useEffect(() => {
    argsDraftRef.current = argsDraft;
  }, [argsDraft]);

  // push history only when study changes (user action)
  const lastPushedStudyRef = useRef<string | null>(urlInitRef.current.studyId);

  // ---------------- Python bridge ----------------
  async function pyInitHierarchyAndRegistry(): Promise<
    OutMsg<{ tree: Record<string, HierNode> }>
  > {
    const ensured = await ensureAppFromFsGroup();
    if (!ensured.ok) return ensured as any;

    const code = `
import sys, importlib

if "/" not in sys.path:
    sys.path.insert(0, "/")

import app.main
importlib.reload(app.main)

raw = app.main.hierarchy()

try:
    _STUDY_REG
except NameError:
    _STUDY_REG = {}   # studyId -> {"args": schema, "validate": fn, "onMessage": fn, "onState": fn}
    _STATE_REG = {}   # stateId -> stateObj

def _sanitize_tree(node, prefix=""):
    if isinstance(node, dict) and "type" not in node:
        out = {}
        for k, v in node.items():
            out[str(k)] = _sanitize_tree(v, prefix + "/" + str(k))
        return out

    if not isinstance(node, dict):
        return {"type":"study", "args": {}, "description": "", "autostart":"FALSE"}

    t = node.get("type", None)

    if t == "dir":
        ch = node.get("children", {}) or {}
        if not isinstance(ch, dict):
            ch = {}
        return {"type":"dir", "children": _sanitize_tree(ch, prefix)}

    if t == "study":
        study_id = prefix.lstrip("/") or "study"

        desc = node.get("description", "")
        if desc is None:
            desc = ""
        desc = str(desc)

        aut = node.get("autostart", "FALSE")
        aut = str(aut).upper()
        if aut not in ("TRUE","PROMPT","FALSE"):
            aut = "FALSE"

        args = node.get("args", {}) or {}
        if not isinstance(args, dict):
            args = {}

        args_out = {}
        for arg_name, spec in args.items():
            if not isinstance(spec, dict):
                continue
            arg_name = str(arg_name)
            arg_type = spec.get("type", None)
            default_val = spec.get("defaultValue", None)

            if arg_type == "dropdown":
                values = spec.get("values", []) or []
                args_out[arg_name] = {
                    "type":"dropdown",
                    "values":[str(x) for x in values],
                    "defaultValue": str(default_val) if default_val is not None else (str(values[0]) if values else "")
                }
            elif arg_type == "string":
                args_out[arg_name] = {"type":"string", "defaultValue": "" if default_val is None else str(default_val)}
            elif arg_type == "int":
                try: dv = int(default_val)
                except Exception: dv = 0
                args_out[arg_name] = {"type":"int", "defaultValue": dv}
            elif arg_type == "float":
                try: dv = float(default_val)
                except Exception: dv = 0.0
                args_out[arg_name] = {"type":"float", "defaultValue": dv}
            else:
                args_out[arg_name] = {"type":"string", "defaultValue": "" if default_val is None else str(default_val)}

        vfn = node.get("validate", None)
        on_message = node.get("onMessage", None)
        on_state = node.get("onState", None)

        _STUDY_REG[study_id] = {
            "args": args_out,
            "validate": vfn if callable(vfn) else None,
            "onMessage": on_message if callable(on_message) else None,
            "onState": on_state if callable(on_state) else None
        }

        return {"type":"study", "args": args_out, "description": desc, "autostart": aut}

    return {"type":"study", "args": {}, "description": "", "autostart":"FALSE"}

tree = _sanitize_tree(raw, prefix="")
{"tree": tree}
`;
    return await run<{ tree: Record<string, HierNode> }>(code);
  }

  async function pyValidate(
    studyId: string,
    argsIn: Record<string, unknown>,
  ): Promise<OutMsg<Record<string, unknown>>> {
    const curVarName = makePyVarName();
    const code = `
req = (${curVarName}).to_py()
sid = req["studyId"]
args_in = req.get("args", {}) or {}

if sid not in _STUDY_REG:
    raise Exception(f"Unknown studyId: {sid}")

entry = _STUDY_REG[sid]
schema = entry.get("args", {}) or {}

args = {}
for name, spec in schema.items():
    t = spec.get("type")
    val = args_in.get(name, spec.get("defaultValue"))

    if t == "int":
        try: val = int(val)
        except Exception: raise Exception(f"{name}: expected int")
    elif t == "float":
        try: val = float(val)
        except Exception: raise Exception(f"{name}: expected float")
    elif t == "dropdown":
        vals = spec.get("values", []) or []
        sval = str(val)
        if sval not in [str(x) for x in vals]:
            raise Exception(f"{name}: must be one of {vals}")
        val = sval
    else:
        val = "" if val is None else str(val)

    args[name] = val

vfn = entry.get("validate")
if callable(vfn):
    res = await vfn(_h5, args)
    if not isinstance(res, dict) or "ok" not in res:
        raise Exception("validate(h5, args) must return {'ok': True} or {'ok': False, 'message': str}")
    if not bool(res.get("ok")):
        msg = res.get("message", "Validation failed")
        raise Exception(str(msg))

args
`;
    return await run<Record<string, unknown>>(code, {
      [curVarName]: { studyId, args: argsIn },
    });
  }

  async function pyMessage(
    studyId: string,
    stateId: string,
    data: any,
  ): Promise<OutMsg<any>> {
    const curVarName = makePyVarName();

    const code = `
req = (${curVarName}).to_py()
sid = req["studyId"]
state_id = req["stateId"]
data = req.get("data", {}) or {}

entry = _STUDY_REG.get(sid)
state = _STATE_REG.get(state_id)
message = lambda data: globalMessage(sid, state_id, data)

fn = entry.get("onMessage") if entry else None
res = None
if callable(fn):
    res = await fn(_h5, message, state, data)

res
`;

    return await run<any>(code, { [curVarName]: { studyId, stateId, data } });
  }

  async function pyStart(
    studyId: string,
    validatedArgs: Record<string, unknown>,
  ): Promise<OutMsg<{ stateId: string; compStr?: string }>> {
    const curVarName = makePyVarName();

    const code = `
import uuid
req = (${curVarName}).to_py()
sid = req["studyId"]
args = req.get("args", {}) or {}

entry = _STUDY_REG.get(sid)
if not entry:
    raise Exception(f"Unknown studyId: {sid}")

state = None

fn = entry.get("onState")
comp_str = None

if callable(fn):
    res = await fn(_h5, args)
    if isinstance(res, tuple) and len(res) >= 1:
        state = res[0]
        if len(res) >= 2:
            comp_str = res[1]
    else:
        state = res

state_id = str(uuid.uuid4())
_STATE_REG[state_id] = state

{"stateId": state_id, "compStr": comp_str}
`;
    return await run<{ stateId: string; compStr?: string }>(code, {
      [curVarName]: { studyId, args: validatedArgs },
    });
  }

  // ---------------- Lifecycle ----------------
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!hasH5) {
        nav("/", { replace: true });
        return;
      }

      const init = await pyInitHierarchyAndRegistry();
      if (!alive) return;

      if (!init.ok) {
        console.error(init.error + "\n\n" + (init.stack ?? ""));
        nav("/", { replace: true });
        return;
      }

      setHier(init.data.tree);

      const u = urlInitRef.current;
      selectionSourceRef.current = "init";
      autoHandledForStudyRef.current = null; // allow autostart on first selection

      if (u.studyId) setSelectedStudyId(u.studyId);
      else setSelectedStudyId(null);
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasH5]);

  // Update derived selection info + set argsDraft defaults; replace URL with defaults (not push)
  useEffect(() => {
    if (!hier) return;

    if (!selectedStudyId) {
      setSelectedStudyName(null);
      setSelectedStudyArgsSchema({});
      setArgsDraft({});
      writeUrlReplace(null, null);
      return;
    }

    const node = findStudyById(studyTree, selectedStudyId);
    if (!node || node.kind !== "study") {
      setSelectedStudyId(null);
      return;
    }

    setSelectedStudyName(node.name);
    setSelectedStudyArgsSchema(node.args ?? {});

    // If this is the initial URL-selected study and URL had args, prefer those.
    // Prefer URL args when:
    // - initial load URL had args for this study, OR
    // - we're handling popstate and the *current* URL has args for this study
    const initUrl = urlInitRef.current;
    const curUrl = readUrlState();

    const preferUrlArgs =
      (selectionSourceRef.current === "init" &&
        initUrl.studyId === selectedStudyId &&
        !!initUrl.args) ||
      (selectionSourceRef.current === "pop" &&
        curUrl.studyId === selectedStudyId &&
        !!curUrl.args);

    const preferredArgs =
      selectionSourceRef.current === "init" ? initUrl.args : curUrl.args;

    const schema = node.args ?? {};
    const nextDraft: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(schema)) {
      nextDraft[k] =
        preferUrlArgs && preferredArgs && k in (preferredArgs as any)
          ? (preferredArgs as any)[k]
          : spec.defaultValue;
    }

    setArgsDraft(nextDraft);

    // Only "normalize" the URL when NOT coming from popstate,
    // or when popstate URL had no args and we want defaults.
    if (selectionSourceRef.current !== "pop") {
      writeUrlReplace(
        selectedStudyId,
        preferUrlArgs ? preferredArgs : nextDraft,
      );
    } else {
      // If popstate has no args in URL, fill them once (optional, but helps consistency)
      if (!curUrl.args) {
        writeUrlReplace(selectedStudyId, nextDraft);
      }
    }
  }, [hier, selectedStudyId]);

  useEffect(() => {
    if (runningStudyId === null || runningStateId === null) return;

    return () => offGlobalMessage(runningStudyId, runningStateId);
  }, [runningStudyId, runningStateId]);

  // ---------------- Run helper (safe for effects) ----------------
  async function runWithArgsNow(
    studyId: string,
    argsIn: Record<string, unknown>,
  ) {
    const vr = await pyValidate(studyId, argsIn);
    if (!vr.ok) {
      setErrorModalText(toErrMsg(vr) ?? "Validation failed");
      setShowErrorModal(true);
      return;
    }

    const sr = await pyStart(studyId, vr.data);
    if (!sr.ok) {
      setErrorModalText(toErrMsg(sr) ?? "Start failed");
      setShowErrorModal(true);
      return;
    }

    const compl = compileJsx(sr.data.compStr ?? "");
    setStudyComp(() => evaluateToComponent(compl));

    setRunningStudyId(studyId);
    setRunningStateId(sr.data.stateId);

    writeUrlReplace(studyId, vr.data);
    setShowArgsModal(false);
  }

  // Per-study autostart:
  // - If URL had ?autostart=..., apply it ONCE (override) then revert to node.autostart
  // - Otherwise respect node.autostart for each selected study
  // - Skip autostart on popstate (back/forward)
  const isRunning = runningStudyId != null && runningStateId != null;

  useEffect(() => {
    if (!hier) return;
    if (!selectedStudyId) return;
    if (selectionSourceRef.current === "pop") return;
    if (isRunning) return;

    if (autoHandledForStudyRef.current === selectedStudyId) return;

    const node = findStudyById(studyTree, selectedStudyId);
    if (!node || node.kind !== "study") return;

    const u = urlInitRef.current;
    const isInitialUrlStudy =
      selectionSourceRef.current === "init" && u.studyId === selectedStudyId;

    // Build args to use now:
    // - For the initial URL study, prefer URL args if present
    // - Otherwise use current argsDraft (which is already set to defaults)
    const schema = node.args ?? {};
    const nextArgs: Record<string, unknown> = {};
    for (const [k, spec] of Object.entries(schema)) {
      nextArgs[k] =
        isInitialUrlStudy && u.args && k in (u.args as any)
          ? (u.args as any)[k]
          : (argsDraftRef.current[k] ?? spec.defaultValue);
    }

    const override = autoOverrideOnceRef.current;
    const mode: "TRUE" | "PROMPT" | "FALSE" = (override ??
      node.autostart ??
      "FALSE") as any;

    autoHandledForStudyRef.current = selectedStudyId;

    // Consume override the first time we use it
    if (override) {
      autoOverrideOnceRef.current = null;
      consumeAutoParamNow();
    }

    if (mode === "TRUE") {
      void runWithArgsNow(selectedStudyId, nextArgs);
    } else if (mode === "PROMPT") {
      setShowArgsModal(true);
    }
    // FALSE => do nothing
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hier, selectedStudyId, studyTree, isRunning]);

  // popstate: back/forward should select study + args (and end running)
  useEffect(() => {
    const onPop = () => {
      const { studyId, args } = readUrlState();
      void (async () => {
        // close any open modals on back/forward
        setShowArgsModal(false);
        setShowStudyModal(false);
        setShowErrorModal(false);

        setRunningStudyId(null);
        setRunningStateId(null);
        setStudyComp(null);

        selectionSourceRef.current = "pop";
        autoHandledForStudyRef.current = null;

        lastPushedStudyRef.current = studyId;

        setSelectedStudyId(studyId);
        setArgsDraft(args ?? {});
      })();
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runningStudyId, runningStateId]);

  // ---------------- Study switching ----------------
  async function setStudyAndEndPrevious(nextStudyId: string | null) {
    setRunningStudyId(null);
    setRunningStateId(null);
    setStudyComp(null);

    // Push history entry ONLY if study actually changed due to user action
    if (lastPushedStudyRef.current !== nextStudyId) {
      lastPushedStudyRef.current = nextStudyId;
      writeUrlPush(nextStudyId);
    }

    selectionSourceRef.current = "user";
    autoHandledForStudyRef.current = null; // allow autostart/prompt for the new selection

    setSelectedStudyId(nextStudyId);
  }

  // ---------------- Start / End ----------------
  async function onStartClick() {
    if (!selectedStudyId) {
      setShowStudyModal(true);
      return;
    }
    setShowArgsModal(true);
  }

  async function onRunWithArgs() {
    if (!selectedStudyId) return;

    const vr = await pyValidate(selectedStudyId, argsDraftRef.current);
    if (!vr.ok) {
      setErrorModalText(toErrMsg(vr) ?? "Validation failed");
      setShowErrorModal(true);
      return;
    }

    const sr = await pyStart(selectedStudyId, vr.data);
    if (!sr.ok) {
      setErrorModalText(toErrMsg(sr) ?? "Start failed");
      setShowErrorModal(true);
      return;
    }

    const compl = compileJsx(sr.data.compStr ?? "");
    setStudyComp(() => evaluateToComponent(compl));

    setRunningStudyId(selectedStudyId);
    setRunningStateId(sr.data.stateId);

    // Replace URL with the args actually used (no push)
    writeUrlReplace(selectedStudyId, vr.data);

    setShowArgsModal(false);
  }

  async function onEndClick() {
    if (!runningStudyId || !runningStateId) return;

    setRunningStudyId(null);
    setRunningStateId(null);
    setStudyComp(null);
  }

  // ---------------- Root view ----------------
  const allStudies = useMemo(() => collectAllStudies(studyTree), [studyTree]);

  const titleSuffix = selectedStudyName ? ` (${selectedStudyName})` : "";

  // ---------------- Render ----------------
  return (
    <div className="container-fluid py-3" style={{ height: "100vh" }}>
      <div className="d-flex align-items-center justify-content-between mb-2 px-2">
        <div>
          <div className="h5 mb-0">{`Analyze${titleSuffix}`}</div>
          <div className="text-muted">{fileName ?? "(no file)"}</div>
        </div>

        <div className="d-flex gap-2">
          <button
            className="btn btn-outline-secondary d-flex align-items-center gap-2"
            onClick={() => setShowStudyModal(true)}
            title="Select study"
          >
            <ListTree size={16} />
            Study
          </button>

          <button
            className="btn btn-outline-secondary d-flex align-items-center gap-2"
            onClick={() => nav("/edit")}
            title="Edit Python"
          >
            <Pencil size={16} />
            Edit
          </button>

          <button
            className="btn btn-primary d-flex align-items-center gap-2"
            onClick={() => void onStartClick()}
            disabled={!selectedStudyId || isRunning}
            title="Start"
          >
            <Play size={16} />
            Start
          </button>

          <button
            className="btn btn-outline-danger d-flex align-items-center gap-2"
            onClick={() => void onEndClick()}
            disabled={!isRunning}
            title="End"
          >
            <Square size={16} />
            End
          </button>
        </div>
      </div>

      <div className="px-2" style={{ height: "calc(100vh - 86px)" }}>
        <div className="border rounded h-100 d-flex flex-column">
          <div className="border-bottom px-3 py-2 d-flex align-items-center justify-content-between">
            <div className="text-muted">
              {selectedStudyId ? (
                <>
                  Selected:{" "}
                  <span className="fw-semibold">{selectedStudyName}</span>
                </>
              ) : (
                <>Root (no study selected)</>
              )}
            </div>
            <div className="text-muted small">
              {isRunning ? "Running" : "Inactive"}
            </div>
          </div>

          <div className="flex-grow-1" style={{ minHeight: 0 }}>
            {selectedStudyId ? (
              <div className="h-100 w-100" style={{ overflow: "auto" }}>
                {StudyComp === null ||
                runningStudyId === null ||
                runningStateId === null ? (
                  <></>
                ) : (
                  <StudyComp
                    message={async (data: any) => {
                      const msgRet = await pyMessage(
                        runningStudyId,
                        runningStateId,
                        data,
                      );
                      if (!msgRet.ok) {
                        throw new Error(
                          msgRet.error + "\n\n" + (msgRet.stack ?? ""),
                        );
                      }
                      return msgRet.data;
                    }}
                    onMessage={(callback: (data: any) => any) => {
                      onGlobalMessage(runningStudyId, runningStateId, callback);
                    }}
                  />
                )}
              </div>
            ) : (
              <div style={{ overflow: "auto", height: "100%", padding: 12 }}>
                {allStudies.length === 0 ? (
                  <div className="text-muted">No studies found.</div>
                ) : (
                  <>
                    <div className="text-muted mb-2">
                      Select a study (descriptions shown when inactive):
                    </div>
                    <StudyTreeView
                      nodes={studyTree}
                      selectedStudyId={selectedStudyId}
                      showRootOption={false}
                      onSelectStudy={(id) => void setStudyAndEndPrevious(id)}
                    />
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Study selector modal */}
      <Modal
        show={showStudyModal}
        title={
          <div className="d-flex align-items-center gap-2">
            <ListTree size={18} />
            <span>Select Study</span>
          </div>
        }
        onClose={() => setShowStudyModal(false)}
        size="lg"
        footer={
          <button
            className="btn btn-outline-secondary"
            onClick={() => setShowStudyModal(false)}
          >
            Close
          </button>
        }
      >
        <StudyTreeView
          nodes={studyTree}
          selectedStudyId={selectedStudyId}
          showRootOption={true}
          onSelectStudy={(id) => {
            void setStudyAndEndPrevious(id);
            setShowStudyModal(false);
          }}
        />
      </Modal>

      {/* Args modal */}
      <Modal
        show={showArgsModal}
        title={
          <div className="d-flex align-items-center gap-2">
            <FilePlay size={18} />
            <span>Start Study</span>
          </div>
        }
        onClose={() => setShowArgsModal(false)}
        size="lg"
        footer={
          <>
            <button
              className="btn btn-outline-secondary"
              onClick={() => setShowArgsModal(false)}
            >
              Cancel
            </button>
            <button
              className="btn btn-primary d-flex align-items-center gap-2"
              onClick={() => void onRunWithArgs()}
            >
              <Play size={16} />
              Run
            </button>
          </>
        }
      >
        {!selectedStudyId ? (
          <div className="text-muted">No study selected.</div>
        ) : (
          <>
            <div className="mb-2 text-muted">
              Study: <span className="fw-semibold">{selectedStudyName}</span>
            </div>

            {Object.keys(selectedStudyArgsSchema).length === 0 ? (
              <div className="text-muted">No args.</div>
            ) : (
              <div className="row g-2">
                {Object.entries(selectedStudyArgsSchema).map(([k, spec]) => (
                  <div className="col-6" key={k}>
                    <label className="form-label mb-1">{k}</label>

                    {spec.type === "dropdown" ? (
                      <select
                        className="form-select"
                        value={String(argsDraft[k] ?? spec.defaultValue)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setArgsDraft((prev) => {
                            const next = { ...prev, [k]: v };
                            // args edits should not push history
                            if (selectedStudyId)
                              writeUrlReplace(selectedStudyId, next);
                            return next;
                          });
                        }}
                      >
                        {spec.values.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <input
                        className="form-control"
                        type={spec.type === "string" ? "text" : "number"}
                        step={spec.type === "float" ? "any" : "1"}
                        value={String(argsDraft[k] ?? spec.defaultValue)}
                        onChange={(e) => {
                          const v: string = e.target.value;
                          setArgsDraft((prev) => {
                            const next = { ...prev, [k]: v };
                            if (selectedStudyId)
                              writeUrlReplace(selectedStudyId, next);
                            return next;
                          });
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>

      {/* Error modal */}
      <Modal
        show={showErrorModal}
        title={
          <div className="d-flex align-items-center gap-2">
            <Square size={18} />
            <span>Error</span>
          </div>
        }
        onClose={() => setShowErrorModal(false)}
        size="lg"
        footer={
          <button
            className="btn btn-primary"
            onClick={() => setShowErrorModal(false)}
          >
            OK
          </button>
        }
      >
        <pre className="mb-0" style={{ whiteSpace: "pre-wrap" }}>
          {errorModalText}
        </pre>
      </Modal>
    </div>
  );
}
