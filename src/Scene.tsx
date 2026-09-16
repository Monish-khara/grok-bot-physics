import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { button, useControls } from "leva";
import { botSdf, buildBotEyes, getBotGeometries, type BotGeometry, type Quality } from "./geometry";
import { Figure } from "./Figure";
import { Canvas2DRenderer } from "./canvas2d";
import { TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors } from "./Status";
import { fitSphere, sphereOutline, type Sphere } from "./sphereShape";
import { boundingRadius } from "./halfShell";
import {
  abovePlane,
  bowlEyeShift,
  buildBowl,
  clipEyes,
  cutPlane,
  frontLipAt,
  pickCast,
  randomSeed,
  settle,
  type CastMember,
  type CutPlane,
} from "./bowl";

/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
const CAMERA_Y = VIEW_HEIGHT / 2;
/** Clearance between the Sphere and the viewport edge, world units. */
const SPHERE_MARGIN = 0.45;
/** Light grey Sphere on a dark grey field, as on the other branches. */
const SPHERE_COLOR = "#d9d9d9";
const OUTSIDE_COLOR = "#4a4a4a";
/** The bowl's default token colour. */
const SHELL_COLOR = TOKENS.blue;
/** The bowl's width as a fraction of the Sphere's interior width. */
const BOWL_WIDTH = 0.85;
/** The bowl is always the round bot. */
const BOWL_SHAPE = "blob";

/** Relative luminance (sRGB) of a hex colour, for picking a readable HUD text colour. */
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
/** `?seed=` fixes the cast; otherwise a fresh one each load. */
const initialSeed = () => {
  const v = Number(QUERY.get("seed"));
  return QUERY.has("seed") && Number.isFinite(v) ? Math.floor(v) : randomSeed();
};

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
 * WebGL stage. Every frame the scene is drawn into a render target cleared to
 * the Sphere's interior colour; the screen is then cleared to the outside
 * colour and the target is drawn through a mesh in the Sphere's shape,
 * textured in screen space — which clips anything reaching past the
 * interior (a bowl rim raised by the sliders) to the Sphere.
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
   * and scene — lands in the drawing buffer, with MSAA at its edge.
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
 * Snapshot: the Sphere with the scene in it as a PNG cropped to the shape's
 * bounding box at native pixel size. By default everything outside the
 * truncated circle is transparent; `includeOutside` keeps the outside colour
 * instead. The HUD, renderer label and Leva panel are DOM, never in it.
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
  includeOutside,
}: {
  sphere: Sphere;
  captureRef: React.RefObject<(() => void) | null>;
  drawRef: React.RefObject<DrawFrame | null>;
  includeOutside: boolean;
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
        if (includeOutside) {
          ctx.drawImage(source, -left, -top);
        } else {
          const frame = c2d.snapshot(scene, camera);
          if (!frame) return;
          ctx.drawImage(frame, -left, -top);
        }
      } else if (drawRef.current) {
        drawRef.current(!includeOutside);
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
        const w = window as unknown as { __grokLastSnapshot?: { name: string; size: number; width: number; height: number; includeOutside: boolean } };
        w.__grokLastSnapshot = { name, size: blob.size, width: out.width, height: out.height, includeOutside };
        // Some embedded browsers (Electron without a download handler) drop
        // anchor downloads silently; there the PNG opens in a new tab to save from.
        if (!("download" in HTMLAnchorElement.prototype)) {
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
  }, [gl, scene, camera, sphere, captureRef, drawRef, includeOutside]);
  return null;
}

// ── The bowl and its cast ───────────────────────────────────────────────────

type BowlSettings = {
  shellColor: string;
  /** Degrees the cut plane tilts toward the camera. */
  cutAngle: number;
  /** Height of the cut on the body's axis, fraction of the body's height. */
  cutHeight: number;
  /** Wall, fraction of the bowl's radius. */
  thickness: number;
  /** Inner bot bounding radius as a fraction of the bowl's radius (slot scale on top). */
  innerSize: number;
  seed: number;
};

type Placed = {
  member: CastMember;
  bot: BotGeometry;
  /** Mesh scale: world units per geometry unit. */
  scale: number;
  /** Position in bowl body units. */
  position: THREE.Vector3;
  rotation: THREE.Euler;
  rests: boolean;
  /** Bowl body units: the bot's top on screen and the rim's front lip at its x. */
  top: number;
  lip: number | null;
  /** Largest sdf of a sampled vertex against the cavity wall (≤ 0 means nothing pokes through). */
  poke: number;
};

