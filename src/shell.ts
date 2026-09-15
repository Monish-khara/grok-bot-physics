import * as THREE from "three";
import type { BotGeometry, Quality } from "./geometry";
import { BODIES } from "./data/bodies";
import { CHORD } from "./sphereShape";

/**
 * The hollow dome shell of the nesting scene, in body units (outer radius 1):
 *
 *   shell = dome − erode(dome, thickness) − window
 *
 * where `dome` is the unit sphere sliced flat at y = CHORD (the Sphere's own
 * cut), the erosion leaves a wall `thickness` thick everywhere (including a
 * floor), and the window is a cone about an axis on the back (−z) at eye
 * height, WINDOW_DEG wide, so a shell turned 180° shows the next one's face
 * and eyes through it.
 *
 * The plan called for marching cubes over that SDF. The shell is built from
 * its parts instead — outer sphere, inner sphere, the conical rim of the
 * window, the base disc and the cavity floor — because that gives exact
 * surfaces at any wall thickness (a 0.06 R wall is one or two grid cells at
 * the resolutions the Canvas 2D fallback can paint), crisp per-part tones
 * (each triangle carries one colour), a few thousand triangles per shell,
 * and instant rebuilds when the thickness slider moves. The three tones —
 * token colour on the face, ~25% lighter on the rim, ~25% darker inside —
 * are baked as vertex colours; the material stays flat and unlit.
 */

/** Default full angular width of the window, degrees. */
export const WINDOW_DEG = 55;

export type ShellTones = { face: string; rim: string; inside: string };

/** Face = the token colour; rim mixed 25% toward white; inside mixed 25% toward black. */
export function shellTones(color: string): ShellTones {
  const c = new THREE.Color(color);
  const rim = c.clone().lerp(new THREE.Color("#ffffff"), 0.25);
  const inside = c.clone().lerp(new THREE.Color("#000000"), 0.25);
  return { face: `#${c.getHexString()}`, rim: `#${rim.getHexString()}`, inside: `#${inside.getHexString()}` };
}

/** Which surface a triangle belongs to; the Canvas 2D painter and the tones key off it. */
export type ShellPart = "face" | "rim" | "inside";

type Tri = [number, number, number, number, number, number, number, number, number];

/** Segments around the window axis and from the window edge to the far pole. */
const SEGMENTS: Record<Quality, { phi: number; theta: number }> = {
  high: { phi: 96, theta: 48 },
  low: { phi: 40, theta: 20 },
};

/** Direction of the window's centre: on the back, at eye height. */
export function windowAxis(): THREE.Vector3 {
  return new THREE.Vector3(0, BODIES.dome.eyes.shiftY, -1).normalize();
}

/**
 * Half-space clip: keep the part of each triangle with n·p ≥ d. Triangles
 * crossing the plane are cut at the exact intersection, so a clipped edge
 * lies on the plane.
 */
function clipTriangles(tris: Tri[], n: THREE.Vector3, d: number): Tri[] {
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
    // Rotate so the odd vertex is first (the one alone on its side), keeping the winding.
    let a = 0;
    if (count === 1) a = inside.indexOf(true);
    else a = inside.indexOf(false);
    const b = (a + 1) % 3, c = (a + 2) % 3;
    const kab = s[a] / (s[a] - s[b]);
    const kac = s[a] / (s[a] - s[c]);
    const pab = lerp(t, a, b, kab), pac = lerp(t, a, c, kac);
    if (count === 1) {
      // Keep the tip: a, ab, ac.
      out.push([...pt(t, a), ...pab, ...pac] as Tri);
    } else {
      // Keep the base quad: ab, b, c and ab, c, ac.
      out.push([...pab, ...pt(t, b), ...pt(t, c)] as Tri);
      out.push([...pab, ...pt(t, c), ...pac] as Tri);
    }
  }
  return out;
}

