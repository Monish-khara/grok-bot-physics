import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { CuboidCollider, Physics, RigidBody, type RapierRigidBody } from "@react-three/rapier";
import { button, folder, useControls } from "leva";
import { Bot } from "./Bot";
import { getBotGeometries } from "./geometry";
import { BOT_HUES, TOKENS } from "./data/tokens";
import { StatusOverlay, detectWebGL, useGlobalErrors, useRapierReady } from "./Status";

/**
 * Front-to-back thickness of the play space at bot scale 1; keeps the pile
 * readable. Scales with the bots so a 2x troop still fits between the slabs.
 */
const SLAB_DEPTH = 3.2;
/** Typical bot diameter in world units at bot scale 1, for spawn spacing. */
const BOT_SIZE = 1.6;
const FLOOR_Y = 0;
/** World units visible top-to-bottom; width follows the aspect ratio. */
const VIEW_HEIGHT = 10;
/** Floor sits this far above the bottom edge of the viewport. */
const FLOOR_PADDING = 0.6;
const CAMERA_Y = FLOOR_Y - FLOOR_PADDING + VIEW_HEIGHT / 2;
/** Stage colour of the Base shapes v2 tool (`--bg: 255 255 255`). */
const BACKGROUND = { r: 255, g: 255, b: 255 };

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

type Spawn = {
  position: [number, number, number];
  rotation: [number, number, number];
};

/** `?lineup` drops the troop in one evenly spaced, upright row — for screenshots. */
const LINEUP = typeof location !== "undefined" && new URLSearchParams(location.search).has("lineup");

