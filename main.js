import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
  standOnFeet: true,     // true = you stand at your real height (like real Gorilla Tag).
                         // false = old behaviour: you sink until your hands touch the ground
  feetRadius: 0.18,      // size of the invisible "feet" that hold you up

  // --- infection game ---
  botCount: 9,           // AI bots (you + 9 = 10 players)
  botSpeed: 5.5,         // m/s, about 20 km/h: an average adult's sprint
  infectedBoost: 1.08,   // infected bots get +8% speed (like real Gorilla Tag)
  botAccel: 28,          // how fast bots speed up / slow down (m/s^2)
  botTurnRate: 9,        // how quickly bots change direction
  botWanderSpeed: 2.2,   // jog speed when nobody is threatening them
  fleeRange: 16,         // bots notice infected players within this distance (m)
  tagRadius: 0.5,        // reach for tags involving you (m)
  botTagDistance: 0.8,   // bot-to-bot tag distance (m)
  startGrace: 3,         // seconds the first infected bot stands still
  infectStun: 0.6,       // seconds a freshly infected bot freezes
  intermission: 6,       // seconds between rounds
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

// Plushie color choices (red is reserved for "infected")
const PALETTE = [
  { name: 'Pink', hex: 0xff8fc7 }, { name: 'Orange', hex: 0xffa24d },
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
  const m = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), lambert(color));
  m.position.set(cx, cy, cz);
  m.rotation.y = yaw;
  scene.add(m);
  addBoxCollider(cx, cy, cz, sx, sy, sz, yaw);
}

function addPost(cx, cz, R, y0, y1, color, seg = 12) {
  const h = y1 - y0;
  const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R, h, seg), lambert(color));
  m.position.set(cx, y0 + h / 2, cz);
  scene.add(m);
  addCylCollider(cx, cz, R, y0, y1);
}

function addStump(cx, cz, R, h) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(R, R * 1.12, h, 16), lambert(0x8a5a33));
  m.position.set(cx, h / 2, cz);
  scene.add(m);
  addCylCollider(cx, cz, R, 0, h);
}

function addRock(cx, cz, R, h) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.8, R, h, 7), lambert(0x8d9199, true));
  m.position.set(cx, h / 2, cz);
  scene.add(m);
  addCylCollider(cx, cz, R, 0, h);
}

function addMushroom(cx, cz, stemH) {
  addPost(cx, cz, 0.22, 0, stemH, 0xe8dcc0, 10);
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.0, 0.3, 16), lambert(0xd9443a));
  cap.position.set(cx, stemH + 0.15, cz);
  scene.add(cap);
  addCylCollider(cx, cz, 1.0, stemH, stemH + 0.3);
}

function addFoliage(x, yBase, z, r, h, color) {
  const m = new THREE.Mesh(new THREE.ConeGeometry(r, h, 9), lambert(color, true));
  m.position.set(x, yBase + h / 2, z);
  scene.add(m);
}

