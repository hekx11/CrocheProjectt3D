import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { YARN_LOOKS } from './render/textures';
import { strandNormalMap } from './render/yarn3d';

/**
 * One strand of yarn, placed by hand: a magic ring, round 1 (ch 1, 6 sc in the ring, sl st to
 * join) and round 2 (ch 1, 2 sc in each st, sl st to join), then fastened off. Nothing here comes
 * from the pattern reader or the solver: every bend is written out below, so the shape of a single
 * stitch can be judged on its own before the renderer draws whole pieces this way.
 *
 * Units are mm, for a 4 mm hook and worsted yarn: an sc is about 6.8 mm wide and 5.8 mm tall, the
 * yarn about 2.3 mm thick. The work lies flat in the x/y plane, its right side facing +z.
 */

const W = 6.8, H = 5.8, YARN_R = 1.55;
const RING_R = 2.0; // the magic ring once the tail has pulled it closed
const R1 = RING_R + H; // tops of round 1
const R2 = R1 + H; // tops of round 2
const deg = Math.PI / 180;

type P = [number, number, number];
const pts: THREE.Vector3[] = [];
const roundOf: number[] = []; // per point: 0 tail and ring, 1, 2
const stages: { at: number; name: string }[] = [];
let round = 0;
const stage = (name: string) => stages.push({ at: pts.length, name });
const put = (x: number, y: number, z: number) => { pts.push(new THREE.Vector3(x, y, z)); roundOf.push(round); };
const polar = (ang: number, r: number, z: number) => put(Math.cos(ang) * r, Math.sin(ang) * r, z);

/**
 * A stitch standing on a circle. Its points are written as (a, s, z): a across the stitch (in
 * stitch widths, -0.5 back towards the stitch before, +0.5 on towards the next), s up the stitch
 * (0 where it is worked, 1 its top), z out of the work (in stitch widths, + towards the right side).
 * The stitch narrows from its top to where it is worked, the way stitches fan out round a circle.
 */
interface Place { angTop: number; angBot: number; rBot: number; rTop: number; widthTop: number; widthBot: number; dip: number }
function stitch(at: Place, path: P[]) {
  for (const [a, s, z] of path) {
    const k = Math.min(1, Math.max(0, s));
    const ang = at.angBot + (at.angTop - at.angBot) * k + a * (at.widthBot + (at.widthTop - at.widthBot) * k);
    // below 0 the yarn goes under what the stitch is worked into: s = -1 is right under it
    polar(ang, s >= 0 ? at.rBot + (at.rTop - at.rBot) * s : at.rBot + s * at.dip, z * W);
  }
}

// An sc, following the four steps of the stitch. A loop sits on the hook from the stitch before.
//  1. insert the hook under the top "v" of the stitch below (in round 1: into the ring);
//  2. yarn over and pull up a loop: a bight of yarn, caught behind, comes through under that "v"
//     to the front and up to the hook. Its two strands are the "v" seen on the front of an sc;
//  3. yarn over again;
//  4. pull through both loops: the new loop goes through the tip of the loop just pulled up and
//     through the loop from the stitch before, and stays on the hook. Pulled snug it lies along the
//     top of the stitch, pointing on to the next one (which closes it): the top "v" of the stitch.
// So the yarn goes: from the previous loop down the back to where the stitch is worked, under it to
// the front, up the front, round the new loop, down the front, under it to the back, up the back,
// then along the top (back strand out, round the hook, front strand back) and through to the back,
// where the next stitch begins. The strands behind are the bars seen on the wrong side of sc.
const SC: P[] = [
  [-0.55, 0.6, -0.3], //   down the back from the previous loop
  [-0.22, 0.14, -0.3],
  [-0.07, -1, -0.32], //   2. caught behind, under the "v" below (or round the ring)
  [-0.09, -1, 0.28], //       out to the front
  [-0.17, 0.3, 0.26], //      up the front: left arm of the "v"
  [-0.15, 0.72, 0.24],
  [-0.07, 0.98, 0.15], //     the tip of the loop, round the new loop
  [0.01, 1.05, -0.03],
  [0.09, 0.97, 0.13],
  [0.15, 0.72, 0.24], //      down the front: right arm of the "v"
  [0.16, 0.3, 0.26],
  [0.09, -1, 0.28], //        under the "v" below again
  [0.07, -1, -0.32],
  [0.14, 0.42, -0.3], //   3. yarn over: up the back to the hook
  [0.08, 0.84, -0.24],
  [0.02, 0.99, -0.14], //  4. through both loops: the new loop along the top
  [0.36, 1.0, -0.18], //      back strand
  [0.7, 1.02, -0.06], //      round the hook: the next stitch closes it
  [0.76, 1.0, 0.08],
  [0.4, 1.0, 0.18], //        front strand
  [0.04, 0.98, 0.12],
  [-0.06, 0.9, -0.16], //     back through to the wrong side
];
// A sl st: insert the hook, yarn over, pull through the stitch and the loop on the hook at once.
// One bight, under the "v" and straight on through the loop: no height.
const SLST: P[] = [
  [-0.3, 0.86, -0.26],
  [0.2, 0.8, -0.3],
  [0.36, 0.78, 0.28], // under the top "v" (centred half a stitch on) to the front
  [0.42, 1.0, 0.18],
  [0.7, 1.06, 0.1], //   the new loop, lying along the top
  [0.9, 1.02, -0.04],
  [0.7, 1.0, -0.16],
  [0.42, 0.86, -0.22],
];
// A ch 1 at the start of a round: yarn over, pull through the loop on the hook. The new loop is
// pulled up to the height of the round: two strands up, its tip at the top, and through to the back.
const CH_UP: P[] = [
  [0.0, 0.15, -0.12],
  [-0.12, 0.4, 0.14],
  [-0.12, 0.82, 0.16],
  [0.0, 1.02, 0.06], //  tip
  [0.12, 0.82, -0.06],
  [0.12, 0.4, -0.16],
  [0.02, 0.35, -0.22],
  [-0.1, 0.8, -0.26],
];

