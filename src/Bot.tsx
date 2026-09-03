import { forwardRef, useMemo } from "react";
import * as THREE from "three";
import {
  BallCollider,
  ConvexHullCollider,
  CuboidCollider,
  RigidBody,
  useRapier,
  type RapierRigidBody,
} from "@react-three/rapier";
import type { ThreeEvent } from "@react-three/fiber";
import type { BotGeometry } from "./geometry";

type Props = {
  bot: BotGeometry;
  color: string;
  position: [number, number, number];
  rotation: [number, number, number];
  restitution: number;
  friction: number;
  /** Keep the face toward the camera: no depth travel, spin only about Z. */
  faceCamera: boolean;
  onTap: (body: RapierRigidBody) => void;
};

const MAX_HULL_POINTS = 700;

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

export const Bot = forwardRef<RapierRigidBody, Props>(function Bot(
  { bot, color, position, rotation, restitution, friction, faceCamera, onTap },
  ref,
) {
  const { rapier } = useRapier();

  const hull = useMemo(() => {
    const pts = sampleHullPoints(bot.hullPoints);
    // Rapier returns null when it cannot build a hull (degenerate cloud).
    // Probe once so complex outlines fall back to a box or ball instead of
    // silently having no collider at all.
    const desc = rapier.ColliderDesc.convexHull(pts);
    return desc ? pts : null;
  }, [bot, rapier]);

  const material = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color,
        roughness: 0.42,
        metalness: 0,
        clearcoat: 0.35,
        clearcoatRoughness: 0.5,
        sheen: 0.4,
        sheenColor: new THREE.Color(color).lerp(new THREE.Color("#ffffff"), 0.4),
      }),
    [color],
  );

  const handlePointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const body = (ref as React.RefObject<RapierRigidBody>).current;
    if (body) onTap(body);
  };

  const he = bot.halfExtents;
  const roundish = Math.abs(he.x - he.y) < 0.15 && Math.abs(he.x - he.z) < 0.35;

  return (
    <RigidBody
      ref={ref}
      colliders={false}
      position={position}
      rotation={rotation}
      restitution={restitution}
      friction={friction}
      linearDamping={0.15}
      angularDamping={0.35}
      enabledTranslations={[true, true, !faceCamera]}
      enabledRotations={[!faceCamera, !faceCamera, true]}
      ccd
      canSleep
    >
      {hull ? (
        <ConvexHullCollider args={[hull]} restitution={restitution} friction={friction} />
      ) : roundish ? (
        <BallCollider args={[Math.max(he.x, he.y)]} restitution={restitution} friction={friction} />
      ) : (
        <CuboidCollider args={[he.x, he.y, he.z]} restitution={restitution} friction={friction} />
      )}
      <mesh
        geometry={bot.geometry}
        material={material}
        castShadow
        receiveShadow
        onPointerDown={handlePointerDown}
      />
    </RigidBody>
  );
});
