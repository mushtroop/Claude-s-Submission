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
  handRadius: 0.07,      // size of the hand collision sphere (m)
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
  standOnFeet: false,     // true = you stand at your real height (like real Gorilla Tag).
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
  botSizeBoost: 1.0,     // 1.0 = bots' eye level matches yours; 1.1 = 10% taller
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
scene.background = new THREE.Color(0x87c8ff);
scene.fog = new THREE.Fog(0x87c8ff, 35, 110);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 200);
camera.position.set(0, 1.6, 0); // desktop preview height; VR overrides this

// The "rig" is the player body. Moving the rig moves the player.
const rig = new THREE.Group();
rig.add(camera);
scene.add(rig);

scene.add(new THREE.HemisphereLight(0xffffff, 0x55704f, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(10, 20, 5);
scene.add(sun);

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const MAP = CFG.worldHalfSize;
const WHITE = new THREE.Color(0xffffff);
const INFECTED_COLOR = 0xff3b1f;

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

const matCache = new Map();
function lambert(color, flat = false) {
  const key = color + (flat ? 'f' : '');
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color, flatShading: flat });
    matCache.set(key, m);
  }
  return m;
}

function lerpAngle(from, to, k) {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + d * k;
}

// Monkey fur colors (red is reserved for "infected")
const PALETTE = [
  { name: 'Orange', hex: 0xffa800 }, { name: 'Pink', hex: 0xff8fc7 },
  { name: 'Yellow', hex: 0xffe14d }, { name: 'Lime', hex: 0xa6e84d },
  { name: 'Green', hex: 0x3fcf6f }, { name: 'Teal', hex: 0x2fd6c4 },
  { name: 'Sky', hex: 0x5ec8ff }, { name: 'Blue', hex: 0x4d7dff },
  { name: 'Purple', hex: 0xa97bff }, { name: 'Magenta', hex: 0xe05cff },
  { name: 'Brown', hex: 0xb07a4a }, { name: 'White', hex: 0xf2f2f2 },
];
let playerColorIdx = 0;
try {
  const saved = parseInt(localStorage.getItem('monkeColor'), 10);
  if (saved >= 0 && saved < PALETTE.length) playerColorIdx = saved;
} catch (_) { /* no saved color */ }

/* ================================================================== */
/*  FOREST MAP                                                         */
/*  Everything you can stand on or grab is added to `colliders`.       */
/* ================================================================== */
const colliders = [];
const statics = new Map(); // static scenery, merged per color so it draws in a handful of calls

function addStatic(geo, color, flat = false) {
  const key = color + (flat ? 'f' : '');
  let b = statics.get(key);
  if (!b) { b = { color, flat, list: [] }; statics.set(key, b); }
  b.list.push(geo);
}

