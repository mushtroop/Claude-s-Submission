import * as THREE from 'three';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/* ------------------------------------------------------------------ */
/*  Tuning - tweak these to change how the movement feels              */
/* ------------------------------------------------------------------ */
const CFG = {
  handRadius: 0.07,      // size of the hand collision sphere (m)
  skin: 0.003,           // tiny buffer so resting hands don't flicker
  gravity: 9.8,          // m/s^2
  velocityScale: 1.1,    // launch strength on release (like gtag's jump multiplier)
  maxSpeed: 7,           // max launch speed (m/s)
  historyFrames: 6,      // frames averaged to get release velocity
  worldHalfSize: 30,     // baseplate is 60 x 60 m
  snapTurnDeg: 45,       // right thumbstick snap turn
  headMinHeight: 0.2,    // head can't go below this height
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

// Decorative pillars around the edge so you can feel your speed.
// (Not collidable yet - that's the next step.)
const pillarColors = [0xff5e5e, 0xffb84d, 0xfff25e, 0x6bff6b, 0x5ec8ff, 0xa97bff];
for (let i = 0; i < 12; i++) {
  const a = (i / 12) * Math.PI * 2;
  const pillar = new THREE.Mesh(
    new THREE.CylinderGeometry(0.6, 0.6, 8, 16),
    new THREE.MeshLambertMaterial({ color: pillarColors[i % pillarColors.length] })
  );
  pillar.position.set(Math.cos(a) * 24, 4, Math.sin(a) * 24);
  scene.add(pillar);
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
    mesh.material.color.set(e.data.handedness === 'left' ? 0xff7a3d : 0x3da5ff);
  });
  controller.addEventListener('disconnected', () => {
    hand.source = null;
    hand.active = false;
    mesh.visible = false;
  });
  return hand;
});

function buzz(hand) {
  const gp = hand.source && hand.source.gamepad;
  if (!gp) return;
  try {
    if (gp.hapticActuators && gp.hapticActuators[0]) gp.hapticActuators[0].pulse(0.4, 40);
    else if (gp.vibrationActuator) gp.vibrationActuator.playEffect('dual-rumble', { duration: 40, strongMagnitude: 0.4, weakMagnitude: 0.4 });
  } catch (_) { /* haptics are optional */ }
}

/* ------------------------------------------------------------------ */
/*  Gorilla Tag style locomotion                                       */
/*                                                                     */
/*  - A hand "touches" when its sphere dips into the ground.           */
/*  - While touching, the body moves opposite to the hand's motion     */
/*    (so you push yourself along).                                    */
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

function resetPlayer() {
  rig.position.set(0, 0, 0);
  rig.rotation.set(0, 0, 0);
  velocity.set(0, 0, 0);
  history.length = 0;
  wasTouching = false;
}

/* ------------------------------------------------------------------ */
/*  Main loop                                                          */
/* ------------------------------------------------------------------ */
renderer.xr.addEventListener('sessionstart', () => {
  resetPlayer();
  const info = document.getElementById('info');
  if (info) info.style.display = 'none';
});
renderer.xr.addEventListener('sessionend', () => {
  const info = document.getElementById('info');
  if (info) info.style.display = '';
});

const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = THREE.MathUtils.clamp(clock.getDelta(), 1 / 240, 0.05);
  if (renderer.xr.isPresenting) {
    handleInput();
    updateLocomotion(dt);
  }
  renderer.render(scene, camera);
});

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});
