import * as THREE from "three";
import { MarchingCubes } from "three/examples/jsm/objects/MarchingCubes.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SHAPES, type BotShape } from "./data/shapes";
import { BODIES, type BodyDef, type EyeFormation, type Pt2 } from "./data/bodies";

/** World units per body unit for a bot of eye-formation size 1. */
export const WORLD_PER_BODY = 0.68;
/**
 * Mesh density. "high" is what the WebGL renderer draws; "low" is a lighter
 * set for the Canvas 2D fallback, which pays per triangle edge it fills.
 */
export type Quality = "high" | "low";

type QualitySpec = {
  /** Marching-cubes grid resolution per axis. Only the rounded slabs (sparkle,
   * clover, star) go through marching cubes; everything else is analytic. At
   * 128 a grid cell is ~0.02 body units (under 2 px at 1440x900), and the
   * extracted vertices are then snapped onto the exact SDF surface. */
  mcRes: number;
  /** Segments around the axis for surfaces of revolution and the capsule. */
  radial: number;
  /** Profile samples for a surface of revolution (after refit). */
  profileSamples: number;
  /** Cross-section levels through a loft, pole to pole. */
  loftLevels: number;
  /** Keep every n-th outline point of a loft ring. */
  ringStride: number;
  boxSegments: number;
  capsuleCaps: number;
  /** Stadium segments per half for the eye pills. */
  eyeSegments: number;
};

const QUALITY: Record<Quality, QualitySpec> = {
  high: { mcRes: 128, radial: 192, profileSamples: 260, loftLevels: 72, ringStride: 1, boxSegments: 8, capsuleCaps: 32, eyeSegments: 24 },
  low: { mcRes: 56, radial: 40, profileSamples: 44, loftLevels: 20, ringStride: 3, boxSegments: 3, capsuleCaps: 8, eyeSegments: 10 },
};

/** Body units are scaled by this to fit the [-1, 1] marching-cubes box. */
const GRID_SCALE = 0.78;
/**
 * Eyes are solid pills set into the body along the local normal: most of the
 * slab sits below the surface (so no body colour can show through and no
 * depth tricks are needed) and a thin lip stands proud of it, like a carved
 * inlay. Body units.
 */
const EYE_ABOVE = 0.025;
const EYE_BELOW = 0.04;
/** Resolution and half-extent (body units) of the cached 2D outline SDFs. */
const SDF_GRID = 256;
const SDF_EXTENT = 1.3;

type Sdf = (x: number, y: number, z: number) => number;

export type BotGeometry = {
  shape: BotShape;
  /** Body mesh in world units, centred. */
  geometry: THREE.BufferGeometry;
  /** Two eye meshes in world units, in the body's frame. */
  eyes: THREE.BufferGeometry[];
  /** Outward surface normal at each eye centre, in the body's frame. */
  eyeNormals: THREE.Vector3[];
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
      const d2 = gridded2d(polygonSdf(def.loop), SDF_GRID, SDF_EXTENT);
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
      const d2 = gridded2d(polygonSdf(def.ring), SDF_GRID, SDF_EXTENT);
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
      const d2 = gridded2d(polygonSdf(loop), SDF_GRID, SDF_EXTENT);
      return (x, y, z) => d2(Math.hypot(x, z), y);
    }

    case "capsuleX":
      return (x, y, z) => {
        const cx = Math.max(-def.halfSpan, Math.min(def.halfSpan, x));
        return Math.hypot(x - cx, y, z) - def.radius;
      };
  }
}

// ── Body surfaces, in body units ─────────────────────────────────────────────

/** Ends narrower than this are pointed tips (the tool's revolve uses 0.06 on a denser outline). */
const POINTED_CAP_RADIUS = 0.3;

/**
 * Least-squares local quadratic (Savitzky–Golay style) fit of radius over y,
 * evaluated at each sample; one-sided windows at the ends. Removes the dump's
 * sampling dither without flattening curvature the way a wide blur would.
 */
