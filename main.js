import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

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
  worldHalfSize: 30,     // baseplate is 60 x 60 m
  snapTurnDeg: 45,       // right thumbstick snap turn
  headMinHeight: 0.2,    // head can't go below this height

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
scene.fog = new THREE.Fog(0x87c8ff, 25, 80);

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
/*  Baseplate                                                          */
/* ------------------------------------------------------------------ */
function makeGridTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#5a9e5a';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#3f7a3f';
  g.lineWidth = 4;
  g.strokeRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(CFG.worldHalfSize, CFG.worldHalfSize); // 2 m tiles
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

const baseplate = new THREE.Mesh(
  new THREE.PlaneGeometry(CFG.worldHalfSize * 2, CFG.worldHalfSize * 2),
  new THREE.MeshLambertMaterial({ map: makeGridTexture() })
);
baseplate.rotation.x = -Math.PI / 2;
scene.add(baseplate);

// Decorative pillars. Bots steer around them; the player can still pass through (for now).
const pillarColors = [0xff5e5e, 0xffb84d, 0xfff25e, 0x6bff6b, 0x5ec8ff, 0xa97bff];
const pillarSpots = [];
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  const px = Math.cos(a) * 24;
  const pz = Math.sin(a) * 24;
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 8, 16),
    new THREE.MeshLambertMaterial({ color: pillarColors[i % pillarColors.length] })
  );
  pillar.position.set(px, 4, pz);
  scene.add(pillar);
  pillarSpots.push([px, pz]);
}

