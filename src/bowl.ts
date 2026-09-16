import * as THREE from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { BotGeometry, Quality, Sdf } from "./geometry";
import {
  INSIDE_GROUP,
  RIM_GROUP,
  RIM_SEGMENTS,
  bake,
  boundingRadius,
  clipTriangles,
  innerSurface,
  shellTones,
  triangleList,
  type Part,
  type Tri,
} from "./halfShell";
import { BODIES } from "./data/bodies";
import { SHAPES, type ShapeId } from "./data/shapes";
import { BOT_HUES, TOKENS, type TokenName } from "./data/tokens";

/**
 * The bowl: a bot body hollowed to a wall of `thickness` and cut by one
 * plane, keeping the part below it.
 *
 *   bowl = (body − erode(body, t)) ∩ { n·p ≤ d }
 *
 * in the bot's own frame (+z toward the camera, +y up), built the same way
 * as the exploded view's half shells (`halfShell.ts`): the outer face is the
 * body's analytic mesh, the inside is that mesh pushed inward onto the
 * sdf = −t level set, both plane-clipped, and the cut rim is the annulus
 * between the sdf = 0 and sdf = −t contours on the plane, ray-marched from
 * the plane's foot point. Tones as there: face, lighter rim, darker inside.
 *
 * The plane passes through the body's vertical axis at `height` (fraction of
 * the body's height) and is tilted toward the camera by `angle`, so from
 * straight on the rim is an ellipse whose front lip dips and back rises,
 * showing the inside wall.
 */

/** Keep the half-space n·p ≤ d (body units). */
export type CutPlane = { n: THREE.Vector3; d: number };

export function cutPlane(angleDeg: number, height: number): CutPlane {
  const a = (angleDeg * Math.PI) / 180;
  const n = new THREE.Vector3(0, Math.cos(a), Math.sin(a));
  const y0 = 2 * height - 1;
  return { n, d: y0 * Math.cos(a) };
}

/** Signed height above the plane (body units), positive on the removed side. */
export const abovePlane = (plane: CutPlane, x: number, y: number, z: number) => plane.n.x * x + plane.n.y * y + plane.n.z * z - plane.d;

/** Distance along `dir` from `origin` where `sdf` crosses `level` (bisection; the section is star-shaped about the foot point). */
function marchTo(sdf: Sdf, origin: THREE.Vector3, dir: THREE.Vector3, level: number, rMax: number): number {
  if (sdf(origin.x, origin.y, origin.z) - level > 0) return 0;
  let lo = 0, hi = rMax;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (sdf(origin.x + dir.x * mid, origin.y + dir.y * mid, origin.z + dir.z * mid) - level <= 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** The flat cut rim on the plane: quads between the sdf = −t and sdf = 0 contours, facing +n (toward the removed part). */
function rimOnPlane(sdf: Sdf, plane: CutPlane, t: number, rMax: number, segments: number): Tri[] {
  const foot = plane.n.clone().multiplyScalar(plane.d);
  const e1 = new THREE.Vector3(1, 0, 0);
  if (Math.abs(plane.n.x) > 0.9) e1.set(0, 0, 1);
  e1.sub(plane.n.clone().multiplyScalar(e1.dot(plane.n))).normalize();
  // e1 × e2 = n, so a ring built counter-clockwise in (e1, e2) faces +n.
  const e2 = new THREE.Vector3().crossVectors(plane.n, e1).normalize();
  const dir = new THREE.Vector3();
  const ro: number[] = [], ri: number[] = [];
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments;
    dir.copy(e1).multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
    ro.push(marchTo(sdf, foot, dir, 0, rMax));
    ri.push(marchTo(sdf, foot, dir, -t, rMax));
  }
  const at = (r: number, a: number, out: number[]) => {
    out.push(foot.x + r * (e1.x * Math.cos(a) + e2.x * Math.sin(a)));
    out.push(foot.y + r * (e1.y * Math.cos(a) + e2.y * Math.sin(a)));
    out.push(foot.z + r * (e1.z * Math.cos(a) + e2.z * Math.sin(a)));
  };
  const out: Tri[] = [];
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    const a0 = (2 * Math.PI * k) / segments, a1 = (2 * Math.PI * k1) / segments;
    const A: number[] = [], B: number[] = [];
    at(ri[k], a0, A); at(ro[k], a0, A); at(ro[k1], a1, A);
    at(ri[k], a0, B); at(ro[k1], a1, B); at(ri[k1], a1, B);
    out.push(A as Tri, B as Tri);
  }
  return out;
}

/**
 * The bowl body as a `BotGeometry` `Figure` can draw (no eyes; see
 * `bowlEyes`). `thickness` is a fraction of the body's bounding radius.
 */