function localQuadratic(profile: readonly Pt2[], halfWindow: number): number[] {
  const n = profile.length;
  return profile.map(([, y0], i) => {
    const lo = Math.max(0, i - halfWindow), hi = Math.min(n - 1, i + halfWindow);
    // Normal equations for r = a + b t + c t², t = y - y0.
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0, r0 = 0, r1 = 0, r2 = 0;
    for (let k = lo; k <= hi; k++) {
      const [r, y] = profile[k];
      const t = y - y0, t2 = t * t;
      s0 += 1; s1 += t; s2 += t2; s3 += t2 * t; s4 += t2 * t2;
      r0 += r; r1 += r * t; r2 += r * t2;
    }
    const det = s0 * (s2 * s4 - s3 * s3) - s1 * (s1 * s4 - s3 * s2) + s2 * (s1 * s3 - s2 * s2);
    if (Math.abs(det) < 1e-12) return profile[i][0];
    // Cramer's rule for `a` (the value at t = 0).
    const a = (r0 * (s2 * s4 - s3 * s3) - s1 * (r1 * s4 - s3 * r2) + s2 * (r1 * s3 - s2 * r2)) / det;
    return Math.max(0, a);
  });
}

/**
 * Round off a pointed end with the sphere cap tangent to the profile there:
 * the circle through the end point whose centre sits on the axis along the
 * profile normal. C1 join, apex on the axis. Returns the arc from just past
 * the end point to the apex, or null if the end is a flat rim.
 */
function tangentCap(r0: number, y0: number, slope: number, dir: 1 | -1): Pt2[] | null {
  // `dir` is +1 at the top end (profile heads up), -1 at the bottom.
  if (r0 >= POINTED_CAP_RADIUS || slope * dir >= 0 || !isFinite(slope)) return null;
  const yc = y0 + slope * r0;
  const R = r0 * Math.sqrt(1 + slope * slope);
  const theta0 = Math.atan2(r0, (y0 - yc) * dir);
  const steps = 12;
  const out: Pt2[] = [];
  for (let k = 1; k <= steps; k++) {
    // Cosine spacing crowds samples toward the join, where curvature changes.
    const theta = theta0 * (1 - Math.sin((Math.PI / 2) * (k / steps)));
    out.push([R * Math.sin(theta), yc + dir * R * Math.cos(theta)]);
  }
  return out;
}

/**
 * The dumped profiles were resampled to even y steps, which left the radii
 * dithering by ~0.01 body units from point to point (about a pixel at 2x),
 * and truncated pointed tips at r ≈ 0.11 (the tool closes those to an axis
 * point with a rounded taper). Refit: local quadratic smoothing, a unimodal
 * monotone radius (no ripples up the tip), centripetal Catmull-Rom resample,
 * then tangent sphere caps on the pointed ends. Flat rims (the wedge base)
 * are kept.
 */
function smoothProfile(profile: readonly Pt2[]): Pt2[] {
  const r = localQuadratic(profile, 4);
  // A body of revolution here is widest once; radius must fall monotonically
  // toward both ends or the silhouette ripples at grazing angles.
  let peak = 0;
  for (let i = 1; i < r.length; i++) if (r[i] > r[peak]) peak = i;
  for (let i = peak + 1; i < r.length; i++) r[i] = Math.min(r[i], r[i - 1]);
  for (let i = peak - 1; i >= 0; i--) r[i] = Math.min(r[i], r[i + 1]);

  const curve = new THREE.CatmullRomCurve3(
    r.map((radius, i) => new THREE.Vector3(radius, profile[i][1], 0)),
    false,
    "centripetal",
  );
  const body = curve.getPoints(profile.length * 4).map((p) => [Math.max(0, p.x), p.y] as Pt2);

  const first = body[0], second = body[1];
  const last = body[body.length - 1], prev = body[body.length - 2];
  const bottom = tangentCap(first[0], first[1], (second[0] - first[0]) / (second[1] - first[1]), -1) ?? [];
  const top = tangentCap(last[0], last[1], (last[0] - prev[0]) / (last[1] - prev[1]), 1) ?? [];
  return [...bottom.reverse(), ...body, ...top];
}

