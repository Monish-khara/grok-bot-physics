import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { button, useControls } from "leva";
import { getBotGeometries, type BotGeometry, type Quality } from "./geometry";
import { Figure } from "./Figure";
import { buildShellBot } from "./shell";
import { Canvas2DRenderer } from "./canvas2d";
import { BOT_HUES, TOKENS, type TokenName } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors } from "./Status";
import { CHORD, fitSphere, sphereOutline, type Sphere } from "./sphereShape";

/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
const CAMERA_Y = VIEW_HEIGHT / 2;
/** Clearance between the Sphere and the viewport edge, world units. */
const SPHERE_MARGIN = 0.45;
/** Light grey Sphere on a dark grey field, as on the other branches. */
const SPHERE_COLOR = "#d9d9d9";
const OUTSIDE_COLOR = "#4a4a4a";
/** Layer 0 takes this token (the reference dome is blue); the rest follow the ladder. */
const FIRST_HUE: TokenName = "blue";

/** Relative luminance (sRGB) of a hex colour, for picking a readable HUD text colour. */
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");

/**
 * Orthographic camera looking straight down -Z at the play plane. Zoom is set
 * so VIEW_HEIGHT world units always fill the viewport height, whatever the
 * aspect ratio.
 */
function CameraRig() {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.position.set(0, CAMERA_Y, 40);
    cam.rotation.set(0, 0, 0);
    cam.zoom = size.height / VIEW_HEIGHT;
    cam.updateProjectionMatrix();
  }, [camera, size.height]);
  return null;
}

/** The Sphere fitted to the current viewport; recomputed on resize. */
function useSphere(): Sphere {
  const { size } = useThree();
  return useMemo(() => {
    const halfWidth = (VIEW_HEIGHT / 2) * (size.width / size.height);
    return fitSphere(halfWidth, CAMERA_Y - VIEW_HEIGHT / 2, VIEW_HEIGHT, SPHERE_MARGIN);
  }, [size.width, size.height]);
}

/** Draws one WebGL frame on demand; see WebGLStage. */
type DrawFrame = (transparentOutside?: boolean) => void;

/** Hands the Sphere backdrop to the Canvas 2D renderer (no trail or blur on this branch). */
function Canvas2DStage({ sphere, inside, outside }: { sphere: Sphere; inside: string; outside: string }) {
  const gl = useThree((s) => s.gl) as unknown as Canvas2DRenderer;
  const outline = useMemo(() => sphereOutline(sphere), [sphere]);
  useEffect(() => {
    if (!gl.isCanvas2DRenderer) return;
    gl.stage = { outline, inside, outside };
    gl.effects.trail = 0;
    gl.effects.blur = 0;
  }, [gl, outline, inside, outside]);
  return null;
}

/**
 * WebGL stage. Every frame the bots are drawn into a render target cleared to
 * the Sphere's interior colour; the screen is then cleared to the outside
 * colour and the target is drawn through a mesh in the Sphere's shape,
 * textured in screen space — which is what clips the peeling layers to the
 * interior as they slide out.
 */
