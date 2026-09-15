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
 * - Bodies tagged `userData.perTriangle` (hollow shells you look into) are
 *   instead painted triangle by triangle in one global depth sort with
 *   back-face culling and per-triangle colours; see `paintTriangles`.
 *
 * Effects (`effects.trail`, `effects.blur`, both 0–1, 0 = off):
 * - Trail: each body's silhouette path is snapshotted as it moves and the
 *   snapshots are refilled in the body's colour, fading with age, before the
 *   live bodies. The frame is still fully cleared to the background every
 *   time, so unlike an alpha fade-clear there is no residue that never quite
 *   reaches the background, and changing the background colour just works.
 * - Blur: the body (with its eyes) is refilled a few times, stepped backwards
 *   along its screen-space velocity (`mesh.userData.velocity`, world units/s,
 *   written by the scene) with decreasing alpha, then drawn solid on top.
 */
/** A closed polyline in world units (x, y pairs) stroked at a world-unit width. */
export type StageStroke = { points: Float32Array; width: number; color: string };

export class Canvas2DRenderer {
  readonly domElement: HTMLCanvasElement;
  readonly isCanvas2DRenderer = true;
  /** Rolling average of `render()` time, ms — read by headless checks. */
  frameMs = 0;
  frames = 0;
  /** Effect strengths, 0–1 each; 0 disables. Set by the scene from the Leva panel. */
  effects = { trail: 0, blur: 0 };
  /**
   * Framed backdrop: `outline` is a closed polygon in world units (x, y
   * pairs) filled with `inside`; everything else is `outside`, and bodies,
   * trails and blur are clipped to the polygon. Null: flat scene background.
   */
  stage: { outline: Float32Array; inside: string; outside: string; strokes?: StageStroke[] } | null = null;
  /** Extra fills drawn last frame for trails and blur, for profiling. */
  ghostFills = 0;

  private trails = new Map<THREE.Mesh, TrailHistory>();

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
  phases = { project: 0, path: 0, fill: 0, triangles: 0, trails: 0 };
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
    this.viewXYZ.clear();
    this.triColorCache.clear();
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

  /**
   * Snapshot frame: the scene as last drawn, at native pixel size, into a
   * fresh canvas with no outside fill — the stage polygon holds the interior
   * colour, bodies, trails (from the live history, which is left untouched)
   * and blur; everything else is transparent, and the polygon's edge is
   * anti-aliased. Null until a frame has been rendered.
   */
  snapshot(scene = this.lastScene, camera = this.lastCamera): HTMLCanvasElement | null {
    if (!scene || !camera) return null;
    const c = document.createElement("canvas");
    c.width = this.domElement.width;
    c.height = this.domElement.height;
    const ctx = c.getContext("2d");
    if (!ctx) return null;
    this.transparentOutside = true;
    try {
      this.renderTo(ctx, this.dpr, scene, camera);
    } finally {
      this.transparentOutside = false;
    }
    return c;
  }

  /** While set, `renderTo` leaves everything outside the stage polygon transparent. */
  private transparentOutside = false;