function flushStatics() {
  for (const b of statics.values()) {
    const merged = mergeGeometries(b.list);
    scene.add(new THREE.Mesh(merged, lambert(b.color, b.flat)));
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

function addBox(cx, cy, cz, sx, sy, sz, color, yaw = 0) {
  const g = new THREE.BoxGeometry(sx, sy, sz);
  g.rotateY(yaw);
  g.translate(cx, cy, cz);
  addStatic(g, color);
  addBoxCollider(cx, cy, cz, sx, sy, sz, yaw);
}

function addPost(cx, cz, R, y0, y1, color, seg = 12) {
  const h = y1 - y0;
  const g = new THREE.CylinderGeometry(R, R, h, seg);
  g.translate(cx, y0 + h / 2, cz);
  addStatic(g, color);
  addCylCollider(cx, cz, R, y0, y1);
}

function addStump(cx, cz, R, h) {
  const g = new THREE.CylinderGeometry(R, R * 1.12, h, 16);
  g.translate(cx, h / 2, cz);
  addStatic(g, 0x8a5a33);
  addCylCollider(cx, cz, R, 0, h);
}

function addRock(cx, cz, R, h) {
  const g = new THREE.CylinderGeometry(R * 0.8, R, h, 7);
  g.translate(cx, h / 2, cz);
  addStatic(g, 0x8d9199, true);
  addCylCollider(cx, cz, R, 0, h);
}

function addMushroom(cx, cz, stemH) {
  addPost(cx, cz, 0.22, 0, stemH, 0xe8dcc0, 10);
  const g = new THREE.CylinderGeometry(0.9, 1.0, 0.3, 16);
  g.translate(cx, stemH + 0.15, cz);
  addStatic(g, 0xd9443a);
  addCylCollider(cx, cz, 1.0, stemH, stemH + 0.3);
}

function addFoliage(x, yBase, z, r, h, color) {
  const g = new THREE.ConeGeometry(r, h, 9);
  g.translate(x, yBase + h / 2, z);
  addStatic(g, color, true);
}

function addDisc(x, z, r, color) {
  const g = new THREE.CircleGeometry(r, 40);
  g.rotateX(-Math.PI / 2);
  g.translate(x, 0.015, z);
  addStatic(g, color);
}

// Zones kept clear of random trees and spawn points
const ZONES = [
  { x: 0, z: 0, r: 11 },      // Great Stump hub
  { x: -16, z: -12, r: 10 },  // treehouse
  { x: 16, z: 0, r: 9 },      // watch tower
  { x: 14, z: -22, r: 10 },   // cabin
  { x: -20, z: 12, r: 9 },    // log tunnel
  { x: -9, z: 8, r: 5 },      // color station
  { x: 24, z: 14, r: 4.5 }, { x: -26, z: -4, r: 4.5 }, { x: 4, z: -26, r: 4.5 }, // rocks
  { x: -6, z: 14, r: 4 }, { x: 22, z: -8, r: 4 }, { x: -28, z: -22, r: 4 }, { x: 26, z: 20, r: 4 }, // logs
];

const SPAWNS = [];
const pads = [];
const STATION = { x: -9, z: 8 };

function buildWorld() {
  const wood = 0xa8744a, darkWood = 0x6b4426, lightWood = 0xc89a66, roofColor = 0x9a4a3a;

  // --- ground ---
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#4e9a47';
  g.fillRect(0, 0, 256, 256);
  const gr = mulberry32(7);
  for (let i = 0; i < 1800; i++) {
    g.fillStyle = gr() < 0.5 ? '#58a650' : '#418a3b';
    g.fillRect(gr() * 256, gr() * 256, 2 + gr() * 3, 2 + gr() * 3);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(MAP / 2, MAP / 2); // 4 m tiles
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(MAP * 2, MAP * 2), new THREE.MeshLambertMaterial({ map: tex }));
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  addDisc(0, 0, 10.5, 0x8a6a45);
  addDisc(STATION.x, STATION.z, 4, 0x9c7b52);

  // --- THE GREAT STUMP (center) + climbing stumps up to its top ---
  addStump(0, 0, 3.2, 3.0);
  for (let k = 0; k < 4; k++) {
    const a = Math.PI * 1.15 + k * 0.46;
    addStump(Math.cos(a) * 6.0, Math.sin(a) * 6.0, 0.85, 0.8 + k * 0.7);
  }
  // bouncy mushrooms around the hub
  [0.9, 1.2, 1.5, 0.9, 1.2, 1.5].forEach((h, k) => {
    const a = (k * Math.PI) / 3 + 0.5;
    addMushroom(Math.cos(a) * 8.5, Math.sin(a) * 8.5, h);
  });

  // --- TREEHOUSE (reach it by hopping up the stump stairs) ---
  const TX = -16, TZ = -12;
  addPost(TX, TZ, 1.3, 0, 10, 0x6b4426, 14);                 // giant trunk
  addBox(TX, 4.825, TZ, 8, 0.35, 8, wood);                    // floor (top at y=5)
  addBox(TX, 5.45, TZ - 3.9, 8, 0.9, 0.2, lightWood);         // railings (east side is open)
  addBox(TX, 5.45, TZ + 3.9, 8, 0.9, 0.2, lightWood);
  addBox(TX - 3.9, 5.45, TZ, 0.2, 0.9, 8, lightWood);
  for (const [sx, sz] of [[-3.7, -3.7], [3.7, -3.7], [-3.7, 3.7], [3.7, 3.7]]) addPost(TX + sx, TZ + sz, 0.18, 5, 8.6, darkWood);
  addBox(TX, 8.775, TZ, 9.4, 0.35, 9.4, roofColor);           // roof
  addFoliage(TX, 9.5, TZ, 6.5, 4.5, 0x2f7d3a);
  addFoliage(TX, 12, TZ, 5.0, 4.2, 0x2b6e34);
  addFoliage(TX, 14.3, TZ, 3.3, 3.8, 0x3a8c45);
  [[-5.0, 1], [-7.0, 2], [-9.0, 3], [-10.9, 4]].forEach(([x, h]) => addStump(x, TZ, 0.8, h));

  // --- WATCH TOWER + log bridge from the Great Stump ---
  const WX = 16, WZ = 0;
  addBox(WX, 2.825, WZ, 6, 0.35, 6, wood);                    // platform (top at y=3)
  for (const [sx, sz] of [[-2.7, -2.7], [2.7, -2.7], [-2.7, 2.7], [2.7, 2.7]]) addPost(WX + sx, WZ + sz, 0.25, 0, 2.65, darkWood);
  addBox(WX, 3.45, WZ - 2.9, 6, 0.9, 0.2, lightWood);
  addBox(WX + 2.9, 3.45, WZ, 0.2, 0.9, 6, lightWood);
  addBox(8.1, 2.85, 0, 9.6, 0.3, 1.4, wood);                  // bridge (top at y=3)
  addBox(8.1, 3.4, -0.65, 9.6, 0.8, 0.12, lightWood);
  addBox(8.1, 3.4, 0.65, 9.6, 0.8, 0.12, lightWood);
  addPost(8.1, 0, 0.25, 0, 2.7, darkWood);
  [[16, 8.0, 0.8], [16, 6.2, 1.6], [16, 4.4, 2.4]].forEach(([x, z, h]) => addStump(x, z, 0.8, h));

  // --- CABIN (walk in the door, or climb stumps to the roof) ---
  const CX = 14, CZ = -22, wallH = 2.8, t = 0.3, w = 9, d = 7;
  addBox(CX, wallH / 2, CZ - d / 2, w, wallH, t, wood);
  addBox(CX - w / 2, wallH / 2, CZ, t, wallH, d, wood);
  addBox(CX + w / 2, wallH / 2, CZ, t, wallH, d, wood);
  const seg = (w - 2.2) / 2;                                  // front wall with a 2.2 m doorway
  addBox(CX - w / 2 + seg / 2, wallH / 2, CZ + d / 2, seg, wallH, t, wood);
  addBox(CX + w / 2 - seg / 2, wallH / 2, CZ + d / 2, seg, wallH, t, wood);
  addBox(CX, wallH + 0.175, CZ, w + 0.8, 0.35, d + 0.8, roofColor); // roof (top at y=3.15)
  addBox(CX - 2, 0.25, CZ - 2, 2.2, 0.5, 0.7, lightWood);     // bench
  [[9.5, 0.9], [7.7, 1.8], [5.9, 2.7]].forEach(([dx, h]) => addStump(CX + dx, CZ, 0.8, h));

  // --- LOG TUNNEL (run through it, or climb on top) ---
  const LX = -20, LZ = 12;
  addBox(LX, 1.2, LZ - 1.35, 7, 2.4, 0.5, darkWood);
  addBox(LX, 1.2, LZ + 1.35, 7, 2.4, 0.5, darkWood);
  addBox(LX, 2.7, LZ, 7, 0.6, 3.2, wood);                     // roof (top at y=3)
  addStump(-26.4, LZ, 0.8, 1.1);
  addStump(-24.6, LZ, 0.8, 2.2);

  // --- fallen logs ---
  [[-6, 14, 0.4], [22, -8, -0.8], [-28, -22, 1.2], [26, 20, 0.2]].forEach(([x, z, yaw]) => addBox(x, 0.5, z, 6, 1.0, 1.0, 0x6e4a2b, yaw));

  // --- rock outcrops ---
  addRock(24, 14, 1.8, 1.2); addRock(24.8, 15.5, 1.1, 2.1); addRock(22.6, 13, 0.8, 0.8);
  addRock(-26, -4, 2.2, 1.0); addRock(-25, -5.1, 1.3, 1.9); addRock(-27.8, -3, 0.9, 1.5);
  addRock(4, -26, 1.6, 1.4); addRock(5.1, -26.6, 0.9, 2.4);

  // --- COLOR STATION: touch a colored post to change your plushie ---
  addPost(STATION.x, STATION.z, 0.9, 0, 0.5, 0xb9b1a6, 20);   // pedestal for the statue
  PALETTE.forEach((p, i) => {
    const a = (i / PALETTE.length) * Math.PI * 2;
    const px = STATION.x + Math.cos(a) * 2.7;
    const pz = STATION.z + Math.sin(a) * 2.7;
    addPost(px, pz, 0.3, 0, 0.55, p.hex, 14);
    pads.push({ x: px, z: pz, r: 0.3, h: 0.55, idx: i });
  });

  // --- spawn points (well spread, never inside structures) ---
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

  // --- the forest: instanced trees (trunks are collidable) ---
  const leafColors = [0x2f7d3a, 0x2b6e34, 0x3a8c45, 0x347a3d];
  const trunkColors = [0x6b4426, 0x5e3b20, 0x7a4f2d];
  const spots = [];
  const makeTree = (x, z) => spots.push({
    x, z, h: 5 + rand() * 4, r: 0.32 + rand() * 0.2,
    leaf: leafColors[Math.floor(rand() * leafColors.length)],
    trunk: trunkColors[Math.floor(rand() * trunkColors.length)],
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
  const trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.85, 1, 1, 8), lambert(0xffffff), n);
  const cones = [0, 1, 2].map(() => new THREE.InstancedMesh(new THREE.ConeGeometry(1, 1, 8), lambert(0xffffff, true), n));
  const dummy = new THREE.Object3D();
  const col = new THREE.Color();
  spots.forEach((s, i) => {
    dummy.position.set(s.x, s.h / 2, s.z);
    dummy.scale.set(s.r, s.h, s.r);
    dummy.updateMatrix();
    trunks.setMatrixAt(i, dummy.matrix);
    trunks.setColorAt(i, col.set(s.trunk));
    const k = s.h / 7;
    for (let j = 0; j < 3; j++) {
      const cr = (2.1 - 0.55 * j) * k;
      const ch = 2.6 * k;
      dummy.position.set(s.x, s.h * 0.4 + j * 1.5 * k + ch / 2, s.z);
      dummy.scale.set(cr, ch, cr);
      dummy.updateMatrix();
      cones[j].setMatrixAt(i, dummy.matrix);
      cones[j].setColorAt(i, col.set(s.leaf));
    }
    addCylCollider(s.x, s.z, s.r, 0, s.h);
  });
  for (const m of [trunks, ...cones]) {
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
      // box (can be rotated around Y)
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
      // upright cylinder (trunks, stumps, rocks, posts)
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
      // segment vs rotated box: move into the box's own frame, then do a slab test
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

let hudKey = '';
function fitFont(c, text, maxW, size) {
  while (size > 24) {
    c.font = `bold ${size}px system-ui, sans-serif`;
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
    c.lineWidth = 14;
    c.strokeStyle = 'rgba(0,0,0,0.85)';
    c.strokeText(main, 512, 150);
    c.fillStyle = mainColor;
    c.fillText(main, 512, 150);
  }
  fitFont(c, sub, 940, 44);
  const w = c.measureText(sub).width + 60;
  c.fillStyle = 'rgba(0,0,0,0.55)';
  c.fillRect(512 - w / 2, 360, w, 76);
  c.fillStyle = '#ffffff';
  c.fillText(sub, 512, 398);
  hudTex.needsUpdate = true;
}

/* ------------------------------------------------------------------ */
/*  Monkey model, built to match your drawing: orange fur, tan face,   */
/*  belly and hands, thick black outlines, spiky cheek fur, a curly    */
/*  tail and mushroom spikes on the back. No legs - it stands on its   */
/*  long arms. Used by you, the bots and the statue.                   */
/* ------------------------------------------------------------------ */
const MODEL_TOP = 1.78;     // top of the head, in model units
const EYE_M = 1.36;         // eye height inside the model
const TAN = 0xc9a46e;
const HULL_T = 0.012;       // outline thickness
const ARM_R = 0.095;        // arm thickness
const HAND_SPLAY = 0.6;     // how far the hands turn outward
const PK = MODEL_TOP / 335; // metres per pixel of your drawing

// turn a point on the zoomed face crop of your drawing (3x zoom) into model metres
const FC = (cx, cy) => [((190 + cx / 3) - 289) * PK, (495 - (130 + cy / 3)) * PK];

// ---- shapes, as plain numbers ----
// the torso is a surface of revolution too: wide shoulders tapering to a rounded bottom (like your drawing)
const TORSO_RX = 0.30, TORSO_RZ = 0.21;
const TORSO_PROFILE = [[0.40, 0.0], [0.42, 0.45], [0.48, 0.6], [0.58, 0.7], [0.70, 0.8], [0.82, 0.9], [0.95, 0.97],
  [1.05, 1.0], [1.12, 0.9], [1.18, 0.6], [1.22, 0.0]];
function profileR(table, y) {
  if (y <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (y <= table[i][0]) { const f = (y - table[i - 1][0]) / (table[i][0] - table[i - 1][0]); return table[i - 1][1] + (table[i][1] - table[i - 1][1]) * f; }
  }
  return 0;
}
const torsoR = (y) => profileR(TORSO_PROFILE, y);
// the thick tail leaves the lower back, sweeps out to the side and curls up
const TAIL_PATH = [[0, 0.52, -0.18], [-0.14, 0.5, -0.32], [-0.3, 0.52, -0.42], [-0.48, 0.57, -0.47], [-0.66, 0.65, -0.47],
  [-0.8, 0.78, -0.42], [-0.88, 0.93, -0.35], [-0.9, 1.06, -0.28]];
const TAIL_R = 0.105;
const SHOULDER_SHAPES = [[-0.27, 1.02, 0, 0.15, 0.15, 0.14], [0.27, 1.02, 0, 0.15, 0.15, 0.14]]; // [x, y, z, radiusX, radiusY, radiusZ]

const HEAD_Y = 1.40; // head centre; the head shapes below are relative to it
const HEAD_RX = 0.345, HEAD_RZ = 0.30;
// the head is a surface of revolution; this table is its outline: [height, width (1 = widest)]
// (wide jaw, round dome - like your drawing, not an egg)
const HEAD_PROFILE = [[0.99, 0.0], [1.0, 0.22], [1.03, 0.5], [1.07, 0.66], [1.11, 0.75], [1.18, 0.84], [1.26, 0.92], [1.36, 0.98],
  [1.46, 1.0], [1.56, 0.96], [1.64, 0.82], [1.71, 0.6], [1.76, 0.33], [1.78, 0.0]];
const headR = (y) => profileR(HEAD_PROFILE, y);
const EAR_SHAPES = [[-0.355, 0.02, 0, 0.045, 0.09, 0.035], [0.355, 0.02, 0, 0.045, 0.09, 0.035]];
// spiky fur: [radius, length, rotation, x, y] (a cone starts at its base and points along its rotation)
const HEAD_CONES = [
  [0.05, 0.17, -Math.PI / 2 + 0.4, 0.31, -0.05], [0.05, 0.17, -Math.PI / 2 - 0.4, 0.31, -0.2],  // cheek fur, right side
  [0.05, 0.17, Math.PI / 2 - 0.4, -0.31, -0.05], [0.05, 0.17, Math.PI / 2 + 0.4, -0.31, -0.2],  // cheek fur, left side
  [0.03, 0.17, -1.0, 0.0, 0.36], [0.03, 0.17, -1.2, 0.08, 0.35], [0.03, 0.17, -1.4, 0.16, 0.33], // hair tuft, leaning right
];

// mushroom spikes on the back and back of the head: [x, y, z, directionX, directionY, directionZ, size]
const MUSHROOMS = [
  [0.0, 1.04, -0.14, 0, 0.55, -0.83, 1.0], [-0.16, 0.95, -0.13, -0.5, 0.3, -0.8, 0.9], [0.16, 0.95, -0.13, 0.5, 0.3, -0.8, 1.0],
  [0.0, 0.82, -0.205, 0, 0.15, -0.99, 1.2], [-0.16, 0.66, -0.14, -0.45, 0.05, -0.9, 0.85], [0.16, 0.64, -0.14, 0.45, 0.05, -0.9, 0.95],
  [-0.1, 1.62, -0.23, -0.35, 0.6, -0.72, 0.9], [0.12, 1.66, -0.19, 0.35, 0.65, -0.68, 0.8], [0.0, 1.74, -0.12, 0, 0.9, -0.4, 0.7],
];

// ---- the flat painted parts: the face and the belly are decals wrapped around the body ----
const FACE = { lathe: true, R: headR, rx: HEAD_RX * 1.02, rz: HEAD_RZ * 1.02, y0: 0.99, y1: 1.64, dphi: 2.8, W: 640, H: 432 };
const BELLY = { lathe: true, R: torsoR, rx: TORSO_RX * 1.02, rz: TORSO_RZ * 1.02, y0: 0.44, y1: 0.98, dphi: 2.3, W: 560, H: 420 };

// every point below was read off your drawing (zoomed face crop coordinates)
const P = (list) => list.map(([a, b]) => FC(a, b));
const FACE_OUTLINE = P([[148, 300], [165, 252], [205, 218], [240, 199], [270, 203], [297, 214], [325, 203], [358, 199], [395, 215], [435, 248],
  [453, 300], [458, 370], [452, 430], [430, 480], [390, 512], [340, 526], [300, 528], [255, 523], [210, 505], [170, 470], [145, 420], [137, 370]]);
const FACE_EYES = [[241, 326, 26, 64], [354, 326, 26, 62]].map(([a, b, rx, ry]) => ({ c: FC(a, b), rx: rx / 3 * PK, ry: ry / 3 * PK }));
const NOSTRILS = [P([[270, 405], [287, 412]]), P([[308, 405], [322, 414]])];
const HAPPY_MOUTH = P([[205, 457], [218, 445], [250, 438], [290, 438], [320, 448], [318, 462], [300, 480], [270, 495], [240, 497], [215, 485], [205, 470]]);
const HAPPY_DASH = P([[205, 389], [230, 388], [257, 382]]);          // the little line under the left eye
const SCARED_ARCS = [P([[216, 345], [203, 368], [214, 396]]), P([[383, 345], [396, 368], [385, 396]])]; // worry lines
const SCARED_MOUTH = P([[240, 490], [265, 478], [300, 483], [335, 476], [360, 490]]);
const BELLY_OVAL = { cy: (495 - 361) * PK, rx: 36 * PK, ry: 37 * PK };

function shapeGeo(base, x, y, z, sx, sy, sz) {
  const g = base.clone();
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

// Outline: a slightly fatter copy drawn inside-out in black
function hullOf(geo, t) {
  const g = geo.clone();
  const p = g.attributes.position, n = g.attributes.normal;
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i, p.getX(i) + n.getX(i) * t, p.getY(i) + n.getY(i) * t, p.getZ(i) + n.getZ(i) * t);
  }
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

// Where does a point on the front of the body (X right, Y up, in metres) land on a decal's canvas?
// These are the inverse of how three.js lays a texture over a patch of surface.
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

// The two faces from your drawings
function makeFaceTexture(scared) {
  return makeDecal(FACE, (x, path, pxm) => {
    path(spline(FACE_OUTLINE, true), true);               // the tan face with its black outline
    x.fillStyle = '#c9a46e';
    x.fill();
    x.lineWidth = 0.016 * pxm;
    x.strokeStyle = '#111111';
    x.stroke();
    x.fillStyle = '#111111';
    for (const e of FACE_EYES) { path(ellipsePts(e.c[0], e.c[1], e.rx, e.ry), true); x.fill(); } // tall oval eyes
    x.lineWidth = 0.014 * pxm;
    for (const n of NOSTRILS) { path(n, false); x.stroke(); }
    if (!scared) {
      path(spline(HAPPY_MOUTH, true), true);              // open smile, a little off to one side
      x.fill();
      path(spline(HAPPY_DASH, false), false);
      x.stroke();
    } else {
      for (const a of SCARED_ARCS) { path(spline(a, false), false); x.stroke(); } // worry lines by the eyes
      x.lineWidth = 0.02 * pxm;
      path(spline(SCARED_MOUTH, false), false);           // flat, wobbly mouth
      x.stroke();
    }
  });
}

function makeBellyTexture() {
  return makeDecal(BELLY, (x, path, pxm) => {
    path(ellipsePts(0, BELLY_OVAL.cy, BELLY_OVAL.rx, BELLY_OVAL.ry, 40), true);
    x.fillStyle = '#c9a46e';
    x.fill();
    x.lineWidth = 0.02 * pxm;
    x.strokeStyle = '#111111';
    x.stroke();
  });
}

const MK = (() => {
  const sph = new THREE.SphereGeometry(1, 20, 14);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 14);
  const S = (x, y, z, sx, sy, sz) => shapeGeo(sph, x, y, z, sx, sy, sz);
  const cone = (r, h, rot, x, y) => {
    const g = new THREE.ConeGeometry(r, h, 7);
    g.translate(0, h / 2, 0);
    g.rotateZ(rot);
    g.translate(x, y, 0);
    return g;
  };

  // a surface of revolution from an outline table (bottom to top), squashed to an oval cross-section
  const lathe = (R, y0, y1, n, rScale, rx, rz, yOff, segments, phiStart, phiLength) => {
    const pts = [];
    for (let j = 0; j < n; j++) {
      const y = y0 + ((y1 - y0) * j) / (n - 1);
      pts.push(new THREE.Vector2(R(y) * rScale, y - yOff));
    }
    const g = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
    g.scale(rx, 1, rz);
    return g;
  };
  const headLathe = (y0, y1, n, rScale, segments, phiStart, phiLength) =>
    lathe(headR, y0, y1, n, rScale, HEAD_RX, HEAD_RZ, HEAD_Y, segments, phiStart, phiLength);

  // body = tapered torso + shoulders + one smooth swept tail with round ends
  const tailCurve = new THREE.CatmullRomCurve3(TAIL_PATH.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
  const tailEnds = [TAIL_PATH[0], TAIL_PATH[TAIL_PATH.length - 1]].map(([x, y, z]) => S(x, y, z, TAIL_R, TAIL_R, TAIL_R));
  const body = mergeGeometries([
    lathe(torsoR, TORSO_PROFILE[0][0], TORSO_PROFILE[TORSO_PROFILE.length - 1][0], 30, 1, TORSO_RX, TORSO_RZ, 0, 32, 0, Math.PI * 2),
    ...SHOULDER_SHAPES.map((b) => S(...b)),
    new THREE.TubeGeometry(tailCurve, 36, TAIL_R, 10, false),
    ...tailEnds,
  ]);
  const headCore = () => headLathe(HEAD_PROFILE[0][0], HEAD_PROFILE[HEAD_PROFILE.length - 1][0], 30, 1, 32, 0, Math.PI * 2);
  const head = mergeGeometries([headCore(), ...HEAD_CONES.map((c) => cone(...c))]);
  const ears = mergeGeometries(EAR_SHAPES.map((e) => S(...e)));
  const headHull = hullOf(mergeGeometries([head, ...EAR_SHAPES.map((e) => S(...e))]), 0.012);

  // face and belly: patches of sphere hugging the head / torso
  const face = headLathe(FACE.y0, FACE.y1, 26, 1.02, 36, -FACE.dphi / 2, FACE.dphi);
  const belly = lathe(torsoR, BELLY.y0, BELLY.y1, 22, 1.02, TORSO_RX, TORSO_RZ, 0, 32, -BELLY.dphi / 2, BELLY.dphi);

  // mushroom spikes: cream stem + dark red cap with white spots (vertex colors)
  const UPV = new THREE.Vector3(0, 1, 0);
  const colored = (g, r, gr, b) => {
    const n = g.attributes.position.count;
    const a = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { a[i * 3] = r; a[i * 3 + 1] = gr; a[i * 3 + 2] = b; }
    g.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return g;
  };
  const mushroom = ([px, py, pz, dx, dy, dz, sc]) => {
    const stem = new THREE.CylinderGeometry(0.022, 0.03, 0.14, 8);
    stem.translate(0, 0.07, 0);
    const parts = [
      colored(stem, 0.85, 0.74, 0.6),
      colored(shapeGeo(sph, 0, 0.15, 0, 0.092, 0.05, 0.092), 0.62, 0.12, 0.13),
      ...[[0, 0.2, 0], [0.05, 0.1887, 0.03], [-0.045, 0.1878, 0.04], [0.01, 0.1875, -0.06]]
        .map(([x, y, z]) => colored(shapeGeo(sph, x, y, z, 0.028, 0.01, 0.028), 1, 1, 1)),
    ];
    const g = mergeGeometries(parts);
    g.scale(sc, sc, sc);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(UPV, new THREE.Vector3(dx, dy, dz).normalize()));
    g.translate(px, py, pz);
    return g;
  };
  const mushrooms = mergeGeometries(MUSHROOMS.map(mushroom));

  // big flat tan paw with four spread fingers
  const fingers = [0, 1, 2, 3].map((i) => {
    const g = S(0, 0, 0.13, 0.03, 0.021, 0.11);
    g.rotateY((i - 1.5) * 0.36);
    g.translate((i - 1.5) * 0.05, 0, 0.02);
    return g;
  });
  const hand = mergeGeometries([S(0, 0, 0, 0.11, 0.03, 0.1), ...fingers]);

  return {
    cyl, body, head, ears, face, belly, mushrooms, hand,
    bodyHull: hullOf(body, 0.014),
    headHull,
    mushHull: hullOf(mushrooms, 0.006),
    handHull: hullOf(hand, 0.012),
  };
})();

const hullMat = new THREE.MeshBasicMaterial({ color: 0x101010, side: THREE.BackSide });
const tanMat = new THREE.MeshLambertMaterial({ color: TAN });
const mushMat = new THREE.MeshLambertMaterial({ vertexColors: true });
// the painted parts are unlit so they look like your flat drawing
const faceMatHappy = new THREE.MeshBasicMaterial({ map: makeFaceTexture(false), alphaTest: 0.4 });
const faceMatScared = new THREE.MeshBasicMaterial({ map: makeFaceTexture(true), alphaTest: 0.4 });
const bellyMat = new THREE.MeshBasicMaterial({ map: makeBellyTexture(), alphaTest: 0.4 });

function makePaw() {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(MK.hand, tanMat), new THREE.Mesh(MK.handHull, hullMat));
  return g;
}

function makeArm(mat) {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(MK.cyl, mat), new THREE.Mesh(MK.cyl, hullMat)); // fur + black outline
  return g;
}

function makePlushie(hex) {
  const main = new THREE.MeshLambertMaterial({ color: hex }); // the fur (recolorable)
  const g = new THREE.Group();
  const add = (geo, mat, parent) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };

  add(MK.body, main, g);
  add(MK.bodyHull, hullMat, g);
  add(MK.belly, bellyMat, g);
  add(MK.mushrooms, mushMat, g);
  add(MK.mushHull, hullMat, g);

  const headG = new THREE.Group();
  headG.position.set(0, HEAD_Y, 0);
  g.add(headG);
  add(MK.head, main, headG);
  add(MK.headHull, hullMat, headG);
  add(MK.ears, tanMat, headG);
  const face = add(MK.face, faceMatHappy, headG);

  const armL = makeArm(main);
  const armR = makeArm(main);
  const handL = makePaw();
  const handR = makePaw();
  handL.rotation.y = HAND_SPLAY;   // fingers splay outward, like in your drawing
  handR.rotation.y = -HAND_SPLAY;
  g.add(armL, armR, handL, handR);

  scene.add(g);
  // The monkey faces +z, so its LEFT side is +x.
  return {
    group: g, headG, face, scared: false, armL, armR, handL, handR, main,
    shoulderL: new THREE.Vector3(0.28, 1.0, 0.02),
    shoulderR: new THREE.Vector3(-0.28, 1.0, 0.02),
  };
}