function WebGLStage({
  sphere,
  inside,
  outside,
  drawRef,
}: {
  sphere: Sphere;
  inside: string;
  outside: string;
  /** Receives a function that draws one frame on demand, for snapshots. */
  drawRef: React.RefObject<DrawFrame | null>;
}) {
  const { gl, scene, camera } = useThree();
  const fx = useMemo(() => {
    const frameMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
    const frameMesh = new THREE.Mesh(new THREE.BufferGeometry(), frameMaterial);
    frameMesh.frustumCulled = false;
    const frameScene = new THREE.Scene().add(frameMesh);
    return {
      frameMaterial,
      frameMesh,
      frameScene,
      size: new THREE.Vector2(),
      v: new THREE.Vector3(),
      target: null as THREE.WebGLRenderTarget | null,
    };
  }, []);
  useEffect(
    () => () => {
      fx.target?.dispose();
      fx.frameMesh.geometry.dispose();
      fx.frameMaterial.dispose();
    },
    [fx],
  );

  // The Sphere mesh in world units, triangulated once per fit; UVs are
  // refreshed each frame from the camera so they always match the target.
  useEffect(() => {
    const outline = sphereOutline(sphere);
    const shape = new THREE.Shape();
    for (let i = 0; i < outline.length; i += 2) {
      if (i === 0) shape.moveTo(outline[i], outline[i + 1]);
      else shape.lineTo(outline[i], outline[i + 1]);
    }
    shape.closePath();
    const geometry = new THREE.ShapeGeometry(shape);
    fx.frameMesh.geometry.dispose();
    fx.frameMesh.geometry = geometry;
  }, [fx, sphere]);

  /**
   * One frame. `transparentOutside` (snapshots) clears the screen to alpha 0
   * instead of the outside colour, so only the Sphere mesh — interior colour
   * and layers — lands in the drawing buffer, with MSAA at its edge.
   */
  const draw = (transparentOutside = false) => {
    const size = gl.getDrawingBufferSize(fx.size);
    let target = fx.target;
    if (!target || target.width !== size.x || target.height !== size.y) {
      target?.dispose();
      target = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: true, stencilBuffer: false });
      fx.target = target;
      fx.frameMaterial.map = target.texture;
      fx.frameMaterial.needsUpdate = true;
    }
    gl.setRenderTarget(target);
    gl.autoClear = false;
    gl.setClearColor(inside, 1);
    gl.clear(true, true, true);
    gl.render(scene, camera);

    // Screen: outside colour everywhere, the target inside the Sphere.
    const geometry = fx.frameMesh.geometry;
    const pos = geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!pos) {
      // First frame can run before the Sphere mesh effect has built the geometry.
      gl.setRenderTarget(null);
      return;
    }
    let uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    if (!uv || uv.count !== pos.count) {
      uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
      geometry.setAttribute("uv", uv);
    }
    for (let i = 0; i < pos.count; i++) {
      fx.v.set(pos.getX(i), pos.getY(i), 0).project(camera);
      uv.setXY(i, (fx.v.x + 1) / 2, (fx.v.y + 1) / 2);
    }
    uv.needsUpdate = true;
    gl.setRenderTarget(null);
    if (transparentOutside) gl.setClearColor(0x000000, 0);
    else gl.setClearColor(outside, 1);
    gl.clear(true, true, true);
    gl.render(fx.frameScene, camera);
  };
  useFrame(() => draw(), 1);
  useEffect(() => {
    drawRef.current = draw;
  });
  return null;
}

