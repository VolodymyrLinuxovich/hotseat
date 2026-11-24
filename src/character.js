import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import {
  HEAD_SCALE,
  TORSO_DEPTH,
  buildFace,
  buildHand,
  buildOutfit,
  chestPatch,
  hairCap,
  rod,
  shadowed,
  std,
  torsoFrontZ,
  torsoPoints,
} from "./avatars.js";

// The candidate's own avatar: built from the character creator's choices, with legs so it can
// walk in through the door and sit in the hot seat. It shares the torso, face and hands with the
// panel, so the candidate looks like they belong in the same room.

// The whole rig is scaled down a touch so a standing candidate clears the doorway.
export const CHAR_SCALE = 0.9;

const THIGH_LEN = 0.5;
const SHIN_LEN = 0.52;
const FOOT_H = 0.07;
const STAND_HIP = THIGH_LEN + SHIN_LEN + FOOT_H;

// Pelvis height (rig units) when sitting with the shins straight down.
export const SIT_HIP = SHIN_LEN + FOOT_H + 0.04;

const UPPER_LEN = 0.5;
const FORE_LEN = 0.46;

export const SKIN_TONES = [0xf6d3b8, 0xeebf98, 0xd9a27b, 0xc28860, 0xa56d4c, 0x8a5636, 0x6b4029, 0x4a2c1d];
export const HAIR_COLORS = [0x15110e, 0x3a2416, 0x6b4126, 0xa8692e, 0xd8b26e, 0x9a958e, 0xb0362a, 0x3d5fa8];
export const EYE_COLORS = [0x3b2618, 0x5a3a1e, 0x4a6a78, 0x3f7a4e, 0x6e8fb5, 0x7a6a3a];
export const OUTFIT_COLORS = [0x2f3d55, 0x5fa8d3, 0xe8a33d, 0xd9634a, 0x3f7a4e, 0x7b5ea7, 0xe9e2d6, 0x2a2826];

export const OPTIONS = {
  face: [
    { id: "oval", label: "Oval" },
    { id: "round", label: "Round" },
    { id: "square", label: "Square" },
    { id: "long", label: "Long" },
  ],
  hair: [
    { id: "short", label: "Short" },
    { id: "buzz", label: "Buzz" },
    { id: "curly", label: "Curly" },
    { id: "long", label: "Long" },
    { id: "bun", label: "Bun" },
    { id: "ponytail", label: "Ponytail" },
    { id: "bald", label: "Bald" },
  ],
  glasses: [
    { id: "none", label: "None" },
    { id: "round", label: "Round" },
    { id: "square", label: "Square" },
  ],
  facialHair: [
    { id: "none", label: "None" },
    { id: "stubble", label: "Stubble" },
    { id: "beard", label: "Beard" },
    { id: "moustache", label: "Moustache" },
  ],
  outfit: [
    { id: "hoodie", label: "Hoodie" },
    { id: "blazer", label: "Blazer" },
    { id: "shirt", label: "Shirt + tie" },
    { id: "tshirt", label: "T-shirt" },
    { id: "sweater", label: "Sweater" },
  ],
  accessories: [
    { id: "headphones", label: "Headphones" },
    { id: "cap", label: "Cap" },
    { id: "earrings", label: "Earrings" },
    { id: "lanyard", label: "Lanyard" },
  ],
};

export const DEFAULT_CHARACTER = {
  skin: SKIN_TONES[2],
  face: "oval",
  hair: "short",
  hairColor: HAIR_COLORS[1],
  eyes: EYE_COLORS[0],
  glasses: "none",
  facialHair: "none",
  outfit: "hoodie",
  outfitColor: OUTFIT_COLORS[0],
  accessories: [],
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];