function randomSpawns(count: number, halfWidth: number, topY: number, faceCamera: boolean, scale: number): Spawn[] {
  const size = BOT_SIZE * scale;
  if (LINEUP) {
    const span = 2 * halfWidth - size * 1.2;
    return Array.from({ length: count }, (_, i) => ({
      position: [-halfWidth + size * 0.6 + (span * (i + 0.5)) / count, topY + 0.5 * scale, 0],
      rotation: [0, 0, 0],
    }));
  }
  // Drop within a narrow column so the bots actually pile up rather than
  // landing in a row across the whole viewport.
  const spread = Math.min(3 * scale, Math.max(0.3, halfWidth - size));
  // Keep every spawn clear of the side walls, whatever the scale and aspect.
  const maxX = Math.max(0, halfWidth - size * 0.65);
  const depthRoom = Math.max(0, (SLAB_DEPTH * scale) / 2 - size * 0.5);
  // Two staggered columns so the whole troop is in view within a second.
  return Array.from({ length: count }, (_, i) => ({
    position: [
      (i % 2 === 0 ? -1 : 1) * Math.min(maxX, 0.9 * scale + Math.random() * spread),
      topY + (0.5 + Math.floor(i / 2) * 1.8 + Math.random() * 0.4) * scale,
      faceCamera ? 0 : (Math.random() * 2 - 1) * depthRoom,
    ],
    rotation: [
      faceCamera ? 0 : (Math.random() - 0.5) * 0.9,
      faceCamera ? 0 : (Math.random() - 0.5) * 1.4,
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
  dragSpin: number;
  righting: number;
  botScale: number;
};

const tmpQ = new THREE.Quaternion();
const tmpAxis = new THREE.Vector3();

/**
 * A soft weeble torque that swings each bot back toward its rest pose (face
 * to the camera, eyes upright) after it tumbles. Rotation stays fully free —
 * kicks and drags spin them in 3D — this only decides where they settle, so
 * the eyes end up readable.
 */
function useRighting(
  bodies: React.RefObject<(RapierRigidBody | null)[]>,
  gain: number,
  gravity: number,
  enabled: boolean,
) {
  useFrame((_, dt) => {
    if (!enabled || gain <= 0) return;
    const g = Math.max(gravity, 4);
    const step = Math.min(dt, 1 / 30);
    for (const body of bodies.current ?? []) {
      if (!body || body.gravityScale() === 0) continue; // being dragged
      const r = body.rotation();
      // Rotation that takes the current pose back to identity, as axis-angle.
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
      body.applyTorqueImpulse({ x: tmpAxis.x * torque, y: tmpAxis.y * torque, z: tmpAxis.z * torque }, true);
    }
  });
}

function World({ settings, generation }: { settings: Settings; generation: number }) {
  const { halfWidth, topY } = useViewBounds();
  const bots = useMemo(() => getBotGeometries(), []);
  const bodies = useRef<(RapierRigidBody | null)[]>([]);
  useRighting(bodies, settings.righting, settings.gravity, !settings.faceCamera);
  useEffect(() => {
    // Test hooks: let headless checks know the bots are in the world and
    // where each one is (world units, y up; the camera looks down -Z).
    const w = window as unknown as {
      __grokBotsReady?: boolean;
      __grokBotPositions?: () => { id: string; x: number; y: number; z: number }[];
    };
    w.__grokBotsReady = true;
    w.__grokBotPositions = () =>
      bodies.current.flatMap((b, i) => {
        if (!b) return [];
        const p = b.translation();
        return [{ id: bots[i].shape.id, x: p.x, y: p.y, z: p.z }];
      });
  }, [bots]);

  const spawns = useMemo(
    () => randomSpawns(bots.length, halfWidth, topY, settings.faceCamera, settings.botScale),
    // Re-roll on respawn only; resizing the window or moving a slider
    // shouldn't re-drop the pile. Scale is read at drop time for spacing;
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

  // Mass grows with the cube of the scale; scale impulses the same way so a
  // tap launches a 2x bot as high as a 1x one.
  const massFactor = settings.botScale ** 3;

  const tap = useCallback(
    (body: RapierRigidBody) => {
      const s = settings.impulse * massFactor;
      body.applyImpulse({ x: (Math.random() - 0.5) * s * 0.3, y: s, z: 0 }, true);
      body.applyTorqueImpulse(
        { x: (Math.random() - 0.5) * s * 0.4, y: (Math.random() - 0.5) * s * 0.4, z: (Math.random() - 0.5) * s * 0.6 },
        true,
      );
    },
    [settings.impulse, massFactor],
  );

  const burst = useCallback(
    (e: ThreeEvent<PointerEvent>) => {
      const origin = e.point;
      const strength = settings.impulse * 1.6 * massFactor;
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
    [settings.impulse, massFactor],
  );

  // The slab widens live when bots grow, but only narrows on Respawn: pulling
  // the front/back walls in past bots that are already sitting deep would
  // leave them outside the floor. So track the largest scale since the drop.
  const [slabScale, setSlabScale] = useState(settings.botScale);
  useEffect(() => {
    setSlabScale((s) => Math.max(s, settings.botScale));
  }, [settings.botScale]);
  useEffect(() => {
    setSlabScale(settings.botScale);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation]);

  const wallH = 60;
  const wallT = 0.5;
  const slabDepth = SLAB_DEPTH * Math.max(slabScale, settings.botScale);

  return (
    <Physics gravity={[0, -settings.gravity, 0]} timeStep={1 / 60}>
      {/* Floor and walls. Walls sit exactly at the viewport edges for this aspect ratio. */}
      <RigidBody type="fixed" friction={settings.friction} restitution={settings.restitution}>
        <CuboidCollider args={[halfWidth + 6, wallT, slabDepth]} position={[0, FLOOR_Y - wallT, 0]} />
        <CuboidCollider args={[wallT, wallH, slabDepth]} position={[-halfWidth - wallT, wallH - 2, 0]} />
        <CuboidCollider args={[wallT, wallH, slabDepth]} position={[halfWidth + wallT, wallH - 2, 0]} />
        <CuboidCollider args={[halfWidth + 6, wallH, wallT]} position={[0, wallH - 2, -slabDepth / 2 - wallT]} />
        <CuboidCollider args={[halfWidth + 6, wallH, wallT]} position={[0, wallH - 2, slabDepth / 2 + wallT]} />
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
          dragSpin={settings.dragSpin}
          scale={settings.botScale}
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

/** The stage is just the tool's paper: a flat colour, no lights, no floor, no shadows. */
function Stage({ background }: { background: string }) {
  return (
    <>
      <color attach="background" args={[background]} />
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
    dragSpin: { value: 0.35, min: 0.05, max: 1.5, step: 0.05, label: "drag spin" },
    righting: { value: 1, min: 0, max: 3, step: 0.05, label: "face seeking" },
    botScale: { value: 1, min: 0.5, max: 2, step: 0.05, label: "bot scale" },
    faceCamera: { value: false, label: "face camera" },
    Respawn: button(() => setGeneration((g) => g + 1)),
    Look: folder({
      background: { value: BACKGROUND, label: "background" },
    }),
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
        <Stage background={background} />
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
