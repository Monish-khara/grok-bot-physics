import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SHAPES, type BotShape } from "./data/shapes";
import { BODIES, type BodyDef, type EyeFormation, type Pt2 } from "./data/bodies";

/** World units per body unit for a bot of eye-formation size 1. */
export const WORLD_PER_BODY = 0.68;
/** Marching-cubes grid resolution per axis. */
const RESOLUTION = 64;
/** Body units are scaled by this to fit the [-1, 1] marching-cubes box. */
const GRID_SCALE = 0.78;
/** How far eyes float above the surface, in body units. */
const EYE_LIFT = 0.012;

type Sdf = (x: number, y: number, z: number) => number;

export type BotGeometry = {
  shape: BotShape;
  /** Body mesh in world units, centred. */
  geometry: THREE.BufferGeometry;
  /** Two eye meshes in world units, in the body's frame. */
  eyes: THREE.BufferGeometry[];
  /** World scale of this bot relative to the hero sphere. */
  scale: number;
  halfExtents: THREE.Vector3;
  hullPoints: Float32Array;
};

// ── 2D signed distance to a closed polygon ──────────────────────────────────

function polygonSdf(loop: readonly Pt2[]): (x: number, y: number) => number {
  const n = loop.length;
  return (px, py) => {
    let d = Infinity;
    let sign = 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, ay] = loop[i];
      const [bx, by] = loop[j];
      const ex = bx - ax, ey = by - ay;
      const wx = px - ax, wy = py - ay;
      const t = Math.max(0, Math.min(1, (wx * ex + wy * ey) / (ex * ex + ey * ey || 1)));
      const dx = wx - ex * t, dy = wy - ey * t;
      d = Math.min(d, dx * dx + dy * dy);
      // Even-odd crossing test folded into the same loop.
      const c1 = ay <= py, c2 = by <= py;
      if (c1 !== c2 && (ex * wy - ey * wx > 0) === c2) sign = -sign;
    }
    return sign * Math.sqrt(d);
  };
}

/** Cache a 2D SDF on a grid so the 3D fill stays cheap. */
function gridded2d(sdf: (x: number, y: number) => number, res: number, extent: number) {
  const table = new Float32Array(res * res);
  const step = (2 * extent) / (res - 1);
  for (let j = 0; j < res; j++)
    for (let i = 0; i < res; i++) table[j * res + i] = sdf(-extent + i * step, -extent + j * step);
  return (x: number, y: number) => {
    const fx = Math.max(0, Math.min(res - 1.001, (x + extent) / step));
    const fy = Math.max(0, Math.min(res - 1.001, (y + extent) / step));
    const i = Math.floor(fx), j = Math.floor(fy);
    const u = fx - i, v = fy - j;
    const a = table[j * res + i], b = table[j * res + i + 1];
    const c = table[(j + 1) * res + i], d = table[(j + 1) * res + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  };
}

// ── Body SDFs, in body units ─────────────────────────────────────────────────

function bodySdf(def: BodyDef): Sdf {
  switch (def.kind) {
    case "sphere":
      return (x, y, z) => Math.hypot(x, y, z) - 1;

    case "box": {
      const r = def.round;
      const hx = def.hx - r, hy = def.hy - r, hz = def.hz - r;
      return (x, y, z) => {
        const qx = Math.abs(x) - hx, qy = Math.abs(y) - hy, qz = Math.abs(z) - hz;
        const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0));
        return outside + Math.min(Math.max(qx, qy, qz), 0) - r;
      };
    }

    case "slab": {
      // Rounded slab: the outline inset by `bevel`, then inflated by a sphere of
      // radius `bevel`, so the mid-plane silhouette is the drawn outline exactly.
      const d2 = gridded2d(polygonSdf(def.loop), 128, 1.3);
      const flat = def.halfDepth - def.bevel;
      return (x, y, z) => {
        const qx = d2(x, y) + def.bevel;
        const qy = Math.abs(z) - flat;
        return Math.min(Math.max(qx, qy), 0) + Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - def.bevel;
      };
    }

    case "loft": {
      // Cross-sections are the outline scaled by cos(phi)^exponent at
      // z = depth * sin(phi) — the tool's roundedLoft.
      const d2 = gridded2d(polygonSdf(def.ring), 128, 1.3);
      const k = def.exponent / 2;
      return (x, y, z) => {
        const t = Math.abs(z) / def.depth;
        if (t >= 1) return Math.abs(z) - def.depth + 0.02;
        const s = Math.max(1e-3, Math.pow(1 - t * t, k));
        return Math.max(d2(x / s, y / s) * s, Math.abs(z) - def.depth);
      };
    }

    case "revolve": {
      // Profile is (radius, y) from bottom to top; close it down the axis.
      const prof = def.profile;
      const loop: Pt2[] = [...prof.map(([r, y]) => [r, y] as Pt2), ...[...prof].reverse().map(([r, y]) => [-r, y] as Pt2)];
      const d2 = gridded2d(polygonSdf(loop), 128, 1.3);
      return (x, y, z) => d2(Math.hypot(x, z), y);
    }

    case "capsuleX":
      return (x, y, z) => {
        const cx = Math.max(-def.halfSpan, Math.min(def.halfSpan, x));
        return Math.hypot(x - cx, y, z) - def.radius;
      };
  }
}

