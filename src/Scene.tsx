import { useCallback, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { ContactShadows, Environment, Lightformer } from "@react-three/drei";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { button, useControls } from "leva";
import { Bot } from "./Bot";
import { BOT_SIZE, getBotGeometries } from "./geometry";
import { BOT_HUES, TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors, useRapierReady } from "./Status";

/** Front-to-back thickness of the play space; keeps the pile readable. */
const SLAB_DEPTH = 3.2;
const FLOOR_Y = 0;
const CAMERA_POS: [number, number, number] = [0, 4.5, 13];
const CAMERA_TARGET: [number, number, number] = [0, 2.6, 0];
const CAMERA_FOV = 42;
const BACKGROUND = "#f7f5f1";
const FLOOR_COLOR = "#e9e5de";

type Spawn = {
  position: [number, number, number];
  rotation: [number, number, number];
};

function randomSpawns(count: number, halfWidth: number, topY: number, faceCamera: boolean): Spawn[] {
  // Drop within a narrow column so the bots actually pile up rather than
  // landing in a row across the whole viewport.
  const spread = Math.min(3, Math.max(0.3, halfWidth - BOT_SIZE));
  return Array.from({ length: count }, (_, i) => ({
    position: [
      (Math.random() * 2 - 1) * spread,
      topY + 1 + i * 1.5 + Math.random() * 0.6,
      faceCamera ? 0 : (Math.random() * 2 - 1) * (SLAB_DEPTH / 2 - BOT_SIZE * 0.5),
    ],
    rotation: [
      faceCamera ? 0 : (Math.random() - 0.5) * 0.6,
      faceCamera ? 0 : (Math.random() - 0.5) * 1.2,
      (Math.random() - 0.5) * 0.8,
    ],
  }));
}

/**
 * Where the camera frustum meets the play plane (z = 0), for the current
 * aspect ratio: half the visible width at the floor line, and the world y of
 * the top edge of the viewport. Walls hug the former; spawns start above the
 * latter so bots always fall into view.
 */
function useFrustumBounds() {
  const { camera, size } = useThree();
  return useMemo(() => {
    // Work on a copy with the aspect for this size applied, so the result is
    // right even if r3f has not yet resized the live camera this frame.
    const cam = (camera as THREE.PerspectiveCamera).clone();
    cam.aspect = size.width / size.height;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    const floor = new THREE.Vector3(0, FLOOR_Y, 0).project(cam);
    const hitPlaneZ0 = (ndcX: number, ndcY: number) => {
      const a = new THREE.Vector3(ndcX, ndcY, -1).unproject(cam);
      const b = new THREE.Vector3(ndcX, ndcY, 1).unproject(cam);
      const t = (0 - a.z) / (b.z - a.z);
      return a.lerp(b, t);
    };
    const right = hitPlaneZ0(1, floor.y);
    const top = hitPlaneZ0(0, 1);
    return {
      halfWidth: Math.max(1.5, right.x - 0.3),
      topY: Math.max(6, top.y),
    };
  }, [camera, size.width, size.height]);
}

type Settings = {
  gravity: number;
  restitution: number;
  friction: number;
  impulse: number;
  faceCamera: boolean;
};

function World({ settings, generation }: { settings: Settings; generation: number }) {
  const { halfWidth, topY } = useFrustumBounds();
  const bots = useMemo(() => getBotGeometries(), []);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);

  const spawns = useMemo(
    () => randomSpawns(bots.length, halfWidth, topY, settings.faceCamera),
    // Re-roll on respawn only; resizing the window shouldn't re-drop the pile.
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

  const tap = useCallback(
    (body: RapierRigidBody) => {
      const s = settings.impulse;
      body.applyImpulse({ x: (Math.random() - 0.5) * s * 0.3, y: s, z: 0 }, true);
      body.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * s * 0.4, y: (Math.random() - 0.5) * s * 0.4, z: (Math.random() - 0.5) * s * 0.6 },
        true,
      );
    },
    [settings.impulse],
  );

  const burst = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const origin = e.point;
      const strength = settings.impulse * 1.6;
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
    [settings.impulse],
  );

  const wallH = 60;
  const wallT = 0.5;

  return (
    <Physics gravity={[0, -settings.gravity, 0]} timeStep={1 / 60}>
      {/* Floor and walls. Walls sit exactly at the viewport edges for this aspect ratio. */}
      <RigidBody type="fixed" friction={settings.friction} restitution={settings.restitution}>
        <CuboidCollider args={[halfWidth + 6, wallT, SLAB_DEPTH]} position={[0, FLOOR_Y - wallT, 0]} />
        <CuboidCollider args={[wallT, wallH, SLAB_DEPTH]} position={[-halfWidth - wallT, wallH - 2, 0]} />
        <CuboidCollider args={[wallT, wallH, SLAB_DEPTH]} position={[halfWidth + wallT, wallH - 2, 0]} />
        <CuboidCollider args={[halfWidth + 6, wallH, wallT]} position={[0, wallH - 2, -SLAB_DEPTH / 2 - wallT]} />
        <CuboidCollider args={[halfWidth + 6, wallH, wallT]} position={[0, wallH - 2, SLAB_DEPTH / 2 + wallT]} />
      </RigidBody>

      {bots.map((bot, i) => (
        <Bot
          key={`${generation}-${bot.shape.id}`}
          ref={(b) => {
            bodies.current[i] = b;
          }}
          bot={bot}
          color={colors[i]}
          position={spawns[i].position}
          rotation={spawns[i].rotation}
          restitution={settings.restitution}
          friction={settings.friction}
          faceCamera={settings.faceCamera}
          onTap={tap}
        />
      ))}

      {/* Click-catcher for empty space: an invisible plane through the slab centre. */}
      <mesh position={[0, 12, 0]} onPointerDown={burst}>
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </Physics>
  );
}