// ------------------------------------------------------------------ the tail and the magic ring
// The tail hangs at the back. The yarn is wound twice round the fingers and the tail pulled, so
// the two turns lie snug, one just inside the other.
stage('Tail');
polar(-120 * deg, RING_R + 14, -0.55 * W);
polar(-100 * deg, RING_R + 7, -0.4 * W);
polar(-80 * deg, RING_R + 2, -0.22 * W);
stage('Magic ring');
const RING_START = -60 * deg;
const TURNS = 2, RING_PTS = 24;
for (let k = 0; k <= RING_PTS; k++) {
  const t = k / RING_PTS;
  polar(RING_START + t * TURNS * 2 * Math.PI, RING_R * (1.1 - 0.2 * t), (-0.14 + 0.1 * t) * W);
}

// ------------------------------------------------------------------ round 1
round = 1;
const N1 = 6, step1 = (2 * Math.PI) / N1;
// round 1 is worked round the ring strands: under them is the hole in the middle
const ring = (angTop: number): Place => ({ angTop, angBot: angTop, rBot: RING_R, rTop: R1, widthTop: step1, widthBot: step1 * 0.5, dip: RING_R * 0.85 });
stage('Rnd 1: ch 1');
stitch(ring(-0.5 * step1), CH_UP);
for (let i = 0; i < N1; i++) {
  stage(`Rnd 1: sc ${i + 1} in the ring`);
  stitch(ring(i * step1), SC);
}
stage('Rnd 1: sl st to the first sc');
stitch(ring(N1 * step1), SLST);

// ------------------------------------------------------------------ round 2
round = 2;
const N2 = 12, step2 = (2 * Math.PI) / N2;
// two in each stitch of round 1: both stand on that stitch's top, fanned out over it
// The top "v" of a round 1 stitch lies along the edge from the stitch on towards the next one, so
// the hole under it, where round 2 goes in, is half a stitch on from the stitch's own legs.
const HOLE = 0.38;
const inc = (parent: number, j: number): Place => ({
  angTop: (parent + HOLE) * step1 + (j - 0.5) * step2, angBot: (parent + HOLE) * step1,
  rBot: R1, rTop: R2, widthTop: step2, widthBot: step2 * 0.35, dip: 2 * YARN_R,
});
stage('Rnd 2: ch 1');
stitch({ angTop: (HOLE - 0.5) * step1, angBot: (HOLE - 0.3) * step1, rBot: R1, rTop: R2, widthTop: step2, widthBot: step2, dip: 0 }, CH_UP);
for (let p = 0; p < N1; p++) for (let j = 0; j < 2; j++) {
  stage(`Rnd 2: sc ${p * 2 + j + 1}${j === 0 ? '' : ' (same st: increase)'}`);
  stitch(inc(p, j), SC);
}
stage('Rnd 2: sl st to the first sc');
stitch(inc(N1, 0), SLST);
stage('Fasten off');
polar(N1 * step1 + 0.1, R2 + 1.5, -0.1 * W);
polar(N1 * step1 + 0.2, R2 + 6, -0.4 * W);
polar(N1 * step1 + 0.25, R2 + 12, -0.6 * W);

