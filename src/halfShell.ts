import * as THREE from "three";
import type { BotGeometry, Quality, Sdf } from "./geometry";

/**
 * Hollow half-shells of any bot body, for the exploded view.
 *
 *   shell = body − erode(body, thickness)
 *   halves = shell ∩ { z ≥ 0 }  (front, carries the eyes)  and  shell ∩ { z ≤ 0 }  (back)
 *
 * in the bot's own frame, where +z is the direction it faces and also the
 * explode axis, so the cut plane z = 0 is perpendicular to the slide.
 *
 * Built from the body's own mesh rather than by re-sampling its SDF: the
 * outer face is the analytic mesh the toolkit shapes already have (exact
 * silhouettes), the inside is that mesh pushed inward along its vertex
 * normals and then Newton-snapped onto the SDF's −thickness level set, both
 * are clipped at the plane, and the flat cut rim is the annulus between the
 * body's sdf = 0 and sdf = −thickness contours on the plane, ray-marched per
 * angle (every body used is star-shaped about its centre). Each triangle
 * carries one flat tone as a vertex colour: the token colour on the face,
 * lighter on the cut rim, darker inside.
 */

export type ShellTones = { face: string; rim: string; inside: string };

/** Face = the token colour; rim mixed 25% toward white; inside mixed 25% toward black. */
export function shellTones(color: string): ShellTones {
  const c = new THREE.Color(color);
  const rim = c.clone().lerp(new THREE.Color("#ffffff"), 0.25);
  const inside = c.clone().lerp(new THREE.Color("#000000"), 0.25);
  return { face: `#${c.getHexString()}`, rim: `#${rim.getHexString()}`, inside: `#${inside.getHexString()}` };
}

export type Part = "face" | "rim" | "inside";
/** Geometry group / material indices (see `buildHalfShells`). */
export const RIM_GROUP = 1;
export const INSIDE_GROUP = 2;
export type Tri = [number, number, number, number, number, number, number, number, number];

/** Rim segments around the cut. */
export const RIM_SEGMENTS: Record<Quality, number> = { high: 256, low: 128, sketch: 72 };
/**
 * Each half's outer face runs this far past the cut plane (fraction of the
 * bounding radius). Assembled, the two lips overlap on the same surface in
 * the same colour, so the face — not the lighter rim — is what anti-aliases
 * along the seam; exploded, a lip this thin is under a pixel.
 */
const FACE_LIP = 0.004;

/** Half-space clip: keep the part of each triangle with n·p ≥ d, cutting crossing triangles exactly at the plane. */
export function clipTriangles(tris: Tri[], n: THREE.Vector3, d: number): Tri[] {
  const out: Tri[] = [];
  const side = (t: Tri, i: number) => n.x * t[i * 3] + n.y * t[i * 3 + 1] + n.z * t[i * 3 + 2] - d;
  const lerp = (t: Tri, a: number, b: number, k: number) => [
    t[a * 3] + (t[b * 3] - t[a * 3]) * k,
    t[a * 3 + 1] + (t[b * 3 + 1] - t[a * 3 + 1]) * k,
    t[a * 3 + 2] + (t[b * 3 + 2] - t[a * 3 + 2]) * k,
  ];
  const pt = (t: Tri, i: number) => [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
  for (const t of tris) {
    const s = [side(t, 0), side(t, 1), side(t, 2)];
    const inside = s.map((v) => v >= 0);
    const count = inside.filter(Boolean).length;
    if (count === 3) {
      out.push(t);
      continue;
    }
    if (count === 0) continue;
    // Rotate so the odd vertex (alone on its side) is first, keeping the winding.
    const a = count === 1 ? inside.indexOf(true) : inside.indexOf(false);
    const b = (a + 1) % 3, c = (a + 2) % 3;
    const pab = lerp(t, a, b, s[a] / (s[a] - s[b]));
    const pac = lerp(t, a, c, s[a] / (s[a] - s[c]));
    if (count === 1) out.push([...pt(t, a), ...pab, ...pac] as Tri);
    else {
      out.push([...pab, ...pt(t, b), ...pt(t, c)] as Tri);
      out.push([...pab, ...pt(t, c), ...pac] as Tri);
    }
  }
  return out;
}

/** Swap two corners of every triangle (reverses the facing). */
function flip(tris: Tri[]): Tri[] {
  for (const t of tris) {
    const x = t[3], y = t[4], z = t[5];
    t[3] = t[6]; t[4] = t[7]; t[5] = t[8];
    t[6] = x; t[7] = y; t[8] = z;
  }
  return tris;
}

/** The mesh as a flat triangle list in body units (positions divided by `scale`). */
export function triangleList(geometry: THREE.BufferGeometry, scale: number): Tri[] {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const out: Tri[] = [];
  for (let i = 0; i < count; i += 3) {
    const t = new Array(9) as Tri;
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(i + k) : i + k;
      t[k * 3] = pos.getX(v) / scale;
      t[k * 3 + 1] = pos.getY(v) / scale;
      t[k * 3 + 2] = pos.getZ(v) / scale;
    }
    out.push(t);
  }
  return out;
}