/** Everything that should be visible even if physics never loads. */
function Stage() {
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <fog attach="fog" args={[BACKGROUND, 24, 70]} />
      <hemisphereLight args={["#ffffff", "#d8d2c8", 0.7]} />
      <directionalLight
        position={[6, 12, 8]}
        intensity={2.2}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-bias={-0.0004}
        shadow-camera-left={-16}
        shadow-camera-right={16}
        shadow-camera-top={16}
        shadow-camera-bottom={-6}
      />
      <directionalLight position={[-8, 6, -4]} intensity={0.6} color="#dfe8ff" />
      <Environment resolution={128}>
        <Lightformer intensity={2} position={[0, 6, -6]} scale={[12, 4, 1]} />
        <Lightformer intensity={1.2} position={[-8, 3, 4]} rotation-y={Math.PI / 2} scale={[8, 3, 1]} />
        <Lightformer intensity={1} position={[8, 3, 4]} rotation-y={-Math.PI / 2} scale={[8, 3, 1]} color="#ffe9d6" />
      </Environment>

      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, FLOOR_Y - 0.001, 0]} receiveShadow>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color={FLOOR_COLOR} roughness={1} />
      </mesh>
      <ContactShadows position={[0, FLOOR_Y + 0.002, 0]} opacity={0.55} scale={50} blur={2.2} far={6} resolution={1024} color="#3a3530" />
    </>
  );
}

export function Scene() {
  const [generation, setGeneration] = useState(0);
  const webgl = useMemo(detectWebGL, []);
  const rapier = useRapierReady();
  const globalError = useGlobalErrors();

  const settings = useControls({
    gravity: { value: 12, min: 0, max: 40, step: 0.5 },
    restitution: { value: 0.35, min: 0, max: 1, step: 0.01, label: "bounce" },
    friction: { value: 0.6, min: 0, max: 1.5, step: 0.01 },
    impulse: { value: 9, min: 1, max: 30, step: 0.5, label: "impulse strength" },
    faceCamera: { value: true, label: "face camera" },
    Respawn: button(() => setGeneration((g) => g + 1)),
  });

  if (!webgl.ok) {
    return (
      <StatusOverlay
        status={{
          kind: "error",
          title: "WebGL is not available in this browser",
          detail: webgl.detail,
        }}
      />
    );
  }

  return (
    <>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ position: CAMERA_POS, fov: CAMERA_FOV, near: 0.1, far: 200 }}
        onCreated={({ camera }) => camera.lookAt(...CAMERA_TARGET)}
        style={{ touchAction: "none" }}
      >
        <Stage />
        {rapier.ready && <World settings={settings} generation={generation} />}
      </Canvas>
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
