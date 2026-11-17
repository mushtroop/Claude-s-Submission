import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { mergeGeometries as mergeRaw } from 'three/addons/utils/BufferGeometryUtils.js';

// merges shapes into one mesh (fewer draw calls); shouts clearly if three.js refuses
function mergeGeometries(list) {
  const g = mergeRaw(list);
  if (!g) throw new Error('mergeGeometries failed (the shapes have mismatched attributes)');
  return g;
}

/* ------------------------------------------------------------------ */
/*  Tuning - tweak these to change how things feel                     */
/* ------------------------------------------------------------------ */
const CFG = {
  // --- locomotion ---
  handRadius: 0.085,     // size of the hand collision sphere (m)
  skin: 0.003,           // tiny buffer so resting hands don't flicker
  gravity: 9.8,          // m/s^2
  velocityScale: 1.1,    // launch strength on release
  maxSpeed: 7,           // max launch speed (m/s)
  historyFrames: 6,      // frames averaged to get release velocity
  worldHalfSize: 40,     // the map is 80 x 80 m
  snapTurnDeg: 45,       // right thumbstick snap turn

  // --- body collision (a head sphere + a chest sphere) ---
  headRadius: 0.2,
  chestRadius: 0.22,
  chestDrop: 0.5,        // chest sits this far below your head
  standOnFeet: true,     // true = you stand at your real height (like real Gorilla Tag).
                         // false = old behaviour: you sink until your hands touch the ground
  feetRadius: 0.18,      // size of the invisible "feet" that hold you up
  armScale: 1.6,         // your virtual arms are this much longer than your real ones, so your
                         // hands reach the ground without a deep crouch (1.0 = real arm length)
  shoulderDrop: 0.2,     // arms stretch out from a point this far below your head

  // --- infection game ---
  botCount: 9,           // AI bots (you + 9 = 10 players)
  botSpeed: 5.5,         // m/s, about 20 km/h: an average adult's sprint
  infectedBoost: 1.08,   // infected bots get +8% speed (like real Gorilla Tag)
  botAccel: 28,          // how fast bots speed up / slow down (m/s^2)
  botTurnRate: 9,        // how quickly bots change direction
  botWanderSpeed: 2.2,   // jog speed when nobody is threatening them
  fleeRange: 16,         // bots notice infected players within this distance (m)
  spotRange: 14,         // an infected player "spots" healthy ones within this distance (scared face)
  tagRadius: 0.5,        // reach for tags involving you (m)
  botTagDistance: 0.8,   // bot-to-bot tag distance (m)
  startGrace: 3,         // seconds the first infected bot stands still
  infectStun: 0.6,       // seconds a freshly infected bot freezes
  intermission: 6,       // seconds between rounds
  roundTime: 120,        // a round ends after this many seconds; whoever is still healthy survives

  // --- sound ---
  musicVolume: 0.35,     // the calm background tune + water
  sfxVolume: 0.8,        // pops, taps, footsteps, chimes
  botSizeBoost: 1.0,     // 1.0 = bots are exactly your height; 1.1 = 10% taller
};

/* ------------------------------------------------------------------ */
/*  Renderer / scene                                                   */
/* ------------------------------------------------------------------ */
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8fd3ff);
scene.fog = new THREE.Fog(0xcdeeff, 40, 125); // a soft sky-blue haze

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 0); // desktop preview height; VR overrides this

// The "rig" is the player body. Moving the rig moves the player.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0xdff4ff, 0x8fe08f, 1.15));
const sun = new THREE.DirectionalLight(0xfff1d0, 1.35);
sun.position.set(18, 32, -14); // same direction as the sun in the sky
scene.add(sun);

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const MAP = CFG.worldHalfSize;
const WHITE = new THREE.Color(0xffffff);
const INFECTED_COLOR = 0xff3b3b;

// seeded random so the forest is the same every time you load it
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261106);

function lerpAngle(from, to, k) {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + d * k;
}

// Buddy colors (red is reserved for "infected")
const PALETTE = [
  { name: 'Aqua', hex: 0x27c8ff }, { name: 'Sky', hex: 0x5aa8ff },
  { name: 'Lime', hex: 0x9cf03a }, { name: 'Green', hex: 0x35d96a },
  { name: 'Sunny', hex: 0xffe14a }, { name: 'Orange', hex: 0xffa23a },
  { name: 'Bubblegum', hex: 0xff7ac8 }, { name: 'Lavender', hex: 0xb69cff },
  { name: 'Teal', hex: 0x20e0c0 }, { name: 'Pearl', hex: 0xf3fbff },
  { name: 'Magenta', hex: 0xe05cff }, { name: 'Mint', hex: 0xa6ffe0 },
];
let playerColorIdx = 0;
try {
  const saved = parseInt(localStorage.getItem('aeroColor'), 10);
  if (saved >= 0 && saved < PALETTE.length) playerColorIdx = saved;
} catch (_) { /* no saved color */ }

/* ================================================================== */
/*  FRUTIGER AERO LOOK: glossy materials, sky reflections, bubbles     */
/* ================================================================== */
const SUN_DIR = new THREE.Vector3(0.45, 0.8, -0.35).normalize();

// a soft sky "cube" that glossy things reflect (this is what makes glass and water look wet)
function makeEnvMap() {
  const size = 128;
  const faces = [];
  for (let f = 0; f < 6; f++) { // +x, -x, +y (sky), -y (ground), +z, -z
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d');
    if (f === 2) {
      const gr = g.createLinearGradient(0, 0, 0, size);
      gr.addColorStop(0, '#3f9bf2');
      gr.addColorStop(1, '#a9dcff');
      g.fillStyle = gr;
    } else if (f === 3) {
      g.fillStyle = '#62cf68';
    } else {
      const gr = g.createLinearGradient(0, 0, 0, size);
      gr.addColorStop(0, '#4aa6f5');
      gr.addColorStop(0.5, '#d9f3ff');
      gr.addColorStop(0.52, '#a8ee9d');
      gr.addColorStop(1, '#5bc860');
      g.fillStyle = gr;
    }
    g.fillRect(0, 0, size, size);
    if (f === 0 || f === 5) { // the sun
      const sg = g.createRadialGradient(size * 0.7, size * 0.22, 2, size * 0.7, size * 0.22, size * 0.35);
      sg.addColorStop(0, 'rgba(255,255,240,1)');
      sg.addColorStop(1, 'rgba(255,255,240,0)');
      g.fillStyle = sg;
      g.fillRect(0, 0, size, size);
    }
    faces.push(c);
  }
  const t = new THREE.CubeTexture(faces);
  t.needsUpdate = true;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const ENV = makeEnvMap();

const rgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

function glossMat(color, o = {}) {
  return new THREE.MeshPhongMaterial({
    color, specular: 0xffffff, shininess: 90, envMap: ENV, combine: THREE.MixOperation, reflectivity: 0.25, ...o,
  });
}

// the scenery's material set (merged per material so it draws in a handful of calls)
const MATS = {
  white: () => glossMat(0xf3fbff, { reflectivity: 0.3 }),
  aqua: () => glossMat(0x3cc8f4, { reflectivity: 0.35 }),
  lime: () => glossMat(0x8fe04a),
  sunny: () => glossMat(0xffd84a),
  pink: () => glossMat(0xff8fd0),
  plaza: () => new THREE.MeshLambertMaterial({ color: 0xdaf4ff }),
  glass: () => glossMat(0x9fe6ff, { transparent: true, opacity: 0.42, depthWrite: false, shininess: 140, reflectivity: 0.6 }),
  glassG: () => glossMat(0xa8ffd0, { transparent: true, opacity: 0.4, depthWrite: false, shininess: 140, reflectivity: 0.6 }),
  crystal: () => glossMat(0x7ad8ff, { transparent: true, opacity: 0.62, flatShading: true, depthWrite: false, shininess: 160, reflectivity: 0.7 }),
  water: () => glossMat(0x2fb4ff, { transparent: true, opacity: 0.62, depthWrite: false, shininess: 200, reflectivity: 0.7 }),
  vcolor: () => glossMat(0xffffff, { vertexColors: true }),
};
const SEE_THROUGH = new Set(['glass', 'glassG', 'crystal', 'water']);
const matCache = new Map();
function getMat(key) {
  let m = matCache.get(key);
  if (!m) { m = MATS[key](); matCache.set(key, m); }
  return m;
}

// paint a soft texture on a square canvas
function softTexture(size, draw) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- sky, sun, clouds, drifting bubbles and light swooshes ---------- */
const SKY = (() => {
  const skyTex = softTexture(256, (g, s) => {
    const gr = g.createLinearGradient(0, 0, 0, s);
    gr.addColorStop(0, '#2a86e6');
    gr.addColorStop(0.3, '#5fb6ff');
    gr.addColorStop(0.47, '#d3f1ff');
    gr.addColorStop(0.5, '#f4fcff');
    gr.addColorStop(0.55, '#c9f3c4');
    gr.addColorStop(1, '#7fdc86');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(180, 24, 16), new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -10;
  dome.frustumCulled = false;
  scene.add(dome);

  const glowTex = softTexture(256, (g, s) => {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,235,1)');
    gr.addColorStop(0.18, 'rgba(255,244,190,0.85)');
    gr.addColorStop(0.5, 'rgba(255,225,150,0.25)');
    gr.addColorStop(1, 'rgba(255,225,150,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, s, s);
  });
  const rayTex = softTexture(256, (g, s) => {
    g.translate(s / 2, s / 2);
    for (let i = 0; i < 12; i++) {
      g.rotate((Math.PI * 2) / 12);
      const gr = g.createLinearGradient(0, 0, s / 2, 0);
      gr.addColorStop(0, 'rgba(255,255,255,0.5)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(0, -3);
      g.lineTo(s / 2, -1);
      g.lineTo(s / 2, 1);
      g.lineTo(0, 3);
      g.closePath();
      g.fill();
    }
  });
  const sunMat = (map, op) => new THREE.SpriteMaterial({ map, transparent: true, opacity: op, depthWrite: false, fog: false, blending: THREE.AdditiveBlending });
  const sunGlow = new THREE.Sprite(sunMat(glowTex, 1));
  const sunRays = new THREE.Sprite(sunMat(rayTex, 0.7));
  sunGlow.position.copy(SUN_DIR).multiplyScalar(150);
  sunRays.position.copy(sunGlow.position);
  sunGlow.scale.set(90, 90, 1);
  sunRays.scale.set(130, 130, 1);
  scene.add(sunGlow, sunRays);

  const cloudTex = softTexture(256, (g, s) => {
    const puffs = [[0.3, 0.62, 0.2], [0.5, 0.5, 0.26], [0.7, 0.6, 0.21], [0.42, 0.68, 0.18], [0.6, 0.68, 0.18]];
    for (const [px, py, pr] of puffs) {
      const gr = g.createRadialGradient(px * s, py * s, 0, px * s, py * s, pr * s);
      gr.addColorStop(0, 'rgba(255,255,255,0.95)');
      gr.addColorStop(0.65, 'rgba(255,255,255,0.7)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, s, s);
    }
  });
  const cr = mulberry32(99);
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + cr() * 0.4;
    const d = 85 + cr() * 60;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: cloudTex, transparent: true, opacity: 0.92, depthWrite: false, fog: false }));
    sp.position.set(Math.cos(a) * d, 22 + cr() * 38, Math.sin(a) * d);
    const w = 50 + cr() * 40;
    sp.scale.set(w, w * 0.55, 1);
    scene.add(sp);
  }

  const swoosh = [];
  [[-120, 40, -60, -40, 58, -110, 30, 46, -90, 110, 62, -30], [100, 30, 80, 40, 50, 120, -30, 64, 100, -110, 44, 70], [-60, 66, 110, 0, 78, 90, 70, 60, 60, 120, 72, 10]]
    .forEach((p) => {
      const curve = new THREE.CatmullRomCurve3([0, 3, 6, 9].map((i) => new THREE.Vector3(p[i], p[i + 1], p[i + 2])));
      const g = new THREE.TubeGeometry(curve, 40, 5, 6, false);
      g.scale(1, 0.12, 1);
      swoosh.push(g);
    });
  const swooshMesh = new THREE.Mesh(mergeGeometries(swoosh), new THREE.MeshBasicMaterial({ color: 0xbff0ff, transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false, fog: false, side: THREE.DoubleSide }));
  swooshMesh.frustumCulled = false;
  swooshMesh.renderOrder = -5;
  scene.add(swooshMesh);

  const N = 70;
  const bubbles = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 8),
    glossMat(0xffffff, { transparent: true, opacity: 0.3, depthWrite: false, shininess: 200, reflectivity: 0.8 }), N);
  bubbles.frustumCulled = false;
  scene.add(bubbles);
  const br = mulberry32(5);
  const bub = Array.from({ length: N }, () => ({
    x: (br() * 2 - 1) * 38, y: br() * 14, z: (br() * 2 - 1) * 38,
    r: 0.1 + br() * 0.32, v: 0.25 + br() * 0.5, ph: br() * 6.28,
  }));
  const dm = new THREE.Object3D();

  return {
    dome,
    bubbles: bub,
    update(dt, time, head) {
      dome.position.copy(head);
      for (let i = 0; i < N; i++) {
        const b = bub[i];
        b.y += b.v * dt;
        if (b.y > 15) { b.y = 0.2; b.x = (Math.random() * 2 - 1) * 38; b.z = (Math.random() * 2 - 1) * 38; }
        dm.position.set(b.x + Math.sin(time * 0.7 + b.ph) * 0.6, b.y, b.z + Math.cos(time * 0.5 + b.ph) * 0.6);
        dm.scale.setScalar(b.r);
        dm.updateMatrix();
        bubbles.setMatrixAt(i, dm.matrix);
      }
      bubbles.instanceMatrix.needsUpdate = true;
    },
  };
})();

