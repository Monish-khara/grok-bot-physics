import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { CuboidCollider, Physics, RigidBody, useAfterPhysicsStep, type RapierRigidBody } from "@react-three/rapier";
import { button, useControls } from "leva";
import { Bot } from "./Bot";
import { getBotGeometries, type Quality } from "./geometry";
import { Canvas2DRenderer } from "./canvas2d";
import { BOT_HUES, TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors, useRapierReady } from "./Status";

/**
 * Front-to-back thickness of the play space at bot scale 1. Shallow, so the
 * troop drifts in one depth band and never leaves the frame. Scales with the
 * bots so a 2x troop still fits between the front and back walls.
 */
const SLAB_DEPTH = 3.2;
/** Typical bot diameter in world units at bot scale 1, for spawn spacing. */
const BOT_SIZE = 1.6;
/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
const CAMERA_Y = VIEW_HEIGHT / 2;
/** Stage colour of the Base shapes v2 tool (`--bg: 255 255 255`). */
const BACKGROUND = { r: 255, g: 255, b: 255 };
/**
 * Fraction of the flight direction allowed front-to-back. The slab is thin,
 * so a mostly-planar direction keeps the bots from rattling between the
 * front and back walls.
 */
const DEPTH_MIX = 0.25;

type Rgb = { r: number; g: number; b: number };

const toHex = ({ r, g, b }: Rgb) =>
  "#" + [r, g, b].map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")).join("");