// ── Surface extraction ───────────────────────────────────────────────────────

let cubes: MarchingCubes | null = null;

function extractSurface(sdf: Sdf): THREE.BufferGeometry {
  if (!cubes) {
    cubes = new MarchingCubes(RESOLUTION, new THREE.MeshBasicMaterial(), false, false, 120000);
    cubes.isolation = 0;
  }
  const size = RESOLUTION, half = size / 2;
  const field = cubes.field;
  for (let z = 0; z < size; z++) {
    const gz = (z - half) / half;
    for (let y = 0; y < size; y++) {
      const gy = (y - half) / half;
      const row = size * size * z + size * y;
      for (let x = 0; x < size; x++) {
        const gx = (x - half) / half;
        // Inside is positive for MarchingCubes; the field is in grid units.
        field[row + x] = -sdf(gx / GRID_SCALE, gy / GRID_SCALE, gz / GRID_SCALE) * GRID_SCALE;
      }
    }
  }
  cubes.update();
  const count = cubes.count;
  const positions = new Float32Array(count * 3);
  positions.set(cubes.positionArray.subarray(0, count * 3));
  for (let i = 0; i < positions.length; i++) positions[i] /= GRID_SCALE;

  const raw = new THREE.BufferGeometry();
  raw.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const merged = mergeVertices(raw, 1e-4);
  raw.dispose();
  ensureOutwardWinding(merged);
  merged.computeVertexNormals();
  return merged;
}

/**
 * MarchingCubes winds its triangles for a "field grows inward" convention,
 * which for our SDF sign comes out inside-out. A flat unlit fill hides that,
 * but raycasting (clicks, drags) culls back faces — so make the winding
 * outward by checking the signed volume.
 */
function ensureOutwardWinding(g: THREE.BufferGeometry) {
  const idx = g.getIndex();
  const pos = g.attributes.position;
  if (!idx) return;
  let volume = 0;
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    const ax = pos.getX(a), ay = pos.getY(a), az = pos.getZ(a);
    const bx = pos.getX(b), by = pos.getY(b), bz = pos.getZ(b);
    const cx = pos.getX(c), cy = pos.getY(c), cz = pos.getZ(c);
    volume += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  if (volume >= 0) return;
  for (let i = 0; i < idx.count; i += 3) {
    const b = idx.getX(i + 1);
    idx.setX(i + 1, idx.getX(i + 2));
    idx.setX(i + 2, b);
  }
  idx.needsUpdate = true;
}

// ── Eyes ────────────────────────────────────────────────────────────────────