/**
 * The inner surface: every vertex moved inward along its (smooth) normal by
 * `t`, then pulled onto the sdf = −t level set with a few Newton steps so the
 * wall is `t` thick wherever the offset is well defined.
 */
export function innerSurface(geometry: THREE.BufferGeometry, scale: number, sdf: Sdf, t: number): Tri[] {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  let normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
  if (!normal) {
    geometry.computeVertexNormals();
    normal = geometry.attributes.normal as THREE.BufferAttribute;
  }
  const moved = new Float32Array(pos.count * 3);
  const e = 0.004;
  for (let i = 0; i < pos.count; i++) {
    let x = pos.getX(i) / scale - normal.getX(i) * t;
    let y = pos.getY(i) / scale - normal.getY(i) * t;
    let z = pos.getZ(i) / scale - normal.getZ(i) * t;
    for (let k = 0; k < 4; k++) {
      const d = sdf(x, y, z) + t;
      if (Math.abs(d) < 1e-5) break;
      const gx = sdf(x + e, y, z) - sdf(x - e, y, z);
      const gy = sdf(x, y + e, z) - sdf(x, y - e, z);
      const gz = sdf(x, y, z + e) - sdf(x, y, z - e);
      const len2 = (gx * gx + gy * gy + gz * gz) / (4 * e * e) || 1;
      const k2 = d / len2 / (2 * e);
      x -= gx * k2;
      y -= gy * k2;
      z -= gz * k2;
    }
    moved[i * 3] = x;
    moved[i * 3 + 1] = y;
    moved[i * 3 + 2] = z;
  }
  const index = geometry.getIndex();
  const count = index ? index.count : pos.count;
  const out: Tri[] = [];
  for (let i = 0; i < count; i += 3) {
    const t9 = new Array(9) as Tri;
    for (let k = 0; k < 3; k++) {
      const v = index ? index.getX(i + k) : i + k;
      t9[k * 3] = moved[v * 3];
      t9[k * 3 + 1] = moved[v * 3 + 1];
      t9[k * 3 + 2] = moved[v * 3 + 2];
    }
    out.push(t9);
  }
  // The offset surface bounds the cavity, so it faces inward.
  return flip(out);
}

