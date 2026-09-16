import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { button, useControls } from "leva";
import { botSdf, getBotGeometries, type BotGeometry, type Quality, type Sdf } from "./geometry";
import { Figure } from "./Figure";
import { Canvas2DRenderer } from "./canvas2d";
import { TOKENS, type TokenName } from "./data/tokens";
import type { ShapeId } from "./data/shapes";
import { StatusOverlay, detectWebGL, useGlobalErrors } from "./Status";
import { boundingRadius, buildHalfShells } from "./halfShell";

/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
/** Default page colour: near black, like the reference. */
const BACKGROUND = "#0b0b0b";
/** Bounding radius of the outer bot, world units. */
const OUTER_RADIUS = 1.6;
/** Where the assembly sits (the Leva panel covers the right edge). */
const CENTRE = new THREE.Vector3(-1.38, -0.15, 0);
/**
 * 3/4 view: the assembly (which faces +z) is turned so its axis runs lower-left
 * to upper-right and toward the camera. A little more across the axis than
 * the classic 35/25 so a front half's face (which points up the axis at the
 * next, larger, nearer piece) is not covered by it.
 */
const YAW_DEG = 42;
const PITCH_DEG = 28;
/** Wall of each shell as a fraction of that body's bounding radius. */
const THICKNESS = 0.06;
/** Gap between neighbouring pieces at full explode, as a fraction of the layer's radius. */
const GAP = 1.8;
/** Clearance kept between a body and the cavity it sits in (fraction of the fitted maximum). */
const FIT_MARGIN = 0.92;

/**
 * The four bots, outer to core, with their target sizes (bounding radius as
 * a fraction of the outer's). Sizes are then capped so every body sits
 * inside the cavity of the one around it — see `fitLayers`.
 */
const LAYERS: { shape: ShapeId; size: number; hue: TokenName }[] = [
  { shape: "blob", size: 1, hue: "blue" },
  { shape: "cloud", size: 0.68, hue: "green" },
  { shape: "tablet", size: 0.46, hue: "yellow" },
  { shape: "teardrop", size: 0.3, hue: "red" },
];

/** Relative luminance (sRGB) of a hex colour, for picking a readable HUD text colour. */
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
/** `?explode=0.5` presets the slider (screenshots, headless checks). */
const fromQuery = (name: string, fallback: number) => {
  const v = Number(QUERY.get(name));
  return QUERY.has(name) && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
};

const smoothstep = (p: number) => {
  const e = Math.min(1, Math.max(0, p));
  return e * e * (3 - 2 * e);
};

/** Orthographic camera straight down -Z; VIEW_HEIGHT world units fill the viewport height. */
function CameraRig() {
  const { camera, size } = useThree();
  useLayoutEffect(() => {
    const cam = camera as THREE.OrthographicCamera;
    cam.position.set(0, 0, 40);
    cam.rotation.set(0, 0, 0);
    cam.zoom = size.height / VIEW_HEIGHT;
    cam.updateProjectionMatrix();
  }, [camera, size.height]);
  return null;
}

/** Canvas 2D: no stage; the canvas stays transparent over the page colour. */
function Canvas2DStage() {
  const gl = useThree((s) => s.gl) as unknown as Canvas2DRenderer;
  useEffect(() => {
    if (!gl.isCanvas2DRenderer) return;
    gl.stage = null;
    gl.effects.trail = 0;
    gl.effects.blur = 0;
  }, [gl]);
  return null;
}