export function randomCharacter() {
  // Most people do not wear every accessory at once, so each one is a coin flip weighted low.
  const accessories = OPTIONS.accessories.map((a) => a.id).filter(() => Math.random() < 0.22);
  return {
    skin: pick(SKIN_TONES),
    face: pick(OPTIONS.face).id,
    hair: pick(OPTIONS.hair).id,
    // unusual dyed colors stay rarer than natural ones
    hairColor: Math.random() < 0.85 ? pick(HAIR_COLORS.slice(0, 6)) : pick(HAIR_COLORS.slice(6)),
    eyes: pick(EYE_COLORS),
    glasses: Math.random() < 0.6 ? "none" : pick(["round", "square"]),
    facialHair: Math.random() < 0.6 ? "none" : pick(["stubble", "beard", "moustache"]),
    outfit: pick(OPTIONS.outfit).id,
    outfitColor: pick(OUTFIT_COLORS),
    accessories,
  };
}

// Fills gaps in a stored character, so an older save never breaks the builder.
export function normalizeCharacter(raw) {
  const c = { ...DEFAULT_CHARACTER, ...(raw || {}) };
  for (const key of ["face", "hair", "glasses", "facialHair", "outfit"]) {
    if (!OPTIONS[key].some((o) => o.id === c[key])) {
      c[key] = DEFAULT_CHARACTER[key];
    }
  }
  for (const key of ["skin", "hairColor", "eyes", "outfitColor"]) {
    if (!Number.isFinite(Number(c[key]))) {
      c[key] = DEFAULT_CHARACTER[key];
    }
    c[key] = Number(c[key]);
  }
  const known = new Set(OPTIONS.accessories.map((a) => a.id));
  c.accessories = Array.isArray(c.accessories) ? c.accessories.filter((a) => known.has(a)) : [];
  return c;
}

// Lightens or darkens a colour in sRGB terms. three's own offsetHSL works in linear space,
// where a dark navy minus a little lightness turns pure black.
function shade(hex, dl, ds = 0) {
  const hsl = new THREE.Color(hex).getHSL({}, THREE.SRGBColorSpace);
  const s = clamp01(hsl.s + ds);
  const l = clamp01(hsl.l + dl);
  return new THREE.Color().setHSL(hsl.h, s, l, THREE.SRGBColorSpace);
}

function clamp01(x) {
  return Math.min(1, Math.max(0, x));
}

// Trousers and shoes follow the outfit, so a blazer never ends up over track pants.
function lowerHalf(outfit) {
  if (outfit === "blazer" || outfit === "shirt") {
    return { trousers: 0x2a2c33, shoes: 0x1b1512, sole: 0x120e0c };
  }
  if (outfit === "sweater") {
    return { trousers: 0x6b5a45, shoes: 0x4a3426, sole: 0x2a1d14 };
  }
  return { trousers: 0x34435e, shoes: 0xece8e0, sole: 0xbdb6aa };
}

// ---------- building the rig ----------