/* ================================================================== */
/*  THE MAP: "Aero Meadow" - glass, water, glossy trees and bubbles     */
/*  Everything you can stand on or grab is added to `colliders`.       */
/* ================================================================== */
const colliders = [];
const statics = new Map();

function addStatic(geo, key) {
  let b = statics.get(key);
  if (!b) { b = { key, list: [] }; statics.set(key, b); }
  b.list.push(geo);
}

function flushStatics() {
  for (const b of statics.values()) {
    const m = new THREE.Mesh(mergeGeometries(b.list), getMat(b.key));
    if (SEE_THROUGH.has(b.key)) m.renderOrder = 2;
    scene.add(m);
  }
  statics.clear();
}

function addBoxCollider(cx, cy, cz, sx, sy, sz, yaw = 0) {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2;
  const b = Math.hypot(hx, hz);
  colliders.push({
    t: 0, cx, cy, cz, hx, hy, hz, c: Math.cos(yaw), s: Math.sin(yaw),
    minX: cx - b, maxX: cx + b, minY: cy - hy, maxY: cy + hy, minZ: cz - b, maxZ: cz + b,
  });
}

function addCylCollider(cx, cz, R, y0, y1) {
  colliders.push({
    t: 1, cx, cz, R, y0, y1,
    minX: cx - R, maxX: cx + R, minY: y0, maxY: y1, minZ: cz - R, maxZ: cz + R,
  });
}

function addBox(cx, cy, cz, sx, sy, sz, key, yaw = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.rotateY(yaw);
  g.translate(cx, cy, cz);
  addStatic(g, key);
  addBoxCollider(cx, cy, cz, sx, sy, sz, yaw);
}

function addPost(cx, cz, R, y0, y1, key, seg = 16) {
  const h = y1 - y0;
  const g = new THREE.CylinderGeometry(R, R, h, seg);
  g.translate(cx, y0 + h / 2, cz);
  addStatic(g, key);
  addCylCollider(cx, cz, R, y0, y1);
}

function addPad(cx, cz, R, h) { // a glossy lily pad / pillar you can hop between
  const g = new THREE.CylinderGeometry(R, R * 1.1, h, 24);
  g.translate(cx, h / 2, cz);
  addStatic(g, 'lime');
  addCylCollider(cx, cz, R, 0, h);
}

function addCrystal(cx, cz, R, h) {
  const g = new THREE.CylinderGeometry(R * 0.7, R, h, 6);
  g.translate(cx, h / 2, cz);
  addStatic(g, 'crystal');
  addCylCollider(cx, cz, R, 0, h);
}

function addJellyBell(cx, cz, stemH) { // a bouncy-looking jellyfish bell on a stalk
  addPost(cx, cz, 0.2, 0, stemH, 'white', 12);
  const g = new THREE.CylinderGeometry(0.9, 1.0, 0.3, 24);
  g.translate(cx, stemH + 0.15, cz);
  addStatic(g, 'pink');
  addCylCollider(cx, cz, 1.0, stemH, stemH + 0.3);
}

// decoration that you can walk through
function addDeco(geo, key) { addStatic(geo, key); }
function decoSphere(x, y, z, r, key) {
  const g = new THREE.SphereGeometry(r, 18, 14);
  g.translate(x, y, z);
  addDeco(g, key);
}
function addDisc(x, z, r, key, y = 0.015) {
  const g = new THREE.CircleGeometry(r, 48);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  addDeco(g, key);
}
function addRing(x, z, r0, r1, key, y = 0.03) {
  const g = new THREE.RingGeometry(r0, r1, 48);
  g.rotateX(-Math.PI / 2);
  g.translate(x, y, z);
  addDeco(g, key);
}
function colored(g, r, gr, b) {
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = gr; a[i * 3 + 2] = b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}
function decoColored(g, hex) { // colorful decoration, all drawn in one call
  const [r, gr, b] = rgb(hex);
  addDeco(colored(g, r, gr, b), 'vcolor');
}

// Zones kept clear of random trees and spawn points
const ZONES = [
  { x: 0, z: 0, r: 11 },      // central fountain
  { x: -16, z: -12, r: 10 },  // sky pavilion
  { x: 16, z: 0, r: 9 },      // crystal tower
  { x: 14, z: -22, r: 10 },   // greenhouse
  { x: -20, z: 12, r: 9 },    // glass tube
  { x: -9, z: 8, r: 5 },      // color orbs
  { x: 24, z: 14, r: 4.5 }, { x: -26, z: -4, r: 4.5 }, { x: 4, z: -26, r: 4.5 }, // crystal clusters
  { x: -6, z: 14, r: 4 }, { x: 22, z: -8, r: 4 }, { x: -28, z: -22, r: 4 }, { x: 26, z: 20, r: 4 }, // glossy pills
];

const SPAWNS = [];
const pads = [];
const STATION = { x: -9, z: 8 };

function buildWorld() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const gg = g.createLinearGradient(0, 0, 256, 256);
  gg.addColorStop(0, '#6fdc5a');
  gg.addColorStop(1, '#52c84c');
  g.fillStyle = gg;
  g.fillRect(0, 0, 256, 256);
  const gr = mulberry32(7);
  for (let i = 0; i < 90; i++) { // soft sunlit patches
    const px = gr() * 256, py = gr() * 256, pr = 14 + gr() * 26;
    const rg = g.createRadialGradient(px, py, 0, px, py, pr);
    rg.addColorStop(0, 'rgba(210,255,150,0.35)');
    rg.addColorStop(1, 'rgba(210,255,150,0)');
    g.fillStyle = rg;
    g.fillRect(px - pr, py - pr, pr * 2, pr * 2);
  }
  for (let i = 0; i < 1400; i++) { // grass blades
    g.fillStyle = gr() < 0.5 ? '#8ae868' : '#3fb040';
    g.fillRect(gr() * 256, gr() * 256, 1 + gr() * 2, 2 + gr() * 4);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(MAP / 2, MAP / 2); // 4 m tiles
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP * 2, MAP * 2), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  addDisc(0, 0, 10.5, 'plaza');
  addRing(0, 0, 4.1, 5.4, 'water');
  addDisc(STATION.x, STATION.z, 4, 'plaza');
  for (const [px, pz, pr] of [[-30, 10, 5], [28, -31, 6], [31, 29, 5], [6, 30, 4.5]]) {
    addDisc(px, pz, pr, 'water', 0.03);
    addRing(px, pz, pr, pr + 0.4, 'white', 0.035);
  }

  addPost(0, 0, 3.2, 0, 3.0, 'glass', 40);                    // glass drum (top at y=3)
  { const collar = new THREE.CylinderGeometry(3.35, 3.35, 0.14, 40); collar.translate(0, 2.93, 0); addDeco(collar, 'white'); }
  addDisc(0, 0, 3.0, 'water', 3.012);                         // water on top
  addPost(0, 0, 0.25, 3.0, 4.6, 'white', 16);                 // the spout
  decoSphere(0, 5.05, 0, 0.5, 'aqua');
  for (let k = 0; k < 4; k++) {
    const a = Math.PI * 1.15 + k * 0.46;
    addPad(Math.cos(a) * 6.0, Math.sin(a) * 6.0, 0.85, 0.8 + k * 0.7);
  }
  [0.9, 1.2, 1.5, 0.9, 1.2, 1.5].forEach((h, k) => {          // jelly bells around the plaza
    const a = (k * Math.PI) / 3 + 0.5;
    addJellyBell(Math.cos(a) * 8.5, Math.sin(a) * 8.5, h);
  });

  const TX = -16, TZ = -12;
  addPost(TX, TZ, 1.3, 0, 10, 'white', 24);                   // glossy trunk
  addBox(TX, 4.825, TZ, 8, 0.35, 8, 'white');                 // floor (top at y=5)
  addBox(TX, 5.45, TZ - 3.9, 8, 0.9, 0.2, 'glass');           // glass railings (east side is open)
  addBox(TX, 5.45, TZ + 3.9, 8, 0.9, 0.2, 'glass');
  addBox(TX - 3.9, 5.45, TZ, 0.2, 0.9, 8, 'glass');
  for (const [sx, sz] of [[-3.7, -3.7], [3.7, -3.7], [-3.7, 3.7], [3.7, 3.7]]) addPost(TX + sx, TZ + sz, 0.18, 5, 8.6, 'aqua', 12);
  addBox(TX, 8.775, TZ, 9.4, 0.35, 9.4, 'glass');             // glass roof
  decoSphere(TX, 11.5, TZ, 5.0, 'lime');                      // glossy canopy
  decoSphere(TX + 3.2, 13.2, TZ + 1.2, 3.2, 'lime');
  decoSphere(TX - 3.0, 13.4, TZ - 1.6, 3.5, 'lime');
  decoSphere(TX, 15.0, TZ, 3.2, 'lime');
  [[-5.0, 1], [-7.0, 2], [-9.0, 3], [-10.9, 4]].forEach(([x, h]) => addPad(x, TZ, 0.8, h));

  const WX = 16, WZ = 0;
  addBox(WX, 2.825, WZ, 6, 0.35, 6, 'white');                 // platform (top at y=3)
  for (const [sx, sz] of [[-2.7, -2.7], [2.7, -2.7], [-2.7, 2.7], [2.7, 2.7]]) addPost(WX + sx, WZ + sz, 0.25, 0, 2.65, 'aqua', 14);
  addBox(WX, 3.45, WZ - 2.9, 6, 0.9, 0.2, 'glass');
  addBox(WX + 2.9, 3.45, WZ, 0.2, 0.9, 6, 'glass');
  addBox(8.1, 2.85, 0, 9.6, 0.3, 1.4, 'glass');               // glass bridge (top at y=3)
  addBox(8.1, 3.4, -0.65, 9.6, 0.8, 0.12, 'white');
  addBox(8.1, 3.4, 0.65, 9.6, 0.8, 0.12, 'white');
  addPost(8.1, 0, 0.25, 0, 2.7, 'aqua', 14);
  [[16, 8.0, 0.8], [16, 6.2, 1.6], [16, 4.4, 2.4]].forEach(([x, z, h]) => addPad(x, z, 0.8, h));

  const CX = 14, CZ = -22, wallH = 2.8, t = 0.3, w = 9, d = 7;
  addBox(CX, wallH / 2, CZ - d / 2, w, wallH, t, 'glassG');
  addBox(CX - w / 2, wallH / 2, CZ, t, wallH, d, 'glassG');
  addBox(CX + w / 2, wallH / 2, CZ, t, wallH, d, 'glassG');
  const seg = (w - 2.2) / 2;                                  // front wall with a 2.2 m doorway
  addBox(CX - w / 2 + seg / 2, wallH / 2, CZ + d / 2, seg, wallH, t, 'glassG');
  addBox(CX + w / 2 - seg / 2, wallH / 2, CZ + d / 2, seg, wallH, t, 'glassG');
  addBox(CX, wallH + 0.175, CZ, w + 0.8, 0.35, d + 0.8, 'glassG'); // roof (top at y=3.15)
  addBox(CX - 2, 0.25, CZ - 2, 2.2, 0.5, 0.7, 'white');       // bench
  for (const [px, pz] of [[2.5, -2], [-3, 0.5], [3, 1.5]]) { // potted plants
    addPost(CX + px, CZ + pz, 0.3, 0, 0.5, 'sunny', 14);
    decoSphere(CX + px, 0.95, CZ + pz, 0.45, 'lime');
  }
  [[9.5, 0.9], [7.7, 1.8], [5.9, 2.7]].forEach(([dx, h]) => addPad(CX + dx, CZ, 0.8, h));

  const LX = -20, LZ = 12;
  addBox(LX, 1.2, LZ - 1.35, 7, 2.4, 0.5, 'glass');
  addBox(LX, 1.2, LZ + 1.35, 7, 2.4, 0.5, 'glass');
  addBox(LX, 2.7, LZ, 7, 0.6, 3.2, 'glass');                  // roof (top at y=3)
  addPad(-26.4, LZ, 0.8, 1.1);
  addPad(-24.6, LZ, 0.8, 2.2);

  [[-6, 14, 0.4, 'pink'], [22, -8, -0.8, 'sunny'], [-28, -22, 1.2, 'aqua'], [26, 20, 0.2, 'lime']].forEach(([x, z, yaw, key]) => addBox(x, 0.5, z, 6, 1.0, 1.0, key, yaw));

  addCrystal(24, 14, 1.8, 1.2); addCrystal(24.8, 15.5, 1.1, 2.1); addCrystal(22.6, 13, 0.8, 0.8);
  addCrystal(-26, -4, 2.2, 1.0); addCrystal(-25, -5.1, 1.3, 1.9); addCrystal(-27.8, -3, 0.9, 1.5);
  addCrystal(4, -26, 1.6, 1.4); addCrystal(5.1, -26.6, 0.9, 2.4);

  addPost(STATION.x, STATION.z, 0.9, 0, 0.5, 'white', 24);    // pedestal for the statue
  PALETTE.forEach((p, i) => {
    const a = (i / PALETTE.length) * Math.PI * 2;
    const px = STATION.x + Math.cos(a) * 2.7;
    const pz = STATION.z + Math.sin(a) * 2.7;
    const stem = new THREE.CylinderGeometry(0.13, 0.17, 0.36, 12);
    stem.translate(px, 0.18, pz);
    addDeco(stem, 'white');
    const orb = new THREE.SphereGeometry(0.28, 20, 16);
    orb.translate(px, 0.64, pz);
    decoColored(orb, p.hex);
    addCylCollider(px, pz, 0.3, 0, 0.92);
    pads.push({ x: px, z: pz, r: 0.3, h: 0.92, idx: i });
  });

  for (let i = 0; i < 3000 && SPAWNS.length < 14; i++) {
    const a = rand() * Math.PI * 2;
    const dist = 8 + rand() * (MAP - 14);
    const x = Math.cos(a) * dist, z = Math.sin(a) * dist;
    if (Math.abs(x) > MAP - 6 || Math.abs(z) > MAP - 6) continue;
    if (ZONES.some((zn) => Math.hypot(x - zn.x, z - zn.z) < zn.r + 0.5)) continue;
    if (SPAWNS.some((s) => Math.hypot(x - s.x, z - s.y) < 7)) continue;
    SPAWNS.push({ x, y: z });
  }
  while (SPAWNS.length < 10) SPAWNS.push({ x: (rand() - 0.5) * 30, y: (rand() - 0.5) * 30 });

  const flowerColors = [0xffffff, 0xffb3e1, 0xfff07a, 0xb9f1ff];
  for (let i = 0; i < 400 && i < 160; i++) {
    const x = (rand() * 2 - 1) * (MAP - 3), z = (rand() * 2 - 1) * (MAP - 3);
    if (ZONES.some((zn) => Math.hypot(x - zn.x, z - zn.z) < zn.r)) continue;
    const stem = new THREE.CylinderGeometry(0.012, 0.016, 0.36, 5);
    stem.translate(x, 0.18, z);
    decoColored(stem, 0x4fc455);
    const head = new THREE.SphereGeometry(0.075, 8, 6);
    head.translate(x, 0.4, z);
    decoColored(head, flowerColors[Math.floor(rand() * flowerColors.length)]);
  }

  const leafColors = [0x7fe05a, 0x5ed67a, 0x9be84a, 0x45d08a];
  const spots = [];
  const makeTree = (x, z) => spots.push({
    x, z, h: 4 + rand() * 3, r: 0.3 + rand() * 0.18, cr: 1.5 + rand() * 0.9, ang: rand() * 6.28,
    leaf: leafColors[Math.floor(rand() * leafColors.length)],
  });
  for (let i = 0; i < 700 && spots.length < 100; i++) {
    const x = (rand() * 2 - 1) * (MAP - 4);
    const z = (rand() * 2 - 1) * (MAP - 4);
    if (ZONES.some((zn) => Math.hypot(x - zn.x, z - zn.z) < zn.r + 0.8)) continue;
    if (SPAWNS.some((s) => Math.hypot(x - s.x, z - s.y) < 2.4)) continue;
    if (spots.some((s) => Math.hypot(x - s.x, z - s.z) < 3.2)) continue;
    makeTree(x, z);
  }
  for (let v = -MAP + 2; v <= MAP - 2; v += 3.2) {            // dense tree wall around the edge
    const j = () => (rand() - 0.5) * 0.7;
    makeTree(v + j(), -(MAP - 1.4) + j());
    makeTree(v + j(), MAP - 1.4 + j());
    makeTree(-(MAP - 1.4) + j(), v + j());
    makeTree(MAP - 1.4 + j(), v + j());
  }

  const n = spots.length;
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.8, 1, 1, 10), glossMat(0xffffff, { reflectivity: 0.2 }), n);
  const crownA = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), glossMat(0xffffff, { reflectivity: 0.3 }), n);
  const crownB = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 12, 9), glossMat(0xffffff, { reflectivity: 0.3 }), n);
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.h / 2, s.z);
    dummy.scale.set(s.r, s.h, s.r);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    trunks.setColorAt(i, col.set(0xf4ecd8));
    dummy.position.set(s.x, s.h + s.cr * 0.45, s.z);
    dummy.scale.setScalar(s.cr);
    dummy.updateMatrix();
    crownA.setMatrixAt(i, dummy.matrix);
    crownA.setColorAt(i, col.set(s.leaf));
    dummy.position.set(s.x + Math.cos(s.ang) * s.cr * 0.8, s.h + s.cr * 0.05, s.z + Math.sin(s.ang) * s.cr * 0.8);
    dummy.scale.setScalar(s.cr * 0.62);
    dummy.updateMatrix();
    crownB.setMatrixAt(i, dummy.matrix);
    crownB.setColorAt(i, col.set(s.leaf).offsetHSL(0.02, 0, 0.05));
    addCylCollider(s.x, s.z, s.r, 0, s.h);
  });
  for (const m of [trunks, crownA, crownB]) {
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.frustumCulled = false;
    scene.add(m);
  }
  flushStatics();
}
buildWorld();

