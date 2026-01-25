import React, { useMemo, useState, useState as useStateReact } from "react";
import * as Babel from "@babel/standalone";

import { Button as RBButton, Card, Alert } from "react-bootstrap";
import { Canvas } from "@react-three/fiber";

function compileTsx(tsx: string): string {
  const { code } = Babel.transform(tsx, {
    filename: "UserCode.tsx",
    presets: ["typescript", ["react", { runtime: "classic" }]],
    plugins: ["transform-modules-commonjs"],
    sourceMaps: "inline",
  });
  if (!code) throw new Error("Babel produced no output.");
  return code;
}

type Scope = {
  React: typeof React;
  useState: typeof useStateReact;
  RB: {
    Button: typeof RBButton;
    Card: typeof Card;
    Alert: typeof Alert;
  };
};

function evaluateToComponent(
  compiledJs: string,
  scope: Scope,
): React.ComponentType<any> {
  if (/\bimport\b/.test(compiledJs)) {
    throw new Error("Imports are not supported.");
  }

  const wrapped = `
    "use strict";
    const exports = {};
    const module = { exports };

    const React = scope.React;
    const useState = scope.useState;
    const RB = scope.RB;

    ${compiledJs}

    return module.exports.default || exports.default;
  `;

  const fn = new Function("scope", wrapped);
  const Component = fn(scope);

  if (typeof Component !== "function") {
    throw new Error("Default export must be a React component.");
  }
  return Component;
}

const DEFAULT_TSX = `export default function Demo() {
  const [count, setCount] = useState(0);

  return (
    <RB.Card>
      <RB.Card.Body>
        <RB.Card.Title>Manual Compile</RB.Card.Title>
        <RB.Alert variant="success">
          Compiled only when you click Run
        </RB.Alert>

        <RB.Button onClick={() => setCount(c => c + 1)}>
          Count: {count}
        </RB.Button>
      </RB.Card.Body>
    </RB.Card>
  );
}
`;

export default function BabelPage() {
  const [pendingSrc, setPendingSrc] = useState(DEFAULT_TSX);
  const [activeSrc, setActiveSrc] = useState(DEFAULT_TSX);

  const [error, setError] = useState<string | null>(null);
  const [Component, setComponent] = useState<React.ComponentType<any> | null>(
    null,
  );
  const [compiled, setCompiled] = useState("");

  const scope: Scope = useMemo(
    () => ({
      React,
      useState: useStateReact,
      RB: { Button: RBButton, Card, Alert },
    }),
    [],
  );

  const run = () => {
    try {
      const js = compileTsx(activeSrc);
      const C = evaluateToComponent(js, scope);
      setCompiled(js);
      setComponent(() => C); // important: store component type, not instance
      setError(null);
    } catch (e: any) {
      setError(e?.message ?? String(e));
    }
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
      <div>
        <h2>TSX Input</h2>
        <textarea
          value={pendingSrc}
          onChange={(e) => setPendingSrc(e.target.value)}
          style={{ width: "100%", height: 360, fontFamily: "monospace" }}
          spellCheck={false}
        />

        <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
          <RBButton onClick={() => setActiveSrc(pendingSrc)}>Apply</RBButton>
          <RBButton variant="success" onClick={run}>
            Run / Compile
          </RBButton>
        </div>

        <details style={{ marginTop: 8 }}>
          <summary>Show compiled JS</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{compiled}</pre>
        </details>
      </div>

      <div>
        <h2>Preview</h2>
        <div style={{ minHeight: 360, padding: 12, background: "#fafafa" }}>
          {error ? (
            <pre style={{ color: "crimson", whiteSpace: "pre-wrap" }}>
              {error}
            </pre>
          ) : Component ? (
            <Component />
          ) : (
            <em>Click “Run / Compile” to render</em>
          )}
        </div>
      </div>

      <Canvas camera={{ position: [3, 3, 3], fov: 60 }}>
        <ambientLight intensity={0.4} />
        <directionalLight position={[5, 5, 5]} intensity={1} />

        <mesh>
          <boxGeometry />
          <meshStandardMaterial color="orange" />
        </mesh>
      </Canvas>
    </div>
  );
}