export function buildBowl(bot: BotGeometry, sdf: Sdf, thickness: number, color: string, quality: Quality, plane: CutPlane): BotGeometry {
  const tones = shellTones(color);
  const scale = bot.scale;
  const rBody = boundingRadius(bot.geometry) / scale;
  const t = thickness * rBody;
  const outer = triangleList(bot.geometry, scale);
  const inner = innerSurface(bot.geometry, scale, sdf, t);
  // `clipTriangles` keeps n·p ≥ d; the bowl keeps n·p ≤ d.
  const keep = plane.n.clone().negate();
  const tris: Tri[] = [];
  const parts: Part[] = [];
  const add = (list: Tri[], part: Part) => {
    for (const tri of list) {
      tris.push(tri);
      parts.push(part);
    }
  };
  add(clipTriangles(outer, keep, -plane.d), "face");
  const rimStart = tris.length * 3;
  add(rimOnPlane(sdf, plane, t, rBody * 1.5, RIM_SEGMENTS[quality]), "rim");
  const insideStart = tris.length * 3;
  add(clipTriangles(inner, keep, -plane.d), "inside");
  const geometry = bake(tris, parts, tones, scale);
  geometry.addGroup(0, rimStart, 0);
  geometry.addGroup(rimStart, insideStart - rimStart, RIM_GROUP);
  geometry.addGroup(insideStart, tris.length * 3 - insideStart, INSIDE_GROUP);
  const half = new THREE.Vector3();
  geometry.boundingBox!.getSize(half).multiplyScalar(0.5);
  return {
    shape: bot.shape,
    geometry,
    eyes: [],
    eyeNormals: [],
    scale,
    halfExtents: half,
    hullPoints: geometry.attributes.position.array as Float32Array,
  };
}

/**
 * Screen-space height (body units) of the rim where it crosses `x` on the
 * front, for a spherical body: the lowest point of the opening at that x.
 * Returns null when the rim does not reach that x.
 */
export function frontLipAt(plane: CutPlane, x: number): number | null {
  const rho2 = 1 - plane.d * plane.d - x * x;
  if (rho2 < 0) return null;
  const sin = plane.n.z, cos = plane.n.y;
  return plane.d * cos - sin * Math.sqrt(rho2);
}

/** Point on the unit sphere's front at (x, y), or null when off the body. */
const frontZ = (x: number, y: number) => {
  const z2 = 1 - x * x - y * y;
  return z2 >= 0 ? Math.sqrt(z2) : null;
};

/** Lowest the bowl's eyes are charted (body units): below this they would sit at the base. */
const EYE_FLOOR = -0.62;
/** Clearance kept between an eye pill's top and the cut, body units. */
const EYE_MARGIN = 0.035;

/**
 * Height for the bowl's eye formation (body units): the toolkit position when
 * the cut clears it, otherwise the highest position at which both pills sit
 * wholly under the plane with a small margin. Returns the `shiftY` to use.
 */