/** A stadium (or circle) outline, y up, centred on the origin. */
function stadium(width: number, height: number, segments = 14): Pt2[] {
  const r = width / 2;
  const straight = Math.max(0, height / 2 - r);
  const pts: Pt2[] = [];
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI * (i / segments);
    pts.push([r * Math.cos(a), straight + r * Math.sin(a)]);
  }
  for (let i = 0; i <= segments; i++) {
    const a = Math.PI + Math.PI * (i / segments);
    pts.push([r * Math.cos(a), -straight + r * Math.sin(a)]);
  }
  return pts;
}

/**
 * A pill draped onto the body: every vertex is pushed along +z until it meets
 * the surface, then lifted a hair off it. That is how the tool charts its eyes
 * on the body surface, so they turn with the volume instead of floating.
 */
function eyeGeometry(sdf: Sdf, cx: number, cy: number, width: number, height: number): THREE.BufferGeometry {
  const outline = stadium(width, height);
  const rings = 3;
  const verts: number[] = [];
  const index: number[] = [];

  const surfaceZ = (x: number, y: number) => {
    let z = 1.6;
    let prev = sdf(x, y, z);
    for (let i = 0; i < 64; i++) {
      const nz = z - 0.05;
      const d = sdf(x, y, nz);
      if (d <= 0) {
        // Refine the crossing.
        let lo = nz, hi = z;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) / 2;
          if (sdf(x, y, mid) <= 0) lo = mid;
          else hi = mid;
        }
        return (lo + hi) / 2;
      }
      z = nz;
      prev = d;
      if (nz < -1.6) break;
    }
    void prev;
    return 0;
  };

  const push = (x: number, y: number) => {
    const z = surfaceZ(x, y);
    const e = 0.01;
    const nx = sdf(x + e, y, z) - sdf(x - e, y, z);
    const ny = sdf(x, y + e, z) - sdf(x, y - e, z);
    const nz = sdf(x, y, z + e) - sdf(x, y, z - e);
    const len = Math.hypot(nx, ny, nz) || 1;
    verts.push(x + (nx / len) * EYE_LIFT, y + (ny / len) * EYE_LIFT, z + (nz / len) * EYE_LIFT);
    return verts.length / 3 - 1;
  };

  const centre = push(cx, cy);
  const n = outline.length;
  const ringStart: number[] = [];
  for (let r = 1; r <= rings; r++) {
    const k = r / rings;
    ringStart.push(verts.length / 3);
    for (const [ox, oy] of outline) push(cx + ox * k, cy + oy * k);
  }
  for (let i = 0; i < n; i++) {
    const a = ringStart[0] + i, b = ringStart[0] + ((i + 1) % n);
    index.push(centre, a, b);
  }
  for (let r = 1; r < rings; r++) {
    const inner = ringStart[r - 1], outer = ringStart[r];
    for (let i = 0; i < n; i++) {
      const i1 = (i + 1) % n;
      index.push(inner + i, outer + i, outer + i1);
      index.push(inner + i, outer + i1, inner + i1);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

function eyeGeometries(sdf: Sdf, f: EyeFormation): THREE.BufferGeometry[] {
  return [-1, 1].map((side) => eyeGeometry(sdf, f.shiftX + (side * f.gap) / 2, f.shiftY, f.width, f.height));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildBotGeometry(shape: BotShape): BotGeometry {
  const { body, eyes } = BODIES[shape.id];
  const sdf = bodySdf(body);
  const scale = WORLD_PER_BODY * eyes.size;

  const geometry = extractSurface(sdf);
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  const half = new THREE.Vector3();
  geometry.boundingBox!.getSize(half).multiplyScalar(0.5);

  const eyeGeoms = eyeGeometries(sdf, eyes);
  for (const g of eyeGeoms) g.scale(scale, scale, scale);

  return {
    shape,
    geometry,
    eyes: eyeGeoms,
    scale,
    halfExtents: half,
    hullPoints: geometry.attributes.position.array as Float32Array,
  };
}

let cache: BotGeometry[] | null = null;

export function getBotGeometries(): BotGeometry[] {
  if (!cache) cache = SHAPES.map(buildBotGeometry);
  return cache;
}