export function buildCharacter(input) {
  const c = normalizeCharacter(input);
  const root = new THREE.Group();
  root.name = "candidate";

  const rig = new THREE.Group();
  rig.scale.setScalar(CHAR_SCALE);
  root.add(rig);

  const skin = std(c.skin, { roughness: 0.55 });
  const cloth = std(c.outfitColor, { roughness: 0.78 });
  const trim = new THREE.MeshStandardMaterial({ color: shade(c.outfitColor, -0.08), roughness: 0.75 });
  const shirtMat = std(c.outfit === "shirt" ? 0xf6f2ea : 0xf4efe6, { roughness: 0.8 });
  const hairMat = std(c.hairColor, { roughness: 0.75 });
  const darkMat = std(0x1a1412, { roughness: 0.4 });
  const lower = lowerHalf(c.outfit);
  const trousers = std(lower.trousers, { roughness: 0.85 });
  const shoeMat = std(lower.shoes, { roughness: 0.6 });
  const soleMat = std(lower.sole, { roughness: 0.7 });

  // pelvis carries the body and the legs; it moves up and down for the walk and the sit
  const pelvis = new THREE.Group();
  pelvis.position.y = STAND_HIP;
  rig.add(pelvis);

  const hips = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.26, 32, 20), trousers));
  hips.scale.set(1, 0.5, TORSO_DEPTH + 0.04);
  hips.position.y = 0.02;
  pelvis.add(hips);

  const body = new THREE.Group();
  pelvis.add(body);

  const torso = shadowed(new THREE.Mesh(new THREE.LatheGeometry(torsoPoints, 40), cloth));
  torso.geometry.scale(1, 1, TORSO_DEPTH);
  body.add(torso);

  buildCandidateOutfit(body, c, { cloth, trim, shirtMat });

  const neck = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.095, 0.26, 20), skin));
  neck.position.y = 1.0;
  body.add(neck);

  // the face shape scales a wrapper, so features stay on the skin without per shape math
  const head = new THREE.Group();
  head.position.y = 1.27;
  head.rotation.order = "YXZ";
  body.add(head);
  const shape = new THREE.Group();
  shape.scale.copy(
    {
      oval: new THREE.Vector3(1, 1, 1),
      round: new THREE.Vector3(1.05, 0.96, 1.02),
      long: new THREE.Vector3(0.94, 1.07, 0.98),
      square: new THREE.Vector3(1.03, 0.99, 1),
    }[c.face],
  );
  head.add(shape);

  const face = buildFace(
    shape,
    { iris: c.eyes, browTube: 0.011, facialHair: c.facialHair, glasses: c.glasses },
    { skin, hairMat, darkMat },
  );
  if (c.face === "square") {
    // a broader jaw under the cheeks gives the square face its corners
    const jaw = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.38, 0.18, 0.3, 4, 0.08), skin));
    jaw.position.set(0, -0.14, 0.04);
    shape.add(jaw);
  }

  const capped = c.accessories.includes("cap");
  buildCandidateHair(shape, c.hair, hairMat, capped);
  buildAccessories(body, shape, c, { darkMat });

  const arms = [-1, 1].map((side) => buildLimbArm(body, side, c, { cloth, trim, skin, shirtMat }));
  const legs = [-1, 1].map((side) => buildLeg(pelvis, side, { trousers, shoeMat, soleMat }));

  return {
    root,
    rig,
    pelvis,
    body,
    head,
    eyes: face.eyes,
    mouth: face.mouth,
    arms,
    legs,
    config: c,
    walkPhase: 0,
    nextBlink: 1.5,
    blink: 0,
  };
}