/** Flip any triangle whose normal points against `wanted(centroid)`. */
function orient(tris: Tri[], wanted: (x: number, y: number, z: number) => THREE.Vector3): Tri[] {
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), nrm = new THREE.Vector3();
  for (const t of tris) {
    ab.set(t[3] - t[0], t[4] - t[1], t[5] - t[2]);
    ac.set(t[6] - t[0], t[7] - t[1], t[8] - t[2]);
    nrm.crossVectors(ab, ac);
    const w = wanted((t[0] + t[3] + t[6]) / 3, (t[1] + t[4] + t[7]) / 3, (t[2] + t[5] + t[8]) / 3);
    if (nrm.dot(w) < 0) {
      const x = t[3], y = t[4], z = t[5];
      t[3] = t[6]; t[4] = t[7]; t[5] = t[8];
      t[6] = x; t[7] = y; t[8] = z;
    }
  }
  return tris;
}

/**
 * A sphere of radius `R` about the window axis, from polar angle `theta0`
 * (the window's edge) to π (the far pole), as a triangle list.
 */
function sphereBand(R: number, theta0: number, seg: { phi: number; theta: number }, frame: THREE.Matrix3): Tri[] {
  const p = (theta: number, phi: number) => {
    const v = new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta));
    return v.applyMatrix3(frame).multiplyScalar(R);
  };
  const tris: Tri[] = [];
  for (let j = 0; j < seg.theta; j++) {
    const t0 = theta0 + ((Math.PI - theta0) * j) / seg.theta;
    const t1 = theta0 + ((Math.PI - theta0) * (j + 1)) / seg.theta;
    for (let i = 0; i < seg.phi; i++) {
      const f0 = (2 * Math.PI * i) / seg.phi, f1 = (2 * Math.PI * (i + 1)) / seg.phi;
      const a = p(t0, f0), b = p(t0, f1), c = p(t1, f1), d = p(t1, f0);
      tris.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z]);
      if (j < seg.theta - 1) tris.push([a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z]);
    }
  }
  return tris;
}

/** The conical strip along the window's edge, from the inner sphere to the outer. */
function rimStrip(theta0: number, rIn: number, rOut: number, seg: { phi: number }, frame: THREE.Matrix3): Tri[] {
  const p = (r: number, phi: number) => {
    const v = new THREE.Vector3(Math.sin(theta0) * Math.cos(phi), Math.sin(theta0) * Math.sin(phi), Math.cos(theta0));
    return v.applyMatrix3(frame).multiplyScalar(r);
  };
  const tris: Tri[] = [];
  for (let i = 0; i < seg.phi; i++) {
    const f0 = (2 * Math.PI * i) / seg.phi, f1 = (2 * Math.PI * (i + 1)) / seg.phi;
    const a = p(rIn, f0), b = p(rIn, f1), c = p(rOut, f1), d = p(rOut, f0);
    tris.push([a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z], [a.x, a.y, a.z, c.x, c.y, c.z, d.x, d.y, d.z]);
  }
  return tris;
}

/** A horizontal disc at height `y` of radius `rho`, as a fan. */
function disc(y: number, rho: number, seg: { phi: number }): Tri[] {
  const tris: Tri[] = [];
  for (let i = 0; i < seg.phi; i++) {
    const f0 = (2 * Math.PI * i) / seg.phi, f1 = (2 * Math.PI * (i + 1)) / seg.phi;
    tris.push([0, y, 0, rho * Math.cos(f0), y, rho * Math.sin(f0), rho * Math.cos(f1), y, rho * Math.sin(f1)]);
  }
  return tris;
}

/**
 * The shell's triangles in body units with a part tag each. `thickness` is
 * a fraction of the outer radius, `windowDeg` the window's full width.
 */
