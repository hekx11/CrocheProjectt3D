import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Model } from '../geometry/pipeline';
import { computeNormals } from '../geometry/mesh';
import { yarnTextures, type YarnTextures, STITCH_BAND, TR } from './textures';
import { Yarn3D } from './yarn3d';

/** Stitches drawn as real 3D yarn; "?yarn=flat" falls back to the textured surface alone. */
const YARN3D = typeof location === 'undefined' || !/[?&]yarn=flat\b/.test(location.search);

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
  private shells = new THREE.Group();
  private ridges = new THREE.Group();
  private ridgeDefs: { mesh: THREE.Mesh; path: number[]; closed: boolean; radius: number; segs: number }[] = [];
  private corner: Uint32Array = new Uint32Array();
  private relief = { map: null as THREE.Texture | null, scale: 0, bias: 0 };
  private markers = new THREE.Group();
  private yarn = new Yarn3D();
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
    this.scene.add(this.shells);
    this.scene.add(this.ridges);
    this.scene.add(this.yarn.group);
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
    for (const sh of this.shells.children) ((sh as THREE.Mesh).material as THREE.Material).dispose();
    this.shells.clear();
    this.clearRidges();
    const tris = model.tris;
    const T = tris.length;
    // UVs on the stitch grid, per triangle corner: u = stitch index, v = row index
    const cornerUv = new Float32Array(T * 2);
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
      // the stitch a triangle shows belongs to its upper row: use that stitch's type to pick the
      // texture band (sc / hdc / dc), and count v from the tile start below so it stays in the band
      let top = 0;
      for (let k = 1; k < 3; k++) if (vs[k] > vs[top]) top = k;
      const band = STITCH_BAND[nodes[tris[t + top]].type] ?? 0;
      const base = TR * Math.floor(Math.min(vs[0], vs[1], vs[2]) / TR);
      for (let k = 0; k < 3; k++) {
        let u = Number.isNaN(us[k]) ? ref : us[k];
        if (u - ref > 0.5) u -= 1;
        if (ref - u > 0.5) u += 1;
        cornerUv[(t + k) * 2] = u * L;
        cornerUv[(t + k) * 2 + 1] = vs[k] - base + band * TR;
      }
    }
    // Tessellate every triangle into SUB² small ones so the stitch relief can really push the
    // surface (bumpy outline) and the shape is smoothed between solver nodes (Phong tessellation).
    const V = T * SUB * SUB; // expanded vertex count (T counts corners: 3 per triangle)
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(V * 3), 3));
    const uv = new Float32Array(V * 2);
    this.corner = new Uint32Array(V);
    for (let t = 0; t < T; t += 3) {
      const base = (t / 3) * BARY.length / 3;
      for (let j = 0; j < BARY.length / 3; j++) {
        const w0 = BARY[j * 3], w1 = BARY[j * 3 + 1], w2 = BARY[j * 3 + 2];
        const o = base + j;
        uv[o * 2] = w0 * cornerUv[t * 2] + w1 * cornerUv[(t + 1) * 2] + w2 * cornerUv[(t + 2) * 2];
        uv[o * 2 + 1] = w0 * cornerUv[t * 2 + 1] + w1 * cornerUv[(t + 1) * 2 + 1] + w2 * cornerUv[(t + 2) * 2 + 1];
        // colours change at stitch boundaries, not as a blur: take the nearest corner's yarn
        this.corner[o] = t + (w0 >= w1 && w0 >= w2 ? 0 : w1 >= w2 ? 1 : 2);
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    this.baseColors = new Float32Array(V * 3);
    const c = new THREE.Color();
    for (let o = 0; o < V; o++) {
      c.set(nodes[tris[this.corner[o]]].color); // Color.set already converts the sRGB hex to linear
      this.baseColors.set([c.r, c.g, c.b], o * 3);
    }
    const sz = model.sizing;
    const yt = yarnTextures(sz.fiber);
    const look = yt.look;
    this.relief = { map: yt.reliefMap, scale: look.relief * sz.w, bias: -0.45 * look.relief * sz.w };
    const mat = new THREE.MeshPhysicalMaterial({
      vertexColors: true,
      map: yt.cavityMap,
      roughness: look.roughness,
      sheen: look.sheen,
      sheenRoughness: look.sheenRoughness,
      sheenColor: new THREE.Color().setScalar(look.sheenTint),
      normalMap: yt.normalMap,
      normalScale: new THREE.Vector2(1, 1),
      displacementMap: this.relief.map,
      displacementScale: this.relief.scale,
      displacementBias: this.relief.bias,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.scene.add(this.mesh);
    if (YARN3D) {
      // the surface is now what shows between the strands: darker, like the inside of the fabric
      // (not black: on flat lace-like work such as a coaster the gaps are large and show a lot)
      mat.color.setScalar(0.72);
      mat.map = null;
      mat.sheen = 0;
      this.yarn.build(model, look);
    } else {
      this.yarn.dispose();
      this.addShells(geo, yt, sz.w);
    }
    this.buildRidges(model, yt);
    this.nrm = new Float32Array(model.solverInput.pos.length);
    this.applyColors();
    this.update(model.solverInput.pos);
    if (!keepView) this.needsFit = true;
  }

  /**
   * Back-loop rounds leave the front loops of the round below free: they show as a raised ring of
   * loops on the outside (the crisp edge at the Lil Big Cig's colour changes). Each one is a tube of
   * the lower round's colour, following that round's stitches.
   */
  private buildRidges(model: Model, yt: YarnTextures) {
    const nodes = model.graph.nodes;
    const sz = model.sizing;
    for (const pi of model.graph.instances) {
      for (let r = 1; r < pi.rows.length; r++) {
        const row = pi.rows[r];
        const prev = pi.rows[r - 1];
        if (row.loop !== 'BLO' || prev.ring !== undefined || prev.nodes.length < 3) continue;
        const path = prev.nodes.filter((id) => !nodes[id].virtual);
        if (path.length < 3) continue;
        const closed = prev.closed;
        const radius = 0.3 * sz.h;
        const segs = path.length * 4;
        const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(path.map(() => new THREE.Vector3()), closed), segs, radius, 8, closed);
        // vertex colours per stitch along the ring; uv u = stitch index so the stitch texture follows
        const count = geo.getAttribute('position').count;
        const col = new Float32Array(count * 3);
        const uvA = geo.getAttribute('uv') as THREE.BufferAttribute;
        const c = new THREE.Color();
        for (let i = 0; i < count; i++) {
          const along = uvA.getX(i) * path.length;
          c.set(nodes[path[Math.min(path.length - 1, Math.floor(along))]].color);
          col.set([c.r, c.g, c.b], i * 3);
          uvA.setXY(i, along, uvA.getY(i) * 0.6);
        }
        geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
        const m = new THREE.MeshPhysicalMaterial({
          vertexColors: true,
          map: yt.cavityMap,
          normalMap: yt.normalMap,
          roughness: yt.look.roughness,
          sheen: yt.look.sheen,
          sheenRoughness: yt.look.sheenRoughness,
          sheenColor: new THREE.Color().setScalar(yt.look.sheenTint),
            });
        const mesh = new THREE.Mesh(geo, m);
        mesh.raycast = () => {};
        this.ridges.add(mesh);
        this.ridgeDefs.push({ mesh, path, closed, radius, segs });
      }
    }
  }

  private updateRidges() {
    const pos = this.pos, nrm = this.nrm;
    for (const d of this.ridgeDefs) {
      // sit on the surface, pushed out so the loops stand proud of the fabric
      const pts = d.path.map((id) => new THREE.Vector3(
        pos[id * 3] + nrm[id * 3] * d.radius * 0.9,
        pos[id * 3 + 1] + nrm[id * 3 + 1] * d.radius * 0.9,
        pos[id * 3 + 2] + nrm[id * 3 + 2] * d.radius * 0.9,
      ));
      const fresh = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, d.closed), d.segs, d.radius, 8, d.closed);
      // one plump loop per stitch: swell the tube mid-stitch and pinch it between stitches
      const fp = fresh.getAttribute('position').array as Float32Array;
      const ring = 9; // radial segments + 1
      for (let i = 0; i <= d.segs; i++) {
        let cx = 0, cy = 0, cz = 0;
        for (let k = 0; k < ring; k++) { const o = (i * ring + k) * 3; cx += fp[o]; cy += fp[o + 1]; cz += fp[o + 2]; }
        cx /= ring; cy /= ring; cz /= ring;
        const f = 0.7 + 0.45 * Math.abs(Math.sin((Math.PI * i * d.path.length) / d.segs));
        for (let k = 0; k < ring; k++) {
          const o = (i * ring + k) * 3;
          fp[o] = cx + (fp[o] - cx) * f; fp[o + 1] = cy + (fp[o + 1] - cy) * f; fp[o + 2] = cz + (fp[o + 2] - cz) * f;
        }
      }
      const old = d.mesh.geometry;
      old.getAttribute('position').array.set(fresh.getAttribute('position').array as Float32Array);
      old.getAttribute('normal').array.set(fresh.getAttribute('normal').array as Float32Array);
      old.getAttribute('position').needsUpdate = true;
      old.getAttribute('normal').needsUpdate = true;
      old.computeBoundingSphere();
      fresh.dispose();
    }
  }

  private clearRidges() {
    for (const d of this.ridgeDefs) { d.mesh.geometry.dispose(); (d.mesh.material as THREE.Material).dispose(); }
    this.ridges.clear();
    this.ridgeDefs = [];
  }

  /**
   * Fuzzy yarns: a few cut-out layers pushed out along the normal, each keeping only the hairs that
   * reach that high. Gives mohair its halo, wool its fuzz and chenille its plush pile.
   */
  private addShells(geo: THREE.BufferGeometry, yt: YarnTextures, scWidth: number) {
    const { shells, sheen, sheenRoughness, sheenTint } = yt.look;
    if (!yt.hairMap || shells.count === 0) return;
    for (let i = 0; i < shells.count; i++) {
      const f = (i + 1) / (shells.count + 1);
      const offset = { value: shells.length * scWidth * f };
      const m = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        map: yt.cavityMap, // keep the stitch shading on the fuzz so stitches still read through it
        roughness: 1,
        sheen: sheen * 0.5,
        sheenRoughness,
        sheenColor: new THREE.Color().setScalar(sheenTint),
        alphaMap: yt.hairMap,
        displacementMap: this.relief.map,
        displacementScale: this.relief.scale,
        displacementBias: this.relief.bias,
          alphaTest: Math.min(0.95, 0.1 + f * 0.85),
        opacity: shells.opacity,
        transparent: shells.opacity < 1,
        depthWrite: shells.opacity >= 1,
        side: THREE.DoubleSide,
      });
      // tips slightly lighter: light scatters through the loose fibres
      m.color.setScalar(1 + 0.15 * f);
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uShellOffset = offset;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform float uShellOffset;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed += normalize(objectNormal) * uShellOffset;');
      };
      m.customProgramCacheKey = () => 'yarn-shell';
      const sh = new THREE.Mesh(geo, m);
      sh.renderOrder = 1 + i;
      sh.raycast = () => {}; // picking uses the real surface
      this.shells.add(sh);
    }
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
      for (let o = 0; o < this.corner.length; o++) {
        if (nodes[tris[this.corner[o]]].line === this.highlightLine) {
          arr[o * 3] = arr[o * 3] * 0.35 + 0.65 * 1.0;
          arr[o * 3 + 1] = arr[o * 3 + 1] * 0.35 + 0.65 * 0.55;
          arr[o * 3 + 2] = arr[o * 3 + 2] * 0.35 + 0.65 * 0.1;
        }
      }
    }
    col.needsUpdate = true;
    if (YARN3D) {
      const nodes = this.model.graph.nodes;
      const c = new THREE.Color();
      this.yarn.setColors((id) => {
        c.set(nodes[id].color);
        if (this.highlightLine >= 0 && nodes[id].line === this.highlightLine) c.lerp(new THREE.Color(1, 0.55, 0.1), 0.65);
        return c;
      });
    }
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
    tessellate(pos, this.nrm, tris, pa, na);
    P.needsUpdate = true;
    Nn.needsUpdate = true;
    this.mesh.geometry.computeBoundingSphere();
    this.mesh.geometry.computeBoundingBox();
    this.updateMarkers();
    this.updateRidges();
    if (YARN3D) { const nodes = this.model.graph.nodes; this.yarn.update(pos, this.nrm, (id) => nodes[id].w); }
    const bb = this.mesh.geometry.boundingBox!;
    const s = bb.getSize(new THREE.Vector3());
    this.onSize?.([s.x, s.y, s.z]);
    if (this.needsFit) this.fit();
  }

  private updateMarkers() {
    if (!this.model) return;
    for (const o of this.markers.children) {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (m.material as THREE.Material | undefined)?.dispose();
    }
    this.markers.clear();
    const pos = this.pos, nrm = this.nrm;
    // chain strands (straps, suspenders): no fabric to mesh, drawn as a cord of yarn
    for (const pi of this.model.graph.instances) {
      if (pi.rows.length !== 1 || !pi.piece.strap) continue;
      const ids = pi.rows[0].nodes;
      if (ids.length < 2) continue;
      const pts = ids.map((id) => new THREE.Vector3(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]));
      const curve = new THREE.CatmullRomCurve3(pts);
      const n0 = this.model.graph.nodes[ids[0]];
      const tube = new THREE.Mesh(
        new THREE.TubeGeometry(curve, ids.length * 3, Math.max(0.6, n0.h * 0.45), 8, false),
        new THREE.MeshStandardMaterial({ color: new THREE.Color(n0.color), roughness: 0.9 }),
      );
      this.markers.add(tube);
    }
    // long strands (hair strands, curls): twisted and laid round the piece from where they hang,
    // half to each side, the later ones of each side a little lower
    for (const pi of this.model.graph.instances) {
      if (!pi.strands?.length) continue;
      const P = (id: number) => new THREE.Vector3(pos[id * 3], pos[id * 3 + 1], pos[id * 3 + 2]);
      const crown = pi.centre !== undefined ? P(pi.centre) : null;
      const h = this.model.sizing.h;
      const half = Math.ceil(pi.strands.length / 2);
      pi.strands.forEach((st, k) => {
        const ring = pi.rows.find((r) => r.nodes.includes(st.base))?.nodes;
        if (!ring || ring.length < 6) return;
        const c = new THREE.Vector3();
        for (const id of ring) c.add(P(id));
        c.multiplyScalar(1 / ring.length);
        const up = crown ? crown.clone().sub(c).normalize() : new THREE.Vector3(0, 1, 0);
        const j0 = ring.indexOf(st.base);
        const dir = k < half ? 1 : -1;
        const tier = k < half ? half - 1 - k : k - half;
        // a twisted strand is much shorter than its chain; it reaches round the side of the head
        const steps = Math.max(3, Math.min(Math.round(st.len * 0.22), Math.round(ring.length * 0.32)));
        const r = h * 0.85;
        const pts: THREE.Vector3[] = [];
        for (let s = 0; s <= steps; s++) {
          const q = P(ring[(((j0 + dir * s) % ring.length) + ring.length) % ring.length]);
          const out = q.clone().sub(c);
          out.addScaledVector(up, -out.dot(up)).normalize();
          q.addScaledVector(out, r * 1.4 + tier * r * 0.3).addScaledVector(up, -tier * r * 1.3 - (s / steps) * r * 1.2);
          pts.push(q);
        }
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), steps * 4, r, 10, false),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(st.color), roughness: 0.9 }),
        );
        this.markers.add(tube);
      });
    }
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
      } else if (m.what === 'nose') {
        // a few stitches wrapped over one stitch in the face's own yarn: a small round bump
        const r = this.model.sizing.w * 0.32;
        const c = new THREE.Color(m.color ?? '#1a1a1a');
        if (m.color) c.multiplyScalar(0.93);
        const nose = new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshStandardMaterial({ color: c, roughness: 0.9 }));
        nose.scale.set(1.25, 0.9, 0.7);
        nose.position.copy(p).addScaledVector(n, r * 0.45);
        nose.lookAt(p.clone().addScaledVector(n, 10));
        this.markers.add(nose);
      } else if (m.what === 'cheek') {
        // blush: a soft flat oval just on the surface
        const r = this.model.sizing.w * 0.55;
        const cheek = new THREE.Mesh(
          new THREE.CircleGeometry(r, 20),
          new THREE.MeshStandardMaterial({ color: new THREE.Color(m.color ?? '#f2a7c3'), roughness: 1, transparent: true, opacity: 0.55, depthWrite: false }),
        );
        cheek.scale.set(1.3, 0.8, 1);
        cheek.position.copy(p).addScaledVector(n, 1.0);
        cheek.lookAt(p.clone().addScaledVector(n, 10));
        this.markers.add(cheek);
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
    const t = Math.floor(hit.faceIndex / (SUB * SUB)) * 3;
    const ids = [this.model.tris[t], this.model.tris[t + 1], this.model.tris[t + 2]];
    const node = ids.map((id) => this.model!.graph.nodes[id]).find((n) => !n.virtual && n.line >= 0);
    if (node) this.onPick(node.line);
  }
}