  private renderTo(ctx: CanvasRenderingContext2D, dpr: number, scene: THREE.Scene, camera: THREE.Camera) {
    const t0 = performance.now();
    this.phases.project = this.phases.path = this.phases.fill = this.phases.triangles = this.phases.trails = 0;
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();

    const { width, height } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    // Unit vector from the scene toward the camera (orthographic: constant).
    this.toCamera.set(0, 0, 1).transformDirection(camera.matrixWorld);

    const stage = this.stage;
    const transparent = this.transparentOutside;
    let stagePath: Path2D | null = null;
    if (stage) {
      if (transparent) {
        ctx.clearRect(0, 0, width, height);
      } else {
        ctx.fillStyle = stage.outside;
        ctx.fillRect(0, 0, width, height);
      }
      const frame = new Path2D();
      const pts = stage.outline;
      for (let i = 0; i < pts.length; i += 2) {
        this.tmpV.set(pts[i], pts[i + 1], 0);
        this.project(this.tmpV);
        if (i === 0) frame.moveTo(this.tmpV.x, this.tmpV.y);
        else frame.lineTo(this.tmpV.x, this.tmpV.y);
      }
      frame.closePath();
      stagePath = frame;
      ctx.fillStyle = stage.inside;
      ctx.fill(frame);
      // Nothing drawn from here on may leave the frame.
      ctx.save();
      ctx.clip(frame);
      // Track strokes: closed polylines in world units, stroked with round
      // joins at a world-unit width, behind everything but the interior.
      if (stage.strokes?.length) {
        this.tmpV.set(0, 0, 0);
        this.project(this.tmpV);
        const ox = this.tmpV.x;
        this.tmpV.set(1, 0, 0);
        this.project(this.tmpV);
        const pxPerUnit = Math.abs(this.tmpV.x - ox);
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        for (const stroke of stage.strokes) {
          const path = new Path2D();
          const p = stroke.points;
          for (let i = 0; i < p.length; i += 2) {
            this.tmpV.set(p[i], p[i + 1], 0);
            this.project(this.tmpV);
            if (i === 0) path.moveTo(this.tmpV.x, this.tmpV.y);
            else path.lineTo(this.tmpV.x, this.tmpV.y);
          }
          path.closePath();
          ctx.strokeStyle = stroke.color;
          ctx.lineWidth = Math.max(0.5, stroke.width * pxPerUnit);
          ctx.stroke(path);
        }
      }
    } else {
      const bg = scene.background;
      if (bg instanceof THREE.Color) {
        ctx.fillStyle = `#${bg.getHexString()}`;
        ctx.fillRect(0, 0, width, height);
      } else {
        ctx.clearRect(0, 0, width, height);
      }
    }

    // Top-level meshes are bodies (or the click-catcher plane); mesh children
    // of a body are its eyes. WebGL-only blur ghosts are tagged and skipped.
    this.bodies.length = 0;
    scene.traverseVisible((obj) => {
      if (!(obj as THREE.Mesh).isMesh) return;
      const mesh = obj as THREE.Mesh;
      if (mesh.parent && (mesh.parent as THREE.Mesh).isMesh) return;
      if (mesh.userData.ghost) return;
      if (!isDrawable(mesh.material)) return;
      this.tmpV.setFromMatrixPosition(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse);
      this.bodies.push({ mesh, depth: this.tmpV.z });
    });
    // View space looks down -Z: more negative is farther. Draw far first.
    this.bodies.sort((a, b) => a.depth - b.depth);

    // Only the on-screen frame advances the trail history; a snapshot draws
    // it as it stands, and ground-truth compare renders skip it entirely.
    const live = ctx === this.ctx;
    const now = t0;
    const { trail, blur } = this.effects;
    this.ghostFills = 0;

    // Build every body's paths first so trails can be laid down underneath all of them.
    // Bodies flagged `perTriangle` (things you can see into) skip the
    // silhouette and go through the global triangle sort below instead.
    const frame: BodyFrame[] = [];
    const perTriangle: THREE.Mesh[] = [];
    for (const { mesh, depth } of this.bodies) {
      if (mesh.userData.perTriangle) {
        perTriangle.push(mesh);
        continue;
      }
      const bodyPath = this.buildPath(mesh);
      if (!bodyPath) continue;
      const eyes: { path: Path2D; color: string }[] = [];
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
        const eyePath = this.buildPath(eye);
        if (eyePath) eyes.push({ path: eyePath, color: colorOf(eye.material) });
      }
      frame.push({ mesh, depth, path: bodyPath, color: colorOf(mesh.material), alpha: alphaOf(mesh.material), eyes });
    }

    if (live || transparent) this.drawTrails(ctx, frame, trail, now, live);

    const tf = performance.now();
    if (perTriangle.length) this.paintTriangles(ctx, camera, frame, perTriangle, blur);
    else for (const body of frame) this.paintBody(ctx, body, blur);
    this.phases.fill += performance.now() - tf;
    if (stage) ctx.restore();
    if (stagePath && transparent) {
      // The clip's edge may be aliased in some browsers; keying the whole
      // frame through an ordinary (anti-aliased) fill of the same path
      // guarantees a soft edge against the transparent outside.
      ctx.globalCompositeOperation = "destination-in";
      ctx.fill(stagePath);
      ctx.globalCompositeOperation = "source-over";
    }

