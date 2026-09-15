import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { button, useControls } from "leva";
import { botSilhouette, getBotGeometries, type BotGeometry, type Quality } from "./geometry";
import { Figure } from "./Figure";
import { Canvas2DRenderer, type StageStroke } from "./canvas2d";
import { BOT_HUES, TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors } from "./Status";
import { fitSphere, sphereOutline, type Sphere } from "./sphereShape";
import { ClosedCurve, offsetCurve, ribbonGeometry, sampleField, transformLoop, type Loop } from "./racetrack";

/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
const CAMERA_Y = VIEW_HEIGHT / 2;
/** Clearance between the Sphere and the viewport edge, world units. */
const SPHERE_MARGIN = 0.45;
/** Reference image colours: light grey Sphere on a dark grey field, green cloud and track. */
const SPHERE_COLOR = "#d9d9d9";
const OUTSIDE_COLOR = "#4a4a4a";
const CLOUD_COLOR = "#2ecc5c";
/** The cloud's width as a fraction of the Sphere's width. */
const CLOUD_FRACTION = 0.4;
/** A racer's default size as a fraction of the cloud's width (`racer size`). */
const RACER_FRACTION = 0.12;
/** Depth of the track ribbons (WebGL): behind the racers, which sit at z = 0. */
const TRACK_Z = -1.5;
/** Render order: sphere fill (the target's clear) < strokes < cloud and racers. */
const STROKE_ORDER = -10;
const FIGURE_ORDER = 0;
/** Body-unit grid for the iso-line extraction: cells per axis over ±extent. */
const ISO_RES = 224;
const ISO_POINTS = 320;