/* ------------------------------------------------------------------ */
/*  Hands                                                              */
/* ------------------------------------------------------------------ */
const SAFE_HAND_COLORS = { left: 0x4dffb0, right: 0x4dc8ff };
const INFECTED_COLOR = 0xff3b1f;

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
    baseColor: 0xcccccc,
    prevLocal: new THREE.Vector3(),
  };

  controller.addEventListener('connected', (e) => {
    hand.source = e.data;
    hand.active = true;
    hand.hasPrev = false;
    mesh.visible = true;
    hand.baseColor = e.data.handedness === 'left' ? SAFE_HAND_COLORS.left : SAFE_HAND_COLORS.right;
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
// Red tint sphere around your head while you're infected
const tint = new THREE.Mesh(
  new THREE.SphereGeometry(0.35, 16, 12),
  new THREE.MeshBasicMaterial({
    color: 0xff2200, transparent: true, opacity: 0, side: THREE.BackSide,
    depthTest: false, depthWrite: false, fog: false,
  })
);
tint.renderOrder = 997;
camera.add(tint);

// HUD: big message on top, status line on the bottom
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
/*  Gorilla Tag style locomotion                                       */
/*                                                                     */
/*  - A hand "touches" when its sphere dips into the ground.           */
/*  - While touching, the body moves opposite to the hand's motion     */
/*  - Letting go launches you with the averaged push velocity.         */
/*  - Otherwise you're in free-fall under gravity.                     */
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

function updateLocomotion(dt) {
  rig.updateMatrixWorld(true);
  const R = CFG.handRadius;

  // 1) Which hands are touching the ground, and how far did they move?
  _move.set(0, 0, 0);
  let count = 0;
  for (const h of hands) {
    if (!h.active) continue;
    const local = h.grip.position; // position in tracking space (relative to rig)
    worldOf(local, _v);
    const hit = _v.y < R + CFG.skin;
    if (hit) {
      if (h.hasPrev) {
        _d.copy(local).sub(h.prevLocal).applyQuaternion(rig.quaternion);
        _move.sub(_d); // move opposite to the hand
      }
      count++;
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
    velocity.set(0, 0, 0);
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

  // 3) Push the rig up if a hand ended up inside the ground
  let push = 0;
  for (const h of hands) {
    if (!h.active) continue;
    worldOf(h.grip.position, _v);
    push = Math.max(push, R - _v.y);
  }
  if (push > 0) {
    rig.position.y += push;
    rig.updateMatrixWorld(true);
  }

  // 4) Keep the head above the floor
  worldOf(camera.position, _v);
  if (_v.y < CFG.headMinHeight) {
    rig.position.y += CFG.headMinHeight - _v.y;
    if (velocity.y < 0) velocity.y = 0;
    rig.updateMatrixWorld(true);
  }

  // 5) Keep the player on the baseplate
  const lim = CFG.worldHalfSize - 1;
  rig.position.x = THREE.MathUtils.clamp(rig.position.x, -lim, lim);
  rig.position.z = THREE.MathUtils.clamp(rig.position.z, -lim, lim);
  rig.updateMatrixWorld(true);

  // 6) Place the visible hand spheres (they rest on the ground instead of sinking in)
  for (const h of hands) {
    if (!h.active) continue;
    worldOf(h.grip.position, _v);
    h.mesh.position.set(_v.x, Math.max(_v.y, R), _v.z);
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
  teleportPlayer(0, 0);
}

/* ------------------------------------------------------------------ */
/*  Extras: snap turn (right stick) and reset (B / Y button)           */
/* ------------------------------------------------------------------ */
let turnLatch = false;
let resetLatch = false;

function handleInput() {
  let stickX = 0;
  let resetPressed = false;
  for (const h of hands) {
    const gp = h.source && h.source.gamepad;
    if (!gp) continue;
    if (h.source.handedness === 'right' && gp.axes.length >= 4) stickX = gp.axes[2];
    if (gp.buttons[5] && gp.buttons[5].pressed) resetPressed = true;
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
}

/* ================================================================== */
/*  INFECTION GAME MODE                                                */
/* ================================================================== */

/* ---------- Entities: you + bots ---------- */
const BOT_LIM = CFG.worldHalfSize - 1.5; // bots stay inside this square
const BOT_TAG_Y = [0.35, 0.8, 1.25];     // heights of a bot's tag spheres
const BOT_COLORS = [0x4da6ff, 0x6bff6b, 0xa97bff, 0xfff25e, 0x2fe0c8, 0xff7ad9, 0x9bd1ff, 0xb6ff3d, 0xc29bff];

const player = {
  name: 'You',
  isPlayer: true,
  infected: false,
  stun: 0,
  pos: new THREE.Vector3(), // head position projected on the ground
  vel: new THREE.Vector3(),
  hasPrev: false,
};

// shared bot geometry
const botGeo = {
  body: new THREE.SphereGeometry(0.3, 20, 14),
  head: new THREE.SphereGeometry(0.18, 16, 12),
  hand: new THREE.SphereGeometry(0.08, 12, 10),
  eye: new THREE.SphereGeometry(0.04, 8, 6),
  pupil: new THREE.SphereGeometry(0.02, 6, 4),
};
const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
const pupilMat = new THREE.MeshBasicMaterial({ color: 0x111111 });

function makeBot(i) {
  const group = new THREE.Group();
  const baseColor = BOT_COLORS[i % BOT_COLORS.length];
  const mat = new THREE.MeshLambertMaterial({ color: baseColor });

  const body = new THREE.Mesh(botGeo.body, mat);
  body.scale.set(1, 1.25, 0.9);
  body.position.y = 0.75;
  const head = new THREE.Mesh(botGeo.head, mat);
  head.position.set(0, 1.28, 0.05);
  const handL = new THREE.Mesh(botGeo.hand, mat);
  const handR = new THREE.Mesh(botGeo.hand, mat);

  group.add(body, head, handL, handR);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(botGeo.eye, eyeMat);
    eye.position.set(sx * 0.07, 1.31, 0.2);
    const pupil = new THREE.Mesh(botGeo.pupil, pupilMat);
    pupil.position.set(sx * 0.07, 1.31, 0.235);
    group.add(eye, pupil);
  }
  scene.add(group);

  return {
    name: `Bot ${i + 1}`,
    isPlayer: false,
    infected: false,
    stun: 0,
    pos: new THREE.Vector3(),
    vel: new THREE.Vector3(),
    dir: { x: 0, z: 1 },
    want: { x: 0, z: 0 },
    facing: 0,
    phase: Math.random() * 6,
    group, mat, body, head, handL, handR, baseColor,
    target: null,
    retargetT: 0,
    wanderT: 0,
    wanderA: Math.random() * Math.PI * 2,
    jitter: 0,
    jitterT: 0,
  };
}

const bots = Array.from({ length: CFG.botCount }, (_, i) => makeBot(i));
const entities = [player, ...bots];

/* ---------- Game state ---------- */
let state = 'idle'; // 'idle' | 'running' | 'intermission'
let round = 0;
let timer = 0;
let lastSurvivor = '-';
let flashText = '';
let flashColor = '#ffffff';
let flashT = 0;

const _head = new THREE.Vector3();
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
  for (const h of hands) {
    h.mesh.material.color.set(player.infected ? INFECTED_COLOR : h.baseColor);
    h.mesh.material.emissive.set(player.infected ? 0x661100 : 0x000000);
  }
  tint.material.opacity = player.infected && renderer.xr.isPresenting ? 0.18 : 0;
}

function setVisual(e) {
  if (e.isPlayer) {
    applyPlayerVisual();
  } else {
    e.mat.color.set(e.infected ? INFECTED_COLOR : e.baseColor);
    e.mat.emissive.set(e.infected ? 0x661100 : 0x000000);
  }
}

function lerpAngle(from, to, k) {
  const d = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + d * k;
}

function animateBot(bot, dt) {
  const speed = Math.hypot(bot.vel.x, bot.vel.z);
  const amount = Math.min(speed / 3, 1);
  bot.phase += speed * dt * 2.0;

  if (speed > 0.3) bot.facing = lerpAngle(bot.facing, Math.atan2(bot.vel.x, bot.vel.z), 1 - Math.exp(-10 * dt));

  const swing = Math.sin(bot.phase);
  const bob = Math.abs(Math.sin(bot.phase)) * 0.06 * amount;
  bot.handL.position.set(-0.42, 0.1 + Math.max(0, swing) * 0.18 * amount, swing * 0.4 * amount);
  bot.handR.position.set(0.42, 0.1 + Math.max(0, -swing) * 0.18 * amount, -swing * 0.4 * amount);
  bot.body.position.y = 0.75 + bob;
  bot.head.position.y = 1.28 + bob;

  bot.group.position.set(bot.pos.x, 0, bot.pos.z);
  bot.group.rotation.y = bot.facing;
  // freshly infected / waiting bots pulse so you can see they're about to go
  const pulse = bot.stun > 0 ? 1 + 0.05 * Math.sin(performance.now() / 60) : 1;
  bot.group.scale.setScalar(pulse);
}

/* ---------- Spawning ---------- */
// Picks well-spread random points on a disc (best-candidate sampling)
function pickSpawns(n) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    let best = null;
    let bestD = -1;
    for (let t = 0; t < 30; t++) {
      const r = 20 * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      const p = new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
      let d = Infinity;
      for (const q of pts) d = Math.min(d, p.distanceTo(q));
      if (d > bestD) { bestD = d; best = p; }
      if (d > 7) break;
    }
    pts.push(best);
  }
  return pts;
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
      const dy = p.y - y;
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
  const btd2 = CFG.botTagDistance * CFG.botTagDistance;
  for (const a of entities) {
    if (state !== 'running') return;
    if (!a.infected || a.stun > 0) continue;
    for (const b of entities) {
      if (b === a || b.infected) continue;
      let hit = false;
      if (a.isPlayer) {
        hit = touchesBot(b, playerPts, CFG.tagRadius);
      } else if (b.isPlayer) {
        hit = touchesBot(a, playerPts, CFG.tagRadius);
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

function thinkBot(bot, dt) {
  const active = state === 'running';
  const chasing = active && bot.infected;
  let ux = 0;
  let uz = 0;
  let speed = 0;

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
      const lead = Math.min(Math.hypot(dx, dz) / sp, 0.7);
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

  // Keep non-chasers away from the walls so they can't be cornered too easily
  if (!chasing) {
    const m = 7;
    const edge = BOT_LIM - m;
    const ax = Math.abs(bot.pos.x);
    const az = Math.abs(bot.pos.z);
    if (ax > edge) ux -= Math.sign(bot.pos.x) * ((ax - edge) / m) * 2.5;
    if (az > edge) uz -= Math.sign(bot.pos.z) * ((az - edge) / m) * 2.5;
    // never run straight into a wall: slide along it instead
    if (ax > BOT_LIM - 1.5 && Math.sign(bot.pos.x) * ux > 0) ux = 0;
    if (az > BOT_LIM - 1.5 && Math.sign(bot.pos.z) * uz > 0) uz = 0;
    l = Math.hypot(ux, uz);
    if (l > 1e-4) {
      ux /= l;
      uz /= l;
    } else {
      ux = -bot.pos.z;
      uz = bot.pos.x;
      l = Math.hypot(ux, uz) || 1;
      ux /= l;
      uz /= l;
    }
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

  bot.pos.x = THREE.MathUtils.clamp(bot.pos.x + bot.vel.x * dt, -BOT_LIM, BOT_LIM);
  bot.pos.z = THREE.MathUtils.clamp(bot.pos.z + bot.vel.z * dt, -BOT_LIM, BOT_LIM);

  // slide around the decorative pillars
  for (const [px, pz] of pillarSpots) {
    const dx = bot.pos.x - px;
    const dz = bot.pos.z - pz;
    const d = Math.hypot(dx, dz);
    if (d < 0.95 && d > 1e-4) {
      bot.pos.x += (dx / d) * (0.95 - d);
      bot.pos.z += (dz / d) * (0.95 - d);
    }
  }
}

function separateBots() {
  for (let i = 0; i < bots.length; i++) {
    for (let j = i + 1; j < bots.length; j++) {
      const a = bots[i];
      const b = bots[j];
      const dx = a.pos.x - b.pos.x;
      const dz = a.pos.z - b.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.6 && d > 1e-4) {
        const push = (0.6 - d) / 2;
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
  hud.visible = true;
  hudKey = '';
  startRound();
  const info = document.getElementById('info');
  if (info) info.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  state = 'idle';
  hud.visible = false;
  tint.material.opacity = 0;
  const info = document.getElementById('info');
  if (info) info.style.display = '';
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = THREE.MathUtils.clamp(clock.getDelta(), 1 / 240, 0.05);
  if (renderer.xr.isPresenting) {
    handleInput();
    updateLocomotion(dt);
    updateGame(dt);
  }
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
