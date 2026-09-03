import * as THREE from "three";
import { SVGLoader } from "three/examples/jsm/loaders/SVGLoader.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { SHAPES, SHAPE_BOX, type BotShape } from "./data/shapes";

/** World-space size of a bot's longest side. */
export const BOT_SIZE = 1.6;
/** Extrusion depth as a fraction of BOT_SIZE. */
const DEPTH_RATIO = 0.34;

export type BotGeometry = {
  shape: BotShape;
  geometry: THREE.ExtrudeGeometry;
  /** Half-extents of the finished, centred geometry. */
  halfExtents: THREE.Vector3;
  /** Flat vertex positions for a convex hull collider. */
  hullPoints: Float32Array;
};

const loader = new SVGLoader();

/**
 * Turn an SVG path string into three.js shapes. The 229-unit box is scaled to
 * BOT_SIZE and flipped so SVG's y-down becomes world y-up.
 */
function pathToShapes(d: string): THREE.Shape[] {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SHAPE_BOX} ${SHAPE_BOX}"><path d="${d}"/></svg>`;
  const parsed = loader.parse(svg);
  const shapes: THREE.Shape[] = [];
  for (const p of parsed.paths) shapes.push(...p.toShapes());
  return shapes;
}

export function buildBotGeometry(shape: BotShape): BotGeometry {
  const shapes = pathToShapes(shape.path);
  const unit = BOT_SIZE / SHAPE_BOX;
  const depth = BOT_SIZE * DEPTH_RATIO;
  // No bevel: seen straight on with a flat fill, the front silhouette must
  // be the SVG outline itself. The extrusion only exists for the physics.
  const extruded = new THREE.ExtrudeGeometry(shapes, {
    depth: depth / unit,
    bevelEnabled: false,
    curveSegments: 12,
    steps: 1,
  });

  // Extrude output is non-indexed; welding shrinks the vertex cloud the hull
  // collider is built from.
  const geometry = mergeVertices(extruded, 1e-3) as THREE.ExtrudeGeometry;
  extruded.dispose();

  // SVG is y-down. A half-turn about X flips y while keeping the winding
  // right-handed (a plain negative scale would turn the mesh inside out).
  geometry.rotateX(Math.PI);
  geometry.scale(unit, unit, unit);
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox!;
  const size = new THREE.Vector3();
  bb.getSize(size);
  // Normalise so every body's longest footprint side is BOT_SIZE.
  const k = BOT_SIZE / Math.max(size.x, size.y);
  geometry.scale(k, k, k);
  geometry.center();
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  const half = new THREE.Vector3();
  geometry.boundingBox!.getSize(half).multiplyScalar(0.5);

  return {
    shape,
    geometry,
    halfExtents: half,
    hullPoints: geometry.attributes.position.array as Float32Array,
  };
}

let cache: BotGeometry[] | null = null;

export function getBotGeometries(): BotGeometry[] {
  if (!cache) cache = SHAPES.map(buildBotGeometry);
  return cache;
}