function buildCandidateOutfit(body, c, { cloth, trim, shirtMat }) {
  if (c.outfit === "blazer") {
    buildOutfit(body, { outfit: "blazer" }, { cloth, lapelMat: trim, shirtMat });
    return;
  }
  if (c.outfit === "sweater") {
    buildOutfit(body, { outfit: "sweater" }, { cloth, lapelMat: trim, shirtMat });
    return;
  }

  if (c.outfit === "hoodie") {
    // the hood lies folded behind the neck, with drawstrings and a front pocket
    const hood = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.15, 0.065, 14, 32), cloth));
    hood.rotation.x = Math.PI / 2 - 0.35;
    hood.position.set(0, 0.92, -0.03);
    hood.scale.set(1.15, 1, 1);
    body.add(hood);
    const fold = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.18, 24, 16), cloth));
    fold.position.set(0, 0.86, -0.17);
    fold.scale.set(1.2, 0.75, 0.55);
    body.add(fold);
    const cord = std(0xf1ece3, { roughness: 0.6 });
    for (const s of [-1, 1]) {
      const top = new THREE.Vector3(s * 0.055, 0.88, torsoFrontZ(s * 0.055, 0.88, 0.03));
      const end = new THREE.Vector3(s * 0.06, 0.68, torsoFrontZ(s * 0.06, 0.68, 0.012));
      body.add(rod(top, end, 0.007, cord));
      const tip = new THREE.Mesh(new THREE.CapsuleGeometry(0.009, 0.02, 4, 8), cord);
      tip.position.copy(end);
      tip.position.y -= 0.015;
      body.add(tip);
    }
    const pocket = chestPatch(
      (t) => {
        const y = 0.36 - t * 0.2;
        const half = 0.12 + t * 0.05;
        return { y, left: -half, right: half };
      },
      0.006,
      trim,
    );
    // the pocket sits a hair off the cloth; skip shadows on it so it never catches acne from the torso
    pocket.receiveShadow = false;
    body.add(pocket);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.262, 0.022, 8, 40), trim);
    band.rotation.x = Math.PI / 2;
    band.scale.set(1, TORSO_DEPTH + 0.06, 1);
    band.position.y = 0.05;
    body.add(band);
    return;
  }

  if (c.outfit === "tshirt") {
    const collar = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.018, 10, 32), trim));
    collar.rotation.x = Math.PI / 2;
    collar.scale.set(1.08, 0.86, 1);
    collar.position.set(0, 0.915, 0.005);
    body.add(collar);
    return;
  }

  // shirt and tie: collar points, a placket of buttons and a tie in a darker, contrasting tone
  const collar = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.022, 10, 32), cloth));
  collar.rotation.x = Math.PI / 2 - 0.25;
  collar.position.set(0, 0.915, 0.01);
  body.add(collar);
  for (const s of [-1, 1]) {
    const point = chestPatch(
      (t) => {
        const y = 0.9 - t * 0.07;
        const inner = 0.02 + t * 0.03;
        return s < 0
          ? { y, left: -inner - 0.06 * (1 - t), right: -inner }
          : { y, left: inner, right: inner + 0.06 * (1 - t) };
      },
      0.012,
      cloth,
    );
    body.add(point);
  }
  const tieColor = new THREE.Color(c.outfitColor).getHSL({}, THREE.SRGBColorSpace);
  const tieMat = std(new THREE.Color().setHSL((tieColor.h + 0.5) % 1, 0.45, 0.3, THREE.SRGBColorSpace), {
    roughness: 0.5,
  });
  const tie = chestPatch(
    (t) => {
      const y = 0.885 - t * 0.42;
      const half = t < 0.1 ? 0.02 : 0.013 + t * 0.022;
      return { y, left: -half, right: half };
    },
    0.008,
    tieMat,
  );
  body.add(tie);
  const knot = new THREE.Mesh(new THREE.SphereGeometry(0.026, 12, 10), tieMat);
  knot.position.set(0, 0.875, torsoFrontZ(0, 0.875, 0.02));
  knot.scale.set(1, 0.8, 0.6);
  body.add(knot);
}

