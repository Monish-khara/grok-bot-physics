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
import {
  ARC_SEGMENTS,
  chordHalfLength,
  fitSphere,
  insideSphere,
  sphereOutline,
  sphereWallSegments,
  type Sphere,
} from "./sphereShape";

/**
 * Front-to-back thickness of the play space at bot scale 1. Shallow, so the
 * troop stays in one depth band. Scales with the bots so a 2x troop still
 * fits between the front and back walls.
 */
const SLAB_DEPTH = 3.2;
/** Typical bot diameter in world units at bot scale 1, for spawn spacing. */
const BOT_SIZE = 1.6;
/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
const CAMERA_Y = VIEW_HEIGHT / 2;
/** Clearance between the Sphere and the viewport edge, world units. */
const SPHERE_MARGIN = 0.45;
/** Reference image colours: light grey Sphere on a dark grey field. */
const SPHERE_COLOR = "#d9d9d9";
const OUTSIDE_COLOR = "#4a4a4a";
/**
 * Fraction of the flight direction allowed front-to-back. The slab is thin,
 * so a mostly-planar direction keeps the bots from rattling between the
 * front and back walls.
 */
const DEPTH_MIX = 0.25;

/** Relative luminance (sRGB) of a hex colour, for picking a readable HUD text colour. */
const luminance = (hex: string) => {
  const c = new THREE.Color(hex);
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
};

type Vec3 = [number, number, number];

type Spawn = {
  position: Vec3;
  rotation: Vec3;
  /** Unit flight direction; scaled to the `speed` setting when the body appears (Fly). */
  direction: Vec3;
  /** Angular velocity as a fraction of the `spin` setting, per axis (Fly). */
  spin: Vec3;
};

type Mode = "Drop" | "Fly";

const QUERY = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
/** `?lineup` parks the troop in one evenly spaced, upright row — for screenshots. */
const LINEUP = QUERY.has("lineup");
/** `?mode=fly` / `?mode=drop` picks the starting mode (default Drop). */
const START_MODE: Mode = QUERY.get("mode")?.toLowerCase() === "fly" ? "Fly" : "Drop";
/** `?trail=0.8&blur=1` preset the Fly effect sliders (screenshots, headless checks). */
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
 * Rejection-sample spawn positions inside the Sphere, clear of the walls and
 * of each other. Drop mode samples the upper part so the fall is visible.
 */
