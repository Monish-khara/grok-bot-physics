import { Component, useEffect, useState, type ReactNode } from "react";

export type SceneStatus =
  | { kind: "loading"; message: string }
  | { kind: "error"; title: string; detail?: string };

export function StatusOverlay({ status }: { status: SceneStatus }) {
  return (
    <div className={`status status-${status.kind}`} role={status.kind === "error" ? "alert" : "status"}>
      {status.kind === "loading" ? (
        <p>{status.message}</p>
      ) : (
        <>
          <h2>{status.title}</h2>
          {status.detail && <pre>{status.detail}</pre>}
          <p className="status-hint">
            Try opening <code>{window.location.href}</code> in Chrome, Safari or Firefox with hardware
            acceleration enabled.
          </p>
          <pre className="status-diag">{diagnostics()}</pre>
        </>
      )}
    </div>
  );
}

/** Facts worth having in a screenshot of a failure. */
export function diagnostics(): string {
  const wasm = typeof WebAssembly === "object" && typeof WebAssembly.instantiate === "function";
  const gl = detectWebGL();
  return [
    `webgl: ${gl.ok ? `ok (${gl.renderer})` : "unavailable"}`,
    `webassembly: ${wasm ? "available" : "missing"}`,
    `viewport: ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`,
    `ua: ${navigator.userAgent}`,
  ].join("\n");
}

/** Probe for a WebGL context without touching the real canvas. */
export function detectWebGL(): { ok: true; renderer: string } | { ok: false; detail: string } {
  try {
    const c = document.createElement("canvas");
    const gl = (c.getContext("webgl2") ?? c.getContext("webgl")) as WebGLRenderingContext | null;
    if (!gl) return { ok: false, detail: "canvas.getContext('webgl2' | 'webgl') returned null — the browser has WebGL disabled or GPU access is blocked." };
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return { ok: true, renderer };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Load the Rapier WASM module up front so a failure is visible, not silent. */
export function useRapierReady(): { ready: boolean; error: string | null } {
  const [state, setState] = useState<{ ready: boolean; error: string | null }>({ ready: false, error: null });
  useEffect(() => {
    let alive = true;
    import("@dimforge/rapier3d-compat")
      .then((r) => r.init())
      .then(() => alive && setState({ ready: true, error: null }))
      .catch((e: unknown) => alive && setState({ ready: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

/** Surfaces async failures (e.g. three's WebGL setup rejects) that React boundaries never see. */
export function useGlobalErrors(): string | null {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason;
      setError(r instanceof Error ? r.message : String(r));
    };
    const onError = (e: ErrorEvent) => setError(e.message);
    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);
  return error;
}

type BoundaryProps = { children: ReactNode };
type BoundaryState = { error: Error | null };

export class SceneErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <StatusOverlay
          status={{ kind: "error", title: "The scene crashed", detail: `${this.state.error.name}: ${this.state.error.message}` }}
        />
      );
    }
    return this.props.children;
  }
}