/** The bowl in world units plus the placed cast. */
type Build = {
  bowl: BotGeometry;
  plane: CutPlane;
  eyeShift: number;
  /** World radius of the bowl body. */
  radius: number;
  centre: THREE.Vector3;
  /** Mesh scale for the bowl geometry. */
  bowlScale: number;
  wall: number;
  cast: Placed[];
};

const bowlSdf = botSdf(BOWL_SHAPE);

function buildScene(bots: BotGeometry[], quality: Quality, sphere: Sphere, s: BowlSettings): Build {
  const blob = bots.find((b) => b.shape.id === BOWL_SHAPE)!;
  const plane = cutPlane(s.cutAngle, s.cutHeight);
  const bowl = buildBowl(blob, bowlSdf, s.thickness, s.shellColor, quality, plane);
  const eyeShift = bowlEyeShift(plane, BOWL_SHAPE);
  const eyes = buildBotEyes(BOWL_SHAPE, quality, { shiftY: eyeShift });
  bowl.eyes = clipEyes(eyes.eyes, plane, blob.scale);
  bowl.eyeNormals = eyes.eyeNormals;

  const rGeom = boundingRadius(blob.geometry);
  const radius = BOWL_WIDTH * sphere.r;
  const centre = new THREE.Vector3(sphere.cx, sphere.chordY + radius, 0);
  const bowlScale = radius / rGeom;
  // The blob is the unit sphere: body units are radii, and the wall in body units is the thickness itself.
  const wall = s.thickness * (rGeom / blob.scale);

  const cast = pickCast(s.seed, s.shellColor).map((member) => {
    const bot = bots.find((b) => b.shape.id === member.shape)!;
    const rBot = boundingRadius(bot.geometry);
    const scale = (s.innerSize * member.slot.scale * radius) / rBot;
    const rotation = new THREE.Euler(0, (member.yaw * Math.PI) / 180, (member.lean * Math.PI) / 180, "YXZ");
    const m = new THREE.Matrix4().makeRotationFromEuler(rotation);
    const dropped = settle(bot.hullPoints, scale / radius, m, member.slot, bowlSdf, wall);
    const position = new THREE.Vector3(member.slot.x, dropped.y, member.slot.z);
    // Screen top and wall clearance of the posed bot, for the checks.
    const v = new THREE.Vector3();
    const pos = bot.geometry.attributes.position as THREE.BufferAttribute;
    const stride = Math.max(1, Math.floor(pos.count / 1500));
    let top = -Infinity, poke = -Infinity;
    for (let i = 0; i < pos.count; i += stride) {
      v.fromBufferAttribute(pos, i).multiplyScalar(scale / radius).applyMatrix4(m).add(position);
      if (v.y > top) top = v.y;
      const d = bowlSdf(v.x, v.y, v.z) + wall;
      if (d > poke) poke = d;
    }
    return { member, bot, scale, position, rotation, rests: dropped.rests, top, lip: frontLipAt(plane, member.slot.x), poke };
  });
  return { bowl, plane, eyeShift, radius, centre, bowlScale, wall, cast };
}