/* ------------------------------------------------------------------ */
/*  Collision queries                                                  */
/* ------------------------------------------------------------------ */
const _n = new THREE.Vector3();

// Tests a sphere against the whole map. Returns how deep it sinks in
// (0 = not touching) and writes the surface normal into outN.
function sphereWorld(p, r, outN) {
  let best = 0;
  const gd = r - p.y; // the ground plane
  if (gd > best) { best = gd; outN.set(0, 1, 0); }

  for (let i = 0; i < colliders.length; i++) {
    const c = colliders[i];
    if (p.x < c.minX - r || p.x > c.maxX + r || p.y < c.minY - r || p.y > c.maxY + r || p.z < c.minZ - r || p.z > c.maxZ + r) continue;
    let depth = 0, nx = 0, ny = 0, nz = 0;

    if (c.t === 0) {
      const dx = p.x - c.cx, dy = p.y - c.cy, dz = p.z - c.cz;
      const lx = dx * c.c - dz * c.s;
      const lz = dx * c.s + dz * c.c;
      const qx = Math.max(-c.hx, Math.min(c.hx, lx));
      const qy = Math.max(-c.hy, Math.min(c.hy, dy));
      const qz = Math.max(-c.hz, Math.min(c.hz, lz));
      const ex = lx - qx, ey = dy - qy, ez = lz - qz;
      const d2 = ex * ex + ey * ey + ez * ez;
      let lnx, lny, lnz;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        depth = r - d;
        if (depth <= 0) continue;
        lnx = ex / d; lny = ey / d; lnz = ez / d;
      } else { // center is inside the box: push out the nearest face
        const px = c.hx - Math.abs(lx), py = c.hy - Math.abs(dy), pz = c.hz - Math.abs(lz);
        if (px <= py && px <= pz) { lnx = Math.sign(lx) || 1; lny = 0; lnz = 0; depth = px + r; }
        else if (py <= pz) { lnx = 0; lny = Math.sign(dy) || 1; lnz = 0; depth = py + r; }
        else { lnx = 0; lny = 0; lnz = Math.sign(lz) || 1; depth = pz + r; }
      }
      nx = lnx * c.c + lnz * c.s;
      ny = lny;
      nz = -lnx * c.s + lnz * c.c;
    } else {
      const dx = p.x - c.cx, dz = p.z - c.cz;
      const rd = Math.hypot(dx, dz);
      const qy = Math.max(c.y0, Math.min(c.y1, p.y));
      const ey = p.y - qy;
      let ex = 0, ez = 0;
      if (rd > c.R) { const k = 1 - c.R / rd; ex = dx * k; ez = dz * k; }
      const d2 = ex * ex + ey * ey + ez * ez;
      if (d2 > 1e-12) {
        const d = Math.sqrt(d2);
        depth = r - d;
        if (depth <= 0) continue;
        nx = ex / d; ny = ey / d; nz = ez / d;
      } else { // inside
        const side = c.R - rd, top = c.y1 - p.y, bot = p.y - c.y0;
        if (side <= top && side <= bot) {
          nx = rd > 1e-6 ? dx / rd : 1; nz = rd > 1e-6 ? dz / rd : 0; ny = 0; depth = side + r;
        } else if (top <= bot) { nx = 0; ny = 1; nz = 0; depth = top + r; }
        else { nx = 0; ny = -1; nz = 0; depth = bot + r; }
      }
    }
    if (depth > best) { best = depth; outN.set(nx, ny, nz); }
  }
  return best;
}

// --- flat (top-down) obstacles for the bots, built from the same colliders ---
const BOT_LIM = CFG.worldHalfSize - 1.5; // bots stay inside this square
const blockers = [];
for (const c of colliders) {
  if (c.t === 0 && c.minY < 1.9 && c.maxY > 0.4) blockers.push({ k: 1, x: c.cx, z: c.cz, hx: c.hx, hz: c.hz, c: c.c, s: c.s, y0: c.minY, y1: c.maxY });
  if (c.t === 1 && c.y0 < 1.9 && c.y1 > 0.4) blockers.push({ k: 0, x: c.cx, z: c.cz, r: c.R, y0: c.y0, y1: c.y1 });
}

function blockedAt(x, z, m) {
  if (Math.abs(x) > BOT_LIM || Math.abs(z) > BOT_LIM) return true;
  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    const dx = x - b.x, dz = z - b.z;
    if (b.k === 0) {
      const rr = b.r + m;
      if (dx * dx + dz * dz < rr * rr) return true;
    } else {
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      const ox = Math.max(Math.abs(lx) - b.hx, 0), oz = Math.max(Math.abs(lz) - b.hz, 0);
      if (ox * ox + oz * oz < m * m) return true;
    }
  }
  return false;
}

// Can a straight line from A to B (at eye height) be blocked by a tree, wall or stump?
function sightBlocked(ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const len2 = dx * dx + dz * dz || 1;
  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    if (!(b.y0 < 1.5 && b.y1 > 1.5)) continue; // low logs and overhead beams don't block eye-level sight
    if (b.k === 0) {
      const t = Math.max(0, Math.min(1, ((b.x - ax) * dx + (b.z - az) * dz) / len2));
      const px = ax + dx * t - b.x, pz = az + dz * t - b.z;
      const rr = b.r + 0.05;
      if (px * px + pz * pz < rr * rr) return true;
    } else {
      const lax = (ax - b.x) * b.c - (az - b.z) * b.s, laz = (ax - b.x) * b.s + (az - b.z) * b.c;
      const lbx = (bx - b.x) * b.c - (bz - b.z) * b.s, lbz = (bx - b.x) * b.s + (bz - b.z) * b.c;
      const ldx = lbx - lax, ldz = lbz - laz;
      const hx = b.hx + 0.05, hz = b.hz + 0.05;
      let t0 = 0, t1 = 1, miss = false;
      if (Math.abs(ldx) < 1e-9) { if (Math.abs(lax) > hx) miss = true; }
      else {
        let ta = (-hx - lax) / ldx, tb = (hx - lax) / ldx;
        if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        if (t0 > t1) miss = true;
      }
      if (!miss) {
        if (Math.abs(ldz) < 1e-9) { if (Math.abs(laz) > hz) miss = true; }
        else {
          let ta = (-hz - laz) / ldz, tb = (hz - laz) / ldz;
          if (ta > tb) { const tmp = ta; ta = tb; tb = tmp; }
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
          if (t0 > t1) miss = true;
        }
      }
      if (!miss) return true;
    }
  }
  return false;
}

