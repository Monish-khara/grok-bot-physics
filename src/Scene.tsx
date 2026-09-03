import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import { Canvas, useThree, type ThreeEvent } from "@react-three/fiber";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { button, useControls } from "leva";
import { Bot } from "./Bot";
import { BOT_SIZE, getBotGeometries } from "./geometry";
import { BOT_HUES, TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors, useRapierReady } from "./Status";

/** Front-to-back thickness of the play space; keeps the pile readable. */
const SLAB_DEPTH = 3.2;
const FLOOR_Y = 0;
/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
/** Floor sits this far above the bottom edge of the viewport. */
const FLOOR_PADDING = 0.6;
const CAMERA_Y = FLOOR_Y - FLOOR_PADDING + VIEW_HEIGHT / 2;
/** Stage colour of the Base shapes v2 tool (`--bg: 255 255 255`). */
const BACKGROUND = "#ffffff";

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
 * Orthographic camera looking straight down -Z at the play plane. Zoom is set
 * so VIEW_HEIGHT world units always fill the viewport height, whatever the
 * aspect ratio, and the floor sits just above the bottom edge.
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

/** Visible half-width at the play plane and the world y of the top edge. */
function useViewBounds() {
  const { size } = useThree();
  return useMemo(() => {
    const halfWidth = (VIEW_HEIGHT / 2) * (size.width / size.height);
    return { halfWidth: Math.max(1.5, halfWidth - 0.05), topY: CAMERA_Y + VIEW_HEIGHT / 2 };
  }, [size.width, size.height]);
}

type Settings = {
  gravity: number;
  restitution: number;
  friction: number;
  impulse: number;
  faceCamera: boolean;
};

function World({ settings, generation }: { settings: Settings; generation: number }) {
  const { halfWidth, topY } = useViewBounds();
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
      <mesh position={[0, 12, -6]} onPointerDown={burst}>
        <planeGeometry args={[400, 400]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
    </Physics>
  );
}

/** The stage is just the tool's white paper: no lights, no floor, no shadows. */
function Stage() {
  return (
    <>
      <color attach="background" args={[BACKGROUND]} />
      <CameraRig />
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
        flat
        orthographic
        dpr={[1, 2]}
        camera={{ position: [0, CAMERA_Y, 40], near: 0.1, far: 100 }}
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