/** Radius along the ray at angle `a` in the z = 0 plane where `sdf` crosses `level` (bisection; bodies are star-shaped). */
function radiusAt(sdf: Sdf, a: number, level: number, rMax: number): number {
  const cx = Math.cos(a), cy = Math.sin(a);
  let lo = 0, hi = rMax;
  if (sdf(0, 0, 0) - level > 0) return 0;
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (sdf(mid * cx, mid * cy, 0) - level <= 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The flat cut rim on z = 0: quads between the sdf = −t and sdf = 0 contours.
 * `facing` is the side the rim looks toward (+1 for the back half, whose cut
 * faces forward; −1 for the front half).
 */
function rimRing(sdf: Sdf, t: number, rMax: number, segments: number, facing: 1 | -1): Tri[] {
  const out: Tri[] = [];
  const z = 0;
  const ro: number[] = [], ri: number[] = [];
  for (let k = 0; k < segments; k++) {
    const a = (2 * Math.PI * k) / segments;
    ro.push(radiusAt(sdf, a, 0, rMax));
    ri.push(radiusAt(sdf, a, -t, rMax));
  }
  for (let k = 0; k < segments; k++) {
    const k1 = (k + 1) % segments;
    const a0 = (2 * Math.PI * k) / segments, a1 = (2 * Math.PI * k1) / segments;
    const A: Tri = [ri[k] * Math.cos(a0), ri[k] * Math.sin(a0), z, ro[k] * Math.cos(a0), ro[k] * Math.sin(a0), z, ro[k1] * Math.cos(a1), ro[k1] * Math.sin(a1), z];
    const B: Tri = [ri[k] * Math.cos(a0), ri[k] * Math.sin(a0), z, ro[k1] * Math.cos(a1), ro[k1] * Math.sin(a1), z, ri[k1] * Math.cos(a1), ri[k1] * Math.sin(a1), z];
    out.push(A, B);
  }
  // Counter-clockwise about +z as built, i.e. facing +z; flip for the front half.
  return facing === 1 ? out : flip(out);
}

/** Bounding radius of a geometry about its origin, in its own units. */
export function boundingRadius(geometry: THREE.BufferGeometry): number {
  const pos = geometry.attributes.position as THREE.BufferAttribute;
  let r2 = 0;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    r2 = Math.max(r2, x * x + y * y + z * z);
  }
  return Math.sqrt(r2);
}

export function bake(tris: Tri[], parts: Part[], tones: ShellTones, scale: number): THREE.BufferGeometry {
  const positions = new Float32Array(tris.length * 9);
  const colors = new Float32Array(tris.length * 9);
  const c = new THREE.Color();
  for (let i = 0; i < tris.length; i++) {
    for (let k = 0; k < 9; k++) positions[i * 9 + k] = tris[i][k] * scale;
    c.set(tones[parts[i]]);
    for (let k = 0; k < 3; k++) {
      colors[i * 9 + k * 3] = c.r;
      colors[i * 9 + k * 3 + 1] = c.g;
      colors[i * 9 + k * 3 + 2] = c.b;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export type HalfShells = { front: BotGeometry; back: BotGeometry; thickness: number };

/**
 * Both halves of a bot's hollow shell as `BotGeometry`s `Figure` can draw:
 * one flat colour per triangle, the bot's own eyes on the front half, none
 * on the back. `thickness` is a fraction of the body's bounding radius.
 */
export function buildHalfShells(bot: BotGeometry, sdf: Sdf, thickness: number, color: string, quality: Quality): HalfShells {
  const tones = shellTones(color);
  const scale = bot.scale;
  const rBody = boundingRadius(bot.geometry) / scale;
  const t = thickness * rBody;
  const outer = triangleList(bot.geometry, scale);
  const inner = innerSurface(bot.geometry, scale, sdf, t);
  const zPlus = new THREE.Vector3(0, 0, 1), zMinus = new THREE.Vector3(0, 0, -1);

  const build = (side: 1 | -1) => {
    const n = side === 1 ? zPlus : zMinus;
    const tris: Tri[] = [];
    const parts: Part[] = [];
    const add = (list: Tri[], part: Part) => {
      for (const tri of list) {
        tris.push(tri);
        parts.push(part);
      }
    };
    // Face first, then the rim and the inside as their own geometry groups:
    // WebGL draws the rim depth-biased (its outer edge lies exactly on the
    // face's cut edge, and a depth tie there lets the lighter tone bleed into
    // the seam), and the Canvas 2D painter pushes both groups behind the face.
    add(clipTriangles(outer.map((tri) => [...tri] as Tri), n, -FACE_LIP * rBody), "face");
    const rimStart = tris.length * 3;
    add(rimRing(sdf, t, rBody * 1.5, RIM_SEGMENTS[quality], side === 1 ? -1 : 1), "rim");
    const insideStart = tris.length * 3;
    add(clipTriangles(inner.map((tri) => [...tri] as Tri), n, 0), "inside");
    const geometry = bake(tris, parts, tones, scale);
    geometry.addGroup(0, rimStart, 0);
    geometry.addGroup(rimStart, insideStart - rimStart, RIM_GROUP);
    geometry.addGroup(insideStart, tris.length * 3 - insideStart, INSIDE_GROUP);
    const half = new THREE.Vector3();
    geometry.boundingBox!.getSize(half).multiplyScalar(0.5);
    return {
      shape: bot.shape,
      geometry,
      eyes: side === 1 ? bot.eyes : [],
      eyeNormals: side === 1 ? bot.eyeNormals : [],
      scale,
      halfExtents: half,
      hullPoints: geometry.attributes.position.array as Float32Array,
    } satisfies BotGeometry;
  };
  return { front: build(1), back: build(-1), thickness: t };
}