function pushOutBlockers(pos, rad) {
  for (let i = 0; i < blockers.length; i++) {
    const b = blockers[i];
    const dx = pos.x - b.x, dz = pos.z - b.z;
    if (b.k === 0) {
      const d = Math.hypot(dx, dz), min = b.r + rad;
      if (d < min) {
        if (d > 1e-4) { pos.x += (dx / d) * (min - d); pos.z += (dz / d) * (min - d); } else pos.x += min;
      }
    } else {
      const lx = dx * b.c - dz * b.s, lz = dx * b.s + dz * b.c;
      const qx = Math.max(-b.hx, Math.min(b.hx, lx)), qz = Math.max(-b.hz, Math.min(b.hz, lz));
      const ex = lx - qx, ez = lz - qz;
      const d = Math.hypot(ex, ez);
      let nlx = 0, nlz = 0, push = 0;
      if (d > 1e-4) {
        if (d < rad) { nlx = ex / d; nlz = ez / d; push = rad - d; }
      } else {
        const px = b.hx - Math.abs(lx), pz = b.hz - Math.abs(lz);
        if (px < pz) { nlx = Math.sign(lx) || 1; push = px + rad; } else { nlz = Math.sign(lz) || 1; push = pz + rad; }
      }
      if (push > 0) {
        pos.x += (nlx * b.c + nlz * b.s) * push;
        pos.z += (-nlx * b.s + nlz * b.c) * push;
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Hands                                                              */
/* ------------------------------------------------------------------ */
const hands = [0, 1].map((i) => {
  const grip = renderer.xr.getControllerGrip(i);
  const controller = renderer.xr.getController(i);
  rig.add(grip, controller);

  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(CFG.handRadius, 24, 16),
    new THREE.MeshLambertMaterial({ color: 0xcccccc })
  );
  mesh.visible = false;
  scene.add(mesh);

  const hand = {
    grip, mesh,
    source: null,
    active: false,
    touching: false,
    hasPrev: false,
    model: null, // the visible paw (created further down)
    vlocal: new THREE.Vector3(), // where your (stretched) hand is, in tracking space
    prevLocal: new THREE.Vector3(),
  };

  controller.addEventListener('connected', (e) => {
    hand.source = e.data;
    hand.active = true;
    hand.hasPrev = false;
    if (hand.model) hand.model.visible = true;
    applyPlayerVisual();
  });
  controller.addEventListener('selectstart', () => SFX.unlock());
  controller.addEventListener('squeezestart', () => SFX.unlock());
  controller.addEventListener('disconnected', () => {
    hand.source = null;
    hand.active = false;
    if (hand.model) hand.model.visible = false;
  });
  return hand;
});

function buzz(hand, strength = 0.4, ms = 40) {
  const gp = hand.source && hand.source.gamepad;
  if (!gp) return;
  try {
    if (gp.hapticActuators && gp.hapticActuators[0]) gp.hapticActuators[0].pulse(strength, ms);
    else if (gp.vibrationActuator) gp.vibrationActuator.playEffect('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: strength });
  } catch (_) { /* haptics are optional */ }
}

function buzzAll(strength, ms) {
  for (const h of hands) buzz(h, strength, ms);
}

/* ------------------------------------------------------------------ */
/*  Head-locked visuals: infected screen tint + HUD text               */
/* ------------------------------------------------------------------ */
const tint = new THREE.Mesh(
  new THREE.SphereGeometry(0.35, 16, 12),
  new THREE.MeshBasicMaterial({
    color: 0xff2200, transparent: true, opacity: 0, side: THREE.BackSide,
    depthTest: false, depthWrite: false, fog: false,
  })
);
tint.renderOrder = 997;
camera.add(tint);

const hudCanvas = document.createElement('canvas');
hudCanvas.width = 1024;
hudCanvas.height = 512;
const hudCtx = hudCanvas.getContext('2d');
const hudTex = new THREE.CanvasTexture(hudCanvas);
hudTex.colorSpace = THREE.SRGBColorSpace;
const hud = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.45),
  new THREE.MeshBasicMaterial({
    map: hudTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false, fog: false,
  })
);
hud.position.set(0, -0.25, -1.0);
hud.renderOrder = 998;
hud.visible = false;
camera.add(hud);

const UI_FONT = "'Segoe UI', 'Frutiger', 'Trebuchet MS', system-ui, sans-serif";

function rrPath(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

// a glossy glass pill: gradient body, bright edge, and a shine across the top half
function glassPill(c, x, y, w, h, top, bottom, edge = 'rgba(255,255,255,0.9)') {
  const r = h / 2;
  rrPath(c, x, y, w, h, r);
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, top);
  g.addColorStop(1, bottom);
  c.fillStyle = g;
  c.fill();
  c.lineWidth = 3;
  c.strokeStyle = edge;
  c.stroke();
  rrPath(c, x + 6, y + 4, w - 12, h * 0.46, r * 0.8);
  const sh = c.createLinearGradient(0, y, 0, y + h * 0.5);
  sh.addColorStop(0, 'rgba(255,255,255,0.65)');
  sh.addColorStop(1, 'rgba(255,255,255,0.08)');
  c.fillStyle = sh;
  c.fill();
}

let hudKey = '';
function fitFont(c, text, maxW, size) {
  while (size > 24) {
    c.font = `bold ${size}px ${UI_FONT}`;
    if (c.measureText(text).width <= maxW) break;
    size -= 4;
  }
}

function drawHud(main, mainColor, sub) {
  const key = main + '|' + mainColor + '|' + sub;
  if (key === hudKey) return; // only redraw when something changed
  hudKey = key;
  const c = hudCtx;
  c.clearRect(0, 0, 1024, 512);
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  if (main) {
    fitFont(c, main, 960, 84);
    c.lineWidth = 12;
    c.strokeStyle = 'rgba(8,70,120,0.85)';
    c.strokeText(main, 512, 150);
    c.shadowColor = 'rgba(120,230,255,0.9)';
    c.shadowBlur = 22;
    c.fillStyle = mainColor;
    c.fillText(main, 512, 150);
    c.shadowBlur = 0;
  }
  fitFont(c, sub, 900, 44);
  const w = c.measureText(sub).width + 90;
  glassPill(c, 512 - w / 2, 356, w, 84, 'rgba(120,225,255,0.85)', 'rgba(20,130,215,0.88)');
  c.shadowColor = 'rgba(0,70,130,0.7)';
  c.shadowBlur = 6;
  c.fillStyle = '#ffffff';
  c.fillText(sub, 512, 398);
  c.shadowBlur = 0;
  hudTex.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/*  SOUND: everything is synthesized, so there are no audio files.     */
/*  - a calm, glassy Frutiger-Aero style tune (pads, bells, water)      */
/*  - 3D sounds: you hear bots' footsteps, pops and gasps where they are */
/*  Browsers only allow sound after a tap/click, so it starts when you  */
/*  press Enter VR or pull a trigger.                                   */
/* ------------------------------------------------------------------ */
const SFX = (() => {
  let ctx = null, master = null, sfxBus = null, musicBus = null, reverb = null, noiseBuf = null;
  let muted = false;
  let nextChord = 0, nextNote = 0, nextBlip = 0, chordIdx = 0;
  let lastTouch = 0, lastGasp = 0, lastPop = 0, lastStepT = 0;
  const CHORDS = [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 64]]; // Cmaj7, Am7, Fmaj7, G6
  const BASS = [36, 33, 41, 43];
  const PENT = [0, 2, 4, 7, 9];
  const CHORD_LEN = 3.2;
  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function makeImpulse(seconds) { // a soft, airy room
    const rate = ctx.sampleRate, len = Math.floor(rate * seconds);
    const buf = ctx.createBuffer(2, len, rate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.6);
    }
    return buf;
  }

  function setPos(p, pos) {
    if (p.positionX) { p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z; }
    else if (p.setPosition) p.setPosition(pos.x, pos.y, pos.z);
  }

  function route(node, { bus = sfxBus, pos = null, wet = 0.2, hrtf = false } = {}) {
    let tail = node;
    if (pos) {
      const p = ctx.createPanner();
      p.panningModel = hrtf ? 'HRTF' : 'equalpower'; // HRTF is nicer but costs more CPU, so only rare sounds use it
      p.distanceModel = 'inverse';
      p.refDistance = 2;
      p.maxDistance = 60;
      p.rolloffFactor = 1.2;
      setPos(p, pos);
      tail.connect(p);
      tail = p;
    }
    tail.connect(bus);
    if (wet > 0) { const w = ctx.createGain(); w.gain.value = wet; tail.connect(w); w.connect(reverb); }
  }

  function tone(freq, { t = 0, dur = 0.2, type = 'sine', gain = 0.3, attack = 0.006, freqEnd = null, bus, pos, wet, detune = 0, hrtf } = {}) {
    const t0 = ctx.currentTime + t;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    if (detune) o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(gain, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g);
    route(g, { bus, pos, wet, hrtf });
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  function noise({ t = 0, dur = 0.1, freq = 1200, q = 1, type = 'bandpass', gain = 0.3, bus, pos, wet = 0.1 } = {}) {
    const t0 = ctx.currentTime + t;
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.max(gain, 0.0002), t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    s.connect(f);
    f.connect(g);
    route(g, { bus, pos, wet });
    s.start(t0, Math.random() * 1.5);
    s.stop(t0 + dur + 0.05);
  }

  function unlock() {
    if (ctx) { if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { /* ignore */ } } return; }
    const AC = typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext);
    if (!AC) return;
    try {
      ctx = new AC();
      if (ctx.state === 'suspended') { try { ctx.resume(); } catch (_) { /* a later tap will resume it */ } }
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      const comp = ctx.createDynamicsCompressor();
      master.connect(comp);
      comp.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = CFG.sfxVolume;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = CFG.musicVolume;
      musicBus.connect(master);
      reverb = ctx.createConvolver();
      reverb.buffer = makeImpulse(2.4);
      const rg = ctx.createGain();
      rg.gain.value = 0.55;
      reverb.connect(rg);
      rg.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

      const s = ctx.createBufferSource();
      s.buffer = noiseBuf;
      s.loop = true;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const wg = ctx.createGain();
      wg.gain.value = 0.05;
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.13;
      const lg = ctx.createGain();
      lg.gain.value = 0.03;
      lfo.connect(lg);
      lg.connect(wg.gain);
      s.connect(lp);
      lp.connect(wg);
      wg.connect(musicBus);
      s.start();
      lfo.start();

      nextChord = ctx.currentTime + 0.2;
      nextNote = ctx.currentTime + 0.4;
      nextBlip = ctx.currentTime + 2;
    } catch (_) {
      ctx = null;
    }
  }

  function playChord(t, idx) { // a warm, slow pad + a soft bass
    const notes = CHORDS[idx];
    for (const m of notes) {
      for (const det of [-6, 7]) {
        const o = ctx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = mtof(m);
        o.detune.value = det;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1700;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.linearRampToValueAtTime(0.045, t + 1.1);
        g.gain.linearRampToValueAtTime(0.0001, t + CHORD_LEN + 0.9);
        o.connect(lp);
        lp.connect(g);
        route(g, { bus: musicBus, wet: 0.5 });
        o.start(t);
        o.stop(t + CHORD_LEN + 1);
      }
    }
    const b = ctx.createOscillator();
    b.type = 'sine';
    b.frequency.value = mtof(BASS[idx]);
    const bg = ctx.createGain();
    bg.gain.setValueAtTime(0.0001, t);
    bg.gain.linearRampToValueAtTime(0.16, t + 0.3);
    bg.gain.exponentialRampToValueAtTime(0.0001, t + CHORD_LEN);
    b.connect(bg);
    route(bg, { bus: musicBus, wet: 0.1 });
    b.start(t);
    b.stop(t + CHORD_LEN + 0.1);
  }

  function playBell(t, midi) { // a glassy little bell
    for (const [mul, gn, dur] of [[1, 0.1, 1.6], [2.01, 0.04, 0.9], [3.0, 0.02, 0.5]]) {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = mtof(midi) * mul;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(gn, t + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g);
      route(g, { bus: musicBus, wet: 0.6 });
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  const guard = (fn) => (...a) => { if (!ctx || muted) return; try { fn(...a); } catch (_) { /* never let sound break the game */ } };

  return {
    unlock,
    get ready() { return !!ctx; },
    get muted() { return muted; },
    toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.9;
      return muted;
    },

    update(head, fwd) {
      if (!ctx) return;
      try {
        const L = ctx.listener;
        if (L.positionX) {
          L.positionX.value = head.x; L.positionY.value = head.y; L.positionZ.value = head.z;
          L.forwardX.value = fwd.x; L.forwardY.value = fwd.y; L.forwardZ.value = fwd.z;
          L.upX.value = 0; L.upY.value = 1; L.upZ.value = 0;
        } else if (L.setPosition) {
          L.setPosition(head.x, head.y, head.z);
          L.setOrientation(fwd.x, fwd.y, fwd.z, 0, 1, 0);
        }
        if (muted) return;
        const t = ctx.currentTime;
        while (nextChord < t + 0.6) { playChord(nextChord, chordIdx); nextChord += CHORD_LEN; chordIdx = (chordIdx + 1) % CHORDS.length; }
        while (nextNote < t + 0.6) {
          if (Math.random() < 0.55) playBell(nextNote, 72 + PENT[Math.floor(Math.random() * 5)] + 12 * Math.floor(Math.random() * 2));
          nextNote += CHORD_LEN / 4;
        }
        if (nextBlip < t) { // a random bubble blip somewhere near you
          const a = Math.random() * 6.28, d = 4 + Math.random() * 12;
          tone(500 + Math.random() * 400, { dur: 0.1, freqEnd: 1200 + Math.random() * 600, gain: 0.07, pos: { x: head.x + Math.cos(a) * d, y: 0.4, z: head.z + Math.sin(a) * d }, wet: 0.3 });
          nextBlip = t + 2.5 + Math.random() * 4;
        }
      } catch (_) { /* ignore */ }
    },

    touch: guard((s = 0.5) => { // a hand lands on something
      const t = ctx.currentTime;
      if (t - lastTouch < 0.05) return;
      lastTouch = t;
      tone(120 + Math.random() * 25, { dur: 0.13, freqEnd: 60, gain: 0.28 * s + 0.05 });
      noise({ dur: 0.06, freq: 500, type: 'lowpass', gain: 0.16 * s + 0.03, wet: 0.05 });
    }),
    launch: guard((speed = 3) => { // you let go and fly
      const s = Math.min(1, speed / 6);
      noise({ dur: 0.4, freq: 700, q: 0.7, gain: 0.1 * s + 0.02, wet: 0.2 });
      tone(380, { dur: 0.28, freqEnd: 900, gain: 0.05 * s + 0.01, wet: 0.3 });
    }),
    step: guard((pos, v = 1) => { // a bot's soft footstep
      const t = ctx.currentTime;
      if (t - lastStepT < 0.07) return; // never more than ~14 steps a second in total
      lastStepT = t;
      tone(160, { dur: 0.08, freqEnd: 90, gain: 0.1 * v, pos, wet: 0.08 });
      noise({ dur: 0.05, freq: 700, type: 'lowpass', gain: 0.08 * v, pos, wet: 0.05 });
    }),
    pop: guard((pos) => { // somebody got tagged
      const t = ctx.currentTime;
      if (t - lastPop < 0.08) return;
      lastPop = t;
      tone(450, { dur: 0.14, freqEnd: 1150, gain: 0.26, pos, wet: 0.3, hrtf: true });
      tone(220, { t: 0.02, dur: 0.12, freqEnd: 120, gain: 0.12, pos, wet: 0.2, hrtf: true });
    }),
    gasp: guard((pos) => { // a bot just spotted a tagger
      const t = ctx.currentTime;
      if (t - lastGasp < 0.15) return;
      lastGasp = t;
      tone(520, { dur: 0.15, type: 'triangle', freqEnd: 900, gain: 0.16, pos, wet: 0.25, hrtf: true });
      tone(700, { t: 0.1, dur: 0.12, type: 'triangle', freqEnd: 1100, gain: 0.12, pos, wet: 0.25, hrtf: true });
    }),
    tagged: guard(() => { // YOU got tagged: a sinking bloop
      tone(820, { dur: 0.45, freqEnd: 280, gain: 0.34, wet: 0.35 });
      tone(150, { dur: 0.55, type: 'triangle', freqEnd: 55, gain: 0.34, wet: 0.2 });
      noise({ dur: 0.18, freq: 1500, q: 0.8, gain: 0.12, wet: 0.2 });
    }),
    tagSuccess: guard(() => { // YOU tagged somebody: a bright double blip
      tone(880, { dur: 0.12, gain: 0.22, wet: 0.35 });
      tone(1320, { t: 0.08, dur: 0.22, gain: 0.22, wet: 0.4 });
    }),
    ding: guard((i = 0) => { // changing color
      const m = 72 + PENT[i % 5] + 12 * Math.floor(i / 5);
      tone(mtof(m), { dur: 0.9, gain: 0.24, wet: 0.5 });
      tone(mtof(m) * 2, { dur: 0.5, gain: 0.07, wet: 0.5 });
    }),
    roundStart: guard(() => {
      noise({ dur: 0.6, freq: 900, q: 0.6, gain: 0.12, wet: 0.35 });
      [72, 76, 79, 84].forEach((m, i) => tone(mtof(m), { t: 0.05 + i * 0.09, dur: 0.7, gain: 0.2, wet: 0.5 }));
    }),
    roundEnd: guard((kind) => { // 'win', 'lose' or 'time'
      const seq = kind === 'win' ? [72, 76, 79, 84, 88] : kind === 'lose' ? [84, 79, 75, 72, 67] : [79, 84];
      seq.forEach((m, i) => tone(mtof(m), { t: i * (kind === 'lose' ? 0.16 : 0.1), dur: 1.1, gain: 0.22, wet: 0.55 }));
    }),
    tick: guard((urgent) => tone(urgent ? 1760 : 1320, { dur: 0.06, gain: 0.1, wet: 0.15 })),
  };
})();

/* ------------------------------------------------------------------ */
/*  The characters: glossy "Aero Buddies". A jelly body with a glass    */
/*  shell, big shiny eyes, a leaf sprout, a glowing ring, bubble         */
/*  stalks on the back and long stretchy arms with glossy orb hands.    */
/*  No legs - they hover and stand on their hands. Used by you, the     */
/*  bots and the statue.                                                */
/* ------------------------------------------------------------------ */
const MODEL_TOP = 1.5;      // top of the body, in model units
const EYE_M = 1.17;         // eye height inside the model
const ARM_R = 0.075;        // arm thickness
const BODY_RX = 0.40, BODY_RZ = 0.36;
// the body is a surface of revolution; this table is its outline: [height, width (1 = widest)]
const BODY_PROFILE = [[0.50, 0.0], [0.52, 0.28], [0.56, 0.45], [0.64, 0.62], [0.76, 0.80], [0.90, 0.95], [1.02, 1.0],
  [1.14, 0.97], [1.26, 0.86], [1.36, 0.68], [1.44, 0.42], [1.49, 0.18], [1.50, 0.0]];
function profileR(table, y) {
  if (y <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (y <= table[i][0]) { const f = (y - table[i - 1][0]) / (table[i][0] - table[i - 1][0]); return table[i - 1][1] + (table[i][1] - table[i - 1][1]) * f; }
  }
  return 0;
}
const bodyR = (y) => profileR(BODY_PROFILE, y);

// the face is a decal: a patch of the body with a transparent texture painted on it
const FACE = { lathe: true, R: bodyR, rx: BODY_RX * 1.015, rz: BODY_RZ * 1.015, y0: 0.80, y1: 1.46, dphi: 2.6, W: 640, H: 400 };

// bubble stalks on the back: [x, y] spots; the rest is worked out from the body's shape
const STALK_SPOTS = [[0, 1.32], [-0.16, 1.2], [0.16, 1.2], [0, 1.08], [-0.2, 0.98], [0.2, 0.98], [0, 0.86], [-0.15, 0.74], [0.15, 0.74]];
function stalkBase([x, y]) {
  const r = bodyR(y), xr = BODY_RX * r, zr = BODY_RZ * r;
  const z = -zr * Math.sqrt(Math.max(0, 1 - (x / xr) * (x / xr)));
  const d = new THREE.Vector3(x / xr, 0.3, z / zr).normalize();
  return { x, y, z, dx: d.x, dy: d.y, dz: d.z };
}
const STALKS = STALK_SPOTS.map(stalkBase);

function shapeGeo(base, x, y, z, sx, sy, sz) {
  const g = base.clone();
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

// smooth curve through points (Catmull-Rom)
function spline(pts, closed, per = 8) {
  const n = pts.length;
  const get = (i) => (closed ? pts[(i + n) % n] : pts[Math.max(0, Math.min(n - 1, i))]);
  const out = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = get(i - 1), p1 = get(i), p2 = get(i + 1), p3 = get(i + 2);
    for (let t = 0; t < per; t++) {
      const u = t / per, u2 = u * u, u3 = u2 * u;
      const f = (k) => 0.5 * ((2 * p1[k]) + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u3);
      out.push([f(0), f(1)]);
    }
  }
  if (!closed) out.push(pts[n - 1]);
  return out;
}

function ellipsePts(cx, cy, rx, ry, n = 28) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return out;
}