/** Drop triangles that reference the same vertex twice (lathe apex slivers). */
function dropDegenerateTriangles(g: THREE.BufferGeometry) {
  const idx = g.getIndex();
  if (!idx) return;
  const kept: number[] = [];
  for (let i = 0; i < idx.count; i += 3) {
    const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
    if (a !== b && b !== c && a !== c) kept.push(a, b, c);
  }
  g.setIndex(kept);
}

/**
 * Surface of revolution from the (refitted) profile curve (radius, y), bottom
 * to top, closed onto the axis at both ends. Exact silhouette at any zoom —
 * no voxel steps. Apex and seam vertices are merged so the tip is one point.
 */
function latheBody(profile: readonly Pt2[], q: QualitySpec): THREE.BufferGeometry {
  const inner = profile.filter(([r]) => r > 1e-6);
  // Thin the refitted profile evenly when a lighter mesh is wanted.
  const stride = Math.max(1, Math.floor(inner.length / q.profileSamples));
  const kept = inner.filter((_, i) => i % stride === 0 || i === inner.length - 1);
  const pts = [
    new THREE.Vector2(0, profile[0][1]),
    ...kept.map(([r, y]) => new THREE.Vector2(r, y)),
    new THREE.Vector2(0, profile[profile.length - 1][1]),
  ];
  const lathe = new THREE.LatheGeometry(pts, q.radial);
  lathe.deleteAttribute("uv");
  lathe.deleteAttribute("normal");
  const merged = mergeVertices(lathe, 1e-5);
  lathe.dispose();
  dropDegenerateTriangles(merged);
  return merged;
}

/**
 * The tool's roundedLoft, built directly: cross-sections are the outline
 * scaled by cos(phi)^exponent at z = depth * sin(phi), stitched pole to pole.
 * The front silhouette is the drawn outline itself.
 */
function loftBody(fullRing: readonly Pt2[], depth: number, exponent: number, q: QualitySpec): THREE.BufferGeometry {
  const ring = q.ringStride > 1 ? fullRing.filter((_, i) => i % q.ringStride === 0) : fullRing;
  const n = ring.length;
  const levels = q.loftLevels;
  const verts: number[] = [];
  const index: number[] = [];
  // Interior levels only; the poles are single vertices.
  for (let j = 1; j < levels; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / levels;
    const s = Math.pow(Math.cos(phi), exponent);
    const z = depth * Math.sin(phi);
    for (const [x, y] of ring) verts.push(x * s, y * s, z);
  }
  const back = verts.length / 3;
  verts.push(0, 0, -depth);
  const front = verts.length / 3;
  verts.push(0, 0, depth);
  const at = (level: number, i: number) => (level - 1) * n + (i % n);
  for (let i = 0; i < n; i++) index.push(back, at(1, i + 1), at(1, i));
  for (let j = 1; j < levels - 1; j++) {
    for (let i = 0; i < n; i++) {
      const a = at(j, i), b = at(j, i + 1), c = at(j + 1, i), d = at(j + 1, i + 1);
      index.push(a, b, d, a, d, c);
    }
  }
  for (let i = 0; i < n; i++) index.push(front, at(levels - 1, i), at(levels - 1, i + 1));
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(index);
  return g;
}