/** The bowl standing on the Sphere floor with the four bots settled in it. Nothing moves. */
function Bowl({ build }: { build: Build }) {
  const still = useMemo(() => new THREE.Vector3(), []);
  return (
    <group position={build.centre}>
      <Figure bot={build.bowl} color={TOKENS.blue} scale={build.bowlScale} blur={0} velocity={still} vertexColors perTriangle />
      {build.cast.map((p) => (
        <group key={p.member.slot.x + "/" + p.member.slot.z} position={p.position.clone().multiplyScalar(build.radius)} rotation={p.rotation}>
          <Figure bot={p.bot} color={p.member.color} scale={p.scale} blur={0} velocity={still} />
        </group>
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
  renderer,
  drawRef,
  captureRef,
  snapshotOutside,
}: {
  look: Look;
  settings: BowlSettings;
  renderer: RendererKind;
  drawRef: React.RefObject<DrawFrame | null>;
  captureRef: React.RefObject<(() => void) | null>;
  snapshotOutside: boolean;
}) {
  const sphere = useSphere();
  const quality: Quality = renderer === "canvas2d" ? "low" : "high";
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const build = useMemo(() => buildScene(bots, quality, sphere, settings), [bots, quality, sphere, settings]);
  useEffect(
    () => () => {
      build.bowl.geometry.dispose();
      for (const e of build.bowl.eyes) e.dispose();
    },
    [build],
  );
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    // Test hooks for the headless checks.
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotBounds?: () => Sphere;
      __grokScene?: () => THREE.Scene;
      __grokBowl?: () => unknown;
    };
    w.__grokBotsReady = true;
    w.__grokBotBounds = () => sphere;
    w.__grokScene = () => scene;
    w.__grokBowl = () => ({
      seed: settings.seed,
      quality,
      shellColor: settings.shellColor,
      cutAngle: settings.cutAngle,
      cutHeight: settings.cutHeight,
      thickness: settings.thickness,
      innerSize: settings.innerSize,
      radius: build.radius,
      centre: build.centre.toArray(),
      plane: { n: build.plane.n.toArray(), d: build.plane.d },
      eyeShift: build.eyeShift,
      frontLip: frontLipAt(build.plane, 0),
      backRim: build.plane.d * build.plane.n.y + build.plane.n.z * Math.sqrt(Math.max(0, 1 - build.plane.d * build.plane.d)),
      eyesAbovePlane: build.bowl.eyes.map((g) => {
        const p = g.attributes.position as THREE.BufferAttribute;
        let m = -Infinity;
        for (let i = 0; i < p.count; i++) m = Math.max(m, abovePlane(build.plane, p.getX(i) / build.bowl.scale, p.getY(i) / build.bowl.scale, p.getZ(i) / build.bowl.scale));
        return m;
      }),
      triangles: (build.bowl.geometry.getIndex()?.count ?? build.bowl.geometry.attributes.position.count) / 3,
      cast: build.cast.map((p) => ({
        shape: p.member.shape,
        hue: p.member.hue,
        color: p.member.color,
        slot: p.member.slot,
        yaw: p.member.yaw,
        lean: p.member.lean,
        position: p.position.toArray(),
        world: p.position.clone().multiplyScalar(build.radius).add(build.centre).toArray(),
        scale: p.scale,
        rests: p.rests,
        top: p.top,
        lip: p.lip,
        peek: p.lip === null ? null : p.top - p.lip,
        poke: p.poke,
      })),
    });
  }, [sphere, scene, settings, build, quality]);

  return (
    <>
      <CameraRig />
      <Snapshot sphere={sphere} captureRef={captureRef} drawRef={drawRef} includeOutside={snapshotOutside} />
      {renderer === "webgl" ? (
        <WebGLStage sphere={sphere} inside={look.inside} outside={look.outside} drawRef={drawRef} />
      ) : (
        <Canvas2DStage sphere={sphere} inside={look.inside} outside={look.outside} />
      )}
      <Bowl build={build} />
    </>
  );
}

export function Scene() {
  const webgl = useMemo(detectWebGL, []);
  const renderer = useMemo(() => pickRenderer(webgl.ok), [webgl.ok]);
  const globalError = useGlobalErrors();
  const captureRef = useRef<(() => void) | null>(null);
  const drawRef = useRef<DrawFrame | null>(null);

  const [controls, set] = useControls(() => ({
    shellColor: { value: SHELL_COLOR, label: "shell colour" },
    cutAngle: { value: 30, min: 0, max: 45, step: 1, label: "cut angle (°)" },
    cutHeight: { value: 0.62, min: 0.45, max: 0.8, step: 0.01, label: "cut height" },
    // Below ~0.045 the eye inlays (set 0.04 R into the body) would show through the inside wall.
    thickness: { value: 0.06, min: 0.045, max: 0.15, step: 0.005 },
    innerSize: { value: 0.32, min: 0.15, max: 0.5, step: 0.01, label: "inner size" },
    seed: { value: initialSeed(), step: 1 },
    Respawn: button(() => set({ seed: randomSeed() })),
    sphere: { value: SPHERE_COLOR, label: "sphere" },
    outside: { value: OUTSIDE_COLOR, label: "outside" },
    Snapshot: button(() => captureRef.current?.()),
    snapshotOutside: { value: false, label: "snapshot include outside" },
  }));

  const look: Look = { inside: controls.sphere as string, outside: controls.outside as string };
  const seed = Math.floor(controls.seed);
  const settings = useMemo<BowlSettings>(
    () => ({
      shellColor: controls.shellColor as string,
      cutAngle: controls.cutAngle,
      cutHeight: controls.cutHeight,
      thickness: controls.thickness,
      innerSize: controls.innerSize,
      seed,
    }),
    [controls.shellColor, controls.cutAngle, controls.cutHeight, controls.thickness, controls.innerSize, seed],
  );

  // Keep `?seed=` in the address bar so the current cast can be shared.
  useEffect(() => {
    const url = new URL(location.href);
    if (url.searchParams.get("seed") === String(seed)) return;
    url.searchParams.set("seed", String(seed));
    history.replaceState(null, "", url);
  }, [seed]);

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
          renderer={renderer}
          drawRef={drawRef}
          captureRef={captureRef}
          snapshotOutside={controls.snapshotOutside}
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