/** Each solver triangle is split into SUB × SUB small triangles. */
const SUB = 5;

/** Barycentric weights of the small triangles' corners, 3 weights per vertex, 3 vertices per triangle. */
const BARY: Float32Array = (() => {
  const out: number[] = [];
  const w = (i: number, j: number) => [1 - (i + j) / SUB, i / SUB, j / SUB];
  for (let i = 0; i < SUB; i++) {
    for (let j = 0; j < SUB - i; j++) {
      out.push(...w(i, j), ...w(i + 1, j), ...w(i, j + 1));
      if (i + j < SUB - 1) out.push(...w(i + 1, j), ...w(i + 1, j + 1), ...w(i, j + 1));
    }
  }
  return new Float32Array(out);
})();

/**
 * Phong tessellation: points of each small triangle are pulled toward the tangent planes at the
 * solver nodes, so a round of 18 stitches looks round, not 18-sided. Shared edges stay watertight
 * because a point on an edge only depends on that edge's two corners.
 */
function tessellate(pos: Float32Array, nrm: Float32Array, tris: Uint32Array, pa: Float32Array, na: Float32Array) {
  const ALPHA = 0.7;
  const n = BARY.length / 3;
  for (let t = 0; t < tris.length; t += 3) {
    const a = tris[t] * 3, b = tris[t + 1] * 3, c = tris[t + 2] * 3;
    const base = (t / 3) * n;
    for (let j = 0; j < n; j++) {
      const w0 = BARY[j * 3], w1 = BARY[j * 3 + 1], w2 = BARY[j * 3 + 2];
      const o = (base + j) * 3;
      for (let k = 0; k < 3; k++) {
        // flat point
        pa[o + k] = w0 * pos[a + k] + w1 * pos[b + k] + w2 * pos[c + k];
      }
      const px = pa[o], py = pa[o + 1], pz = pa[o + 2];
      let qx = 0, qy = 0, qz = 0;
      for (const [w, i] of [[w0, a], [w1, b], [w2, c]] as const) {
        const d = (px - pos[i]) * nrm[i] + (py - pos[i + 1]) * nrm[i + 1] + (pz - pos[i + 2]) * nrm[i + 2];
        qx += w * (px - d * nrm[i]); qy += w * (py - d * nrm[i + 1]); qz += w * (pz - d * nrm[i + 2]);
      }
      pa[o] = (1 - ALPHA) * px + ALPHA * qx;
      pa[o + 1] = (1 - ALPHA) * py + ALPHA * qy;
      pa[o + 2] = (1 - ALPHA) * pz + ALPHA * qz;
      let nx = w0 * nrm[a] + w1 * nrm[b] + w2 * nrm[c];
      let ny = w0 * nrm[a + 1] + w1 * nrm[b + 1] + w2 * nrm[c + 1];
      let nz = w0 * nrm[a + 2] + w1 * nrm[b + 2] + w2 * nrm[c + 2];
      const l = Math.hypot(nx, ny, nz) || 1;
      na[o] = nx / l; na[o + 1] = ny / l; na[o + 2] = nz / l;
    }
  }
}
