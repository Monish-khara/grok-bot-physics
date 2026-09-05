import * as THREE from "three";

/**
 * A Canvas 2D stand-in for three's WebGLRenderer, for browsers where WebGL is
 * blocked (Cursor's built-in tab) but WebAssembly still runs. React Three
 * Fiber only needs `render`, `setSize`, `setPixelRatio` and `domElement`, so
 * the whole scene graph, Rapier physics and pointer raycasting stay as they
 * are — only rasterisation changes.
 *
 * Drawing model, matched to what the bots need (flat unlit fills, no lights):
 * - Orthographic/perspective projection through the camera matrices.
 * - Bodies are painter-sorted by view depth, far to near. Each body is one
 *   `Path2D` of its silhouette loops — the net boundary of its front-facing
 *   triangles — filled once with the nonzero rule, so the fill is exactly the
 *   union of the front faces with no seams and only a few hundred segments.
 * - Eye meshes (children tagged with `userData.eyeNormal`) are drawn right
 *   after their body, only while that normal faces the camera; being flush
 *   inlays, that is when — and only when — they would be visible.
 * - Per-body ordering is an approximation: two interpenetrating bodies would
 *   overlap wrongly, but colliders keep them apart.
 */
export class Canvas2DRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly isCanvas2DRenderer = true;
  /** Rolling average of `render()` time, ms — read by headless checks. */
  frameMs = 0;
  frames = 0;

  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private width = 1;
  private height = 1;
  private viewProj = new THREE.Matrix4();
  private mvp = new THREE.Matrix4();
  private normalMatrix = new THREE.Matrix3();
  private toCamera = new THREE.Vector3();
  private tmpV = new THREE.Vector3();
  private tmpN = new THREE.Vector3();
  private projected = new Map<THREE.BufferGeometry, Float32Array>();
  private bodies: { mesh: THREE.Mesh; depth: number }[] = [];

  constructor(canvas: HTMLCanvasElement) {
    this.domElement = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    this.ctx = ctx;
    // Test hook: headless checks read frame timings from here.
    (window as unknown as { __grokRenderer?: Canvas2DRenderer }).__grokRenderer = this;
  }

  /** Per-phase timings of the last frame (ms), for profiling. */
  phases = { project: 0, path: 0, fill: 0, triangles: 0 };
  /**
   * "silhouette" traces only the outline loops (fast); "triangles" emits every
   * front-facing triangle (slow, but a straightforward ground truth used by
   * `compareFrame`).
   */
  fillMode: "silhouette" | "triangles" = "silhouette";
  private lastScene: THREE.Scene | null = null;
  private lastCamera: THREE.Camera | null = null;

  setPixelRatio(dpr: number) {
    this.dpr = dpr;
    this.applySize();
  }

  setSize(width: number, height: number, updateStyle = true) {
    this.width = width;
    this.height = height;
    if (updateStyle) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    }
    this.applySize();
  }

  getSize(target: THREE.Vector2) {
    return target.set(this.width, this.height);
  }

  getPixelRatio() {
    return this.dpr;
  }

  dispose() {
    this.projected.clear();
    this.adjacencyCache.clear();
  }

  private applySize() {
    this.domElement.width = Math.max(1, Math.floor(this.width * this.dpr));
    this.domElement.height = Math.max(1, Math.floor(this.height * this.dpr));
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    this.lastScene = scene;
    this.lastCamera = camera;
    this.renderTo(this.ctx, this.dpr, scene, camera);
  }

  /**
   * Test hook: draw the last frame twice into offscreen canvases — silhouette
   * loops vs. every front-facing triangle — and count pixels that differ by
   * more than `threshold` in any channel. Anything beyond antialiasing noise
   * means a silhouette loop was wrong (a hole or a chord across a body).
   */
  compareFrame(threshold = 100): { differing: number; total: number } {
    if (!this.lastScene || !this.lastCamera) return { differing: 0, total: 0 };
    const w = Math.max(1, Math.floor(this.width)), h = Math.max(1, Math.floor(this.height));
    const make = () => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      return c.getContext("2d")!;
    };
    const a = make(), b = make();
    const mode = this.fillMode;
    this.fillMode = "silhouette";
    this.renderTo(a, 1, this.lastScene, this.lastCamera);
    this.fillMode = "triangles";
    this.renderTo(b, 1, this.lastScene, this.lastCamera);
    this.fillMode = mode;
    const pa = a.getImageData(0, 0, w, h).data, pb = b.getImageData(0, 0, w, h).data;
    let differing = 0;
    for (let i = 0; i < pa.length; i += 4) {
      if (
        Math.abs(pa[i] - pb[i]) > threshold ||
        Math.abs(pa[i + 1] - pb[i + 1]) > threshold ||
        Math.abs(pa[i + 2] - pb[i + 2]) > threshold
      )
        differing++;
    }
    return { differing, total: w * h };
  }

  private renderTo(ctx: CanvasRenderingContext2D, dpr: number, scene: THREE.Scene, camera: THREE.Camera) {
    const t0 = performance.now();
    this.phases.project = this.phases.path = this.phases.fill = this.phases.triangles = 0;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();

    const { width, height } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = scene.background;
    if (bg instanceof THREE.Color) {
      ctx.fillStyle = `#${bg.getHexString()}`;
      ctx.fillRect(0, 0, width, height);
    } else {
      ctx.clearRect(0, 0, width, height);
    }

    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Unit vector from the scene toward the camera (orthographic: constant).
    this.toCamera.set(0, 0, 1).transformDirection(camera.matrixWorld);

    // Top-level meshes are bodies (or the click-catcher plane); mesh children
    // of a body are its eyes.
    this.bodies.length = 0;
    scene.traverseVisible((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.parent && (mesh.parent as THREE.Mesh).isMesh) return;
      if (!isDrawable(mesh.material)) return;
      this.tmpV.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      this.bodies.push({ mesh, depth: this.tmpV.z });
    });
    // View space looks down -Z: more negative is farther. Draw far first.
    this.bodies.sort((a, b) => a.depth - b.depth);

    for (const { mesh } of this.bodies) {
      const bodyPath = this.fillMesh(ctx, mesh, colorOf(mesh.material));
      if (!bodyPath) continue;
      for (const child of mesh.children) {
        const eye = child as THREE.Mesh;
        if (!eye.isMesh || !eye.visible) continue;
        const local = eye.userData.eyeNormal as THREE.Vector3 | undefined;
        if (local) {
          this.normalMatrix.getNormalMatrix(mesh.matrixWorld);
          this.tmpN.copy(local).applyMatrix3(this.normalMatrix).normalize();
          // Flush inlay: visible while its face points toward the viewer.
          if (this.tmpN.dot(this.toCamera) < 0.15) continue;
        }
        if (!isDrawable(eye.material)) continue;
        // The pill is mostly buried in the body; clipping to the body's
        // silhouette stands in for the depth test at grazing angles.
        ctx.save();
        ctx.clip(bodyPath, "nonzero");
        this.fillMesh(ctx, eye, colorOf(eye.material));
        ctx.restore();
      }
    }

    const dt = performance.now() - t0;
    this.frames++;
    this.frameMs += (dt - this.frameMs) * 0.1;
  }

  /**
   * Fill the projection of a mesh's front-facing triangles as one path. Rather
   * than emitting every triangle (each Path2D call costs ~1 µs, so 25k
   * triangles took >100 ms a frame), only the boundary of the front-facing set
   * is emitted, chained into loops. An earlier version derived it from a
   * two-triangles-per-edge adjacency; that broke on seams, poles and
   * non-manifold marching-cubes edges, leaving open chains that `closePath`
   * shut with a straight chord — a visible wedge cut out of a body. The net
   * edge sum below is balanced by construction, so loops always close.
   */
  private fillMesh(ctx: CanvasRenderingContext2D, mesh: THREE.Mesh, color: string): Path2D | null {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) return null;
    const adj = this.adjacency(geometry);
    const { width, height } = this;
    const count = position.count;
    let out = this.projected.get(geometry);
    if (!out || out.length < count * 2) {
      out = new Float32Array(count * 2);
      this.projected.set(geometry, out);
    }
    const tp = performance.now();
    this.mvp.multiplyMatrices(this.viewProj, mesh.matrixWorld);
    const e = this.mvp.elements;
    const src = position.array as ArrayLike<number>;
    for (let i = 0, j = 0, k = 0; i < count; i++, j += 3, k += 2) {
      const x = src[j], y = src[j + 1], z = src[j + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      out[k] = (nx + 1) * 0.5 * width;
      out[k + 1] = (1 - ny) * 0.5 * height;
    }

    // Front/back per triangle. Screen y points down, so a counter-clockwise
    // (front-facing) triangle in NDC has negative signed area here.
    const { tris, triCount } = adj;
    const front = adj.front;
    for (let t = 0, i = 0; t < triCount; t++, i += 3) {
      const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
      const ax = out[a], ay = out[a + 1];
      front[t] = (out[b] - ax) * (out[c + 1] - ay) - (out[c] - ax) * (out[b + 1] - ay) < 0 ? 1 : 0;
    }

    // Net boundary of the front-facing set: every front triangle contributes
    // its three directed edges; an edge walked both ways (two front
    // neighbours) cancels. Being a sum of closed triangle boundaries, the
    // result has as many outgoing as incoming edges at every vertex whatever
    // the mesh topology (seams, poles, non-manifold marching-cubes output), so
    // the chains below always close, and its nonzero winding number equals
    // the number of front layers over a pixel — exactly the union.
    const { triEdge, triSign, edgeA, edgeB, net } = adj;
    net.fill(0);
    for (let t = 0, i = 0; t < triCount; t++, i += 3) {
      if (!front[t]) continue;
      net[triEdge[i]] += triSign[i];
      net[triEdge[i + 1]] += triSign[i + 1];
      net[triEdge[i + 2]] += triSign[i + 2];
    }
    const outgoing = this.outgoing;
    outgoing.clear();
    let edges = 0;
    for (let k = 0; k < net.length; k++) {
      const n = net[k];
      if (n === 0) continue;
      const from = n > 0 ? edgeA[k] : edgeB[k];
      const to = n > 0 ? edgeB[k] : edgeA[k];
      const list = outgoing.get(from);
      const copies = Math.abs(n);
      if (list) for (let c = 0; c < copies; c++) list.push(to);
      else outgoing.set(from, Array(copies).fill(to));
      edges += copies;
    }
    const tq = performance.now();
    this.phases.project += tq - tp;
    this.phases.triangles += edges;
    if (!edges) return null;

    if (this.fillMode === "triangles") return this.fillTriangles(ctx, adj, out, color);

    // Chain directed edges into closed loops. Every vertex has as many
    // outgoing as incoming silhouette edges, so any unused outgoing edge
    // continues the walk and a walk can only get stuck back at its start.
    const path = new Path2D();
    let open = false;
    for (const [start, firstList] of outgoing) {
      while (firstList.length) {
        let v = start;
        path.moveTo(out[v * 2], out[v * 2 + 1]);
        let closed = false;
        for (let guard = 0; guard <= edges; guard++) {
          const list = outgoing.get(v);
          if (!list || !list.length) break;
          v = list.pop()!;
          if (v === start) {
            closed = true;
            break;
          }
          path.lineTo(out[v * 2], out[v * 2 + 1]);
        }
        path.closePath();
        if (!closed) open = true;
      }
    }
    if (open) {
      // Cannot happen with balanced edges; if it ever does, correctness over
      // speed: fill every front triangle for this mesh instead.
      this.unclosedLoops++;
      return this.fillTriangles(ctx, adj, out, color);
    }
    const tr = performance.now();
    this.phases.path += tr - tq;
    ctx.fillStyle = color;
    ctx.fill(path, "nonzero");
    this.phases.fill += performance.now() - tr;
    return path;
  }

  /** Count of silhouette chains that failed to close (expected to stay 0). */
  unclosedLoops = 0;

  /** Ground truth / fallback: every front-facing triangle, one nonzero fill. */
  private fillTriangles(ctx: CanvasRenderingContext2D, adj: Adjacency, out: Float32Array, color: string): Path2D {
    const { tris, triCount, front } = adj;
    const path = new Path2D();
    for (let t = 0, i = 0; t < triCount; t++, i += 3) {
      if (!front[t]) continue;
      const a = tris[i] * 2, b = tris[i + 1] * 2, c = tris[i + 2] * 2;
      path.moveTo(out[a], out[a + 1]);
      path.lineTo(out[b], out[b + 1]);
      path.lineTo(out[c], out[c + 1]);
      path.closePath();
    }
    ctx.fillStyle = color;
    ctx.fill(path, "nonzero");
    return path;
  }

  private adjacencyCache = new Map<THREE.BufferGeometry, Adjacency>();
  private outgoing = new Map<number, number[]>();

  /**
   * Triangle list plus the undirected edge table: for each triangle side, the
   * edge it lies on and whether it runs along (+1) or against (-1) the edge's
   * stored direction. Built once per geometry; welded vertex indices are the
   * keys, never float positions.
   */
  private adjacency(geometry: THREE.BufferGeometry): Adjacency {
    let adj = this.adjacencyCache.get(geometry);
    if (adj) return adj;
    const index = geometry.getIndex();
    const vertexCount = geometry.attributes.position.count;
    const triCount = index ? index.count / 3 : vertexCount / 3;
    const tris = new Uint32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) tris[i] = index ? index.getX(i) : i;
    const edgeOf = new Map<number, number>();
    const edgeA: number[] = [], edgeB: number[] = [];
    const triEdge = new Uint32Array(triCount * 3);
    const triSign = new Int8Array(triCount * 3);
    for (let t = 0; t < triCount; t++) {
      for (let s = 0; s < 3; s++) {
        const a = tris[t * 3 + s], b = tris[t * 3 + ((s + 1) % 3)];
        const lo = Math.min(a, b), hi = Math.max(a, b);
        const key = lo * vertexCount + hi;
        let k = edgeOf.get(key);
        if (k === undefined) {
          k = edgeA.length;
          edgeOf.set(key, k);
          edgeA.push(lo);
          edgeB.push(hi);
        }
        triEdge[t * 3 + s] = k;
        triSign[t * 3 + s] = a === lo ? 1 : -1;
      }
    }
    adj = {
      tris,
      triCount,
      front: new Uint8Array(triCount),
      edgeA: Uint32Array.from(edgeA),
      edgeB: Uint32Array.from(edgeB),
      triEdge,
      triSign,
      net: new Int16Array(edgeA.length),
    };
    this.adjacencyCache.set(geometry, adj);
    return adj;
  }
}

type Adjacency = {
  tris: Uint32Array;
  triCount: number;
  front: Uint8Array;
  edgeA: Uint32Array;
  edgeB: Uint32Array;
  triEdge: Uint32Array;
  triSign: Int8Array;
  net: Int16Array;
};

function isDrawable(material: THREE.Material | THREE.Material[]): boolean {
  const m = Array.isArray(material) ? material[0] : material;
  if (!m || m.visible === false) return false;
  if (m.transparent && m.opacity <= 0.01) return false;
  return "color" in m;
}

function colorOf(material: THREE.Material | THREE.Material[]): string {
  const m = (Array.isArray(material) ? material[0] : material) as THREE.Material & { color?: THREE.Color };
  return m.color ? `#${m.color.getHexString()}` : "#000000";
}