// Places the hair on the head. capped leaves out what would poke through a cap.
function buildCandidateHair(head, style, hairMat, capped) {
  if (style === "bald") {
    return;
  }

  if (style === "buzz") {
    // a shell barely off the scalp reads as a close crop
    const cap = hairCap(0.276, Math.PI * 0.52, -0.38, hairMat);
    cap.scale.copy(HEAD_SCALE);
    head.add(cap);
    return;
  }

  // every other style starts from a full cap and the back of the head
  const cap = hairCap(0.286, Math.PI * (style === "short" ? 0.48 : 0.55), -0.38, hairMat);
  cap.scale.set(1, 1.07, 1);
  head.add(cap);
  const back = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.268, 32, 24), hairMat));
  back.position.set(0, -0.01, -0.055);
  back.scale.set(1.04, 1, 0.95);
  head.add(back);

  if (style === "short") {
    if (!capped) {
      const quiff = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.13, 24, 16), hairMat));
      quiff.position.set(0.03, 0.225, 0.11);
      quiff.scale.set(1.25, 0.42, 0.8);
      quiff.rotation.z = -0.15;
      head.add(quiff);
    }
    return;
  }

  if (style === "curly") {
    // small curls spread evenly over the crown with a golden angle spiral
    const curl = new THREE.SphereGeometry(0.062, 14, 10);
    const count = 46;
    for (let i = 0; i < count; i++) {
      const y = 1 - (i / (count - 1)) * 1.25;
      const r = Math.sqrt(Math.max(0, 1 - y * y));
      const a = i * 2.39996;
      const p = new THREE.Vector3(Math.cos(a) * r, y, Math.sin(a) * r);
      // keep the face and cheeks clear: no curls low on the front and sides, and a soft hairline
      if (p.z > -0.15 && p.y < 0.3) {
        continue;
      }
      if (p.z > 0.5 && p.y < 0.62) {
        continue;
      }
      if (capped && p.y > 0.3) {
        continue;
      }
      const m = shadowed(new THREE.Mesh(curl, hairMat));
      m.position.copy(p).multiplyScalar(0.285);
      m.position.y *= 1.08;
      m.position.y += 0.03;
      m.scale.setScalar(0.85 + ((i * 37) % 10) / 30);
      head.add(m);
    }
    return;
  }

  // the remaining styles frame the face with locks over the temples
  for (const s of [-1, 1]) {
    const side = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.1, 20, 16), hairMat));
    side.position.set(s * 0.215, 0.06, 0.07);
    side.scale.set(0.7, 1.35, 0.9);
    head.add(side);
  }

  if (style === "long") {
    // hair falls behind the shoulders, with curtains down the sides of the face
    const fall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.27, 32, 24), hairMat));
    fall.position.set(0, -0.2, -0.12);
    fall.scale.set(1.05, 1.5, 0.62);
    head.add(fall);
    for (const s of [-1, 1]) {
      const curtain = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.07, 0.3, 8, 16), hairMat));
      curtain.position.set(s * 0.21, -0.17, -0.02);
      curtain.rotation.z = s * 0.12;
      curtain.scale.set(0.8, 1, 1);
      head.add(curtain);
    }
    if (!capped) {
      const sweep = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), hairMat));
      sweep.position.set(0.05, 0.19, 0.15);
      sweep.scale.set(1.3, 0.36, 0.62);
      sweep.rotation.z = -0.35;
      head.add(sweep);
    }
    return;
  }

  const tieMat = std(0xc2412d);
  if (style === "bun") {
    if (!capped) {
      const sweep = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), hairMat));
      sweep.position.set(-0.06, 0.19, 0.15);
      sweep.scale.set(1.3, 0.36, 0.62);
      sweep.rotation.z = 0.35;
      head.add(sweep);
    }
    // under a cap the bun drops to the back, the way it pokes out of a snapback
    const bun = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.115, 24, 18), hairMat));
    bun.position.set(0, capped ? 0.08 : 0.25, capped ? -0.3 : -0.17);
    head.add(bun);
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 24), tieMat);
    band.position.set(0, capped ? 0.06 : 0.2, capped ? -0.24 : -0.13);
    band.rotation.x = capped ? 0 : -0.9;
    head.add(band);
    return;
  }

  // ponytail: gathered at the back of the crown, falling to the nape
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.016, 8, 24), tieMat);
  band.position.set(0, 0.1, -0.29);
  band.rotation.x = 0.4;
  head.add(band);
  const tail = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.3, 8, 16), hairMat));
  tail.position.set(0, -0.1, -0.34);
  tail.rotation.x = -0.35;
  head.add(tail);
  const tip = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), hairMat));
  tip.position.set(0, -0.28, -0.29);
  head.add(tip);
}

