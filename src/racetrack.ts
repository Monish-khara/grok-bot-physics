import * as THREE from "three";

/**
 * True offset paths ("Offset Path", not scaling) of a 2D shape given as a
 * signed distance function: the offset curve at distance d is the iso-line
 * sdf(x, y) = d. Extracted by marching squares on a grid, chained into a
 * closed loop, Newton-snapped onto the exact iso-line, Catmull-Rom smoothed
 * and resampled by arc length. Because the SDF's level sets are parallel
 * curves by definition, concave corners come out rounded and convex ones
 * stay a constant distance away — exactly what scaling the outline gets wrong.
 */

export type Sdf2 = (x: number, y: number) => number;

/** Flat list of closed-loop points, [x0, y0, x1, y1, …], last not repeated. */
export type Loop = Float32Array;

// ── Marching squares ────────────────────────────────────────────────────────

/**
 * Segment table: for each of the 16 corner cases, the pairs of cell edges the
 * contour crosses. Edges: 0 bottom (c0→c1), 1 right (c1→c2), 2 top (c2→c3),
 * 3 left (c3→c0), with corners c0 = (i, j), c1 = (i+1, j), c2 = (i+1, j+1),
 * c3 = (i, j+1). Saddles (5, 10) are disambiguated with the centre value.
 */
const CASES: readonly (readonly number[])[] = [
  [], [3, 0], [0, 1], [3, 1], [1, 2], [], [0, 2], [3, 2],
  [2, 3], [2, 0], [], [2, 1], [1, 3], [1, 0], [0, 3], [],
];

/** The SDF sampled once on a square grid; iso-lines at any level are read off it. */
export type Field = { f: Float32Array; extent: number; res: number };

export function sampleField(sdf: Sdf2, extent: number, res: number): Field {
  const n = res + 1;
  const step = (2 * extent) / res;
  const f = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) f[j * n + i] = sdf(-extent + i * step, -extent + j * step);
  return { f, extent, res };
}

/**
 * All closed iso-lines of `field = iso`, as loops of points in the field's
 * units, longest first.
 */
export function isoLines(field: Field, iso: number): Loop[] {
  const { extent, res } = field;
  const n = res + 1;
  const step = (2 * extent) / res;
  const at = (k: number) => -extent + k * step;
  const f = new Float32Array(n * n);
  for (let k = 0; k < f.length; k++) f[k] = field.f[k] - iso;

  // Vertices live on grid edges; key them by edge so chaining is exact.
  // Horizontal edge (i, j)→(i+1, j): 2 * (j * n + i); vertical (i, j)→(i, j+1): 2 * (j * n + i) + 1.
  const hKey = (i: number, j: number) => 2 * (j * n + i);
  const vKey = (i: number, j: number) => 2 * (j * n + i) + 1;
  const verts = new Map<number, [number, number]>();
  const links = new Map<number, number[]>();
  const lerp = (a: number, b: number, fa: number, fb: number) => a + ((b - a) * fa) / (fa - fb);
  const vertex = (key: number, i: number, j: number, edge: number): number => {
    if (!verts.has(key)) {
      let p: [number, number];
      switch (edge) {
        case 0: p = [lerp(at(i), at(i + 1), f[j * n + i], f[j * n + i + 1]), at(j)]; break;
        case 1: p = [at(i + 1), lerp(at(j), at(j + 1), f[j * n + i + 1], f[(j + 1) * n + i + 1])]; break;
        case 2: p = [lerp(at(i), at(i + 1), f[(j + 1) * n + i], f[(j + 1) * n + i + 1]), at(j + 1)]; break;
        default: p = [at(i), lerp(at(j), at(j + 1), f[j * n + i], f[(j + 1) * n + i])];
      }
      verts.set(key, p);
    }
    return key;
  };
  const edgeKey = (i: number, j: number, edge: number) =>
    edge === 0 ? hKey(i, j) : edge === 1 ? vKey(i + 1, j) : edge === 2 ? hKey(i, j + 1) : vKey(i, j);
  const link = (a: number, b: number) => {
    (links.get(a) ?? links.set(a, []).get(a)!).push(b);
    (links.get(b) ?? links.set(b, []).get(b)!).push(a);
  };

  for (let j = 0; j < res; j++) {
    for (let i = 0; i < res; i++) {
      const c0 = f[j * n + i], c1 = f[j * n + i + 1], c2 = f[(j + 1) * n + i + 1], c3 = f[(j + 1) * n + i];
      const code = (c0 < 0 ? 1 : 0) | (c1 < 0 ? 2 : 0) | (c2 < 0 ? 4 : 0) | (c3 < 0 ? 8 : 0);
      if (code === 0 || code === 15) continue;
      let pairs: readonly number[];
      if (code === 5 || code === 10) {
        // Saddle: connect so the negative side follows the centre's sign.
        const centreNeg = c0 + c1 + c2 + c3 < 0;
        if (code === 5) pairs = centreNeg ? [0, 1, 2, 3] : [3, 0, 1, 2];
        else pairs = centreNeg ? [3, 0, 1, 2] : [0, 1, 2, 3];
      } else {
        pairs = CASES[code];
      }
      for (let k = 0; k < pairs.length; k += 2) {
        const ea = pairs[k], eb = pairs[k + 1];
        const a = vertex(edgeKey(i, j, ea), i, j, ea);
        const b = vertex(edgeKey(i, j, eb), i, j, eb);
        link(a, b);
      }
    }
  }

  // Chain into loops.
  const seen = new Set<number>();
  const loops: Loop[] = [];
  for (const start of verts.keys()) {
    if (seen.has(start)) continue;
    const chain: number[] = [start];
    seen.add(start);
    let prev = -1, cur = start;
    for (;;) {
      const nb = links.get(cur) ?? [];
      const next = nb.find((k) => k !== prev && !seen.has(k));
      if (next === undefined) break;
      chain.push(next);
      seen.add(next);
      prev = cur;
      cur = next;
    }
    if (chain.length < 8) continue;
    const out = new Float32Array(chain.length * 2);
    chain.forEach((k, idx) => {
      const p = verts.get(k)!;
      out[idx * 2] = p[0];
      out[idx * 2 + 1] = p[1];
    });
    loops.push(out);
  }
  loops.sort((a, b) => loopLength(b) - loopLength(a));
  return loops.map(ccw);
}

