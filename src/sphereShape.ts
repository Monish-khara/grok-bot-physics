/**
 * The Sphere's Exosphere silhouette: a circle with its bottom sliced off by a
 * flat base. The real thing is ~516 ft wide by 366 ft tall, i.e. height =
 * 0.71 × diameter, which puts the chord at y = -0.42 R (height 1.42 R).
 *
 * One definition shared by the physics walls, the Canvas 2D backdrop path,
 * the WebGL backdrop mesh, spawn sampling and the headless checks.
 */

/** Height of the chord below the centre, as a fraction of the radius. */
export const CHORD = -0.42;
/** Wall segments along the arc. */
export const ARC_SEGMENTS = 96;

export type Sphere = {
  /** Centre of the circle, world units. */
  cx: number;
  cy: number;
  /** Radius. */
  r: number;
  /** World y of the flat base (the chord). */
  chordY: number;
};

/**
 * Fit the shape into a view `2 * halfWidth` wide and `viewHeight` tall whose
 * vertical extent is [viewBottom, viewBottom + viewHeight], leaving `margin`
 * world units on the tight side, and centre it.
 */
export function fitSphere(halfWidth: number, viewBottom: number, viewHeight: number, margin: number): Sphere {
  const r = Math.max(0.5, Math.min((viewHeight - 2 * margin) / (1 + Math.abs(CHORD)), halfWidth - margin));
  // Shape spans [cy + CHORD r, cy + r]; centre that span in the view.
  const cy = viewBottom + viewHeight / 2 - ((1 + CHORD) * r) / 2;
  return { cx: 0, cy, r, chordY: cy + CHORD * r };
}

/** True when (x, y) is at least `inset` inside both the arc and the base. */
export function insideSphere(s: Sphere, x: number, y: number, inset = 0): boolean {
  const dx = x - s.cx, dy = y - s.cy;
  const rr = s.r - inset;
  return dx * dx + dy * dy <= rr * rr && y >= s.chordY + inset;
}

/** Angle where the chord meets the circle on the right; the left one is π − this. */
function chordAngle(): number {
  return Math.asin(CHORD);
}

/**
 * Closed outline as [x0, y0, x1, y1, …]: the arc from the right chord point
 * over the top to the left chord point, then straight back along the base.
 */
export function sphereOutline(s: Sphere, segments = ARC_SEGMENTS): Float32Array {
  const a0 = chordAngle();
  const a1 = Math.PI - a0;
  const out = new Float32Array((segments + 1) * 2);
  for (let i = 0; i <= segments; i++) {
    const a = a0 + ((a1 - a0) * i) / segments;
    out[i * 2] = s.cx + Math.cos(a) * s.r;
    out[i * 2 + 1] = s.cy + Math.sin(a) * s.r;
  }
  return out;
}

export type WallSegment = {
  /** Centre of the collider (already pushed outward by `thickness`). */
  x: number;
  y: number;
  /** Rotation about z so the collider's local x runs along the wall. */
  angle: number;
  /** Half-length along the wall, with a little overlap so there are no gaps. */
  halfLength: number;
};

/** Thin boxes along the arc whose inner faces lie on the circle. */
export function sphereWallSegments(s: Sphere, thickness: number, segments = ARC_SEGMENTS): WallSegment[] {
  const a0 = chordAngle();
  const a1 = Math.PI - a0;
  const step = (a1 - a0) / segments;
  const chordLen = 2 * s.r * Math.sin(step / 2);
  const walls: WallSegment[] = [];
  for (let i = 0; i < segments; i++) {
    const a = a0 + step * (i + 0.5);
    const mid = s.r * Math.cos(step / 2) + thickness;
    walls.push({
      x: s.cx + Math.cos(a) * mid,
      y: s.cy + Math.sin(a) * mid,
      angle: a + Math.PI / 2,
      halfLength: chordLen / 2 + thickness * Math.tan(step / 2) + 0.02,
    });
  }
  return walls;
}

/** Half-length of the flat base. */
export function chordHalfLength(s: Sphere): number {
  return Math.sqrt(Math.max(0, s.r * s.r - (s.chordY - s.cy) ** 2));
}