function buildAccessories(body, head, c, { darkMat }) {
  const has = (id) => c.accessories.includes(id);

  if (has("cap")) {
    // a baseball cap in the outfit color, brim forward
    const capMat = std(shade(c.outfitColor, 0.04), { roughness: 0.7 });
    const crown = hairCap(0.3, Math.PI * 0.42, -0.2, capMat);
    crown.scale.set(1, 1.06, 1);
    crown.position.y = 0.02;
    head.add(crown);
    const brim = shadowed(
      new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.016, 32, 1, false, -Math.PI / 2, Math.PI), capMat),
    );
    brim.scale.set(1, 1, 0.75);
    brim.position.set(0, 0.17, 0.2);
    brim.rotation.x = 0.18;
    head.add(brim);
    const button = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), capMat);
    button.position.set(0, 0.32, -0.04);
    head.add(button);
  }

  if (has("headphones")) {
    // over the ears and over the head; the band sits above a cap if there is one
    const shell = std(0x232326, { roughness: 0.35, metalness: 0.2 });
    const lift = has("cap") ? 0.05 : 0;
    const band = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.3 + lift, 0.018, 10, 40, Math.PI), shell));
    band.position.set(0, 0.0, -0.02);
    head.add(band);
    for (const s of [-1, 1]) {
      const cup = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.06, 24), shell));
      cup.rotation.z = Math.PI / 2;
      cup.position.set(s * (0.285 + lift * 0.5), -0.01, -0.02);
      head.add(cup);
      const pad = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.02, 8, 20), std(0x4a4a50, { roughness: 0.9 }));
      pad.rotation.y = Math.PI / 2;
      pad.position.set(s * 0.255, -0.01, -0.02);
      head.add(pad);
    }
  }

  if (has("earrings")) {
    const gold = std(0xe0b45a, { metalness: 0.85, roughness: 0.25 });
    for (const s of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.018, 0.005, 8, 16), gold);
      ring.position.set(s * 0.262, -0.075, 0.0);
      ring.rotation.y = Math.PI / 2;
      head.add(ring);
    }
  }

  if (has("lanyard")) {
    // a strap round the neck and an ID badge on the chest
    const strap = std(shade(c.outfitColor, 0.25, 0.1), { roughness: 0.6 });
    const cardY = 0.52;
    const cardZ = torsoFrontZ(0, cardY, 0.02);
    for (const s of [-1, 1]) {
      const top = new THREE.Vector3(s * 0.1, 0.93, 0.02);
      const mid = new THREE.Vector3(s * 0.08, 0.78, torsoFrontZ(s * 0.08, 0.78, 0.012));
      const end = new THREE.Vector3(s * 0.02, cardY + 0.08, cardZ);
      body.add(rod(top, mid, 0.008, strap));
      body.add(rod(mid, end, 0.008, strap));
    }
    const card = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.11, 0.15, 0.008, 2, 0.004), std(0xf6f3ec)));
    card.position.set(0, cardY, cardZ + 0.004);
    card.rotation.x = -0.12;
    body.add(card);
    const stripe = new THREE.Mesh(new THREE.PlaneGeometry(0.11, 0.035), std(0xe8a33d));
    stripe.position.set(0, cardY + 0.05, cardZ + 0.0095);
    stripe.rotation.x = -0.12;
    body.add(stripe);
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(0.04, 0.045), darkMat);
    photo.position.set(-0.025, cardY - 0.01, cardZ + 0.0095);
    photo.rotation.x = -0.12;
    body.add(photo);
  }
}