function sphereSpawns(count: number, sphere: Sphere, faceCamera: boolean, scale: number, mode: Mode): Spawn[] {
  const size = BOT_SIZE * scale;
  const inset = size * 0.7;
  const depthRoom = Math.max(0, (SLAB_DEPTH * scale) / 2 - size * 0.5);
  if (LINEUP) {
    const half = chordHalfLength(sphere) - size * 0.6;
    return Array.from({ length: count }, (_, i) => ({
      position: [sphere.cx - half + (2 * half * (i + 0.5)) / count, sphere.cy, 0],
      rotation: [0, 0, 0],
      direction: randomDirection(true),
      spin: [0, 0, 0],
    }));
  }
  const yMin = mode === "Drop" ? sphere.cy : sphere.chordY + inset;
  const yMax = sphere.cy + sphere.r - inset;
  const placed: [number, number][] = [];
  return Array.from({ length: count }, () => {
    let x = sphere.cx, y = sphere.cy;
    for (let attempt = 0; attempt < 400; attempt++) {
      x = sphere.cx + (Math.random() * 2 - 1) * (sphere.r - inset);
      y = yMin + Math.random() * Math.max(0, yMax - yMin);
      if (!insideSphere(sphere, x, y, inset)) continue;
      // Relax the spacing as attempts run out, so small Spheres still fill.
      const gap = size * (attempt < 200 ? 1 : 0.6);
      if (placed.every(([px, py]) => Math.hypot(px - x, py - y) >= gap)) break;
    }
    placed.push([x, y]);
    return {
      position: [x, y, faceCamera ? 0 : (Math.random() * 2 - 1) * depthRoom],
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

/** The Sphere fitted to the current viewport; recomputed on resize. */
function useSphere(): Sphere {
  const { size } = useThree();
  return useMemo(() => {
    const halfWidth = (VIEW_HEIGHT / 2) * (size.width / size.height);
    return fitSphere(halfWidth, CAMERA_Y - VIEW_HEIGHT / 2, VIEW_HEIGHT, SPHERE_MARGIN);
  }, [size.width, size.height]);
}

/** Physics and effect settings resolved for the active mode. */
type Physics = {
  mode: Mode;
  gravity: number;
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  righting: number;
  speed: number;
  spin: number;
  trail: number;
  blur: number;
  impulse: number;
  faceCamera: boolean;
  dragSpin: number;
  botScale: number;
};

/**
 * Fly mode's screensaver rule: after every physics step, put each free-flying
 * bot back on exactly `speed`. Elastic bounces and bot-bot collisions are
 * never quite lossless in the solver, so without this the troop slowly
 * stalls or runs away. A bot that has come to rest is sent off in a fresh
 * random direction. Spin is capped at `spin` so collisions cannot pump it up.
 */
function SpeedNormaliser({
  bodies,
  speed,
  spin,
  planar,
}: {
  bodies: React.RefObject<(RapierRigidBody | null)[]>;
  speed: number;
  spin: number;
  planar: boolean;
}) {
  useAfterPhysicsStep(() => {
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

const tmpQ = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();

/**
 * Drop mode's weeble torque: swings each bot back toward its rest pose (face
 * to the camera, eyes upright) after it tumbles. Rotation stays fully free —
 * this only decides where they settle, so the eyes end up readable.
 */
function Righting({
  bodies,
  gain,
  gravity,
  enabled,
}: {
  bodies: React.RefObject<(RapierRigidBody | null)[]>;
  gain: number;
  gravity: number;
  enabled: boolean;
}) {
  useFrame((_, dt) => {
    if (!enabled || gain <= 0) return;
    const g = Math.max(gravity, 4);
    const step = Math.min(dt, 1 / 30);
    for (const body of bodies.current ?? []) {
      if (!body || body.gravityScale() === 0) continue; // being dragged
      // A bot that has come to rest stays at rest: the torque never wakes a
      // sleeping body, and is applied without resetting the sleep timer, so
      // a slab rocking on its face under the torque can settle and sleep
      // instead of jiggling forever. Taps and scatters still wake everything.
      if (body.isSleeping()) continue;
      const r = body.rotation();
      tmpQ.set(-r.x, -r.y, -r.z, r.w);
      if (tmpQ.w < 0) tmpQ.set(-tmpQ.x, -tmpQ.y, -tmpQ.z, -tmpQ.w);
      const sinHalf = Math.hypot(tmpQ.x, tmpQ.y, tmpQ.z);
      if (sinHalf < 0.02) continue;
      const angle = 2 * Math.atan2(sinHalf, tmpQ.w);
      tmpAxis.set(tmpQ.x / sinHalf, tmpQ.y / sinHalf, tmpQ.z / sinHalf);
      // Torque scaled to the body's own weight and size, so it can tip a cube
      // resting on a face (gravity moment ≈ m·g·r) but stays proportional
      // for light or small bodies. Radius recovered from the inertia tensor.
      const m = body.mass();
      const inertia = body.principalInertia();
      const radius = Math.sqrt(Math.max(inertia.x, inertia.y, inertia.z) / (0.4 * m));
      const torque = angle * gain * m * g * radius * step;
      body.applyTorqueImpulse({ x: tmpAxis.x * torque, y: tmpAxis.y * torque, z: tmpAxis.z * torque }, false);
    }
  });
  return null;
}

function World({
  physics,
  sphere,
  generation,
  quality,
  webgl,
}: {
  physics: Physics;
  sphere: Sphere;
  generation: number;
  quality: Quality;
  webgl: boolean;
}) {
  const bots = useMemo(() => getBotGeometries(quality), [quality]);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  // Bodies whose spawn velocity has been applied; the ref callback fires on every render.
  const launched = useRef(new WeakSet<RapierRigidBody>());
  const fly = physics.mode === "Fly";
  useEffect(() => {
    // Test hooks: let headless checks know the bots are in the world and
    // where each one is (world units, y up; the camera looks down -Z).
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotPositions?: () => { id: string; x: number; y: number; z: number }[];
      __grokBotVelocities?: () => { id: string; x: number; y: number; z: number; speed: number }[];
      __grokBotBounds?: () => Sphere & { mode: Mode };
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
    w.__grokBotBounds = () => ({ ...sphere, mode: physics.mode });
  }, [bots, sphere, physics.mode]);

  const spawns = useMemo(
    () => sphereSpawns(bots.length, sphere, physics.faceCamera, physics.botScale, physics.mode),
    // Re-roll on respawn only (a mode switch bumps the generation); resizing
    // or moving a slider shouldn't re-scatter the troop.
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

  /** Fly: give a freshly created body its spawn heading and spin, once. */
  const launch = useCallback(
    (body: RapierRigidBody, spawn: Spawn) => {
      if (launched.current.has(body)) return;
      launched.current.add(body);
      if (!fly) return;
      const [dx, dy, dz] = spawn.direction;
      body.setLinvel({ x: dx * physics.speed, y: dy * physics.speed, z: dz * physics.speed }, true);
      body.setAngvel({ x: spawn.spin[0] * physics.spin, y: spawn.spin[1] * physics.spin, z: spawn.spin[2] * physics.spin }, true);
    },
    [fly, physics.speed, physics.spin],
  );

  // Mass grows with the cube of the scale; scale impulses the same way so a
  // tap moves a 2x bot as much as a 1x one.
  const massFactor = physics.botScale ** 3;

  // Tap. Drop: kick it upward with a little spin. Fly: a shove in a random
  // direction (the normaliser puts it back on `speed`, so the heading changes).
  const tap = useCallback(
    (body: RapierRigidBody) => {
      const s = physics.impulse * massFactor;
      if (fly) {
        const d = randomDirection(physics.faceCamera);
        body.applyImpulse({ x: d[0] * s, y: d[1] * s, z: d[2] * s }, true);
      } else {
        body.applyImpulse({ x: (Math.random() - 0.5) * s * 0.3, y: s, z: 0 }, true);
      }
      body.applyTorqueImpulse(
        physics.faceCamera
          ? { x: 0, y: 0, z: (Math.random() - 0.5) * s * 0.6 }
          : { x: (Math.random() - 0.5) * s * 0.4, y: (Math.random() - 0.5) * s * 0.4, z: (Math.random() - 0.5) * s * 0.6 },
        true,
      );
    },
    [fly, physics.impulse, massFactor, physics.faceCamera],
  );

  // Empty-space click. Drop: radial burst from the point. Fly: every bot
  // picks a new random heading and spin.
  const scatter = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      if (fly) {
        for (const body of bodies.current) {
          if (!body || body.gravityScale() === 0) continue;
          const d = randomDirection(physics.faceCamera);
          const w = randomSpin(physics.faceCamera);
          body.setLinvel({ x: d[0] * physics.speed, y: d[1] * physics.speed, z: d[2] * physics.speed }, true);
          body.setAngvel({ x: w[0] * physics.spin, y: w[1] * physics.spin, z: w[2] * physics.spin }, true);
        }
        return;
      }
      const origin = e.point;
      const strength = physics.impulse * 1.6 * massFactor;
      for (const body of bodies.current) {
        if (!body) continue;
        const p = body.translation();
        const dx = p.x - origin.x;
        const dy = p.y - origin.y;
        const dz = p.z - origin.z;
        const dist = Math.max(0.6, Math.hypot(dx, dy, dz));
        const falloff = Math.min(1, 4 / dist);
        const k = (strength * falloff) / dist;
        body.applyImpulse({ x: dx * k, y: Math.abs(dy) * k + strength * 0.25 * falloff, z: dz * k * 0.3 }, true);
        body.applyTorqueImpulse(
          { x: (Math.random() - 0.5) * strength * 0.3, y: (Math.random() - 0.5) * strength * 0.3, z: (Math.random() - 0.5) * strength * 0.3 },
          true,
        );
      }
    },
    [fly, physics.speed, physics.spin, physics.impulse, massFactor, physics.faceCamera],
  );

  // The slab widens live when bots grow, but only narrows on Respawn: pulling
  // the front/back walls in past bots that are already sitting deep would
  // leave them outside the box. So track the largest scale since the spawn.
  const [slabScale, setSlabScale] = useState(physics.botScale);
  useEffect(() => {
    setSlabScale((s) => Math.max(s, physics.botScale));
  }, [physics.botScale]);
  useEffect(() => {
    setSlabScale(physics.botScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  const wallT = 0.3;
  const slabDepth = SLAB_DEPTH * Math.max(slabScale, physics.botScale);
  const walls = useMemo(() => sphereWallSegments(sphere, wallT, ARC_SEGMENTS), [sphere]);
  const baseHalf = chordHalfLength(sphere);
  // Oversize the flat colliders well past the shape so nothing slips past a corner.
  const pad = 6;

  return (
    <Physics gravity={[0, -physics.gravity, 0]} timeStep={1 / 60}>
      {fly ? (
        <SpeedNormaliser bodies={bodies} speed={physics.speed} spin={physics.spin} planar={physics.faceCamera} />
      ) : (
        <Righting bodies={bodies} gain={physics.righting} gravity={physics.gravity} enabled={!physics.faceCamera} />
      )}

      {/* The Sphere: a ring of thin boxes along the arc, a flat base along the chord, and shallow front/back planes. */}
      <RigidBody type="fixed" friction={physics.friction} restitution={physics.restitution}>
        {walls.map((w, i) => (
          <CuboidCollider
            key={i}
            args={[w.halfLength, wallT, slabDepth + pad]}
            position={[w.x, w.y, 0]}
            rotation={[0, 0, w.angle]}
          />
        ))}
        <CuboidCollider args={[baseHalf + pad, wallT, slabDepth + pad]} position={[sphere.cx, sphere.chordY - wallT, 0]} />
        <CuboidCollider args={[sphere.r + pad, sphere.r + pad, wallT]} position={[sphere.cx, sphere.cy, -slabDepth / 2 - wallT]} />
        <CuboidCollider args={[sphere.r + pad, sphere.r + pad, wallT]} position={[sphere.cx, sphere.cy, slabDepth / 2 + wallT]} />
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
          restitution={physics.restitution}
          friction={physics.friction}
          linearDamping={physics.linearDamping}
          angularDamping={physics.angularDamping}
          canSleep={!fly}
          faceCamera={physics.faceCamera}
          dragSpin={physics.dragSpin}
          scale={physics.botScale}
          blur={webgl ? physics.blur : 0}
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

/** Trail persistence at `trail = 1`, seconds (matches canvas2d.ts). */
const TRAIL_SECONDS = 2;

/** Hands the Sphere backdrop and the effect strengths to the Canvas 2D renderer. */
function Canvas2DStage({ sphere, inside, outside, trail, blur }: { sphere: Sphere; inside: string; outside: string; trail: number; blur: number }) {
  const gl = useThree((s) => s.gl) as unknown as Canvas2DRenderer;
  const outline = useMemo(() => sphereOutline(sphere), [sphere]);
  useEffect(() => {
    if (!gl.isCanvas2DRenderer) return;
    gl.stage = { outline, inside, outside };
    gl.effects.trail = trail;
    gl.effects.blur = blur;
  }, [gl, outline, inside, outside, trail, blur]);
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
  drawRef: React.RefObject<((dt: number) => void) | null>;
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

  const draw = (dt: number) => {
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
    const pos = geometry.attributes.position as THREE.BufferAttribute;
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
    gl.setClearColor(outside, 1);
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
 * Snapshot: the render canvas alone — the framed Sphere with its outside
 * colour, bots, trails and blur as drawn, at native pixel size — as a PNG.
 * The HUD, renderer label and Leva panel are DOM, not canvas, so they are
 * never in it. The Canvas 2D bitmap persists between frames; WebGL's drawing
 * buffer does not, so a frame is drawn right before reading it.
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

/** Inner component so the Sphere fit (which needs the canvas size) can be shared. */
function Framed({
  physics,
  inside,
  outside,
  generation,
  renderer,
  ready,
  drawRef,
}: {
  physics: Physics;
  inside: string;
  outside: string;
  generation: number;
  renderer: RendererKind;
  ready: boolean;
  drawRef: React.RefObject<((dt: number) => void) | null>;
}) {
  const sphere = useSphere();
  return (
    <>
      <CameraRig />
      {renderer === "webgl" ? (
        <WebGLStage sphere={sphere} inside={inside} outside={outside} trail={physics.trail} drawRef={drawRef} />
      ) : (
        <Canvas2DStage sphere={sphere} inside={inside} outside={outside} trail={physics.trail} blur={physics.blur} />
      )}
      {ready && (
        <World
          physics={physics}
          sphere={sphere}
          generation={generation}
          quality={renderer === "canvas2d" ? "low" : "high"}
          webgl={renderer === "webgl"}
        />
      )}
    </>
  );
}

export function Scene() {
  const [generation, setGeneration] = useState(0);
  const webgl = useMemo(detectWebGL, []);
  const renderer = useMemo(() => pickRenderer(webgl.ok), [webgl.ok]);
  const rapier = useRapierReady();
  const globalError = useGlobalErrors();
  const captureRef = useRef<(() => void) | null>(null);
  const drawRef = useRef<((dt: number) => void) | null>(null);

  // Each mode has its own sliders (shown only in that mode), so tweaks
  // persist when switching back and forth.
  const isDrop = (get: (k: string) => unknown) => get("mode") === "Drop";
  const isFly = (get: (k: string) => unknown) => get("mode") === "Fly";
  const settings = useControls({
    mode: { value: START_MODE, options: ["Drop", "Fly"] as Mode[] },
    sphere: { value: SPHERE_COLOR, label: "sphere" },
    outside: { value: OUTSIDE_COLOR, label: "outside" },
    // Drop
    dropGravity: { value: 9.8, min: 0, max: 40, step: 0.1, label: "gravity", render: isDrop },
    dropBounce: { value: 0.4, min: 0, max: 1, step: 0.01, label: "bounce", render: isDrop },
    friction: { value: 0.6, min: 0, max: 1.5, step: 0.01, render: isDrop },
    righting: { value: 1, min: 0, max: 3, step: 0.05, label: "face seeking", render: isDrop },
    // Fly
    speed: { value: 6, min: 0.5, max: 20, step: 0.5, render: isFly },
    spin: { value: 1.5, min: 0, max: 8, step: 0.1, render: isFly },
    flyBounce: { value: 1, min: 0, max: 1, step: 0.01, label: "bounce", render: isFly },
    trail: { value: fromQuery("trail", 0.6, 1), min: 0, max: 1, step: 0.01, render: isFly },
    blur: { value: fromQuery("blur", 0.7, 1), min: 0, max: 1, step: 0.01, render: isFly },
    // Shared
    impulse: { value: 9, min: 1, max: 30, step: 0.5, label: "impulse strength" },
    dragSpin: { value: 0.35, min: 0.05, max: 1.5, step: 0.05, label: "drag spin" },
    botScale: { value: 1, min: 0.5, max: 2, step: 0.05, label: "bot scale" },
    faceCamera: { value: false, label: "face camera" },
    Respawn: button(() => setGeneration((g) => g + 1)),
    Snapshot: button(() => captureRef.current?.()),
    snapshotTab: { value: false, label: "snapshot in tab" },
  });
  const mode = settings.mode as Mode;

  // A mode switch respawns the troop under the new rules.
  const firstMode = useRef(true);
  useEffect(() => {
    if (firstMode.current) {
      firstMode.current = false;
      return;
    }
    setGeneration((g) => g + 1);
  }, [mode]);

  const fly = mode === "Fly";
  const physics: Physics = {
    mode,
    gravity: fly ? 0 : settings.dropGravity,
    restitution: fly ? settings.flyBounce : settings.dropBounce,
    friction: fly ? 0 : settings.friction,
    linearDamping: fly ? 0 : 0.15,
    angularDamping: fly ? 0 : 1.4,
    righting: fly ? 0 : settings.righting,
    speed: settings.speed,
    spin: settings.spin,
    trail: fly ? settings.trail : 0,
    blur: fly ? settings.blur : 0,
    impulse: settings.impulse,
    faceCamera: settings.faceCamera,
    dragSpin: settings.dragSpin,
    botScale: settings.botScale,
  };

  // Paint the page the outside colour so the canvas and page never mismatch
  // (the canvas can lag a frame on resize, and overlays sit on the page), and
  // flip the HUD text light or dark to stay readable.
  const inside = settings.sphere as string;
  const outside = settings.outside as string;
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty("--stage-bg", outside);
    const dark = luminance(outside) < 0.4;
    root.setProperty("--hud-fg", dark ? "#f4f1ec" : "#2a2724");
    root.setProperty("--hud-muted", dark ? "#b8b2aa" : "#6c665f");
  }, [outside]);

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
          physics={physics}
          inside={inside}
          outside={outside}
          generation={generation}
          renderer={renderer}
          ready={rapier.ready}
          drawRef={drawRef}
        />
        <Snapshot captureRef={captureRef} drawRef={drawRef} openInTab={settings.snapshotTab} />
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
