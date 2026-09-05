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
 *   `Path2D` made of its front-facing triangles, filled once with the nonzero
 *   rule, so the union is seamless (no hairlines between triangles) and the
 *   silhouette is exactly the mesh's.
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
  }

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
  }

  private applySize() {
    this.domElement.width = Math.max(1, Math.floor(this.width * this.dpr));
    this.domElement.height = Math.max(1, Math.floor(this.height * this.dpr));
  }

  render(scene: THREE.Scene, camera: THREE.Camera) {
    const t0 = performance.now();
    if (scene.matrixWorldAutoUpdate) scene.updateMatrixWorld();
    if (camera.parent === null && camera.matrixWorldAutoUpdate) camera.updateMatrixWorld();

    const { ctx, dpr, width, height } = this;
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
      this.fillMesh(mesh, colorOf(mesh.material));
      for (const child of mesh.children) {
        const eye = child as THREE.Mesh;
        if (!eye.isMesh || !eye.visible) continue;
        const local = eye.userData.eyeNormal as THREE.Vector3 | undefined;
        if (local) {
          this.normalMatrix.getNormalMatrix(mesh.matrixWorld);
          this.tmpN.copy(local).applyMatrix3(this.normalMatrix).normalize();
          // Flush inlay: visible while its face points toward the viewer.
          if (this.tmpN.dot(this.toCamera) < 0.12) continue;
        }
        if (isDrawable(eye.material)) this.fillMesh(eye, colorOf(eye.material));
      }
    }

    const dt = performance.now() - t0;
    this.frames++;
    this.frameMs += (dt - this.frameMs) * 0.1;
  }

  /** Fill a mesh's front-facing triangles as one seamless path. */
  private fillMesh(mesh: THREE.Mesh, color: string) {
    const geometry = mesh.geometry;
    const position = geometry.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) return;
    const { width, height } = this;
    const count = position.count;
    let out = this.projected.get(geometry);
    if (!out || out.length < count * 3) {
      out = new Float32Array(count * 3);
      this.projected.set(geometry, out);
    }
    this.mvp.multiplyMatrices(this.viewProj, mesh.matrixWorld);
    const e = this.mvp.elements;
    const src = position.array as ArrayLike<number>;
    for (let i = 0, j = 0; i < count; i++, j += 3) {
      const x = src[j], y = src[j + 1], z = src[j + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15] || 1;
      const nx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
      const ny = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
      out[j] = (nx + 1) * 0.5 * width;
      out[j + 1] = (1 - ny) * 0.5 * height;
      out[j + 2] = w;
    }

    const path = new Path2D();
    const index = geometry.getIndex();
    const tris = index ? index.count / 3 : count / 3;
    let drawn = 0;
    for (let t = 0; t < tris; t++) {
      const a = index ? index.getX(t * 3) : t * 3;
      const b = index ? index.getX(t * 3 + 1) : t * 3 + 1;
      const c = index ? index.getX(t * 3 + 2) : t * 3 + 2;
      const ax = out[a * 3], ay = out[a * 3 + 1];
      const bx = out[b * 3], by = out[b * 3 + 1];
      const cx = out[c * 3], cy = out[c * 3 + 1];
      // Screen y points down, so a counter-clockwise (front-facing) triangle
      // in NDC has negative signed area here. Skip back faces.
      const area = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (area >= 0) continue;
      path.moveTo(ax, ay);
      path.lineTo(bx, by);
      path.lineTo(cx, cy);
      path.closePath();
      drawn++;
    }
    if (!drawn) return;
    const ctx = this.ctx;
    ctx.fillStyle = color;
    ctx.fill(path, "nonzero");
  }
}

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
