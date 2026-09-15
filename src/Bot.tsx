import { forwardRef, useCallback, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import {
  BallCollider,
  ConvexHullCollider,
  CuboidCollider,
  RigidBody,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { BotGeometry } from "./geometry";

type Props = {
  bot: BotGeometry;
  color: string;
  position: [number, number, number];
  rotation: [number, number, number];
  restitution: number;
  friction: number;
  linearDamping: number;
  angularDamping: number;
  /** Drop mode lets settled bots sleep; Fly mode never does. Immutable per body (respawn applies it). */
  canSleep: boolean;
  /** Keep the face toward the camera: no depth travel, spin only about Z. */
  faceCamera: boolean;
  /** Degrees of spin per pixel of drag, applied as angular velocity. */
  dragSpin: number;
  /** Uniform size multiplier applied to the mesh and its collider. */
  scale: number;
  /**
   * Speed-blur strength, 0–1, for the WebGL renderer: translucent copies of
   * the body trail behind it along its velocity. The Canvas 2D renderer does
   * its own blur from `mesh.userData.velocity`, so pass 0 there.
   */
  blur: number;
  onTap: (body: RapierRigidBody) => void;
};

/** Smear length at `blur = 1`, as seconds of travel along the velocity (matches canvas2d.ts). */
const BLUR_SECONDS = 0.16;
const BLUR_COPIES = 6;
/** Opacity of the blur copy nearest the body; farther copies fade to ~0. */
const BLUR_ALPHA = 0.5;

const MAX_HULL_POINTS = 700;
/** Pointer travel (px) below which a press counts as a tap, not a drag. */
const TAP_SLOP = 6;
/** Eyes are paper-coloured in the tool: they read as holes in the ink. */
const EYE_COLOR = "#ffffff";

/** Thin the mesh vertices so the hull builder gets a manageable cloud. */
function sampleHullPoints(all: Float32Array): Float32Array {
  const count = all.length / 3;
  if (count <= MAX_HULL_POINTS) return all;
  const stride = Math.ceil(count / MAX_HULL_POINTS);
  const out = new Float32Array(Math.ceil(count / stride) * 3);
  let j = 0;
  for (let i = 0; i < count; i += stride) {
    out[j++] = all[i * 3];
    out[j++] = all[i * 3 + 1];
    out[j++] = all[i * 3 + 2];
  }
  return out.subarray(0, j);
}

type Drag = {
  id: number;
  x0: number;
  y0: number;
  x: number;
  y: number;
  moved: boolean;
  /** Pose when the drag started; drag angles are applied on top of it. */
  q0: THREE.Quaternion;
  /** Last move delta and its timestamp, for the release flick. */
  vx: number;
  vy: number;
  t: number;
};

const qYaw = new THREE.Quaternion();
const qPitch = new THREE.Quaternion();
const qOut = new THREE.Quaternion();
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export const Bot = forwardRef<RapierRigidBody, Props>(function Bot(
  { bot, color, position, rotation, restitution, friction, linearDamping, angularDamping, canSleep, faceCamera, dragSpin, scale, blur, onTap },
  ref,
) {
  const { rapier } = useRapier();
  const drag = useRef<Drag | null>(null);
  const bodyRef = useRef<RapierRigidBody | null>(null);
  const meshRef = useRef<THREE.Mesh | null>(null);
  const ghostsRef = useRef<THREE.Group | null>(null);
  // Keep our own handle and forward to whatever the parent passed (callback or object ref).
  const setRef = useCallback(
    (b: RapierRigidBody | null) => {
      bodyRef.current = b;
      if (typeof ref === "function") ref(b);
      else if (ref) ref.current = b;
    },
    [ref],
  );

  const hull = useMemo(() => {
    const pts = sampleHullPoints(bot.hullPoints).map((v) => v * scale);
    // Rapier returns null when it cannot build a hull (degenerate cloud).
    // Probe once so odd bodies fall back to a box or ball instead of
    // silently having no collider at all. A fresh array per scale also makes
    // the collider re-create, since its args are immutable.
    const desc = rapier.ColliderDesc.convexHull(pts);
    return desc ? pts : null;
  }, [bot, rapier, scale]);

  // Flat ink fill, like the Base shapes v2 tool: unlit, exact token color.
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  // Eyes are solid inlays that intersect the body, so the plain depth test
  // sorts them; no offset tricks needed.
  const eyeMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false }), []);

  const body = () => bodyRef.current;

  // Blur ghosts (WebGL only): one material per copy so each has its own alpha.
  const ghostCount = blur > 0 ? BLUR_COPIES : 0;
  const ghostMaterials = useMemo(
    () =>
      Array.from({ length: ghostCount }, (_, i) => {
        const opacity = BLUR_ALPHA * (1 - (i + 1) / ghostCount) + 0.04;
        return {
          body: new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: true, opacity, depthWrite: false }),
          eye: new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false, transparent: true, opacity, depthWrite: false }),
        };
      }),
    [color, ghostCount],
  );
  useEffect(
    () => () => {
      for (const m of ghostMaterials) {
        m.body.dispose();
        m.eye.dispose();
      }
    },
    [ghostMaterials],
  );

  // Publish the velocity for the Canvas 2D renderer's blur, and lay the WebGL
  // ghosts out behind the body along its velocity.
  useFrame(() => {
    const b = bodyRef.current;
    const mesh = meshRef.current;
    if (!b || !mesh) return;
    const v = b.linvel();
    const vel = (mesh.userData.velocity as THREE.Vector3 | undefined) ?? (mesh.userData.velocity = new THREE.Vector3());
    vel.set(v.x, v.y, v.z);
    const ghosts = ghostsRef.current;
    if (!ghosts) return;
    const speed = vel.length();
    const length = speed * blur * BLUR_SECONDS;
    const parent = mesh.parent;
    if (!parent || length < 0.02) {
      ghosts.visible = false;
      return;
    }
    ghosts.visible = true;
    for (let i = 0; i < ghosts.children.length; i++) {
      const ghost = ghosts.children[i];
      const f = (i + 1) / ghosts.children.length;
      ghost.position.copy(parent.position).addScaledVector(vel, (-length * f) / speed);
      // Nudge each copy a hair farther from the camera so the solid body and
      // nearer copies win the depth test where they overlap.
      ghost.position.z -= 0.002 * (i + 1);
      ghost.quaternion.copy(parent.quaternion);
    }
  });

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const b = body();
    if (!b) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const r = b.rotation();
    drag.current = {
      id: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      q0: new THREE.Quaternion(r.x, r.y, r.z, r.w),
      vx: 0,
      vy: 0,
      t: performance.now(),
    };
  };

  const onPointerMove = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    const b = body();
    if (!d || d.id !== e.pointerId || !b) return;
    const now = performance.now();
    const dt = Math.max(1, now - d.t) / 1000;
    d.vx = (e.clientX - d.x) / dt;
    d.vy = (e.clientY - d.y) / dt;
    d.t = now;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.moved && Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < TAP_SLOP) return;
    if (!d.moved) {
      d.moved = true;
      // Hold the bot still while it is being turned, like a tile in the tool.
      // Gravity scale 0 doubles as the "being dragged" flag for the speed normaliser.
      b.setGravityScale(0, true);
      b.setLinvel({ x: 0, y: 0, z: 0 }, true);
    }
    // Tool: yaw follows horizontal drag, pitch follows vertical drag, at
    // `dragSpin` degrees per pixel, applied on top of the pose at grab time.
    const k = (dragSpin * Math.PI) / 180;
    const dx = e.clientX - d.x0, dy = e.clientY - d.y0;
    if (faceCamera) {
      qYaw.setFromAxisAngle(Z_AXIS, -dx * k);
      qOut.copy(qYaw).multiply(d.q0);
    } else {
      qYaw.setFromAxisAngle(Y_AXIS, dx * k);
      qPitch.setFromAxisAngle(X_AXIS, dy * k);
      qOut.copy(qPitch).multiply(qYaw).multiply(d.q0);
    }
    b.setAngvel({ x: 0, y: 0, z: 0 }, true);
    b.setRotation({ x: qOut.x, y: qOut.y, z: qOut.z, w: qOut.w }, true);
  };

  const onPointerUp = (e: ThreeEvent<PointerEvent>) => {
    const d = drag.current;
    const b = body();
    if (!d || d.id !== e.pointerId) return;
    drag.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    if (!b) return;
    if (d.moved) {
      b.setGravityScale(1, true);
      // Release flick: carry the last drag speed on as spin, capped, and send
      // the bot off the way it was flicked (screen y is down, world y is up).
      // The speed normaliser puts it back on the shared speed next step; a
      // still release leaves it to pick a random heading.
      const k = (dragSpin * Math.PI) / 180;
      const cap = 12;
      const wx = Math.max(-cap, Math.min(cap, d.vy * k));
      const wy = Math.max(-cap, Math.min(cap, d.vx * k));
      b.setAngvel(faceCamera ? { x: 0, y: 0, z: -wy } : { x: wx, y: wy, z: 0 }, true);
      b.setLinvel({ x: d.vx, y: -d.vy, z: 0 }, true);
    } else {
      onTap(b);
    }
  };

  const he = bot.halfExtents.clone().multiplyScalar(scale);
  const roundish = Math.abs(he.x - he.y) < 0.15 * scale && Math.abs(he.x - he.z) < 0.35 * scale;

  const rigidBody = (
    <RigidBody
      ref={setRef}
      colliders={false}
      position={position}
      rotation={rotation}
      restitution={restitution}
      friction={friction}
      linearDamping={linearDamping}
      angularDamping={angularDamping}
      enabledTranslations={[true, true, !faceCamera]}
      enabledRotations={[!faceCamera, !faceCamera, true]}
      ccd
      canSleep={canSleep}
    >
      {hull ? (
        <ConvexHullCollider args={[hull]} restitution={restitution} friction={friction} />
      ) : roundish ? (
        <BallCollider args={[Math.max(he.x, he.y)]} restitution={restitution} friction={friction} />
      ) : (
        <CuboidCollider args={[he.x, he.y, he.z]} restitution={restitution} friction={friction} />
      )}
      <mesh
        ref={meshRef}
        geometry={bot.geometry}
        material={material}
        scale={scale}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {bot.eyes.map((g, i) => (
          <mesh key={i} geometry={g} material={eyeMaterial} userData={{ eyeNormal: bot.eyeNormals[i] }} />
        ))}
      </mesh>
    </RigidBody>
  );

  return (
    <>
      {rigidBody}
      {ghostCount > 0 && (
        // Outside the RigidBody so physics does not move it; posed each frame above.
        <group ref={ghostsRef} visible={false}>
          {ghostMaterials.map((m, i) => (
            <mesh key={i} geometry={bot.geometry} material={m.body} scale={scale} userData={{ ghost: true }} renderOrder={-1}>
              {bot.eyes.map((g, j) => (
                <mesh key={j} geometry={g} material={m.eye} />
              ))}
            </mesh>
          ))}
        </group>
      )}
    </>
  );
});