function addDisc(x, z, r, color) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40), lambert(color));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, 0.015, z);
  scene.add(m);
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
  if (c.t === 0 && c.minY < 1.9 && c.maxY > 0.4) blockers.push({ k: 1, x: c.cx, z: c.cz, hx: c.hx, hz: c.hz, c: c.c, s: c.s });
  if (c.t === 1 && c.y0 < 1.9 && c.y1 > 0.4) blockers.push({ k: 0, x: c.cx, z: c.cz, r: c.R });
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
    prevLocal: new THREE.Vector3(),
  };

  controller.addEventListener('connected', (e) => {
    hand.source = e.data;
    hand.active = true;
    hand.hasPrev = false;
    mesh.visible = true;
    applyPlayerVisual();
  });
  controller.addEventListener('disconnected', () => {
    hand.source = null;
    hand.active = false;
    mesh.visible = false;
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
/*  Plushie model (a teddy bear) - used by you, the bots and the statue */
/* ------------------------------------------------------------------ */
const E0 = 1.55; // eye (head centre) height of the plushie model, in model units

function shapeGeo(base, x, y, z, sx, sy, sz) {
  const g = base.clone();
  g.scale(sx, sy, sz);
  g.translate(x, y, z);
  return g;
}

const PL = (() => {
  const sph = new THREE.SphereGeometry(1, 20, 14);
  const cyl = new THREE.CylinderGeometry(1, 1, 1, 12);
  const S = (x, y, z, sx, sy, sz) => shapeGeo(sph, x, y, z, sx, sy, sz);
  return {
    sph, cyl,
    torso: S(0, 1.0, 0, 0.30, 0.36, 0.26),
    bodyAccent: mergeGeometries([S(0, 0.98, 0.14, 0.2, 0.24, 0.14), S(0, 0.82, -0.27, 0.09, 0.09, 0.09)]), // belly + tail
    headMain: mergeGeometries([S(0, 0, 0, 0.23, 0.21, 0.22), S(-0.15, 0.18, -0.02, 0.085, 0.085, 0.05), S(0.15, 0.18, -0.02, 0.085, 0.085, 0.05)]),
    headAccent: mergeGeometries([S(-0.15, 0.18, 0.012, 0.05, 0.05, 0.03), S(0.15, 0.18, 0.012, 0.05, 0.05, 0.03), S(0, -0.05, 0.17, 0.1, 0.075, 0.08)]),
    headDark: mergeGeometries([S(-0.085, 0.04, 0.205, 0.03, 0.035, 0.03), S(0.085, 0.04, 0.205, 0.03, 0.035, 0.03), S(0, -0.02, 0.245, 0.032, 0.025, 0.025)]),
    leg: mergeGeometries([shapeGeo(cyl, 0, -0.27, 0, 0.12, 0.54, 0.12), S(0, -0.58, 0.05, 0.14, 0.13, 0.19)]),
  };
})();
const darkMat = new THREE.MeshLambertMaterial({ color: 0x1a1a1f });

function makePlushie(hex) {
  const main = new THREE.MeshLambertMaterial({ color: hex });
  const accent = new THREE.MeshLambertMaterial({ color: hex });
  const g = new THREE.Group();
  const add = (geo, mat, parent) => { const m = new THREE.Mesh(geo, mat); parent.add(m); return m; };

  add(PL.torso, main, g);
  add(PL.bodyAccent, accent, g);

  const headG = new THREE.Group();
  headG.position.set(0, E0, 0);
  g.add(headG);
  // head geometry was modelled around (0,0,0), so it sits at the head pivot
  add(PL.headMain, main, headG);
  add(PL.headAccent, accent, headG);
  add(PL.headDark, darkMat, headG);

  const legs = [-1, 1].map((sx) => {
    const pivot = new THREE.Group();
    pivot.position.set(sx * 0.16, 0.72, 0.02);
    g.add(pivot);
    add(PL.leg, main, pivot);
    return pivot;
  });

  // stretchy stuffed arms: a cylinder (stretched every frame) + a round paw
  const armL = add(PL.cyl, main, g);
  const armR = add(PL.cyl, main, g);
  const pawL = add(shapeGeo(PL.sph, 0, 0, 0, 0.1, 0.1, 0.1), accent, g);
  const pawR = add(shapeGeo(PL.sph, 0, 0, 0, 0.1, 0.1, 0.1), accent, g);

  scene.add(g);
  return {
    group: g, headG, legL: legs[0], legR: legs[1], armL, armR, pawL, pawR, main, accent,
    shoulderL: new THREE.Vector3(-0.32, 1.2, 0),
    shoulderR: new THREE.Vector3(0.32, 1.2, 0),
  };
}

function setPlushieColor(pl, hex, infected) {
  const c = infected ? INFECTED_COLOR : hex;
  pl.main.color.set(c);
  pl.accent.color.set(c).lerp(WHITE, infected ? 0.25 : 0.5);
  const em = infected ? 0x661100 : 0x000000;
  pl.main.emissive.set(em);
  pl.accent.emissive.set(em);
}

const _ax = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
// stretch a unit cylinder so it runs from `from` to `to`
function setArm(mesh, from, to) {
  _ax.set(to.x - from.x, to.y - from.y, to.z - from.z);
  const len = _ax.length() || 0.001;
  mesh.position.set((from.x + to.x) / 2, (from.y + to.y) / 2, (from.z + to.z) / 2);
  mesh.scale.set(0.075, len, 0.075);
  _ax.divideScalar(len);
  mesh.quaternion.setFromUnitVectors(_up, _ax);
}

/* ------------------------------------------------------------------ */
/*  Gorilla Tag style locomotion (now works on every surface)          */
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

function updateLocomotion(dt) {
  rig.updateMatrixWorld(true);
  const R = CFG.handRadius;

  // 1) Which hands are touching something, and how far did they move?
  _move.set(0, 0, 0);
  let count = 0;
  let supported = false;
  for (const h of hands) {
    if (!h.active) continue;
    const local = h.grip.position; // position in tracking space (relative to rig)
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
      worldOf(h.grip.position, _v);
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

  // 5) Place the visible hand spheres
  for (const h of hands) {
    if (!h.active) continue;
    worldOf(h.grip.position, _v);
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
const BOT_TAG_Y = [0.35, 0.8, 1.25]; // heights of a bot's tag spheres (model units)
const BOT_NAMES = ['Waffles', 'Pickle', 'Noodle', 'Biscuit', 'Muffin', 'Turnip', 'Pancake', 'Doodle', 'Nugget'];

// Bots are scaled so their eye level matches yours
let eyeHeight = 1.6;
let eyeInit = false;
let botScale = (eyeHeight / E0) * CFG.botSizeBoost;

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

/* ---------- Your plushie body + the color-station statue ---------- */
const playerAvatar = makePlushie(PALETTE[playerColorIdx].hex);
playerAvatar.headG.visible = false; // you can't see your own head (it would block your view)
playerAvatar.pawL.visible = false;  // your real paws are the hand spheres
playerAvatar.pawR.visible = false;
playerAvatar.group.visible = false;

const statue = makePlushie(PALETTE[playerColorIdx].hex);
statue.group.position.set(STATION.x, 0.5, STATION.z);
statue.pawL.position.set(-0.42, 0.7, 0);
statue.pawR.position.set(0.42, 0.7, 0);
setArm(statue.armL, statue.shoulderL, statue.pawL.position);
setArm(statue.armR, statue.shoulderR, statue.pawR.position);

/* ---------- Game state ---------- */
let state = 'idle'; // 'idle' | 'running' | 'intermission'
let round = 0;
let timer = 0;
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
  for (const h of hands) {
    h.mesh.material.color.set(player.infected ? INFECTED_COLOR : hex);
    h.mesh.material.emissive.set(player.infected ? 0x661100 : 0x000000);
  }
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

  const pl = bot.pl;
  const swing = Math.sin(bot.phase);
  pl.legL.rotation.x = swing * 0.9 * amount;
  pl.legR.rotation.x = -swing * 0.9 * amount;

  const handY = 0.6 - 0.4 * amount;
  _bA.set(-0.45, handY + Math.max(0, -swing) * 0.2 * amount, -swing * 0.45 * amount);
  pl.pawL.position.copy(_bA);
  setArm(pl.armL, pl.shoulderL, _bA);
  _bA.set(0.45, handY + Math.max(0, swing) * 0.2 * amount, swing * 0.45 * amount);
  pl.pawR.position.copy(_bA);
  setArm(pl.armR, pl.shoulderR, _bA);

  bot.group.position.set(bot.pos.x, Math.abs(Math.sin(bot.phase)) * 0.06 * amount * botScale, bot.pos.z);
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
    t.sprite.position.set(bot.pos.x, (1.77 + 0.4) * botScale + bob, bot.pos.z);
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
  botScale = (eyeHeight / E0) * CFG.botSizeBoost;
}

function updateAvatar(dt) {
  _fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
  if (Math.hypot(_fwd.x, _fwd.z) > 0.3) avatarYawT = Math.atan2(_fwd.x, _fwd.z) + rig.rotation.y;
  avatarYaw = lerpAngle(avatarYaw, avatarYawT, 1 - Math.exp(-8 * dt));

  worldOf(camera.position, _g0);
  const sc = botScale;
  const back = 0.12; // body sits slightly behind and below your head so it stays out of your view
  const gx = _g0.x - Math.sin(avatarYaw) * back;
  const gy = _g0.y - E0 * sc - 0.1;
  const gz = _g0.z - Math.cos(avatarYaw) * back;
  const pl = playerAvatar;
  pl.group.position.set(gx, gy, gz);
  pl.group.rotation.y = avatarYaw;
  pl.group.scale.setScalar(sc);

  const cs = Math.cos(avatarYaw), sn = Math.sin(avatarYaw);
  pl.armL.visible = pl.armR.visible = false;
  for (const h of hands) {
    if (!h.active) continue;
    const isLeft = h.source && h.source.handedness === 'left';
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
    state = 'intermission';
    timer = CFG.intermission;
    lastSurvivor = victim.name;
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

/* ---------- Per-frame game update ---------- */
function updateHud() {
  let main = '';
  let color = '#ffffff';
  let sub;
  if (state === 'intermission') {
    main = "EVERYONE'S INFECTED!";
    color = '#ff5a3c';
    sub = `Last survivor: ${lastSurvivor}  |  New round in ${Math.ceil(timer)}`;
  } else {
    if (flashT > 0) { main = flashText; color = flashColor; }
    sub = `Round ${round}  |  Infected ${infectedCount()}/${entities.length}  |  ${player.infected ? 'YOU ARE INFECTED' : 'You are safe'}`;
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

  for (const bot of bots) {
    thinkBot(bot, dt);
    moveBot(bot, dt);
  }
  separateBots();
  for (const bot of bots) animateBot(bot, dt);

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
