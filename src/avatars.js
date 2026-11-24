import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

// Shared avatar construction: the three panel members are built here, and the candidate's
// character (character.js) reuses the same torso, face and hand helpers so everyone in the
// room shares one stylized look.

export const TABLE_TOP = 1.01;

// Avatars sit a little behind the table edge so their chests never cut into the wood.
export const AVATAR_Z = -0.35;
export const HIP_Y = 0.7;

export const LOOK_CANDIDATE = new THREE.Vector3(0, 1.8, 6);

// Per person looks. Skin, hair and outfit are what make the three read as different people.
export const LOOKS = {
  manager: {
    skin: 0xd9a27b,
    hair: 0x3a2416,
    jacket: 0xe8a33d,
    lapel: 0xc98526,
    shirt: 0xf6ecdc,
    outfit: "blazer",
  },
  tech: {
    skin: 0xa56d4c,
    hair: 0x1d1714,
    jacket: 0x5fa8d3,
    lapel: 0x3f7fa8,
    shirt: 0xeef3f6,
    outfit: "sweater",
  },
  skeptic: {
    skin: 0xe9b892,
    hair: 0x9a958e,
    jacket: 0xd9634a,
    lapel: 0xb24b34,
    shirt: 0xf4f1ea,
    outfit: "suit",
  },
};

export const MOOD_BROWS = {
  neutral: { lift: 0, tilt: 0 },
  impressed: { lift: 0.018, tilt: 0.05 },
  skeptical: { lift: 0, tilt: -0.18 },
  concerned: { lift: 0.008, tilt: 0.28 },
  amused: { lift: 0.012, tilt: 0.08 },
};

// A soft dark blob texture, used as fake contact shadows where things touch the table.
let blobTex = null;
function blobTexture() {
  if (blobTex) {
    return blobTex;
  }
  const c = document.createElement("canvas");
  c.width = 128;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, "rgba(0,0,0,1)");
  grad.addColorStop(0.5, "rgba(0,0,0,0.5)");
  grad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