// Forward kinematic arm: shoulder and elbow pivots, so the walk can swing it.
function buildLimbArm(body, side, c, { cloth, trim, skin, shirtMat }) {
  const shoulder = new THREE.Group();
  shoulder.position.set(side * 0.275, 0.77, 0);
  body.add(shoulder);

  const bare = c.outfit === "tshirt";
  const ball = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.078, 20, 16), cloth));
  shoulder.add(ball);

  // a t-shirt leaves most of the arm bare, with a short sleeve over the top
  const upperGeo = new THREE.CylinderGeometry(0.068, 0.058, UPPER_LEN, 18);
  upperGeo.translate(0, -UPPER_LEN / 2, 0);
  const upper = shadowed(new THREE.Mesh(upperGeo, bare ? skin : cloth));
  shoulder.add(upper);
  if (bare) {
    const sleeveGeo = new THREE.CylinderGeometry(0.082, 0.078, 0.22, 18);
    sleeveGeo.translate(0, -0.09, 0);
    const sleeve = shadowed(new THREE.Mesh(sleeveGeo, cloth));
    shoulder.add(sleeve);
    const hem = new THREE.Mesh(new THREE.TorusGeometry(0.078, 0.01, 8, 20), trim);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = -0.2;
    shoulder.add(hem);
  }

  const elbow = new THREE.Group();
  elbow.position.y = -UPPER_LEN;
  shoulder.add(elbow);
  const elbowBall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.058, 16, 12), bare ? skin : cloth));
  elbow.add(elbowBall);
  const foreGeo = new THREE.CylinderGeometry(0.056, 0.048, FORE_LEN, 18);
  foreGeo.translate(0, -FORE_LEN / 2, 0);
  const fore = shadowed(new THREE.Mesh(foreGeo, bare ? skin : cloth));
  elbow.add(fore);

  if (!bare) {
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.012, 8, 20), c.outfit === "hoodie" ? trim : shirtMat);
    cuff.rotation.x = Math.PI / 2;
    cuff.position.y = -FORE_LEN + 0.01;
    elbow.add(cuff);
  }

  // the shared hand is modelled pointing along +z; turn it to hang down with the palm inward
  const wrist = new THREE.Group();
  wrist.position.y = -FORE_LEN;
  wrist.rotation.y = side * (Math.PI / 2);
  elbow.add(wrist);
  const hand = buildHand(side, skin);
  hand.rotation.x = Math.PI / 2;
  hand.position.y = 0.01;
  wrist.add(hand);

  return { side, shoulder, elbow, wrist };
}

function buildLeg(pelvis, side, { trousers, shoeMat, soleMat }) {
  const hip = new THREE.Group();
  hip.position.set(side * 0.13, 0, 0);
  pelvis.add(hip);

  const thighGeo = new THREE.CylinderGeometry(0.118, 0.095, THIGH_LEN, 18);
  thighGeo.translate(0, -THIGH_LEN / 2, 0);
  hip.add(shadowed(new THREE.Mesh(thighGeo, trousers)));

  const knee = new THREE.Group();
  knee.position.y = -THIGH_LEN;
  hip.add(knee);
  knee.add(shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.096, 16, 12), trousers)));
  const shinGeo = new THREE.CylinderGeometry(0.092, 0.078, SHIN_LEN, 18);
  shinGeo.translate(0, -SHIN_LEN / 2, 0);
  knee.add(shadowed(new THREE.Mesh(shinGeo, trousers)));

  const ankle = new THREE.Group();
  ankle.position.y = -SHIN_LEN;
  knee.add(ankle);
  const shoe = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.15, 0.08, 0.3, 3, 0.035), shoeMat));
  shoe.position.set(0, -FOOT_H / 2 - 0.005, 0.06);
  ankle.add(shoe);
  const sole = new THREE.Mesh(new RoundedBoxGeometry(0.155, 0.022, 0.305, 2, 0.01), soleMat);
  sole.position.set(0, -FOOT_H + 0.004, 0.06);
  ankle.add(sole);

  return { side, hip, knee, ankle };
}

// ---------- posing ----------