function loopLength(pts: Loop): number {
  let len = 0;
  const m = pts.length / 2;
  for (let k = 0; k < m; k++) {
    const nx = pts[((k + 1) % m) * 2] - pts[k * 2], ny = pts[((k + 1) % m) * 2 + 1] - pts[k * 2 + 1];
    len += Math.hypot(nx, ny);
  }
  return len;
}

/** Orient a loop counter-clockwise (positive signed area). */
function ccw(pts: Loop): Loop {
  let area = 0;
  const m = pts.length / 2;
  for (let k = 0; k < m; k++) {
    const x0 = pts[k * 2], y0 = pts[k * 2 + 1];
    const x1 = pts[((k + 1) % m) * 2], y1 = pts[((k + 1) % m) * 2 + 1];
    area += x0 * y1 - x1 * y0;
  }
  if (area >= 0) return pts;
  const out = new Float32Array(pts.length);
  for (let k = 0; k < m; k++) {
    out[k * 2] = pts[(m - 1 - k) * 2];
    out[k * 2 + 1] = pts[(m - 1 - k) * 2 + 1];
  }
  return out;
}

// ── Refinement ──────────────────────────────────────────────────────────────

/** Newton-project every point onto sdf = iso along the local gradient (in place). */
export function snapToIso(pts: Loop, sdf: Sdf2, iso: number, iterations = 3, e = 1e-3): Loop {
  for (let k = 0; k < pts.length; k += 2) {
    let x = pts[k], y = pts[k + 1];
    for (let it = 0; it < iterations; it++) {
      const d = sdf(x, y) - iso;
      if (Math.abs(d) < 1e-6) break;
      const gx = (sdf(x + e, y) - sdf(x - e, y)) / (2 * e);
      const gy = (sdf(x, y + e) - sdf(x, y - e)) / (2 * e);
      const g2 = gx * gx + gy * gy || 1;
      x -= (d * gx) / g2;
      y -= (d * gy) / g2;
    }
    pts[k] = x;
    pts[k + 1] = y;
  }
  return pts;
}

/**
 * Closed centripetal Catmull-Rom through the loop, resampled to `count`
 * points evenly spaced by arc length.
 */
export function resampleClosed(pts: Loop, count: number): Loop {
  const m = pts.length / 2;
  const ctrl = Array.from({ length: m }, (_, k) => new THREE.Vector3(pts[k * 2], pts[k * 2 + 1], 0));
  const curve = new THREE.CatmullRomCurve3(ctrl, true, "centripetal");
  curve.arcLengthDivisions = Math.max(400, m * 4);
  const out = new Float32Array(count * 2);
  const v = new THREE.Vector3();
  for (let k = 0; k < count; k++) {
    curve.getPointAt(k / count, v);
    out[k * 2] = v.x;
    out[k * 2 + 1] = v.y;
  }
  return out;
}