export function bowlEyeShift(plane: CutPlane, id: ShapeId = "blob"): number {
  const f = BODIES[id].eyes;
  const hh = f.height / 2;
  const xs = [f.shiftX - f.gap / 2, f.shiftX + f.gap / 2].flatMap((cx) => [cx - f.width / 2, cx + f.width / 2]);
  const clear = (shiftY: number) => {
    for (const x of xs) {
      const yTop = shiftY + hh;
      const z = frontZ(x, yTop);
      if (z === null) return false;
      if (abovePlane(plane, x, yTop, z) > -EYE_MARGIN) return false;
    }
    return true;
  };
  if (clear(f.shiftY)) return f.shiftY;
  let lo = EYE_FLOOR, hi = f.shiftY;
  if (!clear(lo)) return lo;
  for (let k = 0; k < 30; k++) {
    const mid = (lo + hi) / 2;
    if (clear(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Eye pills clipped to the kept side of the plane (nothing floats above the
 * cut). Pills entirely below it are returned as they are; a clipped pill is
 * re-indexed so the Canvas 2D renderer can still trace its silhouette.
 */
export function clipEyes(eyes: THREE.BufferGeometry[], plane: CutPlane, scale: number): THREE.BufferGeometry[] {
  const keep = plane.n.clone().negate();
  return eyes.map((g) => {
    const pos = g.attributes.position as THREE.BufferAttribute;
    let crosses = false;
    for (let i = 0; i < pos.count && !crosses; i++) {
      if (abovePlane(plane, pos.getX(i) / scale, pos.getY(i) / scale, pos.getZ(i) / scale) > 0) crosses = true;
    }
    if (!crosses) return g;
    const tris = clipTriangles(triangleList(g, scale), keep, -plane.d);
    const positions = new Float32Array(tris.length * 9);
    for (let i = 0; i < tris.length; i++) for (let k = 0; k < 9; k++) positions[i * 9 + k] = tris[i][k] * scale;
    const raw = new THREE.BufferGeometry();
    raw.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    const merged = mergeVertices(raw, 1e-6);
    raw.dispose();
    merged.computeVertexNormals();
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return merged;
  });
}

// ── The cast ────────────────────────────────────────────────────────────────

/** mulberry32: a small seeded generator, uniform in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const randomSeed = () => Math.floor(Math.random() * 1_000_000);

/** A place in the bowl, in bowl body units (unit sphere): across, depth, and the size relative to `inner size`. */
export type Slot = { x: number; z: number; scale: number };

/**
 * Four hand-placed slots: two in front, lower and full size; two behind,
 * further out toward the wall so they settle higher up it, at 0.9. Heads
 * overlap a little from the front.
 */
export const SLOTS: readonly Slot[] = [
  { x: -0.26, z: 0.52, scale: 1 },
  { x: 0.26, z: 0.55, scale: 1 },
  { x: -0.55, z: -0.33, scale: 0.9 },
  { x: 0.55, z: -0.36, scale: 0.9 },
];

/** Largest seeded yaw and lean, degrees. */
export const JITTER_DEG = 10;

export type CastMember = {
  shape: ShapeId;
  hue: TokenName;
  color: string;
  slot: Slot;
  /** Degrees. */
  yaw: number;
  lean: number;
};

/** Bodies the inner bots are drawn from: the toolkit's, less the bowl's own. */
export const CAST_SHAPES: readonly ShapeId[] = SHAPES.map((s) => s.id).filter((id) => id !== "blob" && id !== "dome");

function shuffle<T>(list: readonly T[], next: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Four distinct shapes and four distinct token colours, none the shell's, from `seed`. */
export function pickCast(seed: number, shellColor: string): CastMember[] {
  const next = rng(seed);
  const shapes = shuffle(CAST_SHAPES, next).slice(0, SLOTS.length);
  const shell = shellColor.trim().toLowerCase();
  const hues = shuffle(BOT_HUES.filter((h) => TOKENS[h].toLowerCase() !== shell), next).slice(0, SLOTS.length);
  return SLOTS.map((slot, i) => ({
    shape: shapes[i],
    hue: hues[i],
    color: TOKENS[hues[i]],
    slot,
    yaw: (next() * 2 - 1) * JITTER_DEG,
    lean: (next() * 2 - 1) * JITTER_DEG,
  }));
}

/** Points sampled from a geometry for the settle test, at most about this many. */
const SETTLE_SAMPLES = 900;

/**
 * Drop a bot into the bowl: the lowest height (bowl body units) at which
 * every sampled vertex of the posed bot is still inside the cavity
 * (bowl sdf ≤ −wall), i.e. resting on the inner wall at its first contact,
 * wherever on the bot that is. `toBowl` maps the bot's own geometry units to
 * bowl units (mesh scale over the bowl's world radius) and `rotation` is its
 * pose. Returns the height and whether a resting position was found; if the
 * bot cannot fit at all, it is set with its lowest point on the floor.
 */
export function settle(
  points: Float32Array,
  toBowl: number,
  rotation: THREE.Matrix4,
  slot: Slot,
  bowlSdf: Sdf,
  wall: number,
): { y: number; rests: boolean } {
  const count = points.length / 3;
  const stride = Math.max(1, Math.floor(count / SETTLE_SAMPLES));
  const local: number[] = [];
  const v = new THREE.Vector3();
  let minY = Infinity;
  for (let i = 0; i < count; i += stride) {
    v.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]).multiplyScalar(toBowl).applyMatrix4(rotation);
    local.push(v.x, v.y, v.z);
    if (v.y < minY) minY = v.y;
  }
  const inside = (y: number) => {
    for (let i = 0; i < local.length; i += 3) {
      if (bowlSdf(local[i] + slot.x, local[i + 1] + y, local[i + 2] + slot.z) > -wall + 1e-4) return false;
    }
    return true;
  };
  // Coarse scan from the top of the cavity down for the lowest height still inside, then refine.
  const step = 0.04;
  let found: number | null = null;
  for (let y = 1; y >= -1.5; y -= step) {
    if (inside(y)) found = y;
    else if (found !== null) break;
  }
  if (found === null) return { y: -(1 - wall) - minY, rests: false };
  let lo = found - step, hi = found;
  for (let k = 0; k < 28; k++) {
    const mid = (lo + hi) / 2;
    if (inside(mid)) hi = mid;
    else lo = mid;
  }
  return { y: hi, rests: true };
}
