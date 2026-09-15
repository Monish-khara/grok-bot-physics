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
 * `fade` (a ref read every frame, so the scene can animate it without
 * re-rendering) is the whole figure's opacity. `overlay` marks a figure that
 * must always be drawn over whatever it shares a centre with (the layer being
 * peeled in the nesting scene): WebGL skips the depth test for it and draws
 * it after the opaque bodies, and the eyes are culled by their normal
 * instead, the way the Canvas 2D renderer does.
 */

type Props = {
  bot: BotGeometry;
  color: string;
  scale: number;
  /** WebGL speed-blur strength, 0–1; the Canvas 2D renderer does its own from `userData.velocity`. */
  blur: number;
  /** World velocity the scene measured for this figure this frame. */
  velocity: THREE.Vector3;
  /** Opacity 0–1, read each frame; undefined is opaque. */
  fade?: React.RefObject<number>;
  /** Always draw over coincident bodies (see above). */
  overlay?: boolean;
  onPointerDown?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerMove?: (e: ThreeEvent<PointerEvent>) => void;
  onPointerUp?: (e: ThreeEvent<PointerEvent>) => void;
};

/** Smear length at `blur = 1`, seconds of travel (matches canvas2d.ts). */
const BLUR_SECONDS = 0.16;
const BLUR_COPIES = 6;
const BLUR_ALPHA = 0.5;
const EYE_COLOR = "#ffffff";
/** An overlay eye is shown while its normal points this far toward the camera (matches canvas2d.ts). */
const EYE_FACING = 0.15;

const normalMatrix = new THREE.Matrix3();
const eyeNormal = new THREE.Vector3();

export const Figure = forwardRef<THREE.Group, Props>(function Figure(
  { bot, color, scale, blur, velocity, fade, overlay = false, onPointerDown, onPointerMove, onPointerUp },
  ref,
) {
  const meshRef = useRef<THREE.Mesh | null>(null);
  const groupRef = useRef<THREE.Group | null>(null);
  const ghostsRef = useRef<THREE.Group | null>(null);
  const material = useMemo(
    () => new THREE.MeshBasicMaterial({ color, toneMapped: false, transparent: overlay, depthTest: !overlay, depthWrite: !overlay }),
    [color, overlay],
  );
  const eyeMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: EYE_COLOR, toneMapped: false, transparent: overlay, depthTest: !overlay, depthWrite: !overlay }),
    [overlay],
  );
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
    const alpha = fade ? Math.max(0, Math.min(1, fade.current)) : 1;
    if (material.opacity !== alpha) {
      material.opacity = alpha;
      eyeMaterial.opacity = alpha;
      // Opaque figures stay on the opaque pass; a fading one joins the transparent pass.
      const transparent = overlay || alpha < 1;
      if (material.transparent !== transparent) {
        material.transparent = eyeMaterial.transparent = transparent;
        material.needsUpdate = eyeMaterial.needsUpdate = true;
      }
    }
    if (overlay) {
      // No depth test, so the body cannot hide an eye on its far side: cull by the normal instead.
      mesh.updateWorldMatrix(true, false);
      normalMatrix.getNormalMatrix(mesh.matrixWorld);
      for (let i = 0; i < mesh.children.length; i++) {
        const eye = mesh.children[i];
        const local = eye.userData.eyeNormal as THREE.Vector3 | undefined;
        if (!local) continue;
        eyeNormal.copy(local).applyMatrix3(normalMatrix).normalize();
        eye.visible = eyeNormal.z > EYE_FACING;
      }
    }
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
          renderOrder={overlay ? 10 : 0}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {bot.eyes.map((g, i) => (
            <mesh key={i} geometry={g} material={eyeMaterial} renderOrder={overlay ? 11 : 0} userData={{ eyeNormal: bot.eyeNormals[i] }} />
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