/**
 * The offset curve of `sdf` at distance `d`: the longest iso-line of its
 * sampled `field`, snapped onto the exact SDF, smoothed and resampled to
 * `count` points, then snapped again.
 */
export function offsetCurve(field: Field, sdf: Sdf2, d: number, count = 256): Loop | null {
  const loops = isoLines(field, d);
  if (!loops.length) return null;
  const snapped = snapToIso(loops[0], sdf, d);
  const smooth = resampleClosed(snapped, count);
  return snapToIso(smooth, sdf, d, 2);
}

// ── Arc-length parametrised closed curve ────────────────────────────────────

export class ClosedCurve {
  readonly length: number;
  private readonly cum: Float32Array;
  private readonly n: number;
  readonly pts: Loop;
  constructor(pts: Loop) {
    this.pts = pts;
    this.n = pts.length / 2;
    this.cum = new Float32Array(this.n + 1);
    let len = 0;
    for (let k = 0; k < this.n; k++) {
      const j = (k + 1) % this.n;
      len += Math.hypot(pts[j * 2] - pts[k * 2], pts[j * 2 + 1] - pts[k * 2 + 1]);
      this.cum[k + 1] = len;
    }
    this.length = len;
  }

  /** Point at arc length `s` (wraps), written to `out` = [x, y]. */
  pointAt(s: number, out: THREE.Vector2): THREE.Vector2 {
    const { k, t } = this.locate(s);
    const j = (k + 1) % this.n;
    out.x = this.pts[k * 2] + (this.pts[j * 2] - this.pts[k * 2]) * t;
    out.y = this.pts[k * 2 + 1] + (this.pts[j * 2 + 1] - this.pts[k * 2 + 1]) * t;
    return out;
  }

  /** Unit tangent at arc length `s`, averaged over the neighbouring segments. */
  tangentAt(s: number, out: THREE.Vector2): THREE.Vector2 {
    const { k } = this.locate(s);
    const i = (k + this.n - 1) % this.n, j = (k + 1) % this.n, l = (k + 2) % this.n;
    out.x = this.pts[l * 2] - this.pts[i * 2] + (this.pts[j * 2] - this.pts[k * 2]);
    out.y = this.pts[l * 2 + 1] - this.pts[i * 2 + 1] + (this.pts[j * 2 + 1] - this.pts[k * 2 + 1]);
    return out.normalize();
  }

  private locate(s: number): { k: number; t: number } {
    let u = s % this.length;
    if (u < 0) u += this.length;
    // Binary search the cumulative table.
    let lo = 0, hi = this.n;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= u) lo = mid;
      else hi = mid;
    }
    const seg = this.cum[lo + 1] - this.cum[lo] || 1;
    return { k: lo, t: (u - this.cum[lo]) / seg };
  }
}

// ── Geometry helpers ────────────────────────────────────────────────────────

/** Map a loop through a uniform scale and translation (body → world units). */
export function transformLoop(pts: Loop, scale: number, dx: number, dy: number): Loop {
  const out = new Float32Array(pts.length);
  for (let k = 0; k < pts.length; k += 2) {
    out[k] = pts[k] * scale + dx;
    out[k + 1] = pts[k + 1] * scale + dy;
  }
  return out;
}

/**
 * Flat closed ribbon of constant `width` centred on the loop, as a triangle
 * strip in the plane z = `z` (the WebGL stroke). Mitre-free: each vertex is
 * offset along the averaged normal of its two segments, which is exact for
 * the smooth, gently curving loops produced above.
 */
export function ribbonGeometry(pts: Loop, width: number, z: number): THREE.BufferGeometry {
  const m = pts.length / 2;
  const pos = new Float32Array(m * 2 * 3);
  const half = width / 2;
  for (let k = 0; k < m; k++) {
    const i = (k + m - 1) % m, j = (k + 1) % m;
    let tx = pts[j * 2] - pts[i * 2], ty = pts[j * 2 + 1] - pts[i * 2 + 1];
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty, ny = tx;
    const x = pts[k * 2], y = pts[k * 2 + 1];
    pos.set([x + nx * half, y + ny * half, z, x - nx * half, y - ny * half, z], k * 6);
  }
  const index: number[] = [];
  for (let k = 0; k < m; k++) {
    const a = k * 2, b = k * 2 + 1, c = ((k + 1) % m) * 2, d = ((k + 1) % m) * 2 + 1;
    index.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setIndex(index);
  return g;
}