function setPlushieColor(pl, hex, infected) {
  pl.main.color.set(infected ? INFECTED_COLOR : hex);
  pl.main.emissive.set(infected ? 0x661100 : 0x000000);
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
  arm.children[0].scale.set(ARM_R, len, ARM_R);
  arm.children[1].scale.set(ARM_R + HULL_T, len + 2 * HULL_T, ARM_R + HULL_T);
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

  // 1) Which hands are touching something, and how far did they move?
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
      if (!h.touching) buzz(h);
    }
    h.touching = hit;
    h.prevLocal.copy(local);
    h.hasPrev = true;
  }

  const touching = count > 0;

  // 2) Move the body
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
      // Just let go: launch with the average recent push velocity
      velocity.set(0, 0, 0);
      for (const v of history) velocity.add(v);
      velocity.divideScalar(history.length).multiplyScalar(CFG.velocityScale);
      if (velocity.length() > CFG.maxSpeed) velocity.setLength(CFG.maxSpeed);
      history.length = 0;
    }
    velocity.y = Math.max(velocity.y - CFG.gravity * dt, -25);
    rig.position.addScaledVector(velocity, dt);
  }
  wasTouching = touching;
  rig.updateMatrixWorld(true);

  // 3) Push out of anything the hands, head, chest or feet sank into
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

  // 4) Keep the player inside the map
  const lim = CFG.worldHalfSize - 1;
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, -lim, lim);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, -lim, lim);
  rig.updateMatrixWorld(true);

  // 5) Place the hand markers (the paw models follow these)
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