function rotPts(pts, ang, cx, cy) {
  const c = Math.cos(ang), s = Math.sin(ang);
  return pts.map(([x, y]) => [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]);
}

// Where does a point on the front of the body (X right, Y up, in metres) land on a decal's canvas?
// This is the inverse of how three.js lays a texture over a patch of surface.
function decalMapper(spec) {
  return (X, Y) => {
    const r = Math.max(spec.rx * spec.R(Y), 1e-4);
    const a = Math.asin(Math.max(-1, Math.min(1, X / r)));
    return [(0.5 + a / spec.dphi) * spec.W, (1 - (Y - spec.y0) / (spec.y1 - spec.y0)) * spec.H];
  };
}

// paint a decal: you draw in metres, it takes care of the wrapping
function makeDecal(spec, draw) {
  const c = document.createElement('canvas');
  c.width = spec.W;
  c.height = spec.H;
  const x = c.getContext('2d');
  const map = decalMapper(spec);
  const pxm = spec.W / (spec.rx * spec.dphi); // pixels per metre (across the middle of the face)
  const path = (pts, close) => {
    x.beginPath();
    pts.forEach(([X, Y], i) => { const [u, v] = map(X, Y); if (i) x.lineTo(u, v); else x.moveTo(u, v); });
    if (close) x.closePath();
  };
  x.lineJoin = 'round';
  x.lineCap = 'round';
  draw(x, path, pxm);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// The two faces, as a list of shapes (in metres). Happy by default; scared when a tagger spots you.
function faceParts(scared) {
  const ops = [];
  const fill = (pts, style) => ops.push({ pts, fill: style, close: true });
  const line = (pts, style, width) => ops.push({ pts, stroke: style, width });
  fill(rotPts(ellipsePts(-0.13, 1.34, 0.07, 0.022), -0.55, -0.13, 1.34), 'rgba(255,255,255,0.6)');
  fill(ellipsePts(-0.285, 1.29, 0.018, 0.018, 14), 'rgba(255,255,255,0.75)');
  for (const sx of [-1, 1]) fill(ellipsePts(sx * 0.235, 1.05, 0.055, 0.032), 'rgba(255,110,150,0.5)');
  for (const sx of [-1, 1]) {
    const cx = sx * 0.15, cy = 1.17;
    const rx = scared ? 0.075 : 0.068, ry = scared ? 0.098 : 0.088;
    fill(ellipsePts(cx, cy, rx, ry), '#0d2b52');
    fill(ellipsePts(cx, cy - 0.012, rx * 0.82, ry * 0.78), '#2db8ff');
    fill(ellipsePts(cx, cy - 0.006, rx * (scared ? 0.3 : 0.52), ry * (scared ? 0.32 : 0.55)), '#071a33');
    fill(ellipsePts(cx - rx * 0.3, cy + ry * 0.35, rx * 0.28, ry * 0.25, 16), '#ffffff');
    fill(ellipsePts(cx + rx * 0.35, cy - ry * 0.38, rx * 0.13, ry * 0.12, 12), '#ffffff');
  }
  if (!scared) {
    fill(spline([[-0.075, 1.045], [-0.04, 1.03], [0, 1.025], [0.04, 1.03], [0.075, 1.045], [0.05, 0.99], [0, 0.965], [-0.05, 0.99]], true, 6), '#0d2b52');
    fill(ellipsePts(0, 0.985, 0.032, 0.016, 16), '#ff7a9a');
  } else {
    line([[-0.21, 1.3], [-0.09, 1.335]], '#0d2b52', 0.013);
    line([[0.21, 1.3], [0.09, 1.335]], '#0d2b52', 0.013);
    fill(ellipsePts(0, 0.99, 0.034, 0.042, 18), '#0d2b52');
    fill(spline([[0.26, 1.32], [0.275, 1.28], [0.288, 1.25], [0.26, 1.22], [0.232, 1.25], [0.245, 1.28]], true, 5), '#6fd8ff');
    fill(ellipsePts(0.252, 1.255, 0.007, 0.012, 10), '#ffffff');
  }
  return ops;
}

function makeFaceTexture(scared) {
  return makeDecal(FACE, (x, path, pxm) => {
    for (const op of faceParts(scared)) {
      path(op.pts, !!op.close);
      if (op.fill) { x.fillStyle = op.fill; x.fill(); }
      if (op.stroke) { x.strokeStyle = op.stroke; x.lineWidth = op.width * pxm; x.stroke(); }
    }
  });
}

const MK = (() => {
  const sph = new THREE.SphereGeometry(1, 20, 14);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
  const S = (x, y, z, sx, sy, sz) => shapeGeo(sph, x, y, z, sx, sy, sz);
  const UPV = new THREE.Vector3(0, 1, 0);

  const lathe = (y0, y1, n, rScale, segments, phiStart, phiLength) => {
    const pts = [];
    for (let j = 0; j < n; j++) {
      const y = y0 + ((y1 - y0) * j) / (n - 1);
      pts.push(new THREE.Vector2(bodyR(y) * rScale, y));
    }
    const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
    g.scale(BODY_RX, 1, BODY_RZ);
    return g;
  };
  const body = lathe(0.5, 1.5, 30, 1, 40, 0, Math.PI * 2);
  const shell = lathe(0.47, 1.53, 32, 1.07, 40, 0, Math.PI * 2);        // the see-through glass shell
  const face = lathe(FACE.y0, FACE.y1, 24, 1.015, 36, -FACE.dphi / 2, FACE.dphi);

  const ring = new THREE.TorusGeometry(0.44, 0.028, 10, 40);
  ring.rotateX(Math.PI / 2);
  ring.translate(0, 0.72, 0);
  const leaf = (x, y, ang, [r, g, b]) => { const l = S(0, 0, 0, 0.17, 0.04, 0.075); l.rotateZ(ang); l.translate(x, y, 0); return colored(l, r, g, b); };
  const sproutStem = new THREE.CylinderGeometry(0.012, 0.016, 0.12, 6);
  sproutStem.translate(0, 1.56, 0);
  const stalk = (b) => {
    const stem = new THREE.CylinderGeometry(0.011, 0.015, 0.2, 6);
    stem.translate(0, 0.1, 0);
    const bulb = S(0, 0.23, 0, 0.06, 0.06, 0.06);
    const g = mergeGeometries([colored(stem, 0.45, 0.85, 0.5), colored(bulb, 0.82, 0.97, 1.0)]);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UPV, new THREE.Vector3(b.dx, b.dy, b.dz)));
    g.translate(b.x, b.y, b.z);
    return g;
  };
  const trim = mergeGeometries([
    colored(ring, 0.97, 0.99, 1.0),
    leaf(0.08, 1.6, -0.5, [0.5, 0.92, 0.3]),
    leaf(-0.08, 1.62, 0.55, [0.3, 0.85, 0.45]),
    colored(sproutStem, 0.35, 0.8, 0.3),
    ...STALKS.map(stalk),
  ]);

  const orb = new THREE.SphereGeometry(0.09, 16, 12); // glossy hands
  const glow = new THREE.CircleGeometry(0.62, 28);   // soft light under the buddy
  glow.rotateX(-Math.PI / 2);

  return { cyl, body, shell, face, trim, orb, glow };
})();