// Poses the rig for one frame.
//   walk: 0 standing still, 1 full stride; phase advances with distance travelled
//   sit: 0 standing, 1 seated on a chair whose seat is at SIT_HIP
//   reach: 0 to 1, right arm reaching forward for a door handle
//   look: optional head yaw/pitch in radians
export function poseCharacter(ch, { t = 0, dt = 0, walk = 0, sit = 0, reach = 0, wave = 0, yaw = 0, pitch = 0 } = {}) {
  const phase = ch.walkPhase;
  const breathe = Math.sin(t * 1.6) * 0.006;

  // the body is highest when the legs pass each other, lowest at full stride
  const bob = walk * 0.03 * Math.cos(phase * 2);
  const standY = STAND_HIP - walk * 0.02 + bob;
  ch.pelvis.position.y = standY + (SIT_HIP - standY) * sit + breathe;
  ch.pelvis.position.z = -0.08 * sit;

  ch.body.rotation.y = walk * 0.07 * Math.sin(phase);
  // a little forward lean while walking and while lowering into the chair
  ch.body.rotation.x = walk * 0.05 + Math.sin(sit * Math.PI) * 0.22 + sit * 0.03;
  ch.body.scale.y = 1 + breathe * 0.5;

  for (const leg of ch.legs) {
    const lp = phase + (leg.side < 0 ? Math.PI : 0);
    const swing = -Math.sin(lp) * 0.48 * walk;
    // the knee folds most while the leg swings through
    const fold = walk * (0.08 + 0.75 * Math.max(0, Math.cos(lp)) ** 2);
    const hip = swing * (1 - sit) - (Math.PI / 2) * sit;
    const knee = fold * (1 - sit) + (Math.PI / 2) * sit;
    leg.hip.rotation.x = hip;
    leg.knee.rotation.x = knee;
    leg.ankle.rotation.x = -(hip + knee) * (1 - sit) * 0.7;
    // knees apart a touch when seated, like a relaxed sitter
    leg.hip.rotation.z = leg.side * 0.07 * sit;
  }

  for (const arm of ch.arms) {
    const lp = phase + (arm.side < 0 ? Math.PI : 0);
    const swing = Math.sin(lp) * 0.38 * walk;
    let shoulderX = swing * (1 - sit) - 0.55 * sit;
    let elbowX = -0.18 - 0.12 * walk - 0.75 * sit;
    let spread = arm.side * (0.09 + 0.02 * Math.sin(t * 1.6));

    if (arm.side < 0 && reach > 0) {
      // right hand out to the door handle
      shoulderX += (-1.25 - shoulderX) * reach;
      elbowX += (-0.25 - elbowX) * reach;
      spread += (arm.side * 0.02 - spread) * reach;
    }
    if (arm.side > 0 && wave > 0) {
      // upper arm forward, forearm up, a small side to side wiggle: a friendly "bye"
      shoulderX += (-1.1 - shoulderX) * wave;
      spread += (0.4 + Math.sin(t * 9) * 0.14 - spread) * wave;
      elbowX += (-1.55 - elbowX) * wave;
    }
    arm.shoulder.rotation.x = shoulderX;
    arm.shoulder.rotation.z = spread;
    arm.elbow.rotation.x = elbowX;
  }

  ch.head.rotation.y += (yaw - ch.head.rotation.y) * Math.min(1, dt * 6 || 1);
  ch.head.rotation.x += (pitch - ch.head.rotation.x) * Math.min(1, dt * 6 || 1);

  // blinks keep the turntable preview from looking like a statue
  if (t > ch.nextBlink) {
    ch.blink = 1;
    ch.nextBlink = t + 2.5 + Math.random() * 3;
  }
  const lid = ch.blink > 0 ? Math.abs(Math.cos(ch.blink * Math.PI)) : 1;
  for (const eye of ch.eyes) {
    eye.scale.y = Math.max(0.08, lid);
  }
  ch.blink = Math.max(0, ch.blink - dt * 7);
}

// Moves the walk cycle on by a distance in world units.
export function advanceWalk(ch, distance) {
  // one step covers about 0.62 m; a full cycle is two steps
  ch.walkPhase += (distance / (0.62 * CHAR_SCALE)) * Math.PI;
}

// Frees GPU buffers when a character is replaced.
export function disposeCharacter(ch) {
  ch.root.traverse((o) => {
    if (o.isMesh) {
      o.geometry.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.dispose();
      }
    }
  });
}
