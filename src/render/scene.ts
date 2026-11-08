import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Model } from '../geometry/pipeline';
import { computeNormals } from '../geometry/mesh';
import { stitchNormalMap } from './textures';

/**
 * Renders the solved stitch surface. Triangles are expanded (non-indexed) so each one can carry
 * its own stitch-grid UVs without wrap seams; positions/normals are copied from the solver each frame.
 */
export class CrochetView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 1, 20000);
  readonly controls: OrbitControls;
  private mesh: THREE.Mesh | null = null;
  private markers = new THREE.Group();
  private model: Model | null = null;
  private pos: Float32Array = new Float32Array();
  private nrm: Float32Array = new Float32Array();
  private baseColors: Float32Array = new Float32Array();
  private highlightLine = -1;
  private needsFit = true;
  onPick: ((line: number) => void) | null = null;
  onSize: ((mm: [number, number, number]) => void) | null = null;

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    host.appendChild(this.renderer.domElement);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.scene.add(new THREE.HemisphereLight(0xfff6ee, 0x6b6460, 1.6));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(300, 500, 600);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xcfe0ff, 0.9);
    rim.position.set(-500, 200, -400);
    this.scene.add(rim);
    this.scene.add(this.markers);
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    this.renderer.domElement.addEventListener('pointerup', (e) => this.pick(e));
    const loop = () => {
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(loop);
    };
    loop();
  }

  setBackground(color: string) {
    this.scene.background = new THREE.Color(color);
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  resetView() {
    this.needsFit = true;
    this.fit();
  }

  /** New model (topology changed). */
  setModel(model: Model) {
    const keepView = !!this.model;
    this.model = model;
    if (this.mesh) {
      this.scene.remove(this.mesh);
      this.mesh.geometry.dispose();
      (this.mesh.material as THREE.Material).dispose();
    }
    const tris = model.tris;
    const T = tris.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(T * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(T * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(T * 3), 3));
    // UVs on the stitch grid: u = stitch index, v = row index (texture repeats once per stitch)
    const uv = new Float32Array(T * 2);
    const nodes = model.graph.nodes;
    const rowLen = new Map<string, number>();
    for (const pi of model.graph.instances) for (const r of pi.rows) rowLen.set(`${pi.piece.id}:${pi.inst}:${r.row}`, r.nodes.length);
    for (let t = 0; t < T; t += 3) {
      const us: number[] = [], vs: number[] = [];
      for (let k = 0; k < 3; k++) {
        const n = nodes[tris[t + k]];
        const len = rowLen.get(`${n.piece}:${n.inst}:${n.row}`) ?? 1;
        // map stitch index to a common scale so neighbouring rows line up
        us.push(n.virtual ? NaN : (n.u + 0.5) / len);
        vs.push(n.row);
      }
      const ref = us.find((u) => !Number.isNaN(u)) ?? 0;
      let L = 1;
      for (let k = 0; k < 3; k++) {
        const n = nodes[tris[t + k]];
        L = Math.max(L, rowLen.get(`${n.piece}:${n.inst}:${n.row}`) ?? 1);
      }
      for (let k = 0; k < 3; k++) {
        let u = Number.isNaN(us[k]) ? ref : us[k];
        if (u - ref > 0.5) u -= 1;
        if (ref - u > 0.5) u += 1;
        uv[(t + k) * 2] = u * L;
        uv[(t + k) * 2 + 1] = vs[k] * 0.8;
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.baseColors = new Float32Array(T * 3);
    const c = new THREE.Color();
    for (let t = 0; t < T; t++) {
      c.set(nodes[tris[t]].color);
      c.convertSRGBToLinear();
      this.baseColors.set([c.r, c.g, c.b], t * 3);
    }
    const sz = model.sizing;
    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      roughness: sz.roughness,
      sheen: sz.sheen * 0.45,
      sheenRoughness: 0.6,
      sheenColor: new THREE.Color(0x9a9a9a),
      normalMap: stitchNormalMap(),
      normalScale: new THREE.Vector2(1, 1).multiplyScalar(0.75 * (1 - sz.fuzz * 0.6)),
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);
    this.nrm = new Float32Array(model.solverInput.pos.length);
    this.applyColors();
    this.update(model.solverInput.pos);
    if (!keepView) this.needsFit = true;
  }

  highlight(line: number) {
    this.highlightLine = line;
    this.applyColors();
  }

  private applyColors() {
    if (!this.mesh || !this.model) return;
    const col = this.mesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    const arr = col.array as Float32Array;
    arr.set(this.baseColors);
    if (this.highlightLine >= 0) {
      const tris = this.model.tris;
      const nodes = this.model.graph.nodes;
      for (let t = 0; t < tris.length; t++) {
        if (nodes[tris[t]].line === this.highlightLine) {
          arr[t * 3] = arr[t * 3] * 0.35 + 0.65 * 1.0;
          arr[t * 3 + 1] = arr[t * 3 + 1] * 0.35 + 0.65 * 0.55;
          arr[t * 3 + 2] = arr[t * 3 + 2] * 0.35 + 0.65 * 0.1;
        }
      }
    }
    col.needsUpdate = true;
  }

  /** New positions from the solver (same topology). */
  update(pos: Float32Array) {
    if (!this.mesh || !this.model) return;
    this.pos = pos;
    const { tris, triPiece, graph } = this.model;
    computeNormals(pos, tris, triPiece, graph.instances, this.nrm);
    const P = (this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
    const Nn = (this.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute);
    const pa = P.array as Float32Array, na = Nn.array as Float32Array;
    for (let t = 0; t < tris.length; t++) {
      const i = tris[t] * 3;
      pa[t * 3] = pos[i]; pa[t * 3 + 1] = pos[i + 1]; pa[t * 3 + 2] = pos[i + 2];
      na[t * 3] = this.nrm[i]; na[t * 3 + 1] = this.nrm[i + 1]; na[t * 3 + 2] = this.nrm[i + 2];
    }
    P.needsUpdate = true;
    Nn.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
    this.updateMarkers();
    const bb = this.mesh.geometry.boundingBox!;
    const s = bb.getSize(new THREE.Vector3());
    this.onSize?.([s.x, s.y, s.z]);
    if (this.needsFit) this.fit();
  }

  private updateMarkers() {
    if (!this.model) return;
    this.markers.clear();
    const pos = this.pos, nrm = this.nrm;
    for (const m of this.model.markers) {
      const p = new THREE.Vector3(
        (pos[m.a * 3] + pos[m.b * 3]) / 2, (pos[m.a * 3 + 1] + pos[m.b * 3 + 1]) / 2, (pos[m.a * 3 + 2] + pos[m.b * 3 + 2]) / 2,
      );
      const n = new THREE.Vector3(nrm[m.a * 3] + nrm[m.b * 3], nrm[m.a * 3 + 1] + nrm[m.b * 3 + 1], nrm[m.a * 3 + 2] + nrm[m.b * 3 + 2]).normalize();
      if (m.kind === 'safety-eyes') {
        const r = m.sizeMm / 2;
        const eye = new THREE.Mesh(
          new THREE.SphereGeometry(r, 24, 16),
          new THREE.MeshPhysicalMaterial({ color: 0x111111, roughness: 0.08, clearcoat: 1, clearcoatRoughness: 0.05 }),
        );
        eye.scale.set(1, 1, 0.6);
        eye.position.copy(p).addScaledVector(n, r * 0.25);
        eye.lookAt(p.clone().addScaledVector(n, 10));
        this.markers.add(eye);
      } else {
        const brow = new THREE.Mesh(
          new THREE.CapsuleGeometry(1.2, (this.model.sizing.w * 0.9), 4, 8),
          new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 }),
        );
        brow.position.copy(p).addScaledVector(n, 0.8);
        // lie along the surface, roughly horizontal
        const tangent = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize();
        brow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent.lengthSq() ? tangent : new THREE.Vector3(1, 0, 0));
        this.markers.add(brow);
      }
    }
  }

  private fit() {
    if (!this.mesh) return;
    const bb = this.mesh.geometry.boundingBox;
    if (!bb) return;
    const c = bb.getCenter(new THREE.Vector3());
    const r = bb.getSize(new THREE.Vector3()).length() / 2 || 50;
    const d = r / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.set(c.x + d * 0.25, c.y + d * 0.25, c.z + d * 0.95);
    this.camera.near = d / 100;
    this.camera.far = d * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(c);
    this.needsFit = false;
  }

  private pick(e: PointerEvent) {
    if (!this.mesh || !this.model || !this.onPick) return;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObject(this.mesh)[0];
    if (!hit || hit.faceIndex == null) return;
    const t = hit.faceIndex * 3;
    const ids = [this.model.tris[t], this.model.tris[t + 1], this.model.tris[t + 2]];
    const node = ids.map((id) => this.model!.graph.nodes[id]).find((n) => !n.virtual && n.line >= 0);
    if (node) this.onPick(node.line);
  }
}