function handleInput() {
  let stickX = 0;
  let resetPressed = false;
  let colorPressed = false;
  for (const h of hands) {
    const gp = h.source && h.source.gamepad;
    if (!gp) continue;
    if (h.source.handedness === 'right' && gp.axes.length >= 4) stickX = gp.axes[2];
    if (gp.buttons[5] && gp.buttons[5].pressed) resetPressed = true;
    if (gp.buttons[4] && gp.buttons[4].pressed) colorPressed = true;
  }

  if (Math.abs(stickX) > 0.7 && !turnLatch) {
    turnLatch = true;
    const angle = -Math.sign(stickX) * THREE.MathUtils.degToRad(CFG.snapTurnDeg);
    // rotate around the player's head so the view turns in place
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
}

/* ================================================================== */
/*  INFECTION GAME MODE                                                */
/* ================================================================== */

/* ---------- Entities: you + bots ---------- */
const BOT_TAG_Y = [0.15, 0.65, 1.3]; // heights of a bot's tag spheres (model units)
const BOT_NAMES = ['Waffles', 'Pickle', 'Noodle', 'Biscuit', 'Muffin', 'Turnip', 'Pancake', 'Doodle', 'Nugget'];

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

/* ---------- Floating name tags (they bob, pop and shake) ---------- */
function drawNameTag(tag, infected) {
  if (tag.infected === infected) return;
  tag.infected = infected;
  tag.popT = 0; // trigger the pop animation
  const c = tag.ctx;
  c.clearRect(0, 0, 512, 128);
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.fillRect(20, 14, 472, 100);
  c.font = 'bold 72px system-ui, sans-serif';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.lineJoin = 'round';
  c.lineWidth = 14;
  c.strokeStyle = 'rgba(0,0,0,0.9)';
  c.strokeText(tag.text, 256, 66);
  c.fillStyle = infected ? '#ff3b30' : '#ffffff';
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
  };
}