const faceMat = (tex) => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
const faceMatHappy = faceMat(makeFaceTexture(false));
const faceMatScared = faceMat(makeFaceTexture(true));
const trimMat = glossMat(0xffffff, { vertexColors: true, reflectivity: 0.3 });
const shellMat = glossMat(0xffffff, { transparent: true, opacity: 0.22, depthWrite: false, shininess: 220, reflectivity: 0.75 });

function makePaw(mat) {
  return new THREE.Mesh(MK.orb, mat);
}

function makePlushie(hex) {
  const main = glossMat(hex, { shininess: 110, reflectivity: 0.3 });   // the jelly body (recolorable)
  const accent = glossMat(hex, { shininess: 140, reflectivity: 0.4 }); // a lighter tint for the hands
  const glowMat = new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false });
  const g = new THREE.Group();
  const add = (geo, mat) => { const m = new THREE.Mesh(geo, mat); g.add(m); return m; };

  add(MK.body, main);
  add(MK.trim, trimMat);
  const face = add(MK.face, faceMatHappy);
  face.renderOrder = 3;
  add(MK.shell, shellMat).renderOrder = 4;
  const glow = add(MK.glow, glowMat);
  glow.position.y = 0.03;
  glow.renderOrder = 1;

  const armL = new THREE.Mesh(MK.cyl, main);
  const armR = new THREE.Mesh(MK.cyl, main);
  const handL = makePaw(accent);
  const handR = makePaw(accent);
  g.add(armL, armR, handL, handR);

  scene.add(g);
  return {
    group: g, face, scared: false, armL, armR, handL, handR, main, accent, glow, glowMat,
    shoulderL: new THREE.Vector3(0.36, 1.0, 0),
    shoulderR: new THREE.Vector3(-0.36, 1.0, 0),
  };
}

function setPlushieColor(pl, hex, infected) {
  const c = infected ? INFECTED_COLOR : hex;
  pl.main.color.set(c);
  pl.main.emissive.set(infected ? 0x7a1515 : 0x000000);
  pl.accent.color.set(c).lerp(WHITE, 0.35);
  pl.accent.emissive.set(infected ? 0x5a1010 : 0x000000);
  pl.glowMat.color.set(c);
}

function setFace(pl, scared) {
  if (pl.scared === scared) return;
  pl.scared = scared;
  pl.face.material = scared ? faceMatScared : faceMatHappy;
}

const _ax = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
// stretch an arm so it runs from `from` to `to`
function setArm(arm, from, to) {
  _ax.set(to.x - from.x, to.y - from.y, to.z - from.z);
  const len = _ax.length() || 0.001;
  arm.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  _ax.divideScalar(len);
  arm.quaternion.setFromUnitVectors(_up, _ax);
  arm.scale.set(ARM_R, len, ARM_R);
}

/* ------------------------------------------------------------------ */
/*  Gorilla Tag style locomotion (works on every surface)              */
/*                                                                     */
/*  - A hand "touches" when its sphere dips into any collider.         */
/*  - While touching, the body moves opposite to the hand's motion.    */
/*  - Floors/tops hold you up; walls only let you push off (no wall    */
/*    climbing), and gravity still pulls you down.                     */
/*  - Letting go launches you with the averaged push velocity.         */
/*  - Your head, chest and feet collide with the world too.            */
/* ------------------------------------------------------------------ */
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _move = new THREE.Vector3();
const velocity = new THREE.Vector3();
const history = [];
let wasTouching = false;

function worldOf(local, out) {
  out.copy(local);
  return rig.localToWorld(out);
}

function bodyPush(dy, rad) {
  worldOf(camera.position, _v);
  _v.y += dy;
  const depth = sphereWorld(_v, rad, _n);
  if (depth <= 0) return false;
  rig.position.addScaledVector(_n, depth);
  if (_n.y > 0.5 && velocity.y < 0) velocity.y = 0;
  rig.updateMatrixWorld(true);
  return true;
}

// invisible feet at floor level, right under your head, so you don't sink through the ground
function footPush() {
  worldOf(camera.position, _v);
  _v.y = rig.position.y + CFG.feetRadius; // rig.y is where your real floor is
  const depth = sphereWorld(_v, CFG.feetRadius, _n);
  if (depth <= 0) return false;
  rig.position.addScaledVector(_n, depth);
  if (_n.y > 0.5 && velocity.y < 0) velocity.y = 0;
  rig.updateMatrixWorld(true);
  return true;
}

// Your virtual hands reach further than your real ones: each hand is pushed away from
// a point just below your head, so you can touch the ground without crouching all the way.
function updateVirtualHands() {
  const k = CFG.armScale;
  const sx = camera.position.x, sy = camera.position.y - CFG.shoulderDrop, sz = camera.position.z;
  for (const h of hands) {
    const g = h.grip.position;
    h.vlocal.set(sx + (g.x - sx) * k, sy + (g.y - sy) * k, sz + (g.z - sz) * k);
  }
}

function updateLocomotion(dt) {
  rig.updateMatrixWorld(true);
  updateVirtualHands();
  const R = CFG.handRadius;

  _move.set(0, 0, 0);
  let count = 0;
  let supported = false;
  for (const h of hands) {
    if (!h.active) continue;
    const local = h.vlocal; // position in tracking space (relative to rig)
    worldOf(local, _v);
    const hit = sphereWorld(_v, R + CFG.skin, _n) > 0;
    if (hit) {
      const support = _n.y > 0.5; // standing on a floor-like surface?
      if (h.hasPrev) {
        _d.copy(local).sub(h.prevLocal).applyQuaternion(rig.quaternion);
        if (!support) _d.y = 0; // you can push off walls, but not climb them
        _move.sub(_d);          // move opposite to the hand
      }
      count++;
      if (support) supported = true;
      if (!h.touching) { buzz(h); SFX.touch(h.hasPrev ? Math.min(1, _d.length() / dt / 3) : 0.4); }
    }
    h.touching = hit;
    h.prevLocal.copy(local);
    h.hasPrev = true;
  }

  const touching = count > 0;

  if (touching) {
    _move.divideScalar(count);
    rig.position.add(_move);
    history.push(_move.clone().divideScalar(dt));
    if (history.length > CFG.historyFrames) history.shift();
    if (supported) {
      velocity.set(0, 0, 0);
    } else { // only touching walls/ceilings: gravity still applies
      velocity.y = Math.max(velocity.y - CFG.gravity * dt, -25);
      rig.position.y += velocity.y * dt;
    }
  } else {
    if (wasTouching && history.length) {
      velocity.set(0, 0, 0);
      for (const v of history) velocity.add(v);
      velocity.divideScalar(history.length).multiplyScalar(CFG.velocityScale);
      if (velocity.length() > CFG.maxSpeed) velocity.setLength(CFG.maxSpeed);
      if (velocity.length() > 1.5) SFX.launch(velocity.length());
      history.length = 0;
    }
    velocity.y = Math.max(velocity.y - CFG.gravity * dt, -25);
    rig.position.addScaledVector(velocity, dt);
  }
  wasTouching = touching;
  rig.updateMatrixWorld(true);

  for (let it = 0; it < 3; it++) {
    let any = false;
    for (const h of hands) {
      if (!h.active) continue;
      worldOf(h.vlocal, _v);
      const depth = sphereWorld(_v, R, _n);
      if (depth > 0) {
        rig.position.addScaledVector(_n, depth);
        rig.updateMatrixWorld(true);
        any = true;
      }
    }
    if (bodyPush(0, CFG.headRadius)) any = true;
    if (bodyPush(-CFG.chestDrop, CFG.chestRadius)) any = true;
    if (CFG.standOnFeet && footPush()) any = true;
    if (!any) break;
  }

  const lim = CFG.worldHalfSize - 1;
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, -lim, lim);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, -lim, lim);
  rig.updateMatrixWorld(true);

  for (const h of hands) {
    if (!h.active) continue;
    worldOf(h.vlocal, _v);
    h.mesh.position.copy(_v);
  }
}

function teleportPlayer(x, z) {
  rig.position.set(x, 0, z);
  velocity.set(0, 0, 0);
  history.length = 0;
  wasTouching = false;
  for (const h of hands) h.hasPrev = false;
  player.hasPrev = false;
  rig.updateMatrixWorld(true);
}

function resetPlayer() {
  rig.rotation.set(0, 0, 0);
  teleportPlayer(SPAWNS[0].x, SPAWNS[0].y);
}

rig.position.set(SPAWNS[0].x, 0, SPAWNS[0].y); // desktop preview start

/* ------------------------------------------------------------------ */
/*  Extras: snap turn (right stick), reset (B / Y), color (A / X)      */
/* ------------------------------------------------------------------ */
let turnLatch = false;
let resetLatch = false;
let colorLatch = false;
let muteLatch = false;

function handleInput() {
  let stickX = 0;
  let resetPressed = false;
  let colorPressed = false;
  let mutePressed = false;
  for (const h of hands) {
    const gp = h.source && h.source.gamepad;
    if (!gp) continue;
    if (h.source.handedness === 'right' && gp.axes.length >= 4) stickX = gp.axes[2];
    if (gp.buttons[5] && gp.buttons[5].pressed) resetPressed = true;
    if (gp.buttons[4] && gp.buttons[4].pressed) colorPressed = true;
    if (h.source.handedness === 'left' && gp.buttons[3] && gp.buttons[3].pressed) mutePressed = true;
  }

  if (Math.abs(stickX) > 0.7 && !turnLatch) {
    turnLatch = true;
    const angle = -Math.sign(stickX) * THREE.MathUtils.degToRad(CFG.snapTurnDeg);
    worldOf(camera.position, _v);
    _d.copy(rig.position).sub(_v).applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    rig.position.copy(_v).add(_d);
    rig.rotation.y += angle;
  } else if (Math.abs(stickX) < 0.3) {
    turnLatch = false;
  }

  if (resetPressed && !resetLatch) {
    resetLatch = true;
    resetPlayer();
  } else if (!resetPressed) {
    resetLatch = false;
  }

  if (colorPressed && !colorLatch) {
    colorLatch = true;
    setPlayerColor((playerColorIdx + 1) % PALETTE.length);
  } else if (!colorPressed) {
    colorLatch = false;
  }

  if (mutePressed && !muteLatch) {
    muteLatch = true;
    const m = SFX.toggleMute();
    flash(m ? 'Sound: OFF' : 'Sound: ON', '#ffffff', 1.2);
  } else if (!mutePressed) {
    muteLatch = false;
  }
}

/* ================================================================== */
/*  INFECTION GAME MODE                                                */
/* ================================================================== */

/* ---------- Entities: you + bots ---------- */
const BOT_TAG_Y = [0.15, 0.8, 1.2]; // heights of a bot's tag spheres (model units)
const BOT_NAMES = ['Bubbles', 'Splash', 'Dewdrop', 'Breeze', 'Lagoon', 'Sparkle', 'Aqua', 'Glimmer', 'Ripple'];

// Bots are scaled so their eye level matches yours
let eyeHeight = 1.6;
let eyeInit = false;
let botScale = ((eyeHeight + 0.12) / MODEL_TOP) * CFG.botSizeBoost; // same overall height as you

const player = {
  name: 'You',
  isPlayer: true,
  infected: false,
  stun: 0,
  pos: new THREE.Vector3(), // head position projected on the ground
  vel: new THREE.Vector3(),
  hasPrev: false,
};

/* ---------- Floating name tags: glass pills that bob, pop and shake ---------- */
function drawNameTag(tag, infected) {
  if (tag.infected === infected) return;
  tag.infected = infected;
  tag.popT = 0; // trigger the pop animation
  const c = tag.ctx;
  c.clearRect(0, 0, 512, 128);
  let size = 66;
  c.font = `bold ${size}px ${UI_FONT}`;
  while (size > 30 && c.measureText(tag.text).width > 400) { size -= 4; c.font = `bold ${size}px ${UI_FONT}`; }
  const w = Math.min(500, c.measureText(tag.text).width + 80);
  if (infected) glassPill(c, (512 - w) / 2, 16, w, 96, 'rgba(255,255,255,0.97)', 'rgba(255,205,205,0.92)', 'rgba(255,80,80,0.95)');
  else glassPill(c, (512 - w) / 2, 16, w, 96, 'rgba(120,225,255,0.88)', 'rgba(20,120,205,0.88)');
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  if (!infected) { c.lineWidth = 8; c.strokeStyle = 'rgba(5,50,100,0.75)'; c.strokeText(tag.text, 256, 66); }
  c.fillStyle = infected ? '#ff2f2f' : '#ffffff'; // healthy = white, infected = red
  c.fillText(tag.text, 256, 66);
  tag.tex.needsUpdate = true;
}

function makeNameTag(text) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, fog: false }));
  sprite.renderOrder = 5;
  scene.add(sprite);
  const tag = { text, ctx: canvas.getContext('2d'), tex, sprite, infected: null, popT: 10, phase: Math.random() * 6.28 };
  drawNameTag(tag, false);
  return tag;
}

