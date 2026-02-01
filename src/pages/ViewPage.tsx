import { H5WasmBufferProvider } from "@h5web/h5wasm";
import { App } from "@h5web/app";

import "@h5web/app/styles.css";
import { usePyodideH5 } from "../contexts/PyodideH5Context";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { Spinner } from "react-bootstrap";

const ViewPage = () => {
  const nav = useNavigate();

  const { hasH5, fileName, fsReadBinary } = usePyodideH5();
  const [fileBuffer, setFileBuffer] = useState<Uint8Array | null>(null);

  useEffect(() => {
    if (!hasH5) {
      nav("/");
    }
  }, [hasH5]);

  useEffect(() => {
    let alive = true;
    if (!hasH5 || !fileName) {
      setFileBuffer(null);
      return;
    }
    (async () => {
      const res = await fsReadBinary(`/work/${fileName}`);
      if (!alive) return;
      setFileBuffer(res.ok ? res.data : null);
    })();
    return () => {
      alive = false;
    };
  }, [hasH5, fileName, fsReadBinary]);

  return (
    <div className="container-fluid py-3" style={{ height: "100vh" }}>
      <div className="d-flex align-items-center justify-content-between mb-2 px-2">
        <div>
          <div className="h5 mb-0">View</div>
          <div className="text-muted">{fileName ?? "(no file)"}</div>
        </div>

        <div className="d-flex gap-2">
          <button
            className="btn btn-outline-secondary d-flex align-items-center gap-2"
            title="Select study"
            onClick={() => nav("/analyze")}
          >
            <ArrowLeft size={16} />
            Back
          </button>
        </div>
      </div>

      <div className="px-2" style={{ height: "calc(100vh - 86px)" }}>
        <div className="border rounded h-100 d-flex flex-column">
          <div className="border-bottom px-3 py-2 d-flex align-items-center justify-content-between">
            <div className="text-muted">Viewer</div>
            <div className="text-muted small">
              This will not reflect changes in fs
            </div>
          </div>

          <div className="flex-grow-1" style={{ minHeight: 0 }}>
            {fileBuffer === null ? (
              <Spinner />
            ) : (
              <H5WasmBufferProvider
                buffer={fileBuffer}
                filename={fileName ?? ""}
              >
                <App />
              </H5WasmBufferProvider>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export { ViewPage };