const bots = Array.from({ length: CFG.botCount }, (_, i) => makeBot(i));
const entities = [player, ...bots];

/* ---------- Your monkey body + the color-station statue ---------- */
const playerAvatar = makePlushie(PALETTE[playerColorIdx].hex);
playerAvatar.headG.visible = false; // you can't see your own head (it would block your view)
playerAvatar.handL.visible = false; // your real paws are the hand models below
playerAvatar.handR.visible = false;
playerAvatar.group.visible = false;

// the visible paws that follow your controllers
for (const h of hands) {
  h.model = makePaw();
  h.model.visible = h.active;
  scene.add(h.model);
}

const statue = makePlushie(PALETTE[playerColorIdx].hex);
statue.group.position.set(STATION.x, 0.5, STATION.z);
statue.handL.position.set(0.42, 0.09, 0.08);
statue.handR.position.set(-0.42, 0.09, 0.08);
setArm(statue.armL, statue.shoulderL, statue.handL.position);
setArm(statue.armR, statue.shoulderR, statue.handR.position);
let statueT = 0;

/* ---------- Game state ---------- */
let state = 'idle'; // 'idle' | 'running' | 'intermission'
let round = 0;
let timer = 0;          // intermission countdown
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
  try { localStorage.setItem('monkeColor', String(idx)); } catch (_) { /* optional */ }
  applyPlayerVisual();
  if (announce) flash(`Color: ${PALETTE[idx].name}`, '#ffffff', 1.2);
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

  // knuckle-walking: hands alternate, lifting while they swing forward
  const pl = bot.pl;
  const s = Math.sin(bot.phase), c = Math.cos(bot.phase);
  _bA.set(0.42, 0.09 + Math.max(0, c) * 0.3 * amount, 0.08 + s * 0.5 * amount);
  pl.handL.position.copy(_bA);
  setArm(pl.armL, pl.shoulderL, _bA);
  _bA.set(-0.42, 0.09 + Math.max(0, -c) * 0.3 * amount, 0.08 - s * 0.5 * amount);
  pl.handR.position.copy(_bA);
  setArm(pl.armR, pl.shoulderR, _bA);

  bot.group.position.set(bot.pos.x, Math.abs(s) * 0.05 * amount * botScale, bot.pos.z);
  bot.group.rotation.y = bot.facing;
  // freshly infected / waiting bots pulse so you can see they're about to go
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
    t.sprite.position.set(bot.pos.x, 2.15 * botScale + bob, bot.pos.z);
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
  const back = 0.12; // body sits slightly behind and below your head so it stays out of your view
  const gx = _g0.x - Math.sin(avatarYaw) * back;
  const gy = _g0.y - EYE_M * sc - 0.1;
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
      h.model.rotation.y = avatarYaw + (isLeft ? HAND_SPLAY : -HAND_SPLAY);
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
  const spawns = pickSpawns(entities.length);

  entities.forEach((e, i) => {
    e.infected = false;
    e.stun = 0;
    if (e.isPlayer) teleportPlayer(spawns[i].x, spawns[i].y);
    else placeBot(e, spawns[i]);
  });

  // pick the first infected at random (could be you!)
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
}

function infect(victim, by) {
  if (victim.infected) return;
  victim.infected = true;
  victim.target = null;
  victim.stun = victim.isPlayer ? 0 : CFG.infectStun;
  setVisual(victim);

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
    // Infected: run at the nearest healthy player, leading the target a little
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
    // Healthy: run away from infected players
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
      // slow random weaving so they aren't perfectly predictable
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
    // Nobody to chase or flee from: wander
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

  // Keep non-chasers away from the map edge so they can't be cornered too easily
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

  // go around trees and structures (but dive straight in when almost touching the target)
  if (!closeToTarget) {
    steer(bot, ux, uz);
    ux = _st.x;
    uz = _st.z;
  }

  // smooth steering
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

  // accelerate toward the wanted velocity (so they can't turn on a dime)
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

  // track your position + velocity so bots can chase / dodge you
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
    } catch (err) {
      // No console in the headset, so show the error on the HUD instead
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