/* ---------- Bots ---------- */
function makeBot(i) {
  const baseColor = PALETTE[(i * 5 + 3) % PALETTE.length].hex;
  const pl = makePlushie(baseColor);
  const name = BOT_NAMES[i] || `Bot ${i + 1}`;
  return {
    name,
    isPlayer: false,
    infected: false,
    stun: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    dir: { x: 0, z: 1 },
    want: { x: 0, z: 0 },
    facing: 0,
    phase: Math.random() * 6,
    pl, group: pl.group, baseColor,
    tag: makeNameTag(name),
    target: null,
    retargetT: 0,
    wanderT: 0,
    wanderA: Math.random() * Math.PI * 2,
    jitter: 0,
    jitterT: 0,
    avoidSign: Math.random() < 0.5 ? 1 : -1,
    avoidT: 0,
    lastStep: 0,
  };
}

const bots = Array.from({ length: CFG.botCount }, (_, i) => makeBot(i));
const entities = [player, ...bots];

/* ---------- Your buddy body + the color-orb statue ---------- */
const playerAvatar = makePlushie(PALETTE[playerColorIdx].hex);
playerAvatar.handL.visible = false; // your real hands are the glossy orbs below
playerAvatar.handR.visible = false;
playerAvatar.glow.visible = false;
playerAvatar.group.visible = false;

// the glossy orbs that follow your controllers
for (const h of hands) {
  h.model = makePaw(playerAvatar.accent);
  h.model.visible = h.active;
  scene.add(h.model);
}

const statue = makePlushie(PALETTE[playerColorIdx].hex);
statue.group.position.set(STATION.x, 0.5, STATION.z);
statue.handL.position.set(0.52, 0.09, 0.1);
statue.handR.position.set(-0.52, 0.09, 0.1);
setArm(statue.armL, statue.shoulderL, statue.handL.position);
setArm(statue.armR, statue.shoulderR, statue.handR.position);
let statueT = 0;

/* ---------- Game state ---------- */
let state = 'idle'; // 'idle' | 'running' | 'intermission'
let round = 0;
let timer = 0;          // intermission countdown
let lastTick = 0;
let roundT = 0;         // time left in the current round
let endedByTime = false;
let survivorText = '';
let lastSurvivor = '-';
let flashText = '';
let flashColor = '#ffffff';
let flashT = 0;

const _head = new THREE.Vector3(0, 1.6, 0);
const _bodyPt = new THREE.Vector3();
const _pv = new THREE.Vector3();
const playerPts = [];

function flash(text, color, secs) {
  flashText = text;
  flashColor = color;
  flashT = secs;
}

function infectedCount() {
  let n = 0;
  for (const e of entities) if (e.infected) n++;
  return n;
}

/* ---------- Visuals ---------- */
function applyPlayerVisual() {
  const hex = PALETTE[playerColorIdx].hex;
  setPlushieColor(playerAvatar, hex, player.infected);
  setPlushieColor(statue, hex, false);
  tint.material.opacity = player.infected && renderer.xr.isPresenting ? 0.18 : 0;
}

function setPlayerColor(idx, announce = true) {
  playerColorIdx = idx;
  try { localStorage.setItem('aeroColor', String(idx)); } catch (_) { /* optional */ }
  applyPlayerVisual();
  if (announce) { flash(`Color: ${PALETTE[idx].name}`, '#ffffff', 1.2); SFX.ding(idx); }
}

function setVisual(e) {
  if (e.isPlayer) {
    applyPlayerVisual();
  } else {
    setPlushieColor(e.pl, e.baseColor, e.infected);
    drawNameTag(e.tag, e.infected);
  }
}

setPlushieColor(playerAvatar, PALETTE[playerColorIdx].hex, false);
setPlushieColor(statue, PALETTE[playerColorIdx].hex, false);
bots.forEach(setVisual);

const _bA = new THREE.Vector3();
function animateBot(bot, dt) {
  const speed = Math.hypot(bot.vel.x, bot.vel.z);
  const amount = Math.min(speed / 3, 1);
  bot.phase += speed * dt * 2.6;

  if (speed > 0.3) bot.facing = lerpAngle(bot.facing, Math.atan2(bot.vel.x, bot.vel.z), 1 - Math.exp(-10 * dt));

  const pl = bot.pl;
  const s = Math.sin(bot.phase), c = Math.cos(bot.phase);
  _bA.set(0.52, 0.09 + Math.max(0, c) * 0.3 * amount, 0.1 + s * 0.5 * amount);
  pl.handL.position.copy(_bA);
  setArm(pl.armL, pl.shoulderL, _bA);
  _bA.set(-0.52, 0.09 + Math.max(0, -c) * 0.3 * amount, 0.1 - s * 0.5 * amount);
  pl.handR.position.copy(_bA);
  setArm(pl.armR, pl.shoulderR, _bA);

  const stepIdx = Math.floor(bot.phase / Math.PI);
  if (stepIdx !== bot.lastStep) {
    bot.lastStep = stepIdx;
    if (amount > 0.3 && state !== 'idle') {
      const dd = Math.hypot(bot.pos.x - _head.x, bot.pos.z - _head.z);
      if (dd < 22) SFX.step({ x: bot.pos.x, y: 0.1, z: bot.pos.z }, Math.min(1, amount) * (1 - dd / 26));
    }
  }

  bot.group.position.set(bot.pos.x, Math.abs(s) * 0.05 * amount * botScale, bot.pos.z);
  bot.group.rotation.y = bot.facing;
  const pulse = bot.stun > 0 ? 1 + 0.05 * Math.sin(performance.now() / 60) : 1;
  bot.group.scale.setScalar(botScale * pulse);
}

function updateTags(dt, time) {
  for (const bot of bots) {
    const t = bot.tag;
    const dist = Math.hypot(bot.pos.x - _head.x, bot.pos.z - _head.z);
    const ds = THREE.MathUtils.clamp(dist / 7, 1, 2.6);          // bigger when far so it stays readable
    t.popT += dt;
    const pop = 1 + 0.6 * Math.exp(-5 * t.popT) * Math.cos(16 * t.popT); // springy pop when it changes
    const inf = bot.infected;
    const pulse = inf ? 1 + 0.06 * Math.sin(time * 7 + t.phase) : 1 + 0.015 * Math.sin(time * 2 + t.phase);
    const bob = Math.sin(time * 2.2 + t.phase) * 0.05 * botScale;
    t.sprite.position.set(bot.pos.x, 1.95 * botScale + bob, bot.pos.z);
    const sc = ds * pop * pulse;
    t.sprite.scale.set(1.5 * sc, 0.375 * sc, 1);
    t.sprite.material.rotation = Math.sin(time * (inf ? 9 : 2.5) + t.phase) * (inf ? 0.07 : 0.025);
  }
}

/* ---------- Your body ---------- */
const _fwd = new THREE.Vector3();
const _hl = new THREE.Vector3();
const _g0 = new THREE.Vector3();
let avatarYaw = 0;
let avatarYawT = 0;

function updateEyeHeight(dt) {
  const y = camera.position.y; // head height above the real floor
  if (!(y > 0.5 && y < 2.4)) return;
  if (!eyeInit) {
    eyeInit = true;
    eyeHeight = y;
  } else {
    const tau = y > eyeHeight ? 0.6 : 45; // rises quickly, falls slowly (so crouching doesn't shrink the bots)
    eyeHeight += (y - eyeHeight) * (1 - Math.exp(-dt / tau));
  }
  eyeHeight = THREE.MathUtils.clamp(eyeHeight, 1.0, 2.2);
  botScale = ((eyeHeight + 0.12) / MODEL_TOP) * CFG.botSizeBoost;
}

function updateAvatar(dt) {
  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  if (Math.hypot(_fwd.x, _fwd.z) > 0.3) avatarYawT = Math.atan2(_fwd.x, _fwd.z) + rig.rotation.y;
  avatarYaw = lerpAngle(avatarYaw, avatarYawT, 1 - Math.exp(-8 * dt));

  worldOf(camera.position, _g0);
  const sc = botScale;
  const back = 0.5 * sc; // your body floats behind and below you, out of your view (look down and back to see it)
  const gx = _g0.x - Math.sin(avatarYaw) * back;
  const gy = _g0.y - MODEL_TOP * sc - 0.15;
  const gz = _g0.z - Math.cos(avatarYaw) * back;
  const pl = playerAvatar;
  pl.group.position.set(gx, gy, gz);
  pl.group.rotation.y = avatarYaw;
  pl.group.scale.setScalar(sc);

  const cs = Math.cos(avatarYaw), sn = Math.sin(avatarYaw);
  pl.armL.visible = pl.armR.visible = false;
  for (const h of hands) {
    const isLeft = h.source && h.source.handedness === 'left';
    if (h.model) {
      h.model.visible = h.active;
      h.model.position.copy(h.mesh.position);
      h.model.scale.setScalar(sc);
    }
    if (!h.active) continue;
    const arm = isLeft ? pl.armL : pl.armR;
    const dx = h.mesh.position.x - gx, dy = h.mesh.position.y - gy, dz = h.mesh.position.z - gz;
    _hl.set((dx * cs - dz * sn) / sc, dy / sc, (dx * sn + dz * cs) / sc); // hand position in body space
    setArm(arm, isLeft ? pl.shoulderL : pl.shoulderR, _hl);
    arm.visible = true;
  }
}

let padCooldown = 0;
function updateStation(dt) {
  statue.group.rotation.y += dt * 0.6;
  statueT += dt;
  setFace(statue, Math.floor(statueT / 3) % 2 === 1); // the statue alternates between both faces
  statue.group.scale.setScalar(botScale);
  padCooldown -= dt;
  if (padCooldown > 0) return;
  for (const h of hands) {
    if (!h.active) continue;
    const p = h.mesh.position;
    for (const pad of pads) {
      const d = Math.hypot(p.x - pad.x, p.z - pad.z);
      if (d < pad.r + CFG.handRadius + 0.05 && p.y < pad.h + CFG.handRadius + 0.05 && pad.idx !== playerColorIdx) {
        setPlayerColor(pad.idx);
        buzz(h, 0.5, 60);
        padCooldown = 0.4;
        return;
      }
    }
  }
}

/* ---------- Spawning ---------- */
function pickSpawns(n) {
  const pool = SPAWNS.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const out = pool.slice(0, n);
  while (out.length < n) out.push({ x: (Math.random() - 0.5) * 20, y: (Math.random() - 0.5) * 20 });
  return out;
}

function placeBot(bot, p) {
  bot.pos.set(p.x, 0, p.y);
  bot.vel.set(0, 0, 0);
  const l = Math.hypot(p.x, p.y) || 1;
  bot.dir.x = -p.x / l;
  bot.dir.z = -p.y / l;
  bot.facing = Math.atan2(bot.dir.x, bot.dir.z);
  bot.stun = 0;
  bot.target = null;
  animateBot(bot, 0);
}

// Scatter bots around before the game starts so they're visible on the page
pickSpawns(bots.length).forEach((p, i) => placeBot(bots[i], p));
updateTags(0, 0);

/* ---------- Rounds ---------- */
function startRound() {
  round++;
  state = 'running';
  roundT = CFG.roundTime;
  spotT = 0;
  lastTick = 0;
  SFX.roundStart();
  const spawns = pickSpawns(entities.length);

  entities.forEach((e, i) => {
    e.infected = false;
    e.stun = 0;
    if (e.isPlayer) teleportPlayer(spawns[i].x, spawns[i].y);
    else placeBot(e, spawns[i]);
  });

  const first = entities[Math.floor(Math.random() * entities.length)];
  first.infected = true;
  if (!first.isPlayer) first.stun = CFG.startGrace;

  entities.forEach(setVisual);

  if (first.isPlayer) {
    buzzAll(1, 300);
    flash("YOU'RE INFECTED! Tag someone!", '#ff5a3c', 4);
  } else {
    flash(`RUN! ${first.name} is infected - released in ${CFG.startGrace}s`, '#ffd84d', CFG.startGrace + 0.5);
  }
}

function endRound(timeUp) {
  state = 'intermission';
  timer = CFG.intermission;
  endedByTime = timeUp;
  if (timeUp) {
    const names = entities.filter((e) => !e.infected).map((e) => e.name);
    survivorText = names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : (names.join(', ') || 'nobody');
    if (!player.infected) buzzAll(0.8, 200);
  }
  SFX.roundEnd(timeUp ? (player.infected ? 'time' : 'win') : 'lose');
}

function infect(victim, by) {
  if (victim.infected) return;
  victim.infected = true;
  victim.target = null;
  victim.stun = victim.isPlayer ? 0 : CFG.infectStun;
  setVisual(victim);
  if (victim.isPlayer) SFX.tagged();
  else { SFX.pop({ x: victim.pos.x, y: 1, z: victim.pos.z }); if (by && by.isPlayer) SFX.tagSuccess(); }

  if (victim.isPlayer) {
    buzzAll(1, 350);
    flash('YOU WERE TAGGED! Go get them!', '#ff5a3c', 3);
  } else if (by && by.isPlayer) {
    buzzAll(0.6, 80);
    flash(`Tagged ${victim.name}!`, '#ffb84d', 1.2);
  }

  if (infectedCount() === entities.length) {
    lastSurvivor = victim.name;
    endRound(false);
  }
}