    const dt = performance.now() - t0;
    this.frames++;
    this.frameMs += (dt - this.frameMs) * 0.1;
  }

  /** One silhouette body: optional blur, the fill at its opacity, then its eyes clipped to it. */
  private paintBody(ctx: CanvasRenderingContext2D, body: BodyFrame, blur: number) {
    if (blur > 0) this.drawBlur(ctx, body, blur);
    // A translucent material (a fading body) fills at its opacity.
    ctx.globalAlpha = body.alpha;
    ctx.fillStyle = body.color;
    ctx.fill(body.path, "nonzero");
    // The pill is mostly buried in the body; clipping to the body's
    // silhouette stands in for the depth test at grazing angles.
    if (body.eyes.length) {
      ctx.save();
      ctx.clip(body.path, "nonzero");
      for (const eye of body.eyes) {
        ctx.fillStyle = eye.color;
        ctx.fill(eye.path, "nonzero");
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  // Per-frame triangle list for the painter (screen xy per corner, view depth, colour).
  private triXY: number[] = [];
  private triDepth: number[] = [];
  private triColor: string[] = [];
  private triOrder: number[] = [];
  private viewXYZ = new Map<THREE.BufferGeometry, Float32Array>();
  private triColorCache = new Map<THREE.BufferGeometry, string[] | null>();

  /**
   * Painter's algorithm per triangle for bodies you can see into (the
   * nesting shells): every front-facing triangle of every `perTriangle` body
   * and of its camera-facing eyes goes into one list, sorted far to near by
   * view depth, and is filled with its own colour — the geometry's vertex
   * colour (one flat tone per triangle) or the material colour. Ordinary
   * silhouette bodies are slotted into the same order at their centre depth,
   * so a solid core inside the shells paints after their back walls and
   * before their front walls. Runs of one colour are merged into a single
   * path, so the fill count is a few hundred, not the triangle count.
   */
  private paintTriangles(ctx: CanvasRenderingContext2D, camera: THREE.Camera, bodies: BodyFrame[], meshes: THREE.Mesh[], blur: number) {
    const xy = this.triXY, depth = this.triDepth, color = this.triColor;
    xy.length = depth.length = color.length = 0;
    for (const mesh of meshes) {
      this.gatherTriangles(mesh, camera, 0);
      for (const child of mesh.children) {
        const eye = child as THREE.Mesh;
        if (!eye.isMesh || !eye.visible || !isDrawable(eye.material)) continue;
        const local = eye.userData.eyeNormal as THREE.Vector3 | undefined;
        if (local) {
          this.normalMatrix.getNormalMatrix(mesh.matrixWorld);
          this.tmpN.copy(local).applyMatrix3(this.normalMatrix).normalize();
          if (this.tmpN.dot(this.toCamera) < 0.15) continue;
        }
        // The pill's lip stands 0.025 body units proud of the face; a bias a
        // little larger than that puts every eye triangle after the face
        // triangles it sits in.
        this.tmpV.setFromMatrixColumn(eye.matrixWorld, 0);
        this.gatherTriangles(eye, camera, 0.06 * this.tmpV.length());
      }
    }
    const n = depth.length;
    const order = this.triOrder;
    order.length = n;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      order[i] = i;
      if (depth[i] < lo) lo = depth[i];
      if (depth[i] > hi) hi = depth[i];
    }
    // Depth is quantised into thin slabs and ties broken by colour, so
    // triangles of one surface that interleave in depth with an occluded
    // surface behind it (the next shell's face) still paint as one run —
    // hundreds of fills instead of thousands, and far fewer seams. A slab
    // is well under the gap between two shells or a wall's thickness.
    const slab = (hi - lo) / DEPTH_SLABS || 1;
    const key = (i: number) => Math.floor((depth[i] - lo) / slab);
    order.sort((a, b) => key(a) - key(b) || (color[a] < color[b] ? -1 : color[a] > color[b] ? 1 : 0) || depth[a] - depth[b]);
    this.phases.triangles += n;

    let bi = 0;
    let path: Path2D | null = null;
    let current = "";
    const flush = () => {
      if (path) {
        ctx.fillStyle = current;
        ctx.fill(path, "nonzero");
        path = null;
      }
    };
    for (let k = 0; k < n; k++) {
      const i = order[k];
      const d = depth[i];
      while (bi < bodies.length && bodies[bi].depth <= d) {
        flush();
        current = "";
        this.paintBody(ctx, bodies[bi++], blur);
      }
      if (!path || color[i] !== current) {
        flush();
        current = color[i];
        path = new Path2D();
      }
      const j = i * 6;
      path.moveTo(xy[j], xy[j + 1]);
      path.lineTo(xy[j + 2], xy[j + 3]);
      path.lineTo(xy[j + 4], xy[j + 5]);
      path.closePath();
    }
    flush();
    while (bi < bodies.length) this.paintBody(ctx, bodies[bi++], blur);
  }

  /** Project a mesh and append its front-facing triangles to the painter's list. */
  private gatherTriangles(mesh: THREE.Mesh, camera: THREE.Camera, bias: number) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) return;
    const count = position.count;
    let v = this.viewXYZ.get(geometry);
    if (!v || v.length < count * 3) {
      v = new Float32Array(count * 3);
      this.viewXYZ.set(geometry, v);
    }
    const { width, height } = this;
    this.mvp.multiplyMatrices(this.viewProj, mesh.matrixWorld);
    const e = this.mvp.elements;
    // View-space z for the depth: row 3 of view × world.
    const mv = this.mvp2.multiplyMatrices(camera.matrixWorldInverse, mesh.matrixWorld).elements;
    const src = position.array as ArrayLike<number>;
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = src[j], y = src[j + 1], z = src[j + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      v[j] = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w + 1) * 0.5 * width;
      v[j + 1] = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w) * 0.5 * height;
      v[j + 2] = mv[2] * x + mv[6] * y + mv[10] * z + mv[14];
    }

    let colors = this.triColorCache.get(geometry);
    if (colors === undefined) {
      colors = triangleColors(geometry);
      this.triColorCache.set(geometry, colors);
    }
    const flat = colors ? "" : colorOf(mesh.material);
    const index = geometry.getIndex();
    const triCount = index ? index.count / 3 : count / 3;
    const xy = this.triXY, depth = this.triDepth, color = this.triColor;
    for (let t = 0; t < triCount; t++) {
      const a = (index ? index.getX(t * 3) : t * 3) * 3;
      const b = (index ? index.getX(t * 3 + 1) : t * 3 + 1) * 3;
      const c = (index ? index.getX(t * 3 + 2) : t * 3 + 2) * 3;
      const ax = v[a], ay = v[a + 1], bx = v[b], by = v[b + 1], cx = v[c], cy = v[c + 1];
      // Screen y points down: a front-facing (CCW in NDC) triangle has negative area here.
      if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) >= 0) continue;
      // Grow each triangle half a pixel about its centroid: abutting fills
      // from different runs would otherwise leave anti-aliased hairlines.
      const mx = (ax + bx + cx) / 3, my = (ay + by + cy) / 3;
      const grow = (x: number, y: number, k: number) => {
        const dx = x - mx, dy = y - my;
        const len = Math.hypot(dx, dy) || 1;
        xy.push(x + (dx / len) * DILATE_PX, y + (dy / len) * DILATE_PX);
        return k;
      };
      grow(ax, ay, 0);
      grow(bx, by, 1);
      grow(cx, cy, 2);
      depth.push((v[a + 2] + v[b + 2] + v[c + 2]) / 3 + bias);
      color.push(colors ? colors[t] : flat);
    }
  }
  private mvp2 = new THREE.Matrix4();

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
  private buildPath(mesh: THREE.Mesh): Path2D | null {
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

    if (this.fillMode === "triangles") return this.trianglePath(adj, out);

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
      return this.trianglePath(adj, out);
    }
    this.phases.path += performance.now() - tq;
    return path;
  }

  /** Count of silhouette chains that failed to close (expected to stay 0). */
  unclosedLoops = 0;

  /** Ground truth / fallback: every front-facing triangle, one nonzero fill. */
  private trianglePath(adj: Adjacency, out: Float32Array): Path2D {
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
    return path;
  }

  /**
   * Trails: remember where each body was and refill those silhouettes, oldest
   * and faintest first. Snapshots are spaced in time (at most TRAIL_SNAPSHOTS
   * alive per body, so the cost is bounded) and skipped while a body is
   * parked, so a dragged bot does not stack copies into a solid blot.
   */
  private drawTrails(ctx: CanvasRenderingContext2D, frame: BodyFrame[], trail: number, now: number, record: boolean) {
    if (trail <= 0) {
      if (record && this.trails.size) this.trails.clear();
      return;
    }
    const life = TRAIL_SECONDS * trail;
    const interval = Math.max(1000 / 60, (life * 1000) / TRAIL_SNAPSHOTS);
    if (record) {
      const seen = new Set<THREE.Mesh>();
      for (const body of frame) {
        seen.add(body.mesh);
        let h = this.trails.get(body.mesh);
        if (!h) {
          h = { snapshots: [], lastAt: -Infinity, lastX: NaN, lastY: NaN };
          this.trails.set(body.mesh, h);
        }
        this.tmpV.setFromMatrixPosition(body.mesh.matrixWorld);
        this.project(this.tmpV);
        const moved = Math.hypot(this.tmpV.x - h.lastX, this.tmpV.y - h.lastY);
        if (now - h.lastAt >= interval && !(moved < 2)) {
          h.snapshots.push({ path: body.path, color: body.color, at: now });
          h.lastAt = now;
          h.lastX = this.tmpV.x;
          h.lastY = this.tmpV.y;
          if (h.snapshots.length > TRAIL_SNAPSHOTS) h.snapshots.shift();
        }
      }
      // Bodies that vanished (respawn) keep fading out, then drop off.
      for (const [mesh, h] of this.trails) {
        while (h.snapshots.length && now - h.snapshots[0].at > life * 1000) h.snapshots.shift();
        if (!h.snapshots.length && !seen.has(mesh)) this.trails.delete(mesh);
      }
    }
    const tg = performance.now();
    // Oldest first across all bodies, so a fresh ghost never hides under a stale one.
    let oldest = Infinity;
    for (const h of this.trails.values()) if (h.snapshots.length) oldest = Math.min(oldest, h.snapshots[0].at);
    if (oldest === Infinity) return;
    // Snapshots are spaced by `interval`, so walking time slots in order is
    // equivalent to a global sort but needs no allocation.
    for (let t = oldest; t <= now; t += interval) {
      for (const h of this.trails.values()) {
        for (const snap of h.snapshots) {
          if (snap.at < t || snap.at >= t + interval) continue;
          const age = (now - snap.at) / (life * 1000);
          if (age >= 1) continue;
          ctx.globalAlpha = TRAIL_ALPHA * (1 - age) ** 1.5;
          ctx.fillStyle = snap.color;
          ctx.fill(snap.path, "nonzero");
          this.ghostFills++;
        }
      }
    }
    ctx.globalAlpha = 1;
    this.phases.trails = performance.now() - tg;
  }

  /**
   * Speed blur: refill the body and its eyes stepped backwards along its
   * screen-space velocity, faintest and farthest first. The offset is
   * `speed × blur × BLUR_SECONDS` of travel, so faster bots smear more.
   */
  private drawBlur(ctx: CanvasRenderingContext2D, body: BodyFrame, blur: number) {
    const vel = body.mesh.userData.velocity as THREE.Vector3 | undefined;
    if (!vel) return;
    const speed = vel.length();
    if (speed < 1e-3) return;
    // Screen-space velocity: project the position and position + velocity.
    this.tmpV.setFromMatrixPosition(body.mesh.matrixWorld);
    this.project(this.tmpV);
    const px = this.tmpV.x, py = this.tmpV.y;
    this.tmpV.setFromMatrixPosition(body.mesh.matrixWorld).add(vel);
    this.project(this.tmpV);
    const vx = this.tmpV.x - px, vy = this.tmpV.y - py;
    const vlen = Math.hypot(vx, vy);
    const length = vlen * blur * BLUR_SECONDS;
    if (length < 1) return;
    const copies = Math.min(BLUR_MAX_COPIES, Math.max(2, Math.ceil(length / BLUR_STEP_PX)));
    const dx = -vx / vlen, dy = -vy / vlen;
    for (let i = copies; i >= 1; i--) {
      const f = i / copies;
      ctx.save();
      ctx.translate(dx * length * f, dy * length * f);
      ctx.globalAlpha = BLUR_ALPHA * (1 - f) + 0.04;
      ctx.fillStyle = body.color;
      ctx.fill(body.path, "nonzero");
      if (body.eyes.length) {
        ctx.clip(body.path, "nonzero");
        for (const eye of body.eyes) {
          ctx.fillStyle = eye.color;
          ctx.fill(eye.path, "nonzero");
        }
      }
      ctx.restore();
      this.ghostFills += 1 + body.eyes.length;
    }
  }

  /** World position → canvas pixels (CSS px, before the dpr transform), in place. */
  private project(v: THREE.Vector3) {
    v.applyMatrix4(this.viewProj);
    v.x = (v.x + 1) * 0.5 * this.width;
    v.y = (1 - v.y) * 0.5 * this.height;
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

/** Trail persistence at `trail = 1`, seconds. */
const TRAIL_SECONDS = 2;
/** Most snapshots kept alive per body; bounds the extra fills per frame. */
const TRAIL_SNAPSHOTS = 24;
/** Opacity of the newest trail copy. */
const TRAIL_ALPHA = 0.45;
/** Smear length at `blur = 1`, as seconds of travel along the velocity. */
const BLUR_SECONDS = 0.16;
const BLUR_MAX_COPIES = 8;
const BLUR_STEP_PX = 8;
/** Opacity of the blur copy nearest the body. */
const BLUR_ALPHA = 0.5;
/** Painter: depth slabs across the frame's depth range, and the per-triangle growth in CSS px. */
const DEPTH_SLABS = 200;
const DILATE_PX = 0.5;

type BodyFrame = {
  mesh: THREE.Mesh;
  /** View-space z of the body's origin (more negative is farther). */
  depth: number;
  path: Path2D;
  color: string;
  /** Fill opacity, from a transparent material; 1 otherwise. */
  alpha: number;
  eyes: { path: Path2D; color: string }[];
};

type TrailHistory = {
  snapshots: { path: Path2D; color: string; at: number }[];
  lastAt: number;
  lastX: number;
  lastY: number;
};

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

/**
 * One CSS colour per triangle from a geometry's `color` attribute (the first
 * corner's — the shells bake one tone per triangle), or null when the
 * geometry has none. Built once per geometry.
 */
function triangleColors(geometry: THREE.BufferGeometry): string[] | null {
  const attr = geometry.attributes.color as THREE.BufferAttribute | undefined;
  if (!attr) return null;
  const index = geometry.getIndex();
  const triCount = index ? index.count / 3 : attr.count / 3;
  const out = new Array<string>(triCount);
  const c = new THREE.Color();
  for (let t = 0; t < triCount; t++) {
    const i = index ? index.getX(t * 3) : t * 3;
    c.setRGB(attr.getX(i), attr.getY(i), attr.getZ(i));
    out[t] = `#${c.getHexString()}`;
  }
  return out;
}

function alphaOf(material: THREE.Material | THREE.Material[]): number {
  const m = Array.isArray(material) ? material[0] : material;
  return m && m.transparent ? Math.max(0, Math.min(1, m.opacity)) : 1;
}

function colorOf(material: THREE.Material | THREE.Material[]): string {
  const m = (Array.isArray(material) ? material[0] : material) as THREE.Material & { color?: THREE.Color };
  return m.color ? `#${m.color.getHexString()}` : "#000000";
}