export function contactShadow(w, d, opacity) {
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshBasicMaterial({
      map: blobTexture(),
      transparent: true,
      opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

// ---------- avatars ----------

// Torso silhouette as a lathe profile: hips, a soft waist, a chest, then rounded shoulders.
const TORSO_PROFILE = [
  [0.0, 0.0],
  [0.24, 0.0],
  [0.285, 0.06],
  [0.29, 0.25],
  [0.3, 0.45],
  [0.325, 0.62],
  [0.345, 0.74],
  [0.33, 0.83],
  [0.26, 0.9],
  [0.13, 0.94],
  [0.0, 0.95],
];
export const TORSO_DEPTH = 0.66;

const torsoCurve = new THREE.SplineCurve(TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
export const torsoPoints = torsoCurve.getPoints(40);

// Radius of the torso at a height, so clothing details can be laid onto its surface.
function torsoRadius(y) {
  for (let i = 1; i < torsoPoints.length; i++) {
    const a = torsoPoints[i - 1];
    const b = torsoPoints[i];
    if ((a.y <= y && y <= b.y) || (b.y <= y && y <= a.y)) {
      const k = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
      return a.x + (b.x - a.x) * k;
    }
  }
  return 0;
}

export function torsoFrontZ(x, y, lift) {
  const r = torsoRadius(y);
  return Math.sqrt(Math.max(0, r * r - x * x)) * TORSO_DEPTH + lift;
}

// A strip that hugs the chest: for t in 0..1 from top to bottom, edge(t) gives { y, left, right }.
export function chestPatch(edge, lift, mat) {
  const rows = 14;
  const cols = 6;
  const pos = [];
  const idx = [];
  for (let i = 0; i <= rows; i++) {
    const e = edge(i / rows);
    for (let j = 0; j <= cols; j++) {
      const x = e.left + ((e.right - e.left) * j) / cols;
      pos.push(x, e.y, torsoFrontZ(x, e.y, lift));
    }
  }
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const a = i * (cols + 1) + j;
      const b = a + cols + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}

// Head is a slightly tall ellipsoid; features are placed on its surface with this.
export const HEAD_R = 0.27;
export const HEAD_SCALE = new THREE.Vector3(0.97, 1.06, 0.95);

export function onHead(x, y, out = new THREE.Vector3(), lift = 0) {
  const a = HEAD_R * HEAD_SCALE.x;
  const b = HEAD_R * HEAD_SCALE.y;
  const c = HEAD_R * HEAD_SCALE.z;
  const k = 1 - (x / a) ** 2 - (y / b) ** 2;
  return out.set(x, y, c * Math.sqrt(Math.max(0, k)) + lift);
}

export function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
}

export function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

export function makeAvatar(scene, id, p) {
  const look = LOOKS[id];
  const g = new THREE.Group();
  g.position.set(p.x, 0, AVATAR_Z);

  const skin = std(look.skin, { roughness: 0.55 });
  // the jacket glows in the speaker's color while they talk
  const cloth = new THREE.MeshStandardMaterial({
    color: p.color,
    roughness: 0.7,
    emissive: p.color,
    emissiveIntensity: 0,
  });
  const lapelMat = std(look.lapel, { roughness: 0.7 });
  const shirtMat = std(look.shirt, { roughness: 0.8 });
  const hairMat = std(look.hair, { roughness: 0.75 });
  const darkMat = std(0x1a1412, { roughness: 0.4 });

  const chair = buildChair();
  chair.position.z = -0.01;
  g.add(chair);

  // Everything above the hips leans together, pivoting at the seat.
  const body = new THREE.Group();
  body.position.y = HIP_Y;
  g.add(body);

  const torso = shadowed(new THREE.Mesh(new THREE.LatheGeometry(torsoPoints, 40), cloth));
  torso.geometry.scale(1, 1, TORSO_DEPTH);
  body.add(torso);

  buildOutfit(body, look, { cloth, lapelMat, shirtMat });

  const neck = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.26, 20), skin));
  neck.position.y = 1.0;
  body.add(neck);

  const head = new THREE.Group();
  head.position.y = 1.27;
  // yaw first, then pitch, so looking down while turned stays natural
  head.rotation.order = "YXZ";
  body.add(head);

  const face = buildFace(head, PANEL_FACES[id], { skin, hairMat, darkMat });
  buildHair(head, id, hairMat);

  // Arms are built in the avatar's space and solved every frame from shoulder to wrist,
  // so lean, gestures and the wave all keep elbows and hands attached.
  const arms = [];
  for (const side of [-1, 1]) {
    arms.push(buildArm(g, side, { cloth, skin, shirtMat }));
  }

  // where each hand rests on the table, in avatar space
  const rest = {
    manager: [new THREE.Vector3(-0.27, 0, 0.78), new THREE.Vector3(0.24, 0, 0.74)],
    tech: [new THREE.Vector3(-0.22, 0, 0.64), new THREE.Vector3(0.22, 0, 0.64)],
    skeptic: [new THREE.Vector3(-0.26, 0, 0.74), new THREE.Vector3(0.28, 0, 0.78)],
  }[id];
  arms.forEach((arm, i) => {
    arm.rest.copy(rest[i]);
    arm.rest.y = TABLE_TOP + 0.052;
    arm.wrist.copy(arm.rest);
  });

  buildProps(g, id, arms);

  // speaking ring on table
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.58, 0.022, 8, 64),
    new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, TABLE_TOP + 0.006, 0.66);
  g.add(ring);

  // soft darkening of the table where the person sits, like light blocked by the body
  const aoBody = contactShadow(1.4, 0.8, 0.45);
  aoBody.position.set(0, TABLE_TOP + 0.003, 0.5);
  g.add(aoBody);

  scene.add(g);

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<div class="n" style="color:#${p.color.toString(16)}">${p.name}</div><div class="r">${p.role}</div><div class="m">listening</div><div class="bidmeter"><i style="background:#${p.color.toString(16)}"></i><span></span></div>`;
  document.getElementById("labels").appendChild(label);

  return {
    id,
    g,
    body,
    head,
    mouth: face.mouth,
    brows: face.brows,
    eyes: face.eyes,
    arms,
    cloth,
    ring,
    label,
    speaking: false,
    mood: "neutral",
    look: LOOK_CANDIDATE.clone(),
    nod: 0,
    pitch: 0,
    mouthOpen: 0,
    waving: 0,
    waveAmount: 0,
    bubbleUntil: 0,
    // stagger blinks so the three never blink in sync
    nextBlink: 1 + Math.random() * 3,
    blink: 0,
  };
}

// An office chair: a soft curved backrest with a headrest, a padded seat, armrests and a
// five star base on casters. Built facing +z with the seat top at seatY.
export function buildChair(seatY = HIP_Y - 0.01, fabricColor = 0x2a2320) {
  const chair = new THREE.Group();
  const fabric = std(fabricColor, { roughness: 0.88 });
  const frame = std(0x1a1a1c, { roughness: 0.45, metalness: 0.4 });
  const chrome = std(0x8d8f94, { roughness: 0.25, metalness: 0.9 });

  const seat = shadowed(new THREE.Mesh(cushionGeometry(0.66, 0.6, 0.09, 0.08, 0.06), fabric));
  seat.rotation.x = -Math.PI / 2;
  seat.position.set(0, seatY - 0.09, 0.02);
  chair.add(seat);

  // the backrest bends around the sitter, which is what stops it reading as a flat box
  const back = shadowed(new THREE.Mesh(cushionGeometry(0.64, 0.78, 0.07, 0.12, 0.38), fabric));
  back.position.set(0, seatY + 0.55, -0.33);
  back.rotation.x = -0.1;
  chair.add(back);

  const headrest = shadowed(new THREE.Mesh(cushionGeometry(0.4, 0.18, 0.06, 0.07, 0.3), fabric));
  headrest.position.set(0, seatY + 1.07, -0.39);
  headrest.rotation.x = -0.12;
  chair.add(headrest);
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.18, 0.03), frame);
  post.position.set(0, seatY + 0.95, -0.4);
  post.rotation.x = -0.12;
  chair.add(post);

  // a spine from the seat to the back, then the gas lift and the star base
  const spine = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.32, 0.03), frame);
  spine.position.set(0, seatY + 0.06, -0.33);
  chair.add(spine);
  const lift = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, seatY - 0.2, 16), chrome);
  lift.position.y = (seatY - 0.2) / 2 + 0.11;
  chair.add(lift);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.06, 16), frame);
  hub.position.y = 0.1;
  chair.add(hub);
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const leg = new THREE.Group();
    leg.rotation.y = a;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.34), frame);
    arm.position.set(0, 0.09, 0.18);
    arm.rotation.x = 0.12;
    leg.add(arm);
    const caster = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 10), frame);
    caster.position.set(0, 0.035, 0.33);
    leg.add(caster);
    chair.add(leg);
  }

  for (const s of [-1, 1]) {
    const pad = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.07, 0.035, 0.3, 3, 0.015), frame));
    pad.position.set(s * 0.37, seatY + 0.2, -0.02);
    chair.add(pad);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.2, 0.035), frame);
    strut.position.set(s * 0.37, seatY + 0.09, -0.1);
    chair.add(strut);
  }

  const shadow = contactShadow(0.9, 0.9, 0.5);
  shadow.position.y = 0.004;
  chair.add(shadow);
  return chair;
}

// A padded panel: a rounded box whose edges are fully pillowed, then bent around the y axis by
// curve (how far the side edges come forward), so cushions look stuffed rather than boxed.
// The radius argument is kept for the call sites' intent; the pillow radius is half the depth.
function cushionGeometry(w, h, depth, radius, curve) {
  const geo = new RoundedBoxGeometry(w, h, depth, 6, Math.min(radius, depth / 2));
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const px = pos.getX(i) / (w / 2);
    pos.setZ(i, pos.getZ(i) + curve * 0.25 * px * px);
  }
  geo.computeVertexNormals();
  return geo;
}

export function buildOutfit(body, look, { cloth, lapelMat, shirtMat }) {
  if (look.outfit === "sweater") {
    // crew-neck sweater with a ribbed collar and a white tee peeking out
    const collar = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.03, 12, 32), lapelMat));
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1.08, 0.86, 1);
    collar.position.set(0, 0.905, 0.005);
    body.add(collar);
    const tee = new THREE.Mesh(new THREE.TorusGeometry(0.095, 0.012, 8, 32), shirtMat);
    tee.rotation.x = Math.PI / 2;
    tee.position.set(0, 0.93, 0.01);
    body.add(tee);

    // a little chest pocket stitched on, so the sweater is not a plain blob
    const pocket = chestPatch((t) => ({ y: 0.66 - t * 0.1, left: 0.08, right: 0.17 }), 0.004, lapelMat);
    body.add(pocket);
    return;
  }

  // Blazer or suit: shirt V, lapels on either side, buttons down the front.
  const vTop = 0.9;
  const vBottom = look.outfit === "suit" ? 0.5 : 0.55;
  const shirt = chestPatch(
    (t) => {
      const y = vTop - t * (vTop - vBottom);
      const half = 0.11 * (1 - t) + 0.004;
      return { y, left: -half, right: half };
    },
    0.003,
    shirtMat,
  );
  body.add(shirt);

  for (const s of [-1, 1]) {
    const lapel = chestPatch(
      (t) => {
        const y = vTop - t * (vTop - vBottom);
        const inner = 0.11 * (1 - t) + 0.004;
        const width = 0.075 * (1 - t) + 0.018 * Math.sin(t * Math.PI);
        return s < 0 ? { y, left: -inner - width, right: -inner } : { y, left: inner, right: inner + width };
      },
      0.007,
      lapelMat,
    );
    body.add(lapel);
  }

  const collar = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 10, 32), shirtMat));
  collar.rotation.x = Math.PI / 2 - 0.25;
  collar.position.set(0, 0.915, 0.01);
  body.add(collar);

  if (look.outfit === "suit") {
    // narrow dark tie down the shirt V
    const tie = chestPatch(
      (t) => {
        const y = 0.885 - t * 0.37;
        const half = t < 0.12 ? 0.018 : 0.012 + t * 0.018;
        return { y, left: -half, right: half };
      },
      0.006,
      std(0x2b2d3a, { roughness: 0.5 }),
    );
    body.add(tie);
  }

  const buttonMat = std(0x2a1d14, { roughness: 0.3 });
  for (const y of [vBottom - 0.06, vBottom - 0.2]) {
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), buttonMat);
    b.position.set(0, y, torsoFrontZ(0, y, 0.004));
    b.scale.z = 0.5;
    body.add(b);
  }
}

// What sets the three panel faces apart; the candidate's face comes from the character creator.
const PANEL_FACES = {
  manager: { iris: 0x5a3a1e, browTube: 0.01, facialHair: "none", glasses: "none" },
  tech: { iris: 0x3b2618, browTube: 0.01, facialHair: "none", glasses: "round" },
  skeptic: { iris: 0x4a6a78, browTube: 0.014, facialHair: "moustache", glasses: "none" },
};

export function buildFace(head, face, { skin, hairMat, darkMat }) {
  const skull = shadowed(new THREE.Mesh(new THREE.SphereGeometry(HEAD_R, 48, 32), skin));
  skull.scale.copy(HEAD_SCALE);
  head.add(skull);

  for (const s of [-1, 1]) {
    const ear = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.055, 16, 12), skin));
    ear.position.set(s * 0.258, -0.01, -0.01);
    ear.scale.set(0.45, 1, 0.75);
    head.add(ear);
  }

  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.034, 16, 12), skin);
  onHead(0, -0.045, nose.position, 0.012);
  nose.scale.set(0.85, 1, 1);
  head.add(nose);

  // gentle cheek blush, very transparent so it just warms the face
  const blushMat = new THREE.MeshBasicMaterial({
    color: 0xe07a6a,
    transparent: true,
    opacity: 0.18,
    depthWrite: false,
  });
  for (const s of [-1, 1]) {
    const blush = new THREE.Mesh(new THREE.CircleGeometry(0.035, 16), blushMat);
    onHead(s * 0.135, -0.07, blush.position, 0.022);
    blush.lookAt(blush.position.clone().multiplyScalar(2));
    head.add(blush);
  }

  // eyes: white, iris, pupil and a catchlight, set into the face and turned to its normal
  const white = new THREE.MeshStandardMaterial({ color: 0xfbf8f2, roughness: 0.25 });
  const iris = std(face.iris, { roughness: 0.3 });
  const shine = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Group();
    onHead(s * 0.088, 0.02, eye.position, -0.012);
    eye.rotation.y = Math.atan2(eye.position.x, eye.position.z) * 0.6;
    const ball = new THREE.Mesh(new THREE.SphereGeometry(0.044, 20, 16), white);
    ball.scale.set(1, 1.12, 0.62);
    eye.add(ball);
    const ir = new THREE.Mesh(new THREE.SphereGeometry(0.026, 16, 12), iris);
    ir.position.z = 0.019;
    ir.scale.set(1, 1.08, 0.5);
    eye.add(ir);
    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.014, 12, 10), darkMat);
    pupil.position.z = 0.03;
    pupil.scale.z = 0.4;
    eye.add(pupil);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.006, 8, 6), shine);
    glint.position.set(0.008, 0.01, 0.034);
    eye.add(glint);
    head.add(eye);
    eyes.push(eye);
  }

  // eyebrows are short arcs in the hair color; Sol's are thicker
  const browTube = face.browTube;
  const brows = [];
  for (const s of [-1, 1]) {
    const pivot = new THREE.Group();
    onHead(s * 0.09, 0.098, pivot.position, 0.008);
    pivot.rotation.y = Math.atan2(pivot.position.x, pivot.position.z) * 0.7;
    const arcLen = 1.3;
    const arc = new THREE.Mesh(new THREE.TorusGeometry(0.06, browTube, 8, 20, arcLen), hairMat);
    arc.rotation.z = Math.PI / 2 - arcLen / 2;
    arc.position.y = -0.052;
    pivot.add(arc);
    pivot.userData.side = s;
    pivot.userData.baseY = pivot.position.y;
    head.add(pivot);
    brows.push(pivot);
  }

  // Mouth: a closed smile line, plus an inner mouth that opens with speech.
  const mouth = new THREE.Group();
  onHead(0, -0.112, mouth.position, -0.004);
  head.add(mouth);
  const lip = std(0x8a3b33, { roughness: 0.5 });
  const smileArc = 1.5;
  const smile = new THREE.Mesh(new THREE.TorusGeometry(0.045, 0.0085, 8, 24, smileArc), lip);
  smile.rotation.z = -Math.PI / 2 - smileArc / 2;
  smile.position.set(0, 0.04, 0.012);
  mouth.add(smile);
  const inner = new THREE.Mesh(new THREE.SphereGeometry(0.036, 20, 12), std(0x4a1a1a, { roughness: 0.8 }));
  inner.scale.set(1, 0.05, 0.4);
  inner.position.set(0, -0.004, 0.008);
  mouth.add(inner);
  const teeth = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.008, 0.01), white);
  teeth.position.set(0, 0.006, 0.02);
  teeth.visible = false;
  mouth.add(teeth);
  mouth.userData = { inner, teeth, smile };

  buildFacialHair(head, face.facialHair, hairMat);
  if (face.glasses !== "none") {
    buildGlasses(head, face.glasses);
  }

  return { mouth, brows, eyes };
}

// Moustache, stubble or a full beard, all in the hair color.
function buildFacialHair(head, kind, hairMat) {
  if (kind === "moustache" || kind === "beard") {
    // a soft bar over the lip, part of what makes Sol read as the seasoned one
    const stache = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 6, 12), hairMat);
    stache.rotation.z = Math.PI / 2;
    onHead(0, -0.082, stache.position, 0.012);
    stache.scale.set(1, 1, 0.7);
    head.add(stache);
  }

  if (kind === "beard") {
    // a lower half shell around the jaw, open at the mouth so speech still shows
    const beard = shadowed(
      new THREE.Mesh(
        new THREE.SphereGeometry(HEAD_R + 0.012, 40, 20, 0, Math.PI * 2, Math.PI * 0.56, Math.PI * 0.3),
        hairMat,
      ),
    );
    beard.scale.copy(HEAD_SCALE);
    beard.position.set(0, -0.005, 0.004);
    head.add(beard);
    const chin = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.08, 20, 14), hairMat));
    onHead(0, -0.2, chin.position, -0.03);
    chin.scale.set(1.35, 0.8, 0.9);
    head.add(chin);
    return;
  }

  if (kind === "stubble") {
    // stubble is a faint shadow over the jaw, drawn as a thin transparent shell
    const shadow = new THREE.Mesh(
      new THREE.SphereGeometry(HEAD_R + 0.003, 40, 20, 0, Math.PI * 2, Math.PI * 0.58, Math.PI * 0.28),
      new THREE.MeshStandardMaterial({
        color: hairMat.color,
        transparent: true,
        opacity: 0.32,
        roughness: 1,
        depthWrite: false,
      }),
    );
    shadow.scale.copy(HEAD_SCALE);
    head.add(shadow);
  }
}

// Round glasses are Theo's; square frames are one of the candidate's options.
export function buildGlasses(head, shape = "round", color = 0x141414) {
  const frame = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xcfe6ff,
    transparent: true,
    opacity: 0.12,
    roughness: 0.05,
    metalness: 0.2,
  });
  for (const s of [-1, 1]) {
    const center = onHead(s * 0.088, 0.02, new THREE.Vector3(), 0.035);
    // a torus with four segments is a soft square, which is all a square frame needs to be
    const square = shape === "square";
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.009, 10, square ? 4 : 32), frame);
    lens.position.copy(center);
    lens.scale.set(1.08, 0.88, 1);
    lens.rotation.y = s * 0.18;
    if (square) {
      lens.rotation.z = Math.PI / 4;
      lens.scale.set(0.98, 0.78, 1);
    }
    head.add(lens);
    const pane = new THREE.Mesh(new THREE.CircleGeometry(0.056, square ? 4 : 24, square ? Math.PI / 4 : 0), glass);
    pane.position.copy(center);
    pane.scale.copy(lens.scale);
    pane.rotation.y = s * 0.18;
    head.add(pane);

    // temple arm running back to the ear
    const from = onHead(s * 0.148, 0.03, new THREE.Vector3(), 0.02);
    const to = new THREE.Vector3(s * 0.262, 0.02, -0.04);
    head.add(rod(from, to, 0.007, frame));
  }
  const bridgeFrom = onHead(-0.03, 0.035, new THREE.Vector3(), 0.04);
  const bridgeTo = onHead(0.03, 0.035, new THREE.Vector3(), 0.04);
  head.add(rod(bridgeFrom, bridgeTo, 0.007, frame));
}

// A cylinder from point a to point b.
export function rod(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 8), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.scale.y = dir.length();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

export function hairCap(r, thetaLength, tiltX, mat) {
  const m = shadowed(new THREE.Mesh(new THREE.SphereGeometry(r, 40, 24, 0, Math.PI * 2, 0, thetaLength), mat));
  m.rotation.x = tiltX;
  return m;
}

function buildHair(head, id, hairMat) {
  if (id === "manager") {
    // full cap swept back, volume at the back of the head and a bun on top
    const cap = hairCap(0.288, Math.PI * 0.56, -0.42, hairMat);
    cap.scale.set(1, 1.06, 1.0);
    head.add(cap);
    const back = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.27, 32, 24), hairMat));
    back.position.set(0, -0.02, -0.06);
    back.scale.set(1.05, 1.0, 0.95);
    head.add(back);
    for (const s of [-1, 1]) {
      // hair falling over the temples, framing the face
      const side = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), hairMat));
      side.position.set(s * 0.215, 0.06, 0.07);
      side.scale.set(0.7, 1.35, 0.9);
      head.add(side);
    }
    const sweep = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), hairMat));
    sweep.position.set(-0.06, 0.19, 0.15);
    sweep.scale.set(1.3, 0.36, 0.62);
    sweep.rotation.z = 0.35;
    head.add(sweep);
    const bun = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 18), hairMat));
    bun.position.set(0, 0.25, -0.17);
    head.add(bun);
    const tie = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 24), std(0xc2412d));
    tie.position.set(0, 0.2, -0.13);
    tie.rotation.x = -0.9;
    head.add(tie);
    return;
  }

  if (id === "tech") {
    // short cropped hair with a little lift at the front
    const cap = hairCap(0.285, Math.PI * 0.48, -0.34, hairMat);
    cap.scale.set(1, 1.08, 1);
    head.add(cap);
    const back = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.265, 32, 24), hairMat));
    back.position.set(0, 0.0, -0.05);
    back.scale.set(1.03, 1.0, 0.95);
    head.add(back);
    const quiff = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), hairMat));
    quiff.position.set(0.03, 0.225, 0.11);
    quiff.scale.set(1.25, 0.42, 0.8);
    quiff.rotation.z = -0.15;
    head.add(quiff);
    return;
  }

  // Sol: grey hair around the back and sides, bald on top. A torus arc reads as a soft fringe
  // from every angle, with the gap turned to face forward.
  const arc = Math.PI * 2 - 1.9;
  const fringe = new THREE.Group();
  fringe.rotation.y = arc / 2 + Math.PI / 2;
  fringe.position.y = 0.02;
  const ring = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.236, 0.062, 16, 48, arc), hairMat));
  ring.rotation.x = Math.PI / 2;
  fringe.add(ring);
  fringe.scale.set(HEAD_SCALE.x, 1.2, HEAD_SCALE.z);
  head.add(fringe);
  for (const s of [-1, 1]) {
    const tuft = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), hairMat));
    tuft.position.set(s * 0.245, 0.06, -0.02);
    tuft.scale.set(0.55, 1, 1.1);
    head.add(tuft);
  }
}

// Hand: a soft palm, four fingers in a gentle curl, and a thumb, modelled pointing down +z.
export function buildHand(side, skin) {
  const hand = new THREE.Group();
  const palm = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.05, 20, 16), skin));
  palm.scale.set(1.05, 0.5, 1.15);
  palm.position.z = 0.045;
  hand.add(palm);
  for (let i = 0; i < 4; i++) {
    const finger = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.0125, 0.045, 4, 8), skin));
    finger.rotation.x = Math.PI / 2 + 0.25;
    finger.position.set((i - 1.5) * 0.024 * -side, -0.006, 0.1 - Math.abs(i - 1.5) * 0.006);
    hand.add(finger);
  }
  const thumb = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.035, 4, 8), skin));
  thumb.position.set(-side * 0.05, 0.0, 0.05);
  thumb.rotation.set(Math.PI / 2, 0, side * 0.7);
  hand.add(thumb);

  // stylized people read friendlier with slightly oversized hands
  hand.scale.setScalar(1.2);
  return hand;
}

function buildArm(g, side, { cloth, skin, shirtMat }) {
  const upper = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.06, 1, 18, 1, true), cloth));
  const fore = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.05, 1, 18, 1, true), cloth));
  const shoulderBall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.076, 20, 16), cloth));
  const elbowBall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), cloth));
  const cuff = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.012, 8, 20), shirtMat));

  const hand = buildHand(side, skin);
  g.add(upper, fore, shoulderBall, elbowBall, cuff, hand);
  return {
    side,
    upper,
    fore,
    shoulderBall,
    elbowBall,
    cuff,
    hand,
    rest: new THREE.Vector3(),
    wrist: new THREE.Vector3(),
    elbow: new THREE.Vector3(),
    shoulder: new THREE.Vector3(),
  };
}

function buildProps(g, id, arms) {
  if (id === "tech") {
    // laptop open toward Theo; the lid's back faces the candidate with a glowing logo
    const alu = new THREE.MeshStandardMaterial({ color: 0xa9b0b8, metalness: 0.7, roughness: 0.32 });
    const laptop = new THREE.Group();
    const base = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.56, 0.022, 0.38, 2, 0.008), alu));
    base.position.y = 0.011;
    laptop.add(base);
    const keys = new THREE.Mesh(new THREE.PlaneGeometry(0.48, 0.17), std(0x26292d, { roughness: 0.8 }));
    keys.rotation.x = -Math.PI / 2;
    keys.position.set(0, 0.0225, 0.03);
    laptop.add(keys);

    const lid = new THREE.Group();
    lid.position.set(0, 0.022, 0.19);
    lid.rotation.x = 0.32;
    laptop.add(lid);
    const lidMesh = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.56, 0.37, 0.014, 2, 0.006), alu));
    lidMesh.position.y = 0.185;
    lid.add(lidMesh);
    const screen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.52, 0.32),
      new THREE.MeshBasicMaterial({ color: 0x1d3347, toneMapped: false }),
    );
    screen.rotation.y = Math.PI;
    screen.position.set(0, 0.185, -0.008);
    lid.add(screen);
    const logo = new THREE.Mesh(
      new THREE.CircleGeometry(0.028, 24),
      new THREE.MeshBasicMaterial({ color: 0xbfe3ff, toneMapped: false }),
    );
    logo.position.set(0, 0.2, 0.0075);
    lid.add(logo);

    laptop.position.set(0, TABLE_TOP, 0.63);
    g.add(laptop);

    const shadow = contactShadow(0.75, 0.55, 0.5);
    shadow.position.set(0, TABLE_TOP + 0.004, 0.63);
    g.add(shadow);
    for (const arm of arms) {
      arm.rest.z = 0.6;
      arm.restLift = 0.022;
    }
    return;
  }

  if (id === "skeptic") {
    // notepad with ruled lines and a few scribbles, and a pen in the writing hand
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 340;
    const ctx = c.getContext("2d");
    ctx.fillStyle = "#f4ecd9";
    ctx.fillRect(0, 0, 256, 340);
    ctx.strokeStyle = "rgba(90,130,180,0.45)";
    for (let y = 40; y < 340; y += 20) {
      ctx.beginPath();
      ctx.moveTo(14, y);
      ctx.lineTo(242, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(40,40,60,0.75)";
    ctx.lineWidth = 2;
    for (let line = 0; line < 6; line++) {
      ctx.beginPath();
      const y = 36 + line * 20;
      ctx.moveTo(22, y);
      for (let x = 22; x < 60 + Math.random() * 160; x += 6) {
        ctx.lineTo(x, y - 2 - Math.random() * 6);
      }
      ctx.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const pad = new THREE.Group();
    const paper = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.3, 0.018, 0.4, 2, 0.006), std(0xf1e9d8)));
    pad.add(paper);
    const page = new THREE.Mesh(
      new THREE.PlaneGeometry(0.28, 0.38),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.9 }),
    );
    page.rotation.x = -Math.PI / 2;
    page.position.y = 0.0095;
    pad.add(page);
    const binding = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.022, 0.03), std(0x2f2f36));
    binding.position.set(0, 0.002, -0.19);
    pad.add(binding);
    pad.position.set(0.24, TABLE_TOP + 0.009, 0.62);
    pad.rotation.y = -0.18;
    g.add(pad);
    const shadow = contactShadow(0.45, 0.55, 0.4);
    shadow.position.set(0.24, TABLE_TOP + 0.003, 0.62);
    g.add(shadow);

    const pen = new THREE.Mesh(new THREE.CylinderGeometry(0.007, 0.005, 0.15, 10), std(0x1e3a5f, { metalness: 0.4 }));
    pen.position.set(-0.02, 0.012, 0.09);
    pen.rotation.set(Math.PI / 2 - 0.4, 0, 0.5);
    arms[1].hand.add(pen);

    // the writing hand rests on the pad, a touch higher
    arms[1].restLift = 0.018;
    return;
  }

  // Maya: a coffee mug and a closed folder
  const mugMat = std(0xf3efe7, { roughness: 0.35 });
  const mug = new THREE.Group();
  const cup = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.05, 0.13, 24), mugMat));
  cup.position.y = 0.065;
  mug.add(cup);
  const coffee = new THREE.Mesh(new THREE.CircleGeometry(0.048, 20), std(0x3b2414, { roughness: 0.2 }));
  coffee.rotation.x = -Math.PI / 2;
  coffee.position.y = 0.12;
  mug.add(coffee);
  const handle = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.01, 8, 16), mugMat));
  handle.position.set(0.06, 0.065, 0);
  mug.add(handle);
  mug.position.set(0.52, TABLE_TOP, 0.55);
  g.add(mug);
  const mugShadow = contactShadow(0.2, 0.2, 0.55);
  mugShadow.position.set(0.52, TABLE_TOP + 0.003, 0.55);
  g.add(mugShadow);

  const folder = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.34, 0.016, 0.26, 2, 0.006), std(0x3d5a6c)));
  folder.position.set(-0.05, TABLE_TOP + 0.008, 0.86);
  folder.rotation.y = 0.12;
  g.add(folder);
}

// ---------- per-frame avatar animation ----------

const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, 1);
const SHOULDER = new THREE.Vector3(0.275, 0.77, 0);
const UPPER_LEN = 0.5;
const FORE_LEN = 0.48;
const tmpQ = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const _d = new THREE.Vector3();
const _n = new THREE.Vector3();
const _u = new THREE.Vector3();
const _v = new THREE.Vector3();
const _c = new THREE.Vector3();
const _e = new THREE.Vector3();
const _p = new THREE.Vector3();

// Puts a unit cylinder between a and b.
function placeLimb(mesh, a, b) {
  _d.subVectors(b, a);
  const len = _d.length();
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.scale.set(1, len, 1);
  mesh.quaternion.setFromUnitVectors(UP, _d.divideScalar(len || 1));
}

// Two-bone arm: picks an elbow on the circle of valid elbows, preferring out and down,
// but never letting it sink into the tabletop.
function solveArm(arm, shoulder, wrist) {
  _d.subVectors(wrist, shoulder);
  let dist = _d.length();
  const maxReach = UPPER_LEN + FORE_LEN - 0.002;
  if (dist > maxReach) {
    // out of reach: pull the hand back toward the shoulder rather than stretching the arm
    wrist.copy(shoulder).addScaledVector(_d, maxReach / dist);
    _d.subVectors(wrist, shoulder);
    dist = maxReach;
  }
  _n.copy(_d).divideScalar(dist);

  const a = (UPPER_LEN * UPPER_LEN - FORE_LEN * FORE_LEN + dist * dist) / (2 * dist);
  const h = Math.sqrt(Math.max(0, UPPER_LEN * UPPER_LEN - a * a));
  _c.copy(shoulder).addScaledVector(_n, a);

  // basis around the shoulder-wrist axis
  _u.set(arm.side, -0.9, -0.5).normalize();
  _u.addScaledVector(_n, -_u.dot(_n)).normalize();
  _v.crossVectors(_n, _u);

  let best = -Infinity;
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2;
    _p.copy(_c)
      .addScaledVector(_u, Math.cos(ang) * h)
      .addScaledVector(_v, Math.sin(ang) * h);
    let score = Math.cos(ang);
    // the table is in front of the body (z > 0 in table space), keep elbows above it
    const overTable = _p.z + AVATAR_Z > -0.02;
    if (overTable && _p.y < TABLE_TOP + 0.06) {
      score -= 10 + (TABLE_TOP + 0.06 - _p.y) * 20;
    }
    // elbows tucked into the ribs look wrong; keep them out from the torso
    if (Math.abs(_p.x) < 0.33 && _p.z < 0.25) {
      score -= 4;
    }
    if (score > best) {
      best = score;
      _e.copy(_p);
    }
  }
  arm.elbow.copy(_e);
}

export function animateAvatar(a, t, dt, conferring, tmpA, tmpB) {
  // breathing
  a.body.position.y = HIP_Y + Math.sin(t * 1.6 + a.g.position.x) * 0.008;
  a.body.scale.set(1, 1 + Math.sin(t * 1.6 + a.g.position.x) * 0.004, 1);

  // head look, measured from the body so the head's own rotation never feeds back into it
  a.body.updateMatrixWorld();
  const local = a.body.worldToLocal(tmpA.copy(a.look)).sub(a.head.position);
  const yaw = THREE.MathUtils.clamp(Math.atan2(local.x, local.z), -0.9, 0.9);
  const pitch = THREE.MathUtils.clamp(-Math.atan2(local.y, Math.hypot(local.x, local.z)), -0.3, 0.45);
  a.head.rotation.y += (yaw - a.head.rotation.y) * 0.08;
  a.pitch += (pitch - a.pitch) * 0.08;

  // mood poses
  const tilt = a.mood === "skeptical" ? 0.18 : a.mood === "amused" ? -0.1 : 0;
  a.head.rotation.z += (tilt - a.head.rotation.z) * 0.05;
  const lean = a.mood === "concerned" ? -0.08 : conferring ? 0.1 : a.speaking ? 0.05 : 0;
  a.body.rotation.x += (lean - a.body.rotation.x) * 0.05;

  let nodOffset = 0;
  if (a.nod > 0) {
    nodOffset = Math.sin((1 - a.nod) * Math.PI * 4) * 0.15;
    a.nod = Math.max(0, a.nod - dt * 0.8);
  }
  a.head.rotation.x = a.pitch + nodOffset;

  // blinks: a quick close and open every few seconds
  if (t > a.nextBlink) {
    a.blink = 1;
    a.nextBlink = t + 2.5 + Math.random() * 3.5;
  }
  const lid = a.blink > 0 ? Math.abs(Math.cos(a.blink * Math.PI)) : 1;
  for (const eye of a.eyes) {
    eye.scale.y = Math.max(0.08, lid);
  }
  a.blink = Math.max(0, a.blink - dt * 7);

  // brows follow the mood
  const mb = MOOD_BROWS[a.mood] || MOOD_BROWS.neutral;
  for (const b of a.brows) {
    const s = b.userData.side;
    let tiltZ = mb.tilt * -s;
    let lift = mb.lift;
    if (a.mood === "skeptical") {
      // one brow up, one down: the classic doubtful look
      lift = s > 0 ? 0.02 : -0.006;
      tiltZ = s > 0 ? -0.1 : 0.12;
    }
    if (a.id === "skeptic" && a.mood === "neutral") {
      tiltZ = 0.1 * s;
    }
    if (a.speaking) {
      lift += Math.max(0, Math.sin(t * 5 + s)) * 0.006;
    }
    b.position.y += (b.userData.baseY + lift - b.position.y) * 0.15;
    b.rotation.z += (tiltZ - b.rotation.z) * 0.15;
  }

  // mouth: a syllable rhythm when speaking, a relaxed smile otherwise
  const talk = a.speaking ? 0.25 + Math.abs(Math.sin(t * 13 + a.g.position.x)) * Math.abs(Math.sin(t * 4.3)) : 0;
  a.mouthOpen += (talk - a.mouthOpen) * 0.4;
  const m = a.mouth.userData;
  m.inner.scale.y = 0.05 + a.mouthOpen * 0.75;
  m.inner.position.y = -0.004 - a.mouthOpen * 0.012;
  m.teeth.visible = a.mouthOpen > 0.25;
  m.smile.scale.set(1 - a.mouthOpen * 0.25, 1, 1);
  const smileTarget = a.mood === "amused" || a.mood === "impressed" ? 1.35 : a.mood === "concerned" ? 0.4 : 1;
  m.smile.scale.y += (smileTarget - m.smile.scale.y) * 0.1;

  // arms: wrists move with gestures, the wave, or rest on the table; elbows and hands follow
  const wave = a.waving ? 1 : 0;
  a.waveAmount += (wave - a.waveAmount) * 0.1;

  for (const arm of a.arms) {
    a.body.localToWorld(arm.shoulder.set(SHOULDER.x * arm.side, SHOULDER.y, SHOULDER.z));
    a.g.worldToLocal(arm.shoulder);

    const target = tmpB.copy(arm.rest);
    target.y += arm.restLift || 0;
    if (a.speaking) {
      const ph = t * 2.2 + a.g.position.x + (arm.side > 0 ? 0 : Math.PI);
      const s = Math.max(0, Math.sin(ph));
      target.y += s * 0.13;
      target.z += s * 0.05;
      target.x -= arm.side * s * 0.05;
    }
    const waveSide = arm.side < 0;
    if (waveSide && a.waveAmount > 0.01) {
      const up = _p.set(arm.side * 0.5, 1.78, 0.22);
      up.x += Math.sin(t * 9) * 0.06;
      target.lerp(up, a.waveAmount);
    }
    arm.wrist.lerp(target, 0.14);

    const wrist = tmpA.copy(arm.wrist);
    solveArm(arm, arm.shoulder, wrist);

    placeLimb(arm.upper, arm.shoulder, arm.elbow);
    placeLimb(arm.fore, arm.elbow, wrist);
    arm.shoulderBall.position.copy(arm.shoulder);
    arm.elbowBall.position.copy(arm.elbow);

    // cuff ring sits around the wrist, facing along the forearm
    _d.subVectors(wrist, arm.elbow).normalize();
    arm.cuff.position.copy(wrist).addScaledVector(_d, -0.01);
    arm.cuff.quaternion.setFromUnitVectors(FORWARD, _d);

    // hand continues the forearm, palm facing down; while waving the palm turns to face out
    arm.hand.position.copy(arm.cuff.position).addScaledVector(_d, 0.012);
    const handUp = waveSide && a.waveAmount > 0.5 ? _v.set(0, 0, -1) : _v.set(0, 1, 0);
    tmpM.lookAt(_p.set(0, 0, 0), _d.clone().negate(), handUp);
    tmpQ.setFromRotationMatrix(tmpM);
    if (!a.speaking && a.waveAmount < 0.5) {
      // a resting hand lies flat on the table, so only keep its heading
      _d.y = 0;
      _d.normalize();
      tmpM.lookAt(_p.set(0, 0, 0), _d.clone().negate(), _v.set(0, 1, 0));
      tmpQ.setFromRotationMatrix(tmpM);
    }
    arm.hand.quaternion.slerp(tmpQ, 0.3);
  }

  // speaking glow and ring
  a.cloth.emissiveIntensity += ((a.speaking ? 0.3 : 0) - a.cloth.emissiveIntensity) * 0.1;
  a.ring.material.opacity += ((a.speaking ? 0.9 : 0) - a.ring.material.opacity) * 0.1;
  a.ring.scale.setScalar(1 + (a.speaking ? Math.sin(t * 4) * 0.05 : 0));
}