/** Relative luminance (sRGB) of a hex colour, for picking a readable HUD text colour. */
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
/** `?trail=0.8&blur=1` preset the effect sliders (screenshots, headless checks). */
const fromQuery = (name: string, fallback: number, max: number) => {
  const v = Number(QUERY.get(name));
  return QUERY.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback;
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

/** Trail persistence at `trail = 1`, seconds (matches canvas2d.ts). */
const TRAIL_SECONDS = 2;

/** Draws one WebGL frame on demand (dt 0: no trail wash); see WebGLStage. */
type DrawFrame = (dt: number, transparentOutside?: boolean) => void;

/** Hands the Sphere backdrop and the effect strengths to the Canvas 2D renderer. */
function Canvas2DStage({
  sphere,
  inside,
  outside,
  strokes,
  trail,
  blur,
}: {
  sphere: Sphere;
  inside: string;
  outside: string;
  strokes: StageStroke[];
  trail: number;
  blur: number;
}) {
  const gl = useThree((s) => s.gl) as unknown as Canvas2DRenderer;
  const outline = useMemo(() => sphereOutline(sphere), [sphere]);
  useEffect(() => {
    if (!gl.isCanvas2DRenderer) return;
    gl.stage = { outline, inside, outside, strokes };
    gl.effects.trail = trail;
    gl.effects.blur = blur;
  }, [gl, outline, inside, outside, strokes, trail, blur]);
  return null;
}

/**
 * WebGL stage. Every frame the bots are drawn into a float render target
 * whose clear colour is the Sphere's interior; when `trail` is on, the target
 * is washed toward that colour instead of cleared, so ghosts persist (float
 * accumulation converges all the way, unlike an 8-bit alpha fade). The screen
 * is then cleared to the outside colour and the target is drawn through a
 * mesh in the Sphere's shape, textured in screen space — which is also what
 * clips bots, trails and blur ghosts to the interior.
 */
function WebGLStage({
  sphere,
  inside,
  outside,
  trail,
  drawRef,
}: {
  sphere: Sphere;
  inside: string;
  outside: string;
  trail: number;
  /** Receives a function that draws one frame on demand (dt 0: no wash), for snapshots. */
  drawRef: React.RefObject<DrawFrame | null>;
}) {
  const { gl, scene, camera } = useThree();
  const fx = useMemo(() => {
    const quad = new THREE.PlaneGeometry(2, 2);
    const quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fadeMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    // Wash the colour only; leave alpha at the opaque 1 the clear wrote, so
    // snapshots of trail frames stay opaque.
    fadeMaterial.blending = THREE.CustomBlending;
    fadeMaterial.blendSrc = THREE.SrcAlphaFactor;
    fadeMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    fadeMaterial.blendSrcAlpha = THREE.ZeroFactor;
    fadeMaterial.blendDstAlpha = THREE.OneFactor;
    const fadeScene = new THREE.Scene().add(new THREE.Mesh(quad, fadeMaterial));
    const frameMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
    const frameMesh = new THREE.Mesh(new THREE.BufferGeometry(), frameMaterial);
    frameMesh.frustumCulled = false;
    const frameScene = new THREE.Scene().add(frameMesh);
    return {
      quad,
      quadCamera,
      fadeMaterial,
      fadeScene,
      frameMaterial,
      frameMesh,
      frameScene,
      size: new THREE.Vector2(),
      v: new THREE.Vector3(),
      target: null as THREE.WebGLRenderTarget | null,
      fresh: true,
    };
  }, []);
  useEffect(
    () => () => {
      fx.target?.dispose();
      fx.quad.dispose();
      fx.frameMesh.geometry.dispose();
      fx.fadeMaterial.dispose();
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

  // (Re)start the accumulation whenever the trail is switched on.
  const active = trail > 0;
  useEffect(() => {
    fx.fresh = true;
  }, [fx, active]);

  /**
   * One frame. `transparentOutside` (snapshots) clears the screen to alpha 0
   * instead of the outside colour, so only the Sphere mesh — interior colour,
   * bots, trails, blur — lands in the drawing buffer, with MSAA at its edge.
   */
  const draw = (dt: number, transparentOutside = false) => {
    const size = gl.getDrawingBufferSize(fx.size);
    let target = fx.target;
    if (!target || target.width !== size.x || target.height !== size.y) {
      target?.dispose();
      // 32-bit float: a half-float wash can still stall one 8-bit level short
      // of a light background (ulp near 1.0 is 5e-4); 8-bit stalls several.
      const floatOk = gl.capabilities.isWebGL2 && gl.extensions.has("EXT_color_buffer_float");
      target = new THREE.WebGLRenderTarget(size.x, size.y, {
        type: floatOk ? THREE.FloatType : THREE.UnsignedByteType,
        depthBuffer: true,
        stencilBuffer: false,
      });
      fx.target = target;
      fx.frameMaterial.map = target.texture;
      fx.frameMaterial.needsUpdate = true;
      fx.fresh = true;
    }
    gl.setRenderTarget(target);
    gl.autoClear = false;
    if (!active || fx.fresh) {
      gl.setClearColor(inside, 1);
      gl.clear(true, true, true);
      fx.fresh = false;
    } else {
      // Wash toward the interior colour: a ghost is down to ~5% after TRAIL_SECONDS * trail.
      const tau = (TRAIL_SECONDS * trail) / 3;
      fx.fadeMaterial.color.set(inside);
      fx.fadeMaterial.opacity = 1 - Math.exp(-Math.min(dt, 0.1) / tau);
      gl.render(fx.fadeScene, fx.quadCamera);
      gl.clearDepth();
    }
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
  useFrame((_, dt) => draw(dt), 1);
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
 * Snapshot: just the Sphere — the interior colour with the bots, trails and
 * blur inside it, everything outside the truncated circle transparent — as
 * a PNG cropped to the shape's bounding box at native pixel size. The HUD,
 * renderer label and Leva panel are DOM, not canvas, so they are never in it.
 *
 * Canvas 2D: the renderer redraws the last frame into an offscreen canvas
 * with no outside fill (`snapshot()`), reusing the live trail history. WebGL:
 * a frame is drawn with the screen cleared to alpha 0 so only the Sphere
 * mesh lands in the drawing buffer (MSAA edge), copied out, and the normal
 * frame is drawn straight back so nothing flashes.
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
        drawRef.current(0, true);
        ctx.drawImage(source, -left, -top);
        drawRef.current(0);
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



// ── Track ───────────────────────────────────────────────────────────────────

type TrackSettings = {
  /** Inner stroke distance from the cloud silhouette, as a fraction of the cloud's width. */
  offset: number;
  /** Lane width (inner to outer stroke), same units. */
  width: number;
  /** Stroke width, same units. */
  stroke: number;
};

type Track = {
  cloud: BotGeometry;
  /** World units per cloud body unit, at the displayed size. */
  worldPerBody: number;
  /** Uniform scale the cloud Figure is drawn at. */
  cloudScale: number;
  cloudWidth: number;
  centre: THREE.Vector2;
  /** Offset curves in world units. */
  inner: Loop;
  outer: Loop;
  /** The two rails as arc-length curves: racers ride centred on these. */
  rails: [ClosedCurve, ClosedCurve];
  centreline: ClosedCurve;
  /** Distances from the silhouette, world units. */
  d1: number;
  d2: number;
  strokeWidth: number;
  /** The cloud's outline polygon in world units, for checks. */
  outline: Loop | null;
};

/**
 * Fit the cloud to the Sphere and derive the track from its silhouette SDF.
 * Everything is computed in cloud body units (so the iso-line grid is
 * sampled once, at build time) and mapped to world units at the end. The
 * SDF is the cloud's rest pose: breathing, wobble and drag never reach it,
 * so the track holds still while the cloud moves inside it.
 */
function useTrack(cloud: BotGeometry, sphere: Sphere, settings: TrackSettings): Track {
  const silhouette = useMemo(() => botSilhouette("cloud"), []);
  // Body-unit width of the cloud and a grid wide enough for the largest offset the sliders allow.
  const bodyHalfW = cloud.halfExtents.x / cloud.scale;
  const bodyHalfH = cloud.halfExtents.y / cloud.scale;
  const bodyWidth = 2 * bodyHalfW;
  const field = useMemo(() => {
    const extent = Math.max(bodyHalfW, bodyHalfH) + bodyWidth * 0.9 + 0.3;
    return sampleField(silhouette.sdf, extent, ISO_RES);
  }, [silhouette, bodyHalfW, bodyHalfH, bodyWidth]);

  return useMemo(() => {
    const cloudWidth = CLOUD_FRACTION * 2 * sphere.r;
    const cloudScale = cloudWidth / (2 * cloud.halfExtents.x);
    const worldPerBody = cloud.scale * cloudScale;
    // Centre the cloud in the Sphere's bounding box.
    const centre = new THREE.Vector2(sphere.cx, (sphere.chordY + sphere.cy + sphere.r) / 2);
    const d1b = settings.offset * bodyWidth;
    const d2b = d1b + settings.width * bodyWidth;
    const dcb = (d1b + d2b) / 2;
    const curve = (d: number) => {
      const loop = offsetCurve(field, silhouette.sdf, d, ISO_POINTS) ?? new Float32Array(0);
      return transformLoop(loop, worldPerBody, centre.x, centre.y);
    };
    const inner = curve(d1b);
    const outer = curve(d2b);
    const centreline = new ClosedCurve(curve(dcb));
    const outline = silhouette.outline
      ? transformLoop(Float32Array.from(silhouette.outline.flat()), worldPerBody, centre.x, centre.y)
      : null;
    return {
      cloud,
      worldPerBody,
      cloudScale,
      cloudWidth,
      centre,
      inner,
      outer,
      rails: [new ClosedCurve(inner), new ClosedCurve(outer)],
      centreline,
      d1: d1b * worldPerBody,
      d2: d2b * worldPerBody,
      strokeWidth: settings.stroke * bodyWidth * worldPerBody,
      outline,
    };
  }, [cloud, sphere, settings.offset, settings.width, settings.stroke, field, silhouette, bodyWidth]);
}

/**
 * WebGL: the two strokes as flat ribbons behind the racers. They draw first
 * (`renderOrder`) and never write depth, so a racer or the cloud always
 * paints over them whatever its depth extent; the Sphere fill is the render
 * target's clear colour, so it is under everything by construction.
 */
function TrackRibbons({ track, color }: { track: Track; color: string }) {
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false, depthWrite: false }), [color]);
  useEffect(() => () => material.dispose(), [material]);
  const geometries = useMemo(
    () => [ribbonGeometry(track.inner, track.strokeWidth, TRACK_Z), ribbonGeometry(track.outer, track.strokeWidth, TRACK_Z)],
    [track],
  );
  useEffect(() => () => geometries.forEach((g) => g.dispose()), [geometries]);
  return (
    <>
      {geometries.map((g, i) => (
        <mesh key={i} geometry={g} material={material} userData={{ ghost: true }} renderOrder={STROKE_ORDER} />
      ))}
    </>
  );
}

// ── Cloud ───────────────────────────────────────────────────────────────────

/** Pointer travel (px) below which a press counts as a tap, not a drag. */
const TAP_SLOP = 6;
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);
const qYaw = new THREE.Quaternion();
const qPitch = new THREE.Quaternion();
const qWobble = new THREE.Quaternion();
const ZERO = new THREE.Vector3();

type Drag = { id: number; x0: number; y0: number; moved: boolean; q0: THREE.Quaternion };

/** One breath (in and out), seconds. */
const BREATH_SECONDS = 3.6;
/** Squash-and-stretch amplitude at `breathe = 1`, as a fraction of the cloud's scale. */
const BREATH_SQUASH = 0.06;
/** Bob amplitude at `breathe = 1`, as a fraction of the cloud's width. */
const BREATH_BOB = 0.012;
/** Blink timing: closing plus opening, and the gap between blinks (min + random extra). */
const BLINK_SECONDS = 0.16;
const BLINK_GAP_MIN = 2.2;
const BLINK_GAP_RANDOM = 3.0;
/** Eye height while shut, as a fraction of open. */
const BLINK_SHUT = 0.08;

type Eye = { mesh: THREE.Mesh; centreY: number };

/**
 * The cloud: fixed at the centre, face to the camera, breathing — a looping
 * squash-and-stretch (x and y in anti-phase, area roughly conserved) with a
 * gentle bob, and periodic blinks. Drag turns it like a tile in the tool
 * (yaw with horizontal drag, pitch with vertical); a tap gives it a damped
 * squash-and-stretch wobble. Both layer on top of the breathing: the wobble
 * multiplies the breath's scale and the drag pose composes with the wobble's
 * roll, so neither fights it. The track is built from the rest pose and
 * never moves.
 */
function Cloud({
  track,
  color,
  dragSpin,
  blur,
  breathe,
  blink,
}: {
  track: Track;
  color: string;
  dragSpin: number;
  blur: number;
  /** Breathing amount, 0 (still) to 1. */
  breathe: number;
  blink: boolean;
}) {
  const group = useRef<THREE.Group | null>(null);
  const drag = useRef<Drag | null>(null);
  /** Rest pose (set by dragging) and the time since the last tap. */
  const pose = useRef(new THREE.Quaternion());
  const wobble = useRef(Infinity);
  /** Breathing clock (seconds), and the seconds until the next blink starts. */
  const clock = useRef(0);
  const nextBlink = useRef(BLINK_GAP_MIN);
  /** Seconds into the current blink, or Infinity between blinks. */
  const blinkT = useRef(Infinity);
  const eyes = useRef<Eye[] | null>(null);

  useFrame((_, rawDt) => {
    const g = group.current;
    if (!g) return;
    const dt = Math.min(rawDt, 0.1);
    clock.current += dt;
    const phase = (clock.current / BREATH_SECONDS) * Math.PI * 2;
    // A sine with a little second harmonic, so the inhale peaks sharper than the exhale.
    const breath = 0.85 * Math.sin(phase) + 0.15 * Math.sin(2 * phase);
    const squash = BREATH_SQUASH * breathe * breath;
    let sx = 1 + squash, sy = 1 - squash;
    const bob = BREATH_BOB * breathe * track.cloudWidth * Math.sin(phase - Math.PI / 4);
    g.position.set(track.centre.x, track.centre.y + bob, 0);

    wobble.current += dt;
    const t = wobble.current;
    if (t < 1.6) {
      const env = Math.exp(-3.2 * t);
      const sq = 0.14 * Math.sin(t * 22) * env;
      sx *= 1 + sq;
      sy *= 1 - sq;
      qWobble.setFromAxisAngle(Z_AXIS, 0.06 * Math.sin(t * 17) * env);
      g.quaternion.copy(qWobble).multiply(pose.current);
    } else {
      g.quaternion.copy(pose.current);
    }
    g.scale.set(track.cloudScale * sx, track.cloudScale * sy, track.cloudScale);

    // Blink: the eye meshes live in the body's frame, so scale each about
    // its own centre (shift by centre × (1 − s)) rather than the body origin.
    if (!eyes.current) {
      const found: Eye[] = [];
      g.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.userData.eyeNormal) return;
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        found.push({ mesh: m, centreY: m.geometry.boundingBox!.getCenter(new THREE.Vector3()).y });
      });
      eyes.current = found;
    }
    let lid = 1;
    if (blink) {
      if (blinkT.current === Infinity) {
        nextBlink.current -= dt;
        if (nextBlink.current <= 0) blinkT.current = 0;
      } else {
        blinkT.current += dt;
        if (blinkT.current >= BLINK_SECONDS) {
          blinkT.current = Infinity;
          nextBlink.current = BLINK_GAP_MIN + Math.random() * BLINK_GAP_RANDOM;
        } else {
          // Shut fast, open a touch slower: a raised sine over the blink.
          const u = blinkT.current / BLINK_SECONDS;
          const shut = Math.sin(Math.PI * u) ** 0.7;
          lid = 1 - (1 - BLINK_SHUT) * shut;
        }
      }
    } else if (blinkT.current !== Infinity) {
      blinkT.current = Infinity;
    }
    for (const eye of eyes.current) {
      eye.mesh.scale.y = lid;
      eye.mesh.position.y = eye.centreY * (1 - lid);
    }
  });

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, moved: false, q0: pose.current.clone() };
  };
  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < TAP_SLOP) return;
    d.moved = true;
    const k = (dragSpin * Math.PI) / 180;
    qYaw.setFromAxisAngle(Y_AXIS, dx * k);
    qPitch.setFromAxisAngle(X_AXIS, dy * k);
    pose.current.copy(qPitch).multiply(qYaw).multiply(d.q0);
  };
  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!d.moved) wobble.current = 0;
  };

  return (
    <Figure
      ref={group}
      bot={track.cloud}
      color={color}
      scale={1}
      blur={blur}
      velocity={ZERO}
      renderOrder={FIGURE_ORDER}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

// ── Racers ──────────────────────────────────────────────────────────────────

type RacerSettings = {
  count: number;
  /** Racer size as a fraction of the cloud's width. */
  size: number;
  speed: number;
  variance: number;
  clockwise: boolean;
  blur: number;
};

/** Seconds a tap boost lasts and how much faster it goes at its peak. */
const BOOST_SECONDS = 1.6;
const BOOST_GAIN = 1.4;

type RacerState = {
  /** Which rail this racer rides: 0 inner, 1 outer. */
  rail: 0 | 1;
  /** Arc length along that rail. */
  s: number;
  /** Per-racer speed multiplier, 1 ± variance. */
  factor: number;
  /** Seconds of boost remaining. */
  boost: number;
  /** Bob phase. */
  phase: number;
  velocity: THREE.Vector3;
  prev: THREE.Vector3;
};

/**
 * The nine other bots as kinematic racers riding the two rails, centred on
 * the strokes: even-numbered racers on the inner rail, odd on the outer, so
 * the field splits in half. Position = rail(s), heading from the tangent
 * (they lean into the travel and turn a little toward it), a light bob,
 * even starting gaps on each rail with the outer rail staggered by half a
 * gap. Speeds differ per racer so they overtake; a tap gives a short boost.
 */
function Racers({
  bots,
  track,
  colors,
  settings,
  generation,
  scale,
  bodiesRef,
}: {
  bots: BotGeometry[];
  track: Track;
  colors: string[];
  settings: RacerSettings;
  generation: number;
  scale: number;
  bodiesRef: React.RefObject<RacerState[]>;
}) {
  const groups = useRef<(THREE.Group | null)[]>([]);
  const n = Math.min(settings.count, bots.length);
  const live = useMemo(() => bots.slice(0, n), [bots, n]);

  // (Re)space the field evenly along each rail and re-roll the speed factors.
  const states = useMemo<RacerState[]>(() => {
    const perRail = [Math.ceil(n / 2), Math.floor(n / 2)];
    return live.map((_, i) => {
      const rail = (i % 2) as 0 | 1;
      const L = track.rails[rail].length;
      const k = Math.floor(i / 2);
      return {
        rail,
        s: (L * (k + rail * 0.5)) / Math.max(1, perRail[rail]),
        factor: 1 + (Math.random() * 2 - 1) * settings.variance,
        boost: 0,
        phase: Math.random() * Math.PI * 2,
        velocity: new THREE.Vector3(),
        prev: new THREE.Vector3(NaN, NaN, NaN),
      };
    });
    // Re-roll on respawn, count or variance change only; a slider nudge to
    // speed or the track must not reshuffle the field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live, n, settings.variance, generation]);
  useEffect(() => {
    bodiesRef.current = states;
  }, [states, bodiesRef]);

  const p = useMemo(() => new THREE.Vector2(), []);
  const tan = useMemo(() => new THREE.Vector2(), []);
  const euler = useMemo(() => new THREE.Euler(), []);
  useFrame((_, rawDt) => {
    // Cap the step so a stalled tab does not teleport the field; slow software GL runs slow-motion instead.
    const dt = Math.min(rawDt, 0.1);
    const dir = settings.clockwise ? -1 : 1;
    const size = settings.size * track.cloudWidth;
    for (let i = 0; i < states.length; i++) {
      const st = states[i];
      const g = groups.current[i];
      if (!g) continue;
      if (st.boost > 0) st.boost = Math.max(0, st.boost - dt);
      const boost = 1 + BOOST_GAIN * (st.boost / BOOST_SECONDS);
      st.s += dir * settings.speed * st.factor * boost * dt;
      const rail = track.rails[st.rail];
      rail.pointAt(st.s, p);
      rail.tangentAt(st.s, tan);
      // Bob: a slight hop per unit travelled, scaled to the racer, so it still reads as sitting on the rail.
      const bob = 0.04 * size * Math.abs(Math.sin(st.s * (2.2 / size) + st.phase));
      g.position.set(p.x, p.y + bob, 0);
      // Lean into the travel direction (tilt the top the way it is going) and
      // yaw slightly toward it, keeping the face mostly to the camera.
      const tx = tan.x * dir;
      euler.set(0, 0.45 * tx, -0.28 * tx, "YXZ");
      g.quaternion.setFromEuler(euler);
      if (Number.isNaN(st.prev.x)) st.prev.copy(g.position);
      st.velocity.copy(g.position).sub(st.prev).divideScalar(Math.max(dt, 1e-3));
      st.prev.copy(g.position);
    }
  });

  const press = useRef<{ i: number; x: number; y: number } | null>(null);
  const onDown = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    press.current = { i, x: e.clientX, y: e.clientY };
  };
  const onUp = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    const pr = press.current;
    press.current = null;
    if (!pr || pr.i !== i || Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > TAP_SLOP) return;
    states[i].boost = BOOST_SECONDS;
  };

  return (
    <>
      {live.map((bot, i) => (
        <Figure
          key={`${bot.shape.id}-${generation}`}
          ref={(g) => {
            groups.current[i] = g;
          }}
          bot={bot}
          color={colors[i]}
          scale={scale / Math.max(bot.halfExtents.x, bot.halfExtents.y)}
          blur={settings.blur}
          velocity={states[i].velocity}
          renderOrder={FIGURE_ORDER}
          onPointerDown={onDown(i)}
          onPointerUp={onUp(i)}
        />
      ))}
    </>
  );
}

// ── Scene ───────────────────────────────────────────────────────────────────

/** Which rasteriser to use: WebGL when the browser allows it, Canvas 2D otherwise. */
type RendererKind = "webgl" | "canvas2d";

function pickRenderer(webglOk: boolean): RendererKind {
  // `?renderer=canvas2d` / `?renderer=webgl` force a choice (testing).
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("renderer") : null;
  if (forced === "canvas2d" || forced === "webgl") return forced;
  return webglOk ? "webgl" : "canvas2d";
}

type Look = {
  inside: string;
  outside: string;
  cloud: string;
  stroke: string;
  trail: number;
  blur: number;
  dragSpin: number;
  breathe: number;
  blink: boolean;
};

/** Inner component so the Sphere fit (which needs the canvas size) can be shared. */
function Framed({
  look,
  trackSettings,
  racerSettings,
  generation,
  renderer,
  drawRef,
  captureRef,
  snapshotInTab,
}: {
  look: Look;
  trackSettings: TrackSettings;
  racerSettings: RacerSettings;
  generation: number;
  renderer: RendererKind;
  drawRef: React.RefObject<DrawFrame | null>;
  captureRef: React.RefObject<(() => void) | null>;
  snapshotInTab: boolean;
}) {
  const sphere = useSphere();
  const quality: Quality = renderer === "canvas2d" ? "low" : "high";
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const cloud = useMemo(() => bots.find((b) => b.shape.id === "cloud")!, [bots]);
  const racers = useMemo(() => bots.filter((b) => b.shape.id !== "cloud"), [bots]);
  const track = useTrack(cloud, sphere, trackSettings);
  const colors = useMemo(() => {
    const hues = [...BOT_HUES];
    for (let i = hues.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [hues[i], hues[j]] = [hues[j], hues[i]];
    }
    return racers.map((_, i) => TOKENS[hues[i % hues.length]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [racers, generation]);
  const racerStates = useRef<RacerState[]>([]);
  const racerScale = (racerSettings.size * track.cloudWidth) / 2;

  const strokes = useMemo<StageStroke[]>(
    () => [
      { points: track.inner, width: track.strokeWidth, color: look.stroke },
      { points: track.outer, width: track.strokeWidth, color: look.stroke },
    ],
    [track, look.stroke],
  );

  useEffect(() => {
    // Test hooks for the headless checks: where things are, in world units.
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotPositions?: () => { id: string; x: number; y: number; z: number }[];
      __grokBotBounds?: () => Sphere;
      __grokTrack?: () => unknown;
      __grokRacers?: () => { id: string; rail: number; s: number; factor: number; boost: number }[];
    };
    w.__grokBotsReady = true;
    w.__grokBotBounds = () => sphere;
    w.__grokBotPositions = () =>
      racerStates.current.map((st, i) => ({ id: racers[i].shape.id, x: st.prev.x, y: st.prev.y, z: st.prev.z }));
    w.__grokRacers = () =>
      racerStates.current.map((st, i) => ({ id: racers[i].shape.id, rail: st.rail, s: st.s, factor: st.factor, boost: st.boost }));
    w.__grokTrack = () => ({
      centre: { x: track.centre.x, y: track.centre.y },
      cloudWidth: track.cloudWidth,
      worldPerBody: track.worldPerBody,
      d1: track.d1,
      d2: track.d2,
      strokeWidth: track.strokeWidth,
      racerSize: racerSettings.size * track.cloudWidth,
      inner: Array.from(track.inner),
      outer: Array.from(track.outer),
      centreline: Array.from(track.centreline.pts),
      outline: track.outline ? Array.from(track.outline) : null,
    });
  }, [sphere, track, racers, racerSettings.size]);

  return (
    <>
      <CameraRig />
      <Snapshot sphere={sphere} captureRef={captureRef} drawRef={drawRef} openInTab={snapshotInTab} />
      {renderer === "webgl" ? (
        <>
          <WebGLStage sphere={sphere} inside={look.inside} outside={look.outside} trail={look.trail} drawRef={drawRef} />
          <TrackRibbons track={track} color={look.stroke} />
        </>
      ) : (
        <Canvas2DStage sphere={sphere} inside={look.inside} outside={look.outside} strokes={strokes} trail={look.trail} blur={look.blur} />
      )}
      <Cloud
        track={track}
        color={look.cloud}
        dragSpin={look.dragSpin}
        blur={renderer === "webgl" ? look.blur : 0}
        breathe={look.breathe}
        blink={look.blink}
      />
      <Racers
        bots={racers}
        track={track}
        colors={colors}
        settings={{ ...racerSettings, blur: renderer === "webgl" ? look.blur : 0 }}
        generation={generation}
        scale={racerScale}
        bodiesRef={racerStates}
      />
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

  const settings = useControls({
    cloudColor: { value: CLOUD_COLOR, label: "cloud colour" },
    sphere: { value: SPHERE_COLOR, label: "sphere" },
    outside: { value: OUTSIDE_COLOR, label: "outside" },
    breathe: { value: fromQuery("breathe", 0.5, 1), min: 0, max: 1, step: 0.01 },
    blink: { value: QUERY.get("blink") !== "0" },
    trackOffset: { value: 0.16, min: 0.03, max: 0.5, step: 0.005, label: "track offset" },
    trackWidth: { value: 0.035, min: 0.01, max: 0.4, step: 0.005, label: "track width" },
    strokeWidth: { value: 0.012, min: 0.003, max: 0.05, step: 0.001, label: "stroke width" },
    strokeColor: { value: CLOUD_COLOR, label: "stroke colour" },
    racers: { value: 9, min: 0, max: 9, step: 1 },
    racerSize: { value: RACER_FRACTION, min: 0.04, max: 0.3, step: 0.005, label: "racer size" },
    raceSpeed: { value: 2.4, min: 0, max: 12, step: 0.1, label: "race speed" },
    speedVariance: { value: 0.2, min: 0, max: 0.6, step: 0.01, label: "speed variance" },
    direction: { value: "anticlockwise", options: ["anticlockwise", "clockwise"] },
    trail: { value: fromQuery("trail", 0, 1), min: 0, max: 1, step: 0.01 },
    blur: { value: fromQuery("blur", 0, 1), min: 0, max: 1, step: 0.01 },
    dragSpin: { value: 0.35, min: 0.05, max: 1.5, step: 0.05, label: "drag spin" },
    Respawn: button(() => setGeneration((g) => g + 1)),
    Snapshot: button(() => captureRef.current?.()),
    snapshotTab: { value: false, label: "snapshot in tab" },
  });

  const look: Look = {
    inside: settings.sphere as string,
    outside: settings.outside as string,
    cloud: settings.cloudColor as string,
    stroke: settings.strokeColor as string,
    trail: settings.trail,
    blur: settings.blur,
    dragSpin: settings.dragSpin,
    breathe: settings.breathe,
    blink: settings.blink,
  };
  const trackSettings = useMemo<TrackSettings>(
    () => ({ offset: settings.trackOffset, width: settings.trackWidth, stroke: settings.strokeWidth }),
    [settings.trackOffset, settings.trackWidth, settings.strokeWidth],
  );
  const racerSettings = useMemo<RacerSettings>(
    () => ({
      count: settings.racers,
      size: settings.racerSize,
      speed: settings.raceSpeed,
      variance: settings.speedVariance,
      clockwise: settings.direction === "clockwise",
      blur: settings.blur,
    }),
    [settings.racers, settings.racerSize, settings.raceSpeed, settings.speedVariance, settings.direction, settings.blur],
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
          trackSettings={trackSettings}
          racerSettings={racerSettings}
          generation={generation}
          renderer={renderer}
          drawRef={drawRef}
          captureRef={captureRef}
          snapshotInTab={settings.snapshotTab}
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