function bodyGeometry(def: BodyDef, sdf: Sdf, q: QualitySpec): THREE.BufferGeometry {
  switch (def.kind) {
    case "sphere":
      return new THREE.SphereGeometry(1, q.radial, q.radial / 2);
    case "box":
      return new RoundedBoxGeometry(2 * def.hx, 2 * def.hy, 2 * def.hz, q.boxSegments, def.round);
    case "capsuleX": {
      const g = new THREE.CapsuleGeometry(def.radius, 2 * def.halfSpan, q.capsuleCaps, q.radial);
      g.rotateZ(Math.PI / 2);
      return g;
    }
    case "revolve":
      return latheBody(def.profile, q);
    case "loft":
      return loftBody(def.ring, def.depth, def.exponent, q);
    case "slab":
      // Bevelled extrusions of concave outlines have no cheap closed form
      // (the rim is an offset of the outline, with tips that round over and
      // merge), so these still go through marching cubes — at high
      // resolution, then snapped onto the exact SDF surface.
      return extractSurface(sdf, q.mcRes);
  }
}

// ── Marching cubes (rounded slabs) ───────────────────────────────────────────

const cubesByRes = new Map<number, MarchingCubes>();

/**
 * Pull every vertex onto the zero level set of the SDF (a few Newton steps
 * along the gradient). Marching cubes places vertices by linear
 * interpolation of grid samples, which leaves them a fraction of a cell off
 * the true surface; that residue is what reads as stair-stepping on a flat
 * silhouette.
 */
function snapToSurface(g: THREE.BufferGeometry, sdf: Sdf) {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const arr = pos.array as Float32Array;
  const e = 0.004;
  for (let i = 0; i < arr.length; i += 3) {
    let x = arr[i], y = arr[i + 1], z = arr[i + 2];
    for (let k = 0; k < 3; k++) {
      const d = sdf(x, y, z);
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
    arr[i] = x;
    arr[i + 1] = y;
    arr[i + 2] = z;
  }
  pos.needsUpdate = true;
}

function extractSurface(sdf: Sdf, resolution: number): THREE.BufferGeometry {
  let cubes = cubesByRes.get(resolution);
  if (!cubes) {
    // Triangle budget scales with surface area in cells, i.e. resolution².
    cubes = new MarchingCubes(resolution, new THREE.MeshBasicMaterial(), false, false, Math.ceil(25 * resolution * resolution));
    cubes.isolation = 0;
    cubesByRes.set(resolution, cubes);
  }
  const size = resolution, half = size / 2;
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
  snapToSurface(merged, sdf);
  return merged;
}

/**
 * Make the winding outward by checking the signed volume. MarchingCubes winds
 * for a "field grows inward" convention (inside-out for our SDF sign), and the
 * lathe/loft builders depend on the direction the source curves run. A flat
 * unlit fill hides that, but raycasting (clicks, drags) culls back faces.
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
function stadium(width: number, height: number, segments = 24): Pt2[] {
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

/** First surface hit along -z from the front, in body units, with its outward normal. */
function frontSurface(sdf: Sdf, x: number, y: number): { p: THREE.Vector3; n: THREE.Vector3 } {
  let z = 1.6;
  let hitZ = 0;
  for (let i = 0; i < 64; i++) {
    const nz = z - 0.05;
    if (sdf(x, y, nz) <= 0) {
      // Refine the crossing.
      let lo = nz, hi = z;
      for (let k = 0; k < 10; k++) {
        const mid = (lo + hi) / 2;
        if (sdf(x, y, mid) <= 0) lo = mid;
        else hi = mid;
      }
      hitZ = (lo + hi) / 2;
      break;
    }
    z = nz;
    if (nz < -1.6) break;
  }
  const e = 0.01;
  const n = new THREE.Vector3(
    sdf(x + e, y, hitZ) - sdf(x - e, y, hitZ),
    sdf(x, y + e, hitZ) - sdf(x, y - e, hitZ),
    sdf(x, y, hitZ + e) - sdf(x, y, hitZ - e),
  ).normalize();
  if (n.lengthSq() < 0.5) n.set(0, 0, 1);
  return { p: new THREE.Vector3(x, y, hitZ), n };
}

/**
 * A solid pill set into the body: a stadium extruded along the surface normal
 * at the eye centre, sunk EYE_BELOW into the volume and standing EYE_ABOVE
 * proud of it. Being a real volume that intersects the body, the ordinary
 * depth test does the rest — the body hides the buried part and the whole eye
 * once the face turns away — with no lift or polygon offset.
 */
function eyeGeometry(
  sdf: Sdf,
  cx: number,
  cy: number,
  width: number,
  height: number,
  q: QualitySpec,
): { geometry: THREE.BufferGeometry; normal: THREE.Vector3 } {
  const { p, n } = frontSurface(sdf, cx, cy);
  const outline = stadium(width, height, q.eyeSegments);
  const shape = new THREE.Shape();
  outline.forEach(([x, y], i) => (i === 0 ? shape.moveTo(x, y) : shape.lineTo(x, y)));
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: EYE_ABOVE + EYE_BELOW, bevelEnabled: false, curveSegments: 1 });
  g.deleteAttribute("uv");
  // Local frame: pill height along the body's up as seen on the surface,
  // extrusion along the outward normal.
  const up = new THREE.Vector3(0, 1, 0);
  const u = new THREE.Vector3().crossVectors(up, n);
  if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
  u.normalize();
  const v = new THREE.Vector3().crossVectors(n, u).normalize();
  const m = new THREE.Matrix4().makeBasis(u, v, n);
  m.setPosition(p.clone().addScaledVector(n, -EYE_BELOW));
  g.applyMatrix4(m);
  g.computeVertexNormals();
  return { geometry: g, normal: n };
}

