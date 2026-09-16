import { forwardRef, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { BotGeometry } from "./geometry";

/**
 * A bot drawn without a physics body: a group the scene poses every frame,
 * with the same mesh structure the renderers expect — body mesh, eye meshes
 * as its children, `userData.velocity` for the Canvas 2D blur — and the
 * WebGL blur ghosts from the physics branches, posed along `velocity`.
 *
 * `vertexColors` draws the body from its baked per-vertex colours (the
 * nesting shells' three tones) instead of `color`. `perTriangle` tells the
 * Canvas 2D renderer to paint this body triangle by triangle in a global
 * depth sort rather than as one silhouette fill — needed for anything you
 * can see into or through.
 */

type Props = {
  bot: BotGeometry;
  color: string;
  scale: number;
  /** WebGL speed-blur strength, 0–1; the Canvas 2D renderer does its own from `userData.velocity`. */
  blur: number;
  /** World velocity the scene measured for this figure this frame. */
  velocity: THREE.Vector3;
  /** Body colour comes from the geometry's `color` attribute. */
  vertexColors?: boolean;
  /** Canvas 2D: paint per triangle in the global depth sort (see above). */
  perTriangle?: boolean;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
};

/** Smear length at `blur = 1`, seconds of travel (matches canvas2d.ts). */
const BLUR_SECONDS = 0.16;
const BLUR_COPIES = 6;
const BLUR_ALPHA = 0.5;
const EYE_COLOR = "#ffffff";

export const Figure = forwardRef<THREE.Group, Props>(function Figure(
  { bot, color, scale, blur, velocity, vertexColors = false, perTriangle = false, onPointerDown, onPointerMove, onPointerUp },
  ref,
) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const ghostsRef = useRef<THREE.Group | null>(null);
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color: vertexColors ? "#ffffff" : color, vertexColors, toneMapped: false }),
    [color, vertexColors],
  );
  // A grouped geometry (the half shells: face, rim, inside) draws its rim
  // pushed back a little in depth, so faces win ties along shared edges.
  const grouped = bot.geometry.groups.length > 1;
  const biased = useMemo(
    () =>
      grouped
        ? new THREE.MeshBasicMaterial({
            color: vertexColors ? "#ffffff" : color,
            vertexColors,
            toneMapped: false,
            polygonOffset: true,
            polygonOffsetFactor: 4,
            polygonOffsetUnits: 16,
          })
        : null,
    [color, vertexColors, grouped],
  );
  const bodyMaterial = useMemo(() => (biased ? [material, biased, material] : material), [material, biased]);
  const eyeMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false }), []);
  useEffect(() => () => material.dispose(), [material]);
  useEffect(() => () => biased?.dispose(), [biased]);
  useEffect(() => () => eyeMaterial.dispose(), [eyeMaterial]);

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

  useFrame(() => {
    const mesh = meshRef.current;
    const group = groupRef.current;
    if (!mesh || !group) return;
    const vel = (mesh.userData.velocity as THREE.Vector3 | undefined) ?? (mesh.userData.velocity = new THREE.Vector3());
    vel.copy(velocity);
    const ghosts = ghostsRef.current;
    if (!ghosts) return;
    const speed = vel.length();
    const length = speed * blur * BLUR_SECONDS;
    if (length < 0.02) {
      ghosts.visible = false;
      return;
    }
    ghosts.visible = true;
    for (let i = 0; i < ghosts.children.length; i++) {
      const ghost = ghosts.children[i];
      const f = (i + 1) / ghosts.children.length;
      ghost.position.copy(group.position).addScaledVector(vel, (-length * f) / speed);
      ghost.position.z -= 0.002 * (i + 1);
      ghost.quaternion.copy(group.quaternion);
      ghost.scale.copy(group.scale).multiplyScalar(scale);
    }
  });

  return (
    <>
      <group
        ref={(g) => {
          groupRef.current = g;
          if (typeof ref === "function") ref(g);
          else if (ref) ref.current = g;
        }}
      >
        <mesh
          ref={meshRef}
          geometry={bot.geometry}
          material={bodyMaterial}
          scale={scale}
          userData={{ perTriangle }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {bot.eyes.map((g, i) => (
            <mesh key={i} geometry={g} material={eyeMaterial} userData={{ eyeNormal: bot.eyeNormals[i] }} />
          ))}
        </mesh>
      </group>
      {ghostCount > 0 && (
        <group ref={ghostsRef} visible={false}>
          {ghostMaterials.map((m, i) => (
            <mesh key={i} geometry={bot.geometry} material={m.body} userData={{ ghost: true }} renderOrder={-1}>
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