/** Local-time stamp for the snapshot filename: grok-bots-YYYYMMDD-HHMMSS.png */
function snapshotName(d = new Date()) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `grok-bots-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}

/**
 * Snapshot: the assembly as drawn, on transparent, cropped to the pieces'
 * projected bounds at native pixel size. Both renderers draw onto a
 * transparent canvas (the page colour is CSS behind it), so a plain
 * re-render is already the transparent image; the HUD and Leva panel are
 * DOM, never in it.
 */
function Snapshot({
  boundsRef,
  captureRef,
  openInTab,
}: {
  boundsRef: React.RefObject<() => THREE.Box3 | null>;
  captureRef: React.RefObject<(() => void) | null>;
  openInTab: boolean;
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    captureRef.current = () => {
      const box = boundsRef.current?.();
      if (!box || box.isEmpty()) return;
      const source = gl.domElement;
      const v = new THREE.Vector3();
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (let i = 0; i < 8; i++) {
        v.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).project(camera);
        const px = ((v.x + 1) / 2) * source.width, py = ((1 - v.y) / 2) * source.height;
        x0 = Math.min(x0, px); x1 = Math.max(x1, px);
        y0 = Math.min(y0, py); y1 = Math.max(y1, py);
      }
      const left = Math.max(0, Math.floor(x0) - 2);
      const top = Math.max(0, Math.floor(y0) - 2);
      const width = Math.min(source.width, Math.ceil(x1) + 2) - left;
      const height = Math.min(source.height, Math.ceil(y1) + 2) - top;
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
      } else {
        // Draw a frame and copy it before the compositor gets it.
        gl.render(scene, camera);
        ctx.drawImage(source, -left, -top);
      }

      const name = snapshotName();
      out.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const w = window as unknown as { __grokLastSnapshot?: { name: string; size: number; width: number; height: number } };
        w.__grokLastSnapshot = { name, size: blob.size, width: out.width, height: out.height };
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
  }, [gl, scene, camera, boundsRef, captureRef, openInTab]);
  return null;
}

// ── Pieces ──────────────────────────────────────────────────────────────────

type Fit = { layer: number; shape: ShapeId; target: number; maxFit: number; used: number };

type Piece = {
  /** Layer 0 is the outer bot, 3 the core. */
  layer: number;
  half: "front" | "back" | "core";
  bot: BotGeometry;
  color: string;
  /** Mesh scale: world radius over the geometry's own bounding radius. */
  scale: number;
  /** Assembled position along the axis is 0; this is the full-explode offset (world units). */
  offset: number;
};

/**
 * Largest mesh scale for the inner bot at which every one of its vertices
 * is at least the wall thickness inside the outer body — i.e. inside the
 * outer shell's cavity — found by bisection (bodies are star-shaped).
 */
function maxFitScale(inner: BotGeometry, outer: BotGeometry, outerScale: number, outerSdf: Sdf, outerWall: number, upTo: number): number {
  const pos = inner.geometry.attributes.position as THREE.BufferAttribute;
  const stride = Math.max(1, Math.floor(pos.count / 1500));
  const toOuterBody = 1 / (outerScale * outer.scale);
  const fits = (s: number) => {
    const k = s * toOuterBody;
    for (let i = 0; i < pos.count; i += stride) {
      if (outerSdf(pos.getX(i) * k, pos.getY(i) * k, pos.getZ(i) * k) > -outerWall) return false;
    }
    return true;
  };
  let lo = 0, hi = upTo;
  if (fits(hi)) return hi;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Sizes each layer (capped to fit its cavity), builds the half shells and the core, and lays out the explode offsets. */
function buildPieces(bots: BotGeometry[], quality: Quality): { pieces: Piece[]; fits: Fit[]; radii: number[] } {
  const byId = (id: ShapeId) => bots.find((b) => b.shape.id === id)!;
  const scales: number[] = [];
  const radii: number[] = [];
  const fits: Fit[] = [];
  const sdfs = LAYERS.map((l) => botSdf(l.shape));
  for (let i = 0; i < LAYERS.length; i++) {
    const bot = byId(LAYERS[i].shape);
    const rGeom = boundingRadius(bot.geometry);
    const target = (LAYERS[i].size * OUTER_RADIUS) / rGeom;
    let used = target;
    let maxFit = Infinity;
    if (i > 0) {
      const outer = byId(LAYERS[i - 1].shape);
      const outerWall = (THICKNESS * boundingRadius(outer.geometry)) / outer.scale;
      maxFit = maxFitScale(bot, outer, scales[i - 1], sdfs[i - 1], outerWall, target * 2);
      used = Math.min(target, FIT_MARGIN * maxFit);
    }
    scales.push(used);
    radii.push(used * rGeom);
    fits.push({
      layer: i,
      shape: LAYERS[i].shape,
      target: LAYERS[i].size,
      maxFit: (maxFit * rGeom) / OUTER_RADIUS,
      used: (used * rGeom) / OUTER_RADIUS,
    });
  }

  // Offsets: back L0, back L1, back L2, core, front L2, front L1, front L0 along the axis,
  // gaps proportional to the layer's radius so the stack reads evenly.
  const gap = (i: number) => GAP * radii[i];
  const cumulative = (i: number) => {
    let d = 0;
    for (let k = i; k < LAYERS.length - 1; k++) d += gap(k);
    return d;
  };
  const pieces: Piece[] = [];
  for (let i = 0; i < LAYERS.length - 1; i++) {
    const bot = byId(LAYERS[i].shape);
    const color = TOKENS[LAYERS[i].hue];
    const shells = buildHalfShells(bot, sdfs[i], THICKNESS, color, quality);
    pieces.push({ layer: i, half: "back", bot: shells.back, color, scale: scales[i], offset: -cumulative(i) });
    pieces.push({ layer: i, half: "front", bot: shells.front, color, scale: scales[i], offset: cumulative(i) });
  }
  const core = LAYERS.length - 1;
  pieces.push({ layer: core, half: "core", bot: byId(LAYERS[core].shape), color: TOKENS[LAYERS[core].hue], scale: scales[core], offset: 0 });
  return { pieces, fits, radii };
}

/**
 * The assembly: seven pieces on one axis (the bots' +z), the whole group
 * turned to the 3/4 view. `explode` slides each piece along the axis by its
 * full offset × smoothstep(explode).
 */
function Assembly({
  pieces,
  explode,
  groupsRef,
}: {
  pieces: Piece[];
  explode: number;
  groupsRef: React.RefObject<(THREE.Group | null)[]>;
}) {
  const still = useMemo(() => new THREE.Vector3(), []);
  const assembly = useRef<THREE.Group | null>(null);
  useFrame(() => {
    const a = assembly.current;
    if (a) {
      a.position.copy(CENTRE);
      a.rotation.set((-PITCH_DEG * Math.PI) / 180, (YAW_DEG * Math.PI) / 180, 0, "YXZ");
    }
    const e = smoothstep(explode);
    for (let i = 0; i < pieces.length; i++) {
      const g = groupsRef.current[i];
      if (!g) continue;
      g.position.set(0, 0, pieces[i].offset * e);
      g.scale.setScalar(pieces[i].scale);
    }
  });
  return (
    <group ref={assembly}>
      {pieces.map((p, i) => (
        <Figure
          key={`${p.layer}-${p.half}`}
          ref={(g) => {
            groupsRef.current[i] = g;
          }}
          bot={p.bot}
          color={p.color}
          scale={1}
          blur={0}
          velocity={still}
          vertexColors={p.half !== "core"}
          perTriangle
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

/** Inner component: builds the pieces once per renderer quality and exposes the test hooks. */
function Framed({
  explode,
  renderer,
  captureRef,
  snapshotInTab,
}: {
  explode: number;
  renderer: RendererKind;
  captureRef: React.RefObject<(() => void) | null>;
  snapshotInTab: boolean;
}) {
  const quality: Quality = renderer === "canvas2d" ? "sketch" : "high";
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const built = useMemo(() => buildPieces(bots, quality), [bots, quality]);
  useEffect(
    () => () => {
      for (const p of built.pieces) if (p.half !== "core") p.bot.geometry.dispose();
    },
    [built],
  );
  const groups = useRef<(THREE.Group | null)[]>([]);
  const scene = useThree((s) => s.scene);

  const bounds = useRef<() => THREE.Box3 | null>(() => null);
  useEffect(() => {
    bounds.current = () => {
      const box = new THREE.Box3();
      const tmp = new THREE.Box3();
      for (const g of groups.current) {
        if (!g) continue;
        g.updateWorldMatrix(true, true);
        g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh || !mesh.geometry.boundingBox) {
            if (mesh.isMesh) mesh.geometry.computeBoundingBox();
            if (!mesh.isMesh || !mesh.geometry.boundingBox) return;
          }
          tmp.copy(mesh.geometry.boundingBox!).applyMatrix4(mesh.matrixWorld);
          box.union(tmp);
        });
      }
      return box;
    };
  }, [built]);

  useEffect(() => {
    // Test hooks for the headless checks.
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokScene?: () => THREE.Scene;
      __grokExploded?: () => unknown;
    };
    w.__grokBotsReady = true;
    w.__grokScene = () => scene;
    w.__grokExploded = () => ({
      explode,
      eased: smoothstep(explode),
      quality,
      radii: built.radii,
      fits: built.fits,
      pieces: built.pieces.map((p, i) => {
        const g = groups.current[i];
        const world = g ? g.getWorldPosition(new THREE.Vector3()) : null;
        return {
          layer: p.layer,
          half: p.half,
          shape: p.bot.shape.id,
          offset: p.offset,
          z: p.offset * smoothstep(explode),
          triangles: (p.bot.geometry.getIndex()?.count ?? p.bot.geometry.attributes.position.count) / 3,
          world: world ? [world.x, world.y, world.z] : null,
        };
      }),
    });
  }, [scene, built, explode, quality]);

  return (
    <>
      <CameraRig />
      <Snapshot boundsRef={bounds} captureRef={captureRef} openInTab={snapshotInTab} />
      {renderer === "canvas2d" ? <Canvas2DStage /> : null}
      <Assembly pieces={built.pieces} explode={explode} groupsRef={groups} />
    </>
  );
}

export function Scene() {
  const webgl = useMemo(detectWebGL, []);
  const renderer = useMemo(() => pickRenderer(webgl.ok), [webgl.ok]);
  const globalError = useGlobalErrors();
  const captureRef = useRef<(() => void) | null>(null);

  const controls = useControls({
    explode: { value: fromQuery("explode", 0.6), min: 0, max: 1, step: 0.01 },
    background: { value: BACKGROUND },
    Snapshot: button(() => captureRef.current?.()),
    snapshotTab: { value: false, label: "snapshot in tab" },
  });

  // The canvas is transparent; the page carries the background colour, and
  // the HUD text flips light or dark to stay readable.
  const background = controls.background as string;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--stage-bg", background);
    const dark = luminance(background) < 0.4;
    root.setProperty("--hud-fg", dark ? "#f4f1ec" : "#2a2724");
    root.setProperty("--hud-muted", dark ? "#b8b2aa" : "#6c665f");
  }, [background]);

  return (
    <>
      <Canvas
        flat
        orthographic
        dpr={[1, 2]}
        camera={{ position: [0, 0, 40], near: 0.1, far: 100 }}
        style={{ touchAction: "none", background: "transparent" }}
        // Without WebGL, hand R3F a Canvas 2D rasteriser instead of a WebGLRenderer.
        gl={renderer === "canvas2d" ? ({ canvas }) => new Canvas2DRenderer(canvas as HTMLCanvasElement) : { alpha: true }}
      >
        <Framed explode={controls.explode} renderer={renderer} captureRef={captureRef} snapshotInTab={controls.snapshotTab} />
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