/** Relative luminance (sRGB), for picking a readable HUD text colour. */
const luminance = ({ r, g, b }: Rgb) => {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

type Vec3 = [number, number, number];

type Spawn = {
  position: Vec3;
  rotation: Vec3;
  /** Unit flight direction; scaled to the `speed` setting when the body appears. */
  direction: Vec3;
  /** Angular velocity as a fraction of the `spin` setting, per axis. */
  spin: Vec3;
};

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
/** `?lineup` parks the troop in one evenly spaced, upright row — for screenshots. */
const LINEUP = QUERY.has("lineup");
/** `?trail=0.8&blur=1` preset the effect sliders (screenshots, headless checks). */
const fromQuery = (name: string, fallback: number, max: number) => {
  const v = Number(QUERY.get(name));
  return QUERY.has(name) && Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : fallback;
};

/** A random unit vector, mostly in the view plane (see DEPTH_MIX). */
function randomDirection(planar: boolean): Vec3 {
  const a = Math.random() * Math.PI * 2;
  const z = planar ? 0 : (Math.random() * 2 - 1) * DEPTH_MIX;
  const r = Math.sqrt(1 - z * z);
  return [Math.cos(a) * r, Math.sin(a) * r, z];
}

function randomSpin(planar: boolean): Vec3 {
  const mag = 0.4 + Math.random() * 0.6;
  if (planar) return [0, 0, (Math.random() < 0.5 ? -1 : 1) * mag];
  const d = randomDirection(false);
  return [d[0] * mag, d[1] * mag, d[2] * mag];
}

/**
 * Spread the troop over the whole visible volume on a jittered grid, so no
 * two bots start inside each other, each with its own heading and spin.
 */
function randomSpawns(
  count: number,
  halfWidth: number,
  bottomY: number,
  topY: number,
  faceCamera: boolean,
  scale: number,
): Spawn[] {
  const size = BOT_SIZE * scale;
  if (LINEUP) {
    const span = 2 * halfWidth - size * 1.2;
    return Array.from({ length: count }, (_, i) => ({
      position: [-halfWidth + size * 0.6 + (span * (i + 0.5)) / count, (bottomY + topY) / 2, 0],
      rotation: [0, 0, 0],
      direction: randomDirection(true),
      spin: [0, 0, 0],
    }));
  }
  const cols = Math.ceil(Math.sqrt(count * (halfWidth * 2) / (topY - bottomY)));
  const rows = Math.ceil(count / cols);
  // Usable extents: keep every spawn clear of the walls, whatever the scale.
  const x0 = -halfWidth + size * 0.7;
  const x1 = halfWidth - size * 0.7;
  const y0 = bottomY + size * 0.7;
  const y1 = topY - size * 0.7;
  const cellW = (x1 - x0) / cols;
  const cellH = (y1 - y0) / rows;
  const jitterX = Math.max(0, (cellW - size) / 2);
  const jitterY = Math.max(0, (cellH - size) / 2);
  const depthRoom = Math.max(0, (SLAB_DEPTH * scale) / 2 - size * 0.5);
  // Shuffle the cells so the empty ones (grid is larger than the troop) land anywhere.
  const cells = Array.from({ length: cols * rows }, (_, i) => i);
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  return Array.from({ length: count }, (_, i) => {
    const cell = cells[i];
    const cx = x0 + (cell % cols + 0.5) * cellW;
    const cy = y0 + (Math.floor(cell / cols) + 0.5) * cellH;
    return {
      position: [
        cx + (Math.random() * 2 - 1) * jitterX,
        cy + (Math.random() * 2 - 1) * jitterY,
        faceCamera ? 0 : (Math.random() * 2 - 1) * depthRoom,
      ],
      rotation: [
        faceCamera ? 0 : (Math.random() - 0.5) * 0.9,
        faceCamera ? 0 : (Math.random() - 0.5) * 1.4,
        (Math.random() - 0.5) * 0.8,
      ],
      direction: randomDirection(faceCamera),
      spin: randomSpin(faceCamera),
    };
  });
}

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

/** Visible half-width at the play plane and the world y of the top and bottom edges. */
function useViewBounds() {
  const { size } = useThree();
  return useMemo(() => {
    const halfWidth = (VIEW_HEIGHT / 2) * (size.width / size.height);
    return {
      halfWidth: Math.max(1.5, halfWidth - 0.05),
      bottomY: CAMERA_Y - VIEW_HEIGHT / 2 + 0.05,
      topY: CAMERA_Y + VIEW_HEIGHT / 2 - 0.05,
    };
  }, [size.width, size.height]);
}

type Settings = {
  speed: number;
  spin: number;
  gravity: number;
  restitution: number;
  trail: number;
  blur: number;
  impulse: number;
  faceCamera: boolean;
  dragSpin: number;
  botScale: number;
};

/**
 * Screensaver rule: after every physics step, put each free-flying bot back
 * on exactly `speed`. Elastic bounces and bot-bot collisions are never quite
 * lossless in the solver, so without this the troop slowly stalls or runs
 * away. A bot that has come to rest (dragged and released, or pinned in a
 * corner) is sent off in a fresh random direction. Spin is capped at `spin`
 * so collisions cannot pump it up forever. Skipped while gravity is on, so
 * the slider still gives a real fall.
 */
function SpeedNormaliser({
  bodies,
  speed,
  spin,
  gravity,
  planar,
}: {
  bodies: React.RefObject<(RapierRigidBody | null)[]>;
  speed: number;
  spin: number;
  gravity: number;
  planar: boolean;
}) {
  useAfterPhysicsStep(() => {
    if (gravity !== 0) return;
    for (const body of bodies.current ?? []) {
      if (!body || body.gravityScale() === 0) continue; // being dragged
      const v = body.linvel();
      const mag = Math.hypot(v.x, v.y, v.z);
      if (mag < 1e-3) {
        const d = randomDirection(planar);
        body.setLinvel({ x: d[0] * speed, y: d[1] * speed, z: d[2] * speed }, true);
      } else if (Math.abs(mag - speed) > speed * 1e-4) {
        const k = speed / mag;
        body.setLinvel({ x: v.x * k, y: v.y * k, z: v.z * k }, true);
      }
      const w = body.angvel();
      const wmag = Math.hypot(w.x, w.y, w.z);
      if (wmag > spin) {
        const k = spin / wmag;
        body.setAngvel({ x: w.x * k, y: w.y * k, z: w.z * k }, true);
      }
    }
  });
  return null;
}

function World({
  settings,
  generation,
  quality,
  webgl,
}: {
  settings: Settings;
  generation: number;
  quality: Quality;
  webgl: boolean;
}) {
  const { halfWidth, bottomY, topY } = useViewBounds();
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  // Bodies whose spawn velocity has been applied; the ref callback fires on every render.
  const launched = useRef(new WeakSet<RapierRigidBody>());
  useEffect(() => {
    // Test hooks: let headless checks know the bots are in the world and
    // where each one is (world units, y up; the camera looks down -Z).
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotPositions?: () => { id: string; x: number; y: number; z: number }[];
      __grokBotVelocities?: () => { id: string; x: number; y: number; z: number; speed: number }[];
      __grokBotBounds?: () => { halfWidth: number; bottomY: number; topY: number };
      __grokBotRandomize?: () => void;
    };
    w.__grokBotsReady = true;
    // Test hook: throw every bot into a random orientation (renderer stress tests).
    w.__grokBotRandomize = () => {
      for (const b of bodies.current) {
        if (!b) continue;
        const q = new THREE.Quaternion().setFromEuler(
          new THREE.Euler(Math.random() * Math.PI * 2, Math.random() * Math.PI * 2, Math.random() * Math.PI * 2),
        );
        b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
        b.setAngvel({ x: (Math.random() - 0.5) * 6, y: (Math.random() - 0.5) * 6, z: (Math.random() - 0.5) * 6 }, true);
      }
    };
    w.__grokBotPositions = () =>
      bodies.current.flatMap((b, i) => {
        if (!b) return [];
        const p = b.translation();
        return [{ id: bots[i].shape.id, x: p.x, y: p.y, z: p.z }];
      });
    w.__grokBotVelocities = () =>
      bodies.current.flatMap((b, i) => {
        if (!b) return [];
        const v = b.linvel();
        return [{ id: bots[i].shape.id, x: v.x, y: v.y, z: v.z, speed: Math.hypot(v.x, v.y, v.z) }];
      });
    w.__grokBotBounds = () => ({ halfWidth, bottomY, topY });
  }, [bots, halfWidth, bottomY, topY]);

  const spawns = useMemo(
    () => randomSpawns(bots.length, halfWidth, bottomY, topY, settings.faceCamera, settings.botScale),
    // Re-roll on respawn only; resizing the window or moving a slider
    // shouldn't re-scatter the troop. Scale is read at spawn time for spacing;
    // live scale changes just resize the bodies where they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [bots.length, generation],
  );

  const colors = useMemo(() => {
    const hues = [...BOT_HUES];
    for (let i = hues.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [hues[i], hues[j]] = [hues[j], hues[i]];
    }
    return bots.map((_, i) => TOKENS[hues[i % hues.length]]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bots, generation]);

  /** Give a freshly created body its spawn heading and spin, once. */
  const launch = useCallback(
    (body: RapierRigidBody, spawn: Spawn) => {
      if (launched.current.has(body)) return;
      launched.current.add(body);
      const [dx, dy, dz] = spawn.direction;
      body.setLinvel({ x: dx * settings.speed, y: dy * settings.speed, z: dz * settings.speed }, true);
      body.setAngvel({ x: spawn.spin[0] * settings.spin, y: spawn.spin[1] * settings.spin, z: spawn.spin[2] * settings.spin }, true);
    },
    [settings.speed, settings.spin],
  );

  // Mass grows with the cube of the scale; scale impulses the same way so a
  // tap nudges a 2x bot as much as a 1x one.
  const massFactor = settings.botScale ** 3;

  // Tap: a shove in a random direction plus some spin. The normaliser puts
  // the bot back on `speed`, so what the tap really changes is its heading.
  const tap = useCallback(
    (body: RapierRigidBody) => {
      const s = settings.impulse * massFactor;
      const d = randomDirection(settings.faceCamera);
      body.applyImpulse({ x: d[0] * s, y: d[1] * s, z: d[2] * s }, true);
      body.applyTorqueImpulse(
        settings.faceCamera
          ? { x: 0, y: 0, z: (Math.random() - 0.5) * s * 0.6 }
          : { x: (Math.random() - 0.5) * s * 0.4, y: (Math.random() - 0.5) * s * 0.4, z: (Math.random() - 0.5) * s * 0.6 },
        true,
      );
    },
    [settings.impulse, massFactor, settings.faceCamera],
  );

  // Empty-space click: every bot picks a new random heading and spin.
  const scatter = useCallback(
    (_e: ThreeEvent<PointerEvent>) => {
      for (const body of bodies.current) {
        if (!body || body.gravityScale() === 0) continue;
        const d = randomDirection(settings.faceCamera);
        const w = randomSpin(settings.faceCamera);
        body.setLinvel({ x: d[0] * settings.speed, y: d[1] * settings.speed, z: d[2] * settings.speed }, true);
        body.setAngvel({ x: w[0] * settings.spin, y: w[1] * settings.spin, z: w[2] * settings.spin }, true);
      }
    },
    [settings.speed, settings.spin, settings.faceCamera],
  );

  // The slab widens live when bots grow, but only narrows on Respawn: pulling
  // the front/back walls in past bots that are already sitting deep would
  // leave them outside the box. So track the largest scale since the spawn.
  const [slabScale, setSlabScale] = useState(settings.botScale);
  useEffect(() => {
    setSlabScale((s) => Math.max(s, settings.botScale));
  }, [settings.botScale]);
  useEffect(() => {
    setSlabScale(settings.botScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  const wallT = 0.5;
  const slabDepth = SLAB_DEPTH * Math.max(slabScale, settings.botScale);
  const midY = (bottomY + topY) / 2;
  const halfH = (topY - bottomY) / 2;
  // Oversize the walls well past the corners so a bot can never slip between two of them.
  const pad = 6;

  return (
    <Physics gravity={[0, -settings.gravity, 0]} timeStep={1 / 60}>
      <SpeedNormaliser
        bodies={bodies}
        speed={settings.speed}
        spin={settings.spin}
        gravity={settings.gravity}
        planar={settings.faceCamera}
      />

      {/* Six invisible walls, one per face of the visible box; bounce is fully elastic. */}
      <RigidBody type="fixed" friction={0} restitution={settings.restitution}>
        <CuboidCollider args={[wallT, halfH + pad, slabDepth + pad]} position={[-halfWidth - wallT, midY, 0]} />
        <CuboidCollider args={[wallT, halfH + pad, slabDepth + pad]} position={[halfWidth + wallT, midY, 0]} />
        <CuboidCollider args={[halfWidth + pad, wallT, slabDepth + pad]} position={[0, bottomY - wallT, 0]} />
        <CuboidCollider args={[halfWidth + pad, wallT, slabDepth + pad]} position={[0, topY + wallT, 0]} />
        <CuboidCollider args={[halfWidth + pad, halfH + pad, wallT]} position={[0, midY, -slabDepth / 2 - wallT]} />
        <CuboidCollider args={[halfWidth + pad, halfH + pad, wallT]} position={[0, midY, slabDepth / 2 + wallT]} />
      </RigidBody>

      {bots.map((bot, i) => (
        <Bot
          key={`${generation}-${bot.shape.id}`}
          ref={(b) => {
            bodies.current[i] = b;
            if (b) launch(b, spawns[i]);
          }}
          bot={bot}
          color={colors[i]}
          position={spawns[i].position}
          rotation={spawns[i].rotation}
          restitution={settings.restitution}
          faceCamera={settings.faceCamera}
          dragSpin={settings.dragSpin}
          scale={settings.botScale}
          blur={webgl ? settings.blur : 0}
          onTap={tap}
        />
      ))}

      {/* Click-catcher for empty space: an invisible plane behind the slab. */}
      <mesh position={[0, CAMERA_Y, -6]} onPointerDown={scatter}>
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </Physics>
  );
}

/**
 * The stage is just the tool's paper: a flat colour, no lights, no floor, no
 * shadows. While the WebGL fade trail is on, the clear is done by hand (see
 * WebGLTrail), because a scene background colour forces a full clear.
 */
function Stage({ background, manualClear }: { background: string; manualClear: boolean }) {
  return (
    <>
      {!manualClear && <color attach="background" args={[background]} />}
      <CameraRig />
    </>
  );
}

/** Trail persistence at `trail = 1`, seconds (matches canvas2d.ts). */
const TRAIL_SECONDS = 2;

/** Hands the Leva effect strengths to the Canvas 2D renderer. */
function Canvas2DEffects({ trail, blur }: { trail: number; blur: number }) {
  const gl = useThree((s) => s.gl) as unknown as Canvas2DRenderer;
  useEffect(() => {
    if (!gl.isCanvas2DRenderer) return;
    gl.effects.trail = trail;
    gl.effects.blur = blur;
  }, [gl, trail, blur]);
  return null;
}

/**
 * WebGL trail as a fade-clear: the scene accumulates in a float render
 * target that is washed toward the background colour a little each frame
 * before the bots are drawn on top, then blitted to the screen. Float
 * accumulation means the wash really does converge to the background (an
 * 8-bit alpha fade stalls a few levels short and leaves a permanent ghost),
 * and a new background colour is simply faded in. With `trail` at 0 this
 * just renders normally.
 */
function WebGLTrail({
  trail,
  background,
  drawRef,
}: {
  trail: number;
  background: string;
  /** Receives a function that draws one frame on demand (dt 0: no wash), for snapshots. */
  drawRef: React.RefObject<((dt: number) => void) | null>;
}) {
  const { gl, scene, camera } = useThree();
  const fx = useMemo(() => {
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const quad = new THREE.PlaneGeometry(2, 2);
    const fadeMaterial = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, toneMapped: false });
    // Wash the colour only; leave alpha at the opaque 1 the clear wrote.
    // Plain blending would pull the buffer's alpha toward the wash opacity,
    // invisible on screen (the page behind is the same colour) but it would
    // make snapshots of trail frames semi-transparent.
    fadeMaterial.blending = THREE.CustomBlending;
    fadeMaterial.blendSrc = THREE.SrcAlphaFactor;
    fadeMaterial.blendDst = THREE.OneMinusSrcAlphaFactor;
    fadeMaterial.blendSrcAlpha = THREE.ZeroFactor;
    fadeMaterial.blendDstAlpha = THREE.OneFactor;
    const fadeScene = new THREE.Scene().add(new THREE.Mesh(quad, fadeMaterial));
    const blitMaterial = new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, toneMapped: false });
    const blitScene = new THREE.Scene().add(new THREE.Mesh(quad, blitMaterial));
    return {
      cam,
      quad,
      fadeMaterial,
      fadeScene,
      blitMaterial,
      blitScene,
      size: new THREE.Vector2(),
      target: null as THREE.WebGLRenderTarget | null,
      fresh: true,
    };
  }, []);
  useEffect(
    () => () => {
      fx.target?.dispose();
      fx.quad.dispose();
      fx.fadeMaterial.dispose();
      fx.blitMaterial.dispose();
    },
    [fx],
  );
  // (Re)start the accumulation whenever the trail is switched on.
  const active = trail > 0;
  useEffect(() => {
    fx.fresh = true;
  }, [fx, active]);

  const draw = (dt: number) => {
    if (!active) {
      gl.autoClear = true;
      gl.setRenderTarget(null);
      gl.render(scene, camera);
      return;
    }
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
      fx.blitMaterial.map = target.texture;
      fx.blitMaterial.needsUpdate = true;
      fx.fresh = true;
    }
    gl.setRenderTarget(target);
    gl.autoClear = false;
    if (fx.fresh) {
      gl.setClearColor(background, 1);
      gl.clear(true, true, true);
      fx.fresh = false;
    }
    // Wash toward the background: a ghost is down to ~5% after TRAIL_SECONDS * trail.
    const tau = (TRAIL_SECONDS * trail) / 3;
    fx.fadeMaterial.color.set(background);
    fx.fadeMaterial.opacity = 1 - Math.exp(-Math.min(dt, 0.1) / tau);
    gl.render(fx.fadeScene, fx.cam);
    gl.clearDepth();
    gl.render(scene, camera);
    gl.setRenderTarget(null);
    gl.render(fx.blitScene, fx.cam);
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
 * Snapshot: the render canvas alone — bots, background, trails and blur as
 * drawn, at its native pixel size — as a PNG. The HUD, renderer label and
 * Leva panel are DOM, not canvas, so they are never in it. The Canvas 2D
 * bitmap persists between frames; WebGL's drawing buffer does not, so a
 * frame is drawn right before reading it (no preserveDrawingBuffer needed).
 */
function Snapshot({
  captureRef,
  drawRef,
  openInTab,
}: {
  captureRef: React.RefObject<(() => void) | null>;
  drawRef: React.RefObject<((dt: number) => void) | null>;
  openInTab: boolean;
}) {
  const { gl, scene, camera } = useThree();
  useEffect(() => {
    captureRef.current = () => {
      const canvas = gl.domElement;
      if (!(gl as unknown as Canvas2DRenderer).isCanvas2DRenderer) {
        if (drawRef.current) drawRef.current(0);
        else gl.render(scene, camera);
      }
      const name = snapshotName();
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const w = window as unknown as { __grokLastSnapshot?: { name: string; size: number; width: number; height: number } };
        w.__grokLastSnapshot = { name, size: blob.size, width: canvas.width, height: canvas.height };
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
  }, [gl, scene, camera, captureRef, drawRef, openInTab]);
  return null;
}

/** Which rasteriser to use: WebGL when the browser allows it, Canvas 2D otherwise. */
type RendererKind = "webgl" | "canvas2d";

function pickRenderer(webglOk: boolean): RendererKind {
  // `?renderer=canvas2d` / `?renderer=webgl` force a choice (testing).
  const forced = typeof location !== "undefined" ? new URLSearchParams(location.search).get("renderer") : null;
  if (forced === "canvas2d" || forced === "webgl") return forced;
  return webglOk ? "webgl" : "canvas2d";
}

export function Scene() {
  const [generation, setGeneration] = useState(0);
  const webgl = useMemo(detectWebGL, []);
  const renderer = useMemo(() => pickRenderer(webgl.ok), [webgl.ok]);
  const rapier = useRapierReady();
  const globalError = useGlobalErrors();
  const captureRef = useRef<(() => void) | null>(null);
  const drawRef = useRef<((dt: number) => void) | null>(null);

  const settings = useControls({
    // First in the panel so it is visible without expanding anything.
    background: { value: BACKGROUND, label: "background" },
    speed: { value: 6, min: 0.5, max: 20, step: 0.5 },
    spin: { value: 1.5, min: 0, max: 8, step: 0.1 },
    gravity: { value: 0, min: 0, max: 40, step: 0.5 },
    restitution: { value: 1, min: 0, max: 1, step: 0.01, label: "bounce" },
    trail: { value: fromQuery("trail", 0, 1), min: 0, max: 1, step: 0.01 },
    blur: { value: fromQuery("blur", 0, 1), min: 0, max: 1, step: 0.01 },
    impulse: { value: 9, min: 1, max: 30, step: 0.5, label: "impulse strength" },
    dragSpin: { value: 0.35, min: 0.05, max: 1.5, step: 0.05, label: "drag spin" },
    botScale: { value: 1, min: 0.5, max: 2, step: 0.05, label: "bot scale" },
    faceCamera: { value: false, label: "face camera" },
    Respawn: button(() => setGeneration((g) => g + 1)),
    Snapshot: button(() => captureRef.current?.()),
    snapshotTab: { value: false, label: "snapshot in tab" },
  });

  // Paint the page the same colour as the canvas so the two never mismatch
  // (the canvas can lag a frame on resize, and overlays sit on the page), and
  // flip the HUD text light or dark to stay readable.
  const background = toHex(settings.background as Rgb);
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--stage-bg", background);
    const dark = luminance(settings.background as Rgb) < 0.4;
    root.setProperty("--hud-fg", dark ? "#f4f1ec" : "#2a2724");
    root.setProperty("--hud-muted", dark ? "#b8b2aa" : "#6c665f");
  }, [background, settings.background]);

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
        <Stage background={background} manualClear={renderer === "webgl" && settings.trail > 0} />
        {renderer === "webgl" ? (
          <WebGLTrail trail={settings.trail} background={background} drawRef={drawRef} />
        ) : (
          <Canvas2DEffects trail={settings.trail} blur={settings.blur} />
        )}
        <Snapshot captureRef={captureRef} drawRef={drawRef} openInTab={settings.snapshotTab} />
        {rapier.ready && (
          <World
            settings={settings}
            generation={generation}
            quality={renderer === "canvas2d" ? "low" : "high"}
            webgl={renderer === "webgl"}
          />
        )}
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
      ) : rapier.error ? (
        <StatusOverlay status={{ kind: "error", title: "Physics engine (Rapier WASM) failed to load", detail: rapier.error }} />
      ) : !rapier.ready ? (
        <StatusOverlay status={{ kind: "loading", message: "Loading physics engine…" }} />
      ) : null}
    </>
  );
}