/* ---------- Tag detection ---------- */
// does any of the given points touch this bot's body?
function touchesBot(bot, pts, r) {
  const r2 = r * r;
  for (const p of pts) {
    const dx = p.x - bot.pos.x;
    const dz = p.z - bot.pos.z;
    const dxz2 = dx * dx + dz * dz;
    if (dxz2 > r2) continue;
    for (const y of BOT_TAG_Y) {
      const dy = p.y - y * botScale;
      if (dxz2 + dy * dy < r2) return true;
    }
  }
  return false;
}

function updatePlayerPoints() {
  worldOf(camera.position, _head);
  _bodyPt.copy(_head);
  _bodyPt.y -= 0.35;
  playerPts.length = 0;
  playerPts.push(_head, _bodyPt);
  for (const h of hands) if (h.active) playerPts.push(h.mesh.position);
}

function checkTags() {
  const reach = CFG.tagRadius * botScale;
  const btd2 = (CFG.botTagDistance * botScale) * (CFG.botTagDistance * botScale);
  for (const a of entities) {
    if (state !== 'running') return;
    if (!a.infected || a.stun > 0) continue;
    for (const b of entities) {
      if (b === a || b.infected) continue;
      let hit = false;
      if (a.isPlayer) {
        hit = touchesBot(b, playerPts, reach);
      } else if (b.isPlayer) {
        hit = touchesBot(a, playerPts, reach);
      } else {
        const dx = a.pos.x - b.pos.x;
        const dz = a.pos.z - b.pos.z;
        hit = dx * dx + dz * dz < btd2;
      }
      if (hit) infect(b, a);
    }
  }
}

/* ---------- Bot brain ---------- */
function nearestHealthy(bot) {
  let best = null;
  let bestD = Infinity;
  for (const e of entities) {
    if (e === bot || e.infected) continue;
    const dx = e.pos.x - bot.pos.x;
    const dz = e.pos.z - bot.pos.z;
    const d = dx * dx + dz * dz;
    if (d < bestD) { bestD = d; best = e; }
  }
  return best;
}

// Steer around trees, walls and structures: try the wanted direction first,
// then swing left/right until the path ahead is clear.
const _st = { x: 0, z: 0 };
const STEER_OFFSETS = [0, 0.5, 1.0, 1.6, 2.4];
function steer(bot, ux, uz) {
  _st.x = ux;
  _st.z = uz;
  const a = Math.atan2(ux, uz);
  const margin = 0.55 * botScale;
  for (const o of STEER_OFFSETS) {
    for (const side of o === 0 ? [1] : [bot.avoidSign, -bot.avoidSign]) {
      const ang = a + o * side;
      const dx = Math.sin(ang), dz = Math.cos(ang);
      if (!blockedAt(bot.pos.x + dx * 1.3, bot.pos.z + dz * 1.3, margin) &&
          !blockedAt(bot.pos.x + dx * 2.8, bot.pos.z + dz * 2.8, margin)) {
        _st.x = dx;
        _st.z = dz;
        return;
      }
    }
  }
}

function thinkBot(bot, dt) {
  const active = state === 'running';
  const chasing = active && bot.infected;
  let ux = 0;
  let uz = 0;
  let speed = 0;
  let closeToTarget = false;

  bot.avoidT -= dt;
  if (bot.avoidT <= 0) { bot.avoidT = 3 + Math.random() * 3; bot.avoidSign = Math.random() < 0.5 ? 1 : -1; }

  if (chasing) {
    bot.retargetT -= dt;
    if (bot.retargetT <= 0 || !bot.target || bot.target.infected) {
      bot.retargetT = 0.35;
      bot.target = nearestHealthy(bot);
    }
    const t = bot.target;
    if (t) {
      const sp = CFG.botSpeed * CFG.infectedBoost;
      const dx = t.pos.x - bot.pos.x;
      const dz = t.pos.z - bot.pos.z;
      const dist = Math.hypot(dx, dz);
      closeToTarget = dist < 2;
      const lead = Math.min(dist / sp, 0.7);
      ux = dx + t.vel.x * lead;
      uz = dz + t.vel.z * lead;
      speed = sp;
    }
  } else if (active) {
    let fx = 0;
    let fz = 0;
    let nearest = Infinity;
    for (const e of entities) {
      if (!e.infected) continue;
      const dx = bot.pos.x - (e.pos.x + e.vel.x * 0.4);
      const dz = bot.pos.z - (e.pos.z + e.vel.z * 0.4);
      const d = Math.hypot(dx, dz) + 0.001;
      nearest = Math.min(nearest, d);
      if (d < CFG.fleeRange) {
        fx += dx / d / d; // closer threats count for more
        fz += dz / d / d;
      }
    }
    if (nearest < CFG.fleeRange) {
      const l = Math.hypot(fx, fz) || 1;
      fx /= l;
      fz /= l;
      bot.jitterT -= dt;
      if (bot.jitterT <= 0) {
        bot.jitter = (Math.random() - 0.5) * 0.9;
        bot.jitterT = 0.5 + Math.random() * 0.8;
      }
      const c = Math.cos(bot.jitter);
      const s = Math.sin(bot.jitter);
      ux = fx * c - fz * s;
      uz = fx * s + fz * c;
      speed = CFG.botSpeed;
    }
  }

  if (speed === 0) {
    bot.wanderT -= dt;
    if (bot.wanderT <= 0) {
      bot.wanderT = 1.5 + Math.random() * 2;
      bot.wanderA += (Math.random() - 0.5) * 2.2;
    }
    ux = Math.sin(bot.wanderA);
    uz = Math.cos(bot.wanderA);
    speed = CFG.botWanderSpeed;
  }

  let l = Math.hypot(ux, uz);
  if (l > 1e-4) { ux /= l; uz /= l; } else { ux = bot.dir.x; uz = bot.dir.z; }

  if (!chasing) {
    const m = 7;
    const edge = BOT_LIM - m;
    const ax = Math.abs(bot.pos.x);
    const az = Math.abs(bot.pos.z);
    if (ax > edge) ux -= Math.sign(bot.pos.x) * ((ax - edge) / m) * 2.5;
    if (az > edge) uz -= Math.sign(bot.pos.z) * ((az - edge) / m) * 2.5;
    l = Math.hypot(ux, uz);
    if (l > 1e-4) { ux /= l; uz /= l; }
  }

  if (!closeToTarget) {
    steer(bot, ux, uz);
    ux = _st.x;
    uz = _st.z;
  }

  const k = 1 - Math.exp(-CFG.botTurnRate * dt);
  bot.dir.x += (ux - bot.dir.x) * k;
  bot.dir.z += (uz - bot.dir.z) * k;
  const dl = Math.hypot(bot.dir.x, bot.dir.z) || 1;
  bot.dir.x /= dl;
  bot.dir.z /= dl;

  bot.want.x = bot.dir.x * speed;
  bot.want.z = bot.dir.z * speed;
}

function moveBot(bot, dt) {
  const stunned = bot.stun > 0;
  if (stunned) bot.stun -= dt;
  const wx = stunned ? 0 : bot.want.x;
  const wz = stunned ? 0 : bot.want.z;

  let ax = wx - bot.vel.x;
  let az = wz - bot.vel.z;
  const dl = Math.hypot(ax, az);
  const maxD = CFG.botAccel * dt;
  if (dl > maxD) { ax *= maxD / dl; az *= maxD / dl; }
  bot.vel.x += ax;
  bot.vel.z += az;

  bot.pos.x += bot.vel.x * dt;
  bot.pos.z += bot.vel.z * dt;
  pushOutBlockers(bot.pos, 0.42 * botScale);
  bot.pos.x = THREE.MathUtils.clamp(bot.pos.x, -BOT_LIM, BOT_LIM);
  bot.pos.z = THREE.MathUtils.clamp(bot.pos.z, -BOT_LIM, BOT_LIM);
}

function separateBots() {
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i];
      const b = bots[j];
      const dx = a.pos.x - b.pos.x;
      const dz = a.pos.z - b.pos.z;
      const d = Math.hypot(dx, dz);
      const min = 0.6 * botScale;
      if (d < min && d > 1e-4) {
        const push = (min - d) / 2;
        a.pos.x += (dx / d) * push;
        a.pos.z += (dz / d) * push;
        b.pos.x -= (dx / d) * push;
        b.pos.z -= (dz / d) * push;
      }
    }
  }
}

/* ---------- Spotted: healthy players look scared when a tagger sees them ---------- */
let spotT = 0;
function updateSpotted(dt) {
  spotT -= dt;
  if (spotT > 0) return;
  spotT = 0.2; // check 5 times a second
  for (const e of entities) {
    let spotted = false;
    if (state === 'running' && !e.infected) {
      for (const t of entities) {
        if (t === e || !t.infected) continue;
        const d = Math.hypot(t.pos.x - e.pos.x, t.pos.z - e.pos.z);
        if (d < CFG.spotRange && !sightBlocked(t.pos.x, t.pos.z, e.pos.x, e.pos.z)) { spotted = true; break; }
      }
    }
    if (spotted && !e.spotted && !e.isPlayer) SFX.gasp({ x: e.pos.x, y: 1, z: e.pos.z });
    e.spotted = spotted;
    setFace(e.isPlayer ? playerAvatar : e.pl, spotted);
  }
}

/* ---------- Per-frame game update ---------- */
function updateHud() {
  let main = '';
  let color = '#ffffff';
  let sub;
  if (state === 'intermission') {
    if (endedByTime) {
      main = player.infected ? "TIME'S UP!" : "TIME'S UP - YOU SURVIVED!";
      color = player.infected ? '#ffd84d' : '#7dff9a';
      sub = `Survivors: ${survivorText}  |  New round in ${Math.ceil(timer)}`;
    } else {
      main = "EVERYONE'S INFECTED!";
      color = '#ff5a3c';
      sub = `Last survivor: ${lastSurvivor}  |  New round in ${Math.ceil(timer)}`;
    }
  } else {
    if (flashT > 0) { main = flashText; color = flashColor; }
    const secs = Math.max(0, Math.ceil(roundT));
    const tstr = Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
    sub = `Round ${round}  |  Infected ${infectedCount()}/${entities.length}  |  ${tstr}  |  ${player.infected ? 'YOU ARE INFECTED' : 'You are safe'}`;
  }
  drawHud(main, color, sub);
}

function updateGame(dt) {
  if (state === 'idle') return;

  worldOf(camera.position, _head);
  if (player.hasPrev) {
    _pv.set((_head.x - player.pos.x) / dt, 0, (_head.z - player.pos.z) / dt);
    player.vel.lerp(_pv, 0.3);
  } else {
    player.vel.set(0, 0, 0);
  }
  player.pos.set(_head.x, 0, _head.z);
  player.hasPrev = true;

  if (state === 'intermission') {
    timer -= dt;
    if (timer <= 0) { startRound(); return; }
  }
  flashT = Math.max(0, flashT - dt);

  if (state === 'running') {
    roundT -= dt;
    const secLeft = Math.ceil(roundT);
    if (secLeft !== lastTick && secLeft <= 10 && secLeft > 0) SFX.tick(secLeft <= 3); // countdown ticks
    lastTick = secLeft;
    if (roundT <= 0) { endRound(true); updateHud(); return; } // time's up: whoever is still healthy survived
  }

  for (const bot of bots) {
    thinkBot(bot, dt);
    moveBot(bot, dt);
  }
  separateBots();
  for (const bot of bots) animateBot(bot, dt);
  updateSpotted(dt);

  if (state === 'running') {
    updatePlayerPoints();
    checkTags();
  }
  updateHud();
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */
renderer.xr.addEventListener('sessionstart', () => {
  SFX.unlock();
  resetPlayer();
  round = 0;
  eyeInit = false;
  hud.visible = true;
  hudKey = '';
  playerAvatar.group.visible = true;
  startRound();
  const info = document.getElementById('info');
  if (info) info.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  state = 'idle';
  hud.visible = false;
  playerAvatar.group.visible = false;
  tint.material.opacity = 0;
  const info = document.getElementById('info');
  if (info) info.style.display = '';
});

// ears + music follow your head
const _afwd = new THREE.Vector3();
function updateAudio() {
  worldOf(camera.position, _g0);
  _afwd.set(0, 0, -1).applyQuaternion(camera.quaternion).applyAxisAngle(_up, rig.rotation.y);
  SFX.update(_g0, _afwd);
}

// sound can only start after a tap/click
['pointerdown', 'click', 'touchstart', 'keydown'].forEach((ev) => window.addEventListener(ev, () => SFX.unlock(), { passive: true }));

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = THREE.MathUtils.clamp(clock.getDelta(), 1 / 240, 0.05);
  if (renderer.xr.isPresenting) {
    try {
      handleInput();
      updateLocomotion(dt);
      updateEyeHeight(dt);
      updateGame(dt);
      updateAvatar(dt);
      updateStation(dt);
      updateTags(dt, performance.now() / 1000);
      updateAudio();
      SKY.update(dt, performance.now() / 1000, _g0);
    } catch (err) {
      console.error(err);
      drawHud('ERROR: ' + String((err && err.message) || err), '#ff5a3c', 'Tell Claude what this says');
    }
  }
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
