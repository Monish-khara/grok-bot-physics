import { forwardRef, useEffect, useMemo, useRef } from "react";
import * as THREE from "three";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import type { BotGeometry } from "./geometry";

/**
 * A bot drawn without a physics body: a group the scene poses every frame
 * (racers ride the track, the cloud sits still), with the same mesh
 * structure the renderers expect — body mesh, eye meshes as its children,
 * `userData.velocity` for the Canvas 2D blur — and the WebGL blur ghosts
 * from the physics branches, posed along `velocity`.
 */

type Props = {
  bot: BotGeometry;
  color: string;
  scale: number;
  /** WebGL speed-blur strength, 0–1; the Canvas 2D renderer does its own from `userData.velocity`. */
  blur: number;
  /** World velocity the scene measured for this figure this frame. */
  velocity: THREE.Vector3;
  /** WebGL draw order for the body and eyes (higher draws later); ghosts draw one step earlier. */
  renderOrder?: number;
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
  { bot, color, scale, blur, velocity, renderOrder = 0, onPointerDown, onPointerMove, onPointerUp },
  ref,
) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const ghostsRef = useRef<THREE.Group | null>(null);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color, toneMapped: false }), [color]);
  const eyeMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false }), []);
  useEffect(() => () => material.dispose(), [material]);
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
          material={material}
          scale={scale}
          renderOrder={renderOrder}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {bot.eyes.map((g, i) => (
            <mesh key={i} geometry={g} material={eyeMaterial} renderOrder={renderOrder} userData={{ eyeNormal: bot.eyeNormals[i] }} />
          ))}
        </mesh>
      </group>
      {ghostCount > 0 && (
        <group ref={ghostsRef} visible={false}>
          {ghostMaterials.map((m, i) => (
            <mesh key={i} geometry={bot.geometry} material={m.body} userData={{ ghost: true }} renderOrder={renderOrder - 1}>
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