// ------------------------------------------------------------------ the strand
const SUB = 8, RAD = 12;
const curve = new THREE.CatmullRomCurve3(pts, false, 'centripetal');
const n = (pts.length - 1) * SUB + 1;
const samples: THREE.Vector3[] = [];
for (let i = 0; i < n; i++) samples.push(curve.getPoint(i / (n - 1)));
const pos = new Float32Array(n * (RAD + 1) * 3), nrm = new Float32Array(pos.length), col = new Float32Array(pos.length);
const uv = new Float32Array(n * (RAD + 1) * 2);
const T = new THREE.Vector3(), N = new THREE.Vector3(0, 0, 1), B = new THREE.Vector3(), D = new THREE.Vector3();
let along = 0;
for (let i = 0; i < n; i++) {
  T.subVectors(samples[Math.min(n - 1, i + 1)], samples[Math.max(0, i - 1)]).normalize();
  // parallel transport: the strand's frame turns with it, without twisting
  N.addScaledVector(T, -N.dot(T));
  if (N.lengthSq() < 1e-8) N.set(T.y, -T.x, 0);
  N.normalize();
  B.crossVectors(T, N);
  if (i > 0) along += samples[i].distanceTo(samples[i - 1]);
  for (let j = 0; j <= RAD; j++) {
    const a = (j / RAD) * Math.PI * 2, v = i * (RAD + 1) + j;
    D.copy(N).multiplyScalar(Math.cos(a)).addScaledVector(B, Math.sin(a));
    pos.set([samples[i].x + D.x * YARN_R, samples[i].y + D.y * YARN_R, samples[i].z + D.z * YARN_R], v * 3);
    nrm.set([D.x, D.y, D.z], v * 3);
    uv.set([along / (2 * YARN_R), j / RAD], v * 2);
  }
}
const idx: number[] = [];
for (let i = 0; i < n - 1; i++) for (let j = 0; j < RAD; j++) {
  const a = i * (RAD + 1) + j, b = a + RAD + 1;
  idx.push(a, a + 1, b, b, a + 1, b + 1);
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
geo.setIndex(idx);

const YARN = new THREE.Color('#e8c9a6');
const ROUND = [new THREE.Color('#8f8a84'), new THREE.Color('#e8a87c'), new THREE.Color('#7fa7d6')];
function paint(byRound: boolean) {
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    c.copy(byRound ? ROUND[roundOf[Math.min(pts.length - 1, Math.floor(i / SUB))]] : YARN);
    for (let j = 0; j <= RAD; j++) col.set([c.r, c.g, c.b], (i * (RAD + 1) + j) * 3);
  }
  geo.getAttribute('color').needsUpdate = true;
}
paint(false);

const look = YARN_LOOKS.acrylic;
const mat = new THREE.MeshPhysicalMaterial({
  vertexColors: true, roughness: look.roughness, sheen: look.sheen, sheenRoughness: look.sheenRoughness,
  sheenColor: new THREE.Color().setScalar(look.sheenTint), normalMap: strandNormalMap(look),
});

// ------------------------------------------------------------------ scene
const host = document.getElementById('view')!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 1, 1000);
camera.position.set(0, -28, 62);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xfff6ee, 0x6b5f57, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 2.2);
sun.position.set(-30, -20, 60);
scene.add(sun);
const rim = new THREE.DirectionalLight(0xffffff, 0.6);
rim.position.set(40, 40, -20);
scene.add(rim);
scene.add(new THREE.Mesh(geo, mat));

function resize() {
  const r = host.getBoundingClientRect();
  renderer.setSize(r.width, r.height);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
const bg = () => scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--view').trim() || '#efe8e0');
bg();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', bg);

// ------------------------------------------------------------------ how much is drawn
const slider = document.getElementById('t') as HTMLInputElement;
const label = document.getElementById('stage')!;
function show() {
  const upto = Math.max(1, Math.round((Number(slider.value) / 1000) * (pts.length - 1)));
  geo.setDrawRange(0, upto * SUB * RAD * 6);
  let name = stages[0].name;
  for (const s of stages) if (s.at <= upto) name = s.name;
  label.textContent = Number(slider.value) >= 1000 ? 'Finished' : name;
}
slider.addEventListener('input', show);
(document.getElementById('rounds') as HTMLInputElement).addEventListener('change', (e) => paint((e.target as HTMLInputElement).checked));
const q = new URLSearchParams(location.search);
if (q.has('t')) slider.value = q.get('t')!;
if (q.has('rounds')) { (document.getElementById('rounds') as HTMLInputElement).checked = true; paint(true); }
if (q.has('side')) camera.position.set(0, -75, 18);
if (q.has('back')) camera.position.set(0, 38, -70);
if (q.has('cam')) { const [x, y, z, tx, ty, tz] = q.get('cam')!.split(',').map(Number); camera.position.set(x, y, z); controls.target.set(tx || 0, ty || 0, tz || 0); }
show();
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