/** Local-time stamp for the snapshot filename: grok-bots-YYYYMMDD-HHMMSS.png */
function snapshotName(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `grok-bots-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

/**
 * Snapshot: just the Sphere — the interior colour with the layers inside it,
 * everything outside the truncated circle transparent — as a PNG cropped to
 * the shape's bounding box at native pixel size. The HUD, renderer label and
 * Leva panel are DOM, not canvas, so they are never in it.
 *
 * Canvas 2D: the renderer redraws the last frame into an offscreen canvas
 * with no outside fill (`snapshot()`). WebGL: a frame is drawn with the
 * screen cleared to alpha 0 so only the Sphere mesh lands in the drawing
 * buffer (MSAA edge), copied out, and the normal frame is drawn straight
 * back so nothing flashes.
 */
function Snapshot({
  sphere,
  captureRef,
  drawRef,
  openInTab,
}: {
  sphere: Sphere;
  captureRef: React.RefObject<(() => void) | null>;
  drawRef: React.RefObject<DrawFrame | null>;
  openInTab: boolean;
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    captureRef.current = () => {
      const source = gl.domElement;
      // Shape bounding box in device pixels (orthographic: corners project exactly).
      const v = new THREE.Vector3();
      const toPx = (x: number, y: number) => {
        v.set(x, y, 0).project(camera);
        return [((v.x + 1) / 2) * source.width, ((1 - v.y) / 2) * source.height] as const;
      };
      const [x0, y0] = toPx(sphere.cx - sphere.r, sphere.cy + sphere.r);
      const [x1, y1] = toPx(sphere.cx + sphere.r, sphere.chordY);
      const left = Math.max(0, Math.floor(x0));
      const top = Math.max(0, Math.floor(y0));
      const width = Math.min(source.width, Math.ceil(x1)) - left;
      const height = Math.min(source.height, Math.ceil(y1)) - top;
      if (width <= 0 || height <= 0) return;

      const out = document.createElement("canvas");
      out.width = width;
      out.height = height;
      const ctx = out.getContext("2d");
      if (!ctx) return;
      const c2d = gl as unknown as Canvas2DRenderer;
      if (c2d.isCanvas2DRenderer) {
        const frame = c2d.snapshot(scene, camera);
        if (!frame) return;
        ctx.drawImage(frame, -left, -top);
      } else if (drawRef.current) {
        drawRef.current(true);
        ctx.drawImage(source, -left, -top);
        drawRef.current();
      } else {
        gl.render(scene, camera);
        ctx.drawImage(source, -left, -top);
      }

      const name = snapshotName();
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const w = window as unknown as { __grokLastSnapshot?: { name: string; size: number; width: number; height: number } };
        w.__grokLastSnapshot = { name, size: blob.size, width: out.width, height: out.height };
        // Some embedded browsers (Electron without a download handler) drop
        // anchor downloads silently; the "snapshot in tab" toggle shows the
        // PNG in a new tab instead, to save from there.
        if (openInTab || !("download" in HTMLAnchorElement.prototype)) {
          window.open(url, "_blank");
          setTimeout(() => URL.revokeObjectURL(url), 60_000);
          return;
        }
        const a = document.createElement("a");
        a.href = url;
        a.download = name;
        a.rel = "noopener";
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
      }, "image/png");
    };
  }, [gl, scene, camera, sphere, captureRef, drawRef, openInTab]);
  return null;
}

// ── Nesting ─────────────────────────────────────────────────────────────────

type Align = "centre" | "floor";

type NestSettings = {
  /** Number of layers, 2..10; the last is the solid core. */
  layers: number;
  /** Scale of each layer relative to the one outside it. */
  shrink: number;
  /** Shell wall, as a fraction of that shell's outer radius. */
  thickness: number;
  /** Seconds a state is held before the next shell turns. */
  interval: number;
  /** Seconds one 180° turn takes. */
  turn: number;
  /** Stack pitched toward the camera, degrees, so rims show. */
  tilt: number;
  /** Shells share the dome's sphere centre, or each stands on the Sphere floor. */
  align: Align;
  /** Layer 0's width as a fraction of the Sphere's; 1 fills it. */
  botScale: number;
  play: boolean;
};

/** "open": shells turn away one by one from the outside in; "close": they turn back from the inside out. */
type Mode = "open" | "close";
type NestState = { layer: number; mode: Mode; t: number };

/** Pause between two shells turning back while closing, seconds. */
const CLOSE_GAP = 0.4;
/** Pointer travel (px) below which a press counts as a tap. */
const TAP_SLOP = 6;

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2);

/** Colours cycle through the token ladder from `FIRST_HUE`; nine hues, so neighbours never match. */
function layerColor(i: number): string {
  const start = BOT_HUES.indexOf(FIRST_HUE);
  return TOKENS[BOT_HUES[(start + i) % BOT_HUES.length]];
}

/**
 * Turn of every layer this frame, 0..1 (× 180°). Shells 0..n−2 turn; the core
 * (n−1) never does. Opening: shells before `layer` are turned, `layer` is
 * turning once its hold is over. Closing: shells after `layer` are back,
 * `layer` is turning back after a short gap, shells before it are still open.
 */
function turns(s: NestState, n: number, settings: NestSettings): number[] {
  const out = new Array<number>(n).fill(0);
  if (s.mode === "open") {
    for (let i = 0; i < Math.min(s.layer, n - 1); i++) out[i] = 1;
    if (s.layer < n - 1 && s.t > settings.interval) out[s.layer] = easeInOut(Math.min(1, (s.t - settings.interval) / settings.turn));
  } else {
    for (let i = 0; i < s.layer; i++) out[i] = 1;
    if (s.layer >= 0 && s.layer < n - 1) out[s.layer] = s.t > CLOSE_GAP ? 1 - easeInOut(Math.min(1, (s.t - CLOSE_GAP) / settings.turn)) : 1;
  }
  return out;
}

/** Advance the timeline by `dt` seconds. */
function step(s: NestState, dt: number, n: number, settings: NestSettings) {
  s.t += dt;
  if (s.mode === "open") {
    if (s.layer >= n - 1) {
      // Fully open (only the core still faces us): hold, then close from the inside out.
      if (s.t >= settings.interval) {
        s.mode = "close";
        s.layer = n - 2;
        s.t = 0;
      }
    } else if (s.t >= settings.interval + settings.turn) {
      s.layer++;
      s.t = 0;
    }
  } else if (s.t >= CLOSE_GAP + settings.turn) {
    s.layer--;
    s.t = 0;
    if (s.layer < 0) {
      s.mode = "open";
      s.layer = 0;
    }
  }
}

/**
 * The stack: layer 0 is the shell scaled to the Sphere (its silhouette the
 * Sphere's own), every layer inside it is the same shell scaled by `shrink`;
 * the last layer is the solid dome. All are drawn — you look into them —
 * either sharing the dome's sphere centre or each standing on the Sphere's
 * floor, the whole stack pitched by `tilt`. Each shell turns 180° about its
 * own vertical axis in the cascade, bringing its window round to the camera.
 */
function Nesting({
  dome,
  sphere,
  settings,
  generation,
  quality,
  stateRef,
}: {
  dome: BotGeometry;
  sphere: Sphere;
  settings: NestSettings;
  generation: number;
  quality: Quality;
  stateRef: React.RefObject<NestState>;
}) {
  const n = Math.max(2, Math.round(settings.layers));
  const groups = useRef<(THREE.Group | null)[]>([]);
  const stack = useRef<THREE.Group | null>(null);
  const still = useMemo(() => new THREE.Vector3(), []);
  const colors = useMemo(() => Array.from({ length: n }, (_, i) => layerColor(i)), [n]);

  // One shell geometry per colour (tones are baked as vertex colours); the core reuses the solid dome.
  const shells = useMemo(
    () => colors.slice(0, n - 1).map((c) => buildShellBot(dome, settings.thickness, c, quality)),
    [dome, settings.thickness, colors, n, quality],
  );
  useEffect(() => () => shells.forEach((s) => s.geometry.dispose()), [shells]);

  // Restart (button or layer-count change) closes everything.
  const resetFor = useRef<string | null>(null);

  /** World radius of layer `i`. */
  const radius = (i: number) => settings.botScale * sphere.r * Math.pow(settings.shrink, i);

  useFrame((_, rawDt) => {
    const s = stateRef.current;
    const key = `${generation}/${n}`;
    if (resetFor.current !== key) {
      resetFor.current = key;
      s.layer = 0;
      s.mode = "open";
      s.t = 0;
    }
    if (settings.play) step(s, Math.min(rawDt, 0.1), n, settings);
    const turn = turns(s, n, settings);

    // The stack pivots about layer 0's sphere centre, which sits so layer 0's base is on the floor.
    const r0 = radius(0);
    const st = stack.current;
    if (st) {
      st.position.set(sphere.cx, sphere.chordY - CHORD * r0, 0);
      st.rotation.set((settings.tilt * Math.PI) / 180, 0, 0);
    }
    for (let i = 0; i < n; i++) {
      const g = groups.current[i];
      if (!g) continue;
      const r = radius(i);
      const y = settings.align === "centre" ? 0 : CHORD * (r0 - r);
      g.position.set(0, y, 0);
      g.rotation.set(0, Math.PI * turn[i], 0);
      g.scale.setScalar(r / dome.halfExtents.x);
    }
  });

  // Tap: end the current hold now so the next shell turns.
  const press = useRef<{ x: number; y: number } | null>(null);
  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    press.current = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: ThreeEvent<PointerEvent>) => {
    const p = press.current;
    press.current = null;
    if (!p || Math.hypot(e.clientX - p.x, e.clientY - p.y) > TAP_SLOP) return;
    const s = stateRef.current;
    if (s.mode === "open" && s.t < settings.interval) s.t = settings.interval;
    else if (s.mode === "close" && s.t < CLOSE_GAP) s.t = CLOSE_GAP;
  };

  return (
    <group ref={stack}>
      {colors.map((c, i) => (
        <Figure
          key={i < n - 1 ? `shell-${i}` : `core-${i}`}
          ref={(g) => {
            groups.current[i] = g;
          }}
          bot={i < n - 1 ? shells[i] : dome}
          color={c}
          scale={1}
          blur={0}
          velocity={still}
          vertexColors={i < n - 1}
          perTriangle={i < n - 1}
          onPointerDown={onDown}
          onPointerUp={onUp}
        />
      ))}
    </group>
  );
}

// ── Scene ───────────────────────────────────────────────────────────────────

/** Which rasteriser to use: WebGL when the browser allows it, Canvas 2D otherwise. */
type RendererKind = "webgl" | "canvas2d";

function pickRenderer(webglOk: boolean): RendererKind {
  // `?renderer=canvas2d` / `?renderer=webgl` force a choice (testing).
  const forced = QUERY.get("renderer");
  if (forced === "canvas2d" || forced === "webgl") return forced;
  return webglOk ? "webgl" : "canvas2d";
}

type Look = { inside: string; outside: string };

/** Inner component so the Sphere fit (which needs the canvas size) can be shared. */
function Framed({
  look,
  settings,
  generation,
  renderer,
  drawRef,
  captureRef,
  snapshotInTab,
}: {
  look: Look;
  settings: NestSettings;
  generation: number;
  renderer: RendererKind;
  drawRef: React.RefObject<DrawFrame | null>;
  captureRef: React.RefObject<(() => void) | null>;
  snapshotInTab: boolean;
}) {
  const sphere = useSphere();
  const quality: Quality = renderer === "canvas2d" ? "low" : "high";
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const dome = useMemo(() => bots.find((b) => b.shape.id === "dome")!, [bots]);
  const state = useRef<NestState>({ layer: 0, mode: "open", t: 0 });
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    // Test hooks for the headless checks.
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotBounds?: () => Sphere;
      __grokScene?: () => THREE.Scene;
      __grokNesting?: () => NestState & { layers: number; turns: number[]; radius: number[] };
      __grokNestingSet?: (s: Partial<NestState>) => void;
    };
    w.__grokBotsReady = true;
    w.__grokBotBounds = () => sphere;
    w.__grokScene = () => scene;
    w.__grokNesting = () => {
      const s = state.current;
      const n = Math.max(2, Math.round(settings.layers));
      return {
        ...s,
        layers: n,
        turns: turns(s, n, settings),
        radius: Array.from({ length: n }, (_, i) => settings.botScale * sphere.r * Math.pow(settings.shrink, i)),
      };
    };
    w.__grokNestingSet = (s) => Object.assign(state.current, s);
  }, [sphere, scene, settings]);

  return (
    <>
      <CameraRig />
      <Snapshot sphere={sphere} captureRef={captureRef} drawRef={drawRef} openInTab={snapshotInTab} />
      {renderer === "webgl" ? (
        <WebGLStage sphere={sphere} inside={look.inside} outside={look.outside} drawRef={drawRef} />
      ) : (
        <Canvas2DStage sphere={sphere} inside={look.inside} outside={look.outside} />
      )}
      <Nesting dome={dome} sphere={sphere} settings={settings} generation={generation} quality={quality} stateRef={state} />
    </>
  );
}

export function Scene() {
  const [generation, setGeneration] = useState(0);
  const webgl = useMemo(detectWebGL, []);
  const renderer = useMemo(() => pickRenderer(webgl.ok), [webgl.ok]);
  const globalError = useGlobalErrors();
  const captureRef = useRef<(() => void) | null>(null);
  const drawRef = useRef<DrawFrame | null>(null);

  const controls = useControls({
    layers: { value: 6, min: 2, max: 10, step: 1 },
    shrink: { value: 0.82, min: 0.6, max: 0.95, step: 0.01 },
    thickness: { value: 0.06, min: 0.02, max: 0.2, step: 0.005 },
    interval: { value: 2.5, min: 0.2, max: 10, step: 0.1, label: "interval (s)" },
    turn: { value: 1.2, min: 0.2, max: 5, step: 0.1, label: "turn (s)" },
    tilt: { value: 10, min: 0, max: 25, step: 1, label: "tilt (°)" },
    align: { value: "centre" as Align, options: ["centre", "floor"] as Align[] },
    // `?play=0` starts paused (screenshots, headless checks).
    play: { value: QUERY.get("play") !== "0" },
    Restart: button(() => setGeneration((g) => g + 1)),
    botScale: { value: 1, min: 0.3, max: 1, step: 0.01, label: "bot scale" },
    sphere: { value: SPHERE_COLOR, label: "sphere" },
    outside: { value: OUTSIDE_COLOR, label: "outside" },
    Snapshot: button(() => captureRef.current?.()),
    snapshotTab: { value: false, label: "snapshot in tab" },
  });

  const look: Look = { inside: controls.sphere as string, outside: controls.outside as string };
  const settings = useMemo<NestSettings>(
    () => ({
      layers: controls.layers,
      shrink: controls.shrink,
      thickness: controls.thickness,
      interval: controls.interval,
      turn: controls.turn,
      tilt: controls.tilt,
      align: controls.align as Align,
      botScale: controls.botScale,
      play: controls.play,
    }),
    [
      controls.layers,
      controls.shrink,
      controls.thickness,
      controls.interval,
      controls.turn,
      controls.tilt,
      controls.align,
      controls.botScale,
      controls.play,
    ],
  );

  // Paint the page the outside colour so the canvas and page never mismatch,
  // and flip the HUD text light or dark to stay readable.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--stage-bg", look.outside);
    const dark = luminance(look.outside) < 0.4;
    root.setProperty("--hud-fg", dark ? "#f4f1ec" : "#2a2724");
    root.setProperty("--hud-muted", dark ? "#b8b2aa" : "#6c665f");
  }, [look.outside]);

  return (
    <>
      <Canvas
        flat
        orthographic
        dpr={[1, 2]}
        camera={{ position: [0, CAMERA_Y, 40], near: 0.1, far: 100 }}
        style={{ touchAction: "none" }}
        // Without WebGL, hand R3F a Canvas 2D rasteriser instead of a WebGLRenderer.
        gl={renderer === "canvas2d" ? ({ canvas }) => new Canvas2DRenderer(canvas as HTMLCanvasElement) : undefined}
      >
        <Framed
          look={look}
          settings={settings}
          generation={generation}
          renderer={renderer}
          drawRef={drawRef}
          captureRef={captureRef}
          snapshotInTab={controls.snapshotTab}
        />
      </Canvas>
      <div className="renderer-label" data-renderer={renderer}>
        {renderer === "webgl" ? "Renderer: WebGL" : `Renderer: Canvas 2D${webgl.ok ? "" : " (WebGL unavailable)"}`}
      </div>
      {globalError ? (
        <StatusOverlay
          status={{
            kind: "error",
            title: /webgl/i.test(globalError) ? "WebGL context creation failed" : "Runtime error",
            detail: globalError,
          }}
        />
      ) : null}
    </>
  );
}