function eyeGeometries(sdf: Sdf, f: EyeFormation, q: QualitySpec) {
  return [-1, 1].map((side) => eyeGeometry(sdf, f.shiftX + (side * f.gap) / 2, f.shiftY, f.width, f.height, q));
}

// ── Assembly ─────────────────────────────────────────────────────────────────

export function buildBotGeometry(shape: BotShape, quality: Quality = "high"): BotGeometry {
  const q = QUALITY[quality];
  const { body: rawBody, eyes } = BODIES[shape.id];
  // The mesh and the eye-draping SDF must describe the same surface.
  const body: BodyDef = rawBody.kind === "revolve" ? { ...rawBody, profile: smoothProfile(rawBody.profile) } : rawBody;
  const sdf = bodySdf(body);
  const scale = WORLD_PER_BODY * eyes.size;

  const geometry = bodyGeometry(body, sdf, q);
  // Raycasting (taps, drags) culls back faces, so every body must wind outward.
  ensureOutwardWinding(geometry);
  geometry.computeVertexNormals();
  geometry.scale(scale, scale, scale);
  geometry.computeBoundingBox();
  const half = new THREE.Vector3();
  geometry.boundingBox!.getSize(half).multiplyScalar(0.5);

  const eyeParts = eyeGeometries(sdf, eyes, q);
  for (const { geometry: g } of eyeParts) g.scale(scale, scale, scale);

  return {
    shape,
    geometry,
    eyes: eyeParts.map((e) => e.geometry),
    eyeNormals: eyeParts.map((e) => e.normal),
    scale,
    halfExtents: half,
    hullPoints: geometry.attributes.position.array as Float32Array,
  };
}

const cache = new Map<Quality, BotGeometry[]>();

/** Builds all ten bodies once per quality; later calls (respawns, rescales) reuse them. */
export function getBotGeometries(quality: Quality = "high"): BotGeometry[] {
  let bots = cache.get(quality);
  if (!bots) {
    const t0 = performance.now();
    bots = SHAPES.map((shape) => buildBotGeometry(shape, quality));
    cache.set(quality, bots);
    // Test hook: headless checks read the build time from here.
    (window as unknown as { __grokBotsBuildMs?: number }).__grokBotsBuildMs = performance.now() - t0;
  }
  return bots;
}