export function shellParts(thickness: number, windowDeg: number, quality: Quality): { tris: Tri[]; parts: ShellPart[] } {
  const seg = SEGMENTS[quality];
  const t = Math.max(0.01, Math.min(0.4, thickness));
  const rIn = 1 - t;
  const half = (Math.max(10, Math.min(160, windowDeg)) / 2) * (Math.PI / 180);
  // Orthonormal frame with the window axis as its z: x stays the body's x.
  const d = windowAxis();
  const ax = new THREE.Vector3(1, 0, 0);
  const by = new THREE.Vector3().crossVectors(d, ax).normalize();
  const frame = new THREE.Matrix3().set(ax.x, by.x, d.x, ax.y, by.y, d.y, ax.z, by.z, d.z);
  const up = new THREE.Vector3(0, 1, 0);

  const tris: Tri[] = [];
  const parts: ShellPart[] = [];
  const add = (list: Tri[], part: ShellPart) => {
    for (const tri of list) {
      tris.push(tri);
      parts.push(part);
    }
  };

  // Outer face: the sphere less the window, sliced by the base plane.
  add(orient(clipTriangles(sphereBand(1, half, seg, frame), up, CHORD), (x, y, z) => new THREE.Vector3(x, y, z)), "face");
  // Inner face: the eroded sphere less the window, sliced by the cavity floor; normals point into the cavity.
  add(orient(clipTriangles(sphereBand(rIn, half, seg, frame), up, CHORD + t), (x, y, z) => new THREE.Vector3(-x, -y, -z)), "inside");
  // Rim: the cone of the window between the two spheres. It is the wall of
  // the hole, so its visible side faces the window axis: sin(h)·d − cos(h)·u,
  // with u the unit direction from the axis to the point.
  add(
    orient(rimStrip(half, rIn, 1, seg, frame), (x, y, z) => {
      const p = new THREE.Vector3(x, y, z);
      const u = p.clone().addScaledVector(d, -p.dot(d)).normalize();
      return d.clone().multiplyScalar(Math.sin(half)).addScaledVector(u, -Math.cos(half));
    }),
    "rim",
  );
  // Base disc (face tone, looks down) and the cavity floor (inside tone, looks up).
  const rhoOut = Math.sqrt(Math.max(0, 1 - CHORD * CHORD));
  const rhoIn = Math.sqrt(Math.max(0, rIn * rIn - (CHORD + t) * (CHORD + t)));
  add(orient(disc(CHORD, rhoOut, seg), () => new THREE.Vector3(0, -1, 0)), "face");
  if (rhoIn > 0) add(orient(disc(CHORD + t, rhoIn, seg), () => new THREE.Vector3(0, 1, 0)), "inside");

  return { tris, parts };
}

/**
 * A shell as a `BotGeometry` that `Figure` can draw: non-indexed body with
 * one flat colour per triangle, the dome's own eyes (same outer surface) and
 * the dome's world scale so the two line up.
 */
export function buildShellBot(dome: BotGeometry, thickness: number, windowDeg: number, color: string, quality: Quality): BotGeometry {
  const tones = shellTones(color);
  const { tris, parts } = shellParts(thickness, windowDeg, quality);
  const positions = new Float32Array(tris.length * 9);
  const colors = new Float32Array(tris.length * 9);
  const c = new THREE.Color();
  for (let i = 0; i < tris.length; i++) {
    positions.set(tris[i], i * 9);
    c.set(tones[parts[i]]);
    for (let k = 0; k < 3; k++) {
      colors[i * 9 + k * 3] = c.r;
      colors[i * 9 + k * 3 + 1] = c.g;
      colors[i * 9 + k * 3 + 2] = c.b;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.scale(dome.scale, dome.scale, dome.scale);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const half = new THREE.Vector3();
  geometry.boundingBox!.getSize(half).multiplyScalar(0.5);
  return {
    shape: dome.shape,
    geometry,
    eyes: dome.eyes,
    eyeNormals: dome.eyeNormals,
    scale: dome.scale,
    halfExtents: half,
    hullPoints: positions,
  };
}
