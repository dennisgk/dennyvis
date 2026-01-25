import { useRef, useState } from "react";
import { useNavigate } from "react-router";
import { usePyodideH5 } from "../contexts/PyodideH5Context";

export function HomePage() {
  const nav = useNavigate();
  const { loadH5, fileName, hasH5 } = usePyodideH5();

  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function onPick(file: File | null) {
    if (!file) return;
    setBusy(true);
    setErr(null);

    const r = await loadH5(file);

    setBusy(false);

    if (!r.ok) {
      setErr(r.stack ? `${r.error}\n\n${r.stack}` : r.error);
      return;
    }

    // success
    setErr(null);
    nav("/analyze");
  }

  return (
    <div className="container py-4" style={{ maxWidth: 820 }}>
      <div className="d-flex align-items-center justify-content-between mb-3">
        <div>
          <div className="h4 mb-0">Pyodide H5 Studio</div>
          <div className="text-muted">
            Load an HDF5 file and analyze/edit python in the <code>/fs</code>{" "}
            group.
          </div>
        </div>
        <div className="text-end">
          <div className="text-muted small">Current file</div>
          <div className="fw-semibold">{fileName ?? "None"}</div>
        </div>
      </div>

      {err && (
        <div
          className="alert alert-danger"
          role="alert"
          style={{ whiteSpace: "pre-wrap" }}
        >
          {err}
        </div>
      )}

      <div className="card">
        <div className="card-body">
          <div className="d-flex align-items-center justify-content-between gap-2 flex-wrap">
            <div>
              <div className="fw-semibold mb-1">Select H5 file</div>
              <div className="text-muted small">
                Supported: <code>.h5</code>, <code>.hdf5</code>
              </div>
            </div>

            <div className="d-flex gap-2">
              <input
                ref={inputRef}
                type="file"
                accept=".h5,.hdf5,application/x-hdf5"
                className="d-none"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  void onPick(f);
                  // allow picking same file again
                  e.currentTarget.value = "";
                }}
                disabled={busy}
              />
              <button
                className="btn btn-primary"
                onClick={() => inputRef.current?.click()}
                disabled={busy}
              >
                {busy ? "Loading…" : "Choose file"}
              </button>

              {hasH5 && (
                <button
                  className="btn btn-outline-secondary"
                  onClick={() => nav("/analyze")}
                  disabled={busy}
                >
                  Go to Analyze
                </button>
              )}
            </div>
          </div>

          <hr />

          <div className="text-muted small">
            If the file fails to load, you’ll see the Python stack trace here.
          </div>
        </div>
      </div>
    </div>
  );
}
