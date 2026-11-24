import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import {
  AVATAR_Z,
  LOOK_CANDIDATE,
  TABLE_TOP,
  animateAvatar,
  buildChair,
  contactShadow,
  makeAvatar,
} from "./avatars.js";
import { CHAR_SCALE, SIT_HIP, buildCharacter, disposeCharacter, poseCharacter } from "./character.js";
import { buildCity } from "./city.js";

// The 3D interview room: the panel avatars, their animation, the candidate's walk in and out,
// and the webcam. main.js owns the interview flow and hands us read-only hooks for the flags it flips.

// Where the candidate's eyes are once seated, and where they look.
const SEAT_POS = new THREE.Vector3(0, 1.75, 6.2);
const SEAT_LOOK = new THREE.Vector3(0, 1.48, 0);

const DOOR_Z = 8.6;
const DOOR_W = 1.3;
const DOOR_H = 2.6;

// The hot seat itself, facing the panel, and where the candidate's feet are once seated.
const CHAIR_POS = new THREE.Vector3(0, 0, 6.5);
const SEAT_ROOT = new THREE.Vector3(0, 0, 6.42);

// The walk in: down the hallway to the door, then round the hot seat and into it.
const HALL_START_Z = 13.2;
const DOOR_STOP_Z = 9.3;
const ENTRY_PATH = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0.05, 0, DOOR_STOP_Z),
  new THREE.Vector3(0.12, 0, 8.2),
  new THREE.Vector3(0.62, 0, 7.25),
  new THREE.Vector3(0.82, 0, 6.35),
  new THREE.Vector3(0.45, 0, 5.88),
  new THREE.Vector3(0.05, 0, 5.92),
]);

// The walk out, the same loop in reverse, ending in the doorway facing the hallway.
const EXIT_PATH = new THREE.CatmullRomCurve3([
  new THREE.Vector3(0, 0, 5.92),
  new THREE.Vector3(0.48, 0, 5.86),
  new THREE.Vector3(0.84, 0, 6.4),
  new THREE.Vector3(0.7, 0, 7.35),
  new THREE.Vector3(0.18, 0, 8.25),
  new THREE.Vector3(0.05, 0, 8.78),
]);

const INTRO_DURATION = 8.4;
const OUTRO_DURATION = 6.3;

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const easeOut = (x) => 1 - (1 - x) * (1 - x);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Progress of a sub-step that runs from a to b inside a timeline, eased at both ends.
function phase(t, a, b) {
  return ease(clamp01((t - a) / (b - a)));
}

// 1 while walking between a and b, ramping up and down over ramp seconds at either end.
function stride(t, a, b, ramp = 0.35) {
  return clamp01(Math.min((t - a) / ramp, (b - t) / ramp));
}

function lerpAngle(a, b, k) {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) {
    d -= Math.PI * 2;
  }
  if (d < -Math.PI) {
    d += Math.PI * 2;
  }
  return a + d * k;
}

function headingOf(tangent) {
  return Math.atan2(tangent.x, tangent.z);
}

// The candidate's camera stream, once permission is granted. Null until then, or forever if denied.
let webcamStream = null;

export function getWebcamStream() {
  return webcamStream;
}

export function initScene(PANEL, MOOD_LABEL, hooks) {
  const canvas = document.getElementById("scene");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x14110f);
  scene.fog = new THREE.Fog(0x14110f, 11, 26);

  // A soft studio environment gives every surface gentle bounce light, which reads like ambient occlusion
  // without paying for a post pass.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 140);
  const camBase = SEAT_POS.clone();
  camera.position.copy(camBase);
  const camLook = SEAT_LOOK.clone();
  const camLookTarget = camLook.clone();

  // exit cinematic state; frozen holds the last frame as a still behind the score card
  let outro = null;
  let frozen = false;

  buildLights(scene);
  buildRoom(scene);
  buildCity(scene);
  const door = buildDoorAndHallway(scene);
  const monitor = buildWebcamMonitor(scene);

  // the hot seat, turned to face the panel
  const hotSeat = buildChair(SIT_HIP * CHAR_SCALE - 0.04, 0x2f2724);
  hotSeat.position.copy(CHAIR_POS);
  hotSeat.rotation.y = Math.PI;
  scene.add(hotSeat);

  const avatars = {};
  for (const id of Object.keys(PANEL)) {
    avatars[id] = makeAvatar(scene, id, PANEL[id]);
  }

  // ---------- the candidate ----------
  // Built from the character creator's choices; hidden whenever the camera is behind their eyes.
  let candidate = null;
  const candidateHead = new THREE.Vector3();

  function setCandidate(config) {
    if (candidate) {
      scene.remove(candidate.root);
      disposeCharacter(candidate);
    }
    candidate = buildCharacter(config);
    candidate.root.visible = false;
    scene.add(candidate.root);
    seatCandidate();
  }

  function seatCandidate() {
    candidate.root.position.copy(SEAT_ROOT);
    candidate.root.rotation.y = Math.PI;
    poseCharacter(candidate, { sit: 1 });
  }

  // Shows the candidate only once the camera is clear of their head, so the first person view
  // never looks out from inside a skull.
  function updateCandidateVisibility() {
    if (!candidate) {
      return;
    }
    candidate.root.updateMatrixWorld(true);
    candidate.head.getWorldPosition(candidateHead);
    const cinematic = intro !== null || outro !== null || frozen !== false;
    candidate.root.visible = cinematic && camera.position.distanceTo(candidateHead) > 1.3;
  }

  setCandidate(null);

  function setMood(id, mood) {
    const a = avatars[id];
    a.mood = mood;
    a.label.querySelector(".m").textContent = MOOD_LABEL[mood] || mood;
    if (mood === "impressed") {
      a.nod = 1;
    }
  }

  function lookAt(id, target) {
    if (target === "candidate") {
      avatars[id].look.copy(LOOK_CANDIDATE);
    } else {
      const t = avatars[target];
      avatars[id].look.set(t.g.position.x, 2.0, t.g.position.z);
    }
  }

  function allLookAt(target) {
    for (const id of Object.keys(avatars)) {
      if (id !== target) {
        lookAt(id, target);
      } else {
        lookAt(id, "candidate");
      }
    }
  }

  // A small nudge toward the speaker; a big swing would push the far member off screen.
  function focusOn(id) {
    if (!id) {
      camLookTarget.copy(SEAT_LOOK);
      camBase.x = 0;
      return;
    }
    camLookTarget.set(avatars[id].g.position.x * 0.3, 1.58, 0);
    camBase.x = avatars[id].g.position.x * 0.1;
  }

  // ---------- framing ----------
  // The ledger (and later the score card) covers the right side of the window. Rather than
  // moving the camera, the projection is shifted so the picture's centre sits in the middle of
  // the part that is still visible, and the lens widens when that part gets narrow.
  const ledgerEl = document.getElementById("ledger");
  const verdictEl = document.getElementById("verdict");
  let inset = 0;

  function verdictInset() {
    const w = innerWidth;
    if (w < 900) {
      return 0;
    }
    // matches #verdict: min(460px, 100vw - 32px) wide, 24px from the right, plus breathing room
    return Math.min(460, w - 32) + 24 + 16;
  }

  function targetInset() {
    let px = 0;
    if (outro || frozen) {
      px = verdictInset();
    } else if (verdictEl && !verdictEl.classList.contains("hidden")) {
      px = verdictInset();
    } else if (ledgerEl && !ledgerEl.classList.contains("hidden")) {
      px = ledgerEl.offsetWidth + 16 + 8;
    }
    // on a narrow window the panels stack over the scene anyway, so keep the full frame
    if (innerWidth - px < 520) {
      return 0;
    }
    return px;
  }

  function applyFraming() {
    const w = innerWidth;
    const h = innerHeight;
    const usable = w - inset;

    // The panel spans about 0.46 of the view distance either side of centre; keep that inside
    // the usable width, never going tighter than the default 38 degree lens.
    let tanHalf = Math.tan(THREE.MathUtils.degToRad(19));
    tanHalf = Math.max(tanHalf, 0.46 / (usable / h));
    camera.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalf));

    if (inset > 0.5) {
      camera.aspect = (w + inset) / h;
      camera.setViewOffset(w + inset, h, inset, 0, w, h);
    } else {
      camera.aspect = w / h;
      camera.clearViewOffset();
    }
    camera.updateProjectionMatrix();
  }

  function resize() {
    renderer.setSize(innerWidth, innerHeight, false);
    if (frozen === true) {
      inset = targetInset();
    }
    applyFraming();
    if (frozen === true) {
      renderer.render(scene, camera);
    }
  }
  addEventListener("resize", resize);
  resize();

  // ---------- door intro ----------
  // While intro is set, the camera follows the candidate's walk in instead of the seated drift.
  let intro = null;
  let debugCam = null;
  // dev only: pins the cinematic clock so screenshot scripts can grab an exact moment
  let holdAt = null;
  const labelsEl = document.getElementById("labels");

  function playIntro() {
    if (intro) {
      return intro.promise;
    }

    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    intro = { start: null, duration: INTRO_DURATION, promise, resolve, blendFrom: null };
    labelsEl.classList.add("intro");
    document.body.classList.add("intro-playing");

    // coming back in after a verdict: thaw the frozen still and drop the old moods
    unfreeze();
    introFinished = false;
    if (selfView) {
      selfView.classList.add("hidden");
    }

    // Everyone starts with their eyes on their own notes, then looks up when the door opens.
    for (const a of Object.values(avatars)) {
      a.nod = 0;
      a.introNodded = false;
      a.mood = "neutral";
      a.label.querySelector(".m").textContent = MOOD_LABEL.neutral || "neutral";
    }

    const hint = document.getElementById("skipHint");
    if (hint) {
      hint.classList.remove("hidden");
    }

    const skip = () => {
      if (intro && intro.start !== null) {
        intro.skipped = true;
      }
    };
    addEventListener("pointerdown", skip);
    addEventListener("keydown", skip);
    promise.then(() => {
      removeEventListener("pointerdown", skip);
      removeEventListener("keydown", skip);
      if (hint) {
        hint.classList.add("hidden");
      }
    });
    return promise;
  }

  function finishIntro() {
    const done = intro;
    intro = null;
    door.pivot.rotation.y = door.openAngle;
    camera.position.copy(camBase);
    camLook.copy(camLookTarget);
    seatCandidate();
    labelsEl.classList.remove("intro");
    document.body.classList.remove("intro-playing");
    for (const a of Object.values(avatars)) {
      a.waving = 0;
    }
    introFinished = true;
    revealSelfView();
    done.resolve();
  }

  // Poses the candidate for time t of the walk in. Everything here is a function of t alone,
  // so a skipped or paused clock always lands on a consistent pose.
  function poseEntrance(t, dt) {
    const root = candidate.root;
    const hallLen = HALL_START_Z - DOOR_STOP_Z;
    const pathLen = ENTRY_PATH.getLength();

    // down the hallway, already in stride, slowing to a stop at the door
    const uh = easeOut(clamp01(t / 2.5));
    // through the door and round the chair
    const ui = phase(t, 3.35, 6.1);
    let walk = 0;
    let heading = Math.PI;

    if (t < 3.35) {
      root.position.set(0.05, 0, HALL_START_Z - hallLen * uh);
      walk = clamp01((2.5 - t) / 0.45);
    } else {
      ENTRY_PATH.getPointAt(ui, root.position);
      heading = headingOf(ENTRY_PATH.getTangentAt(Math.min(ui, 0.999), tmpB));
      walk = stride(t, 3.35, 6.1);
    }

    // then turn to face the panel and lower into the seat
    const settle = phase(t, 6.0, 7.0);
    if (settle > 0) {
      const end = ENTRY_PATH.getPointAt(1, tmpC);
      root.position.lerpVectors(end, SEAT_ROOT, settle);
      heading = lerpAngle(heading, Math.PI, phase(t, 5.9, 6.5));
    }
    root.rotation.y = heading;

    // stride count follows the ground covered, so feet never skate
    candidate.walkPhase = ((hallLen * uh + pathLen * ui) / (0.62 * CHAR_SCALE)) * Math.PI;

    // reach for the handle, push, let go
    const reach = phase(t, 2.15, 2.6) * (1 - phase(t, 3.2, 3.7));

    // a glance at the panel once inside
    const yaw = t > 4.4 && t < 6.2 ? -0.25 * stride(t, 4.4, 6.2, 0.4) : 0;
    poseCharacter(candidate, { t: clockT, dt, walk, sit: phase(t, 6.25, 7.05), reach, yaw });
  }

  // Returns how far into the walk in we are, or -1 when no intro is running.
  // Time advances by the clamped frame delta, so a main thread stall (model loading on the
  // same click) pauses the walk instead of skipping half of it.
  function updateIntro(dt) {
    if (!intro) {
      return -1;
    }
    let first = false;
    if (intro.start === null) {
      intro.start = 0;
      door.pivot.rotation.y = 0;
      first = true;
    } else {
      intro.start += dt;
    }
    if (holdAt !== null) {
      intro.start = holdAt;
    }
    const t = intro.start;
    if (intro.skipped || t >= intro.duration) {
      finishIntro();
      return -1;
    }

    door.pivot.rotation.y = door.openAngle * phase(t, 2.55, 3.8);
    poseEntrance(t, dt);
    const p = candidate.root.position;

    // The camera trails the candidate: behind them in the hallway, straight through the door,
    // then up over their shoulder to watch them take the seat.
    const camTarget = tmpA;
    const lookTarget = tmpB;
    if (p.z > 8.3) {
      // behind and to the right, so the candidate sits left of centre with the door ahead
      camTarget.set(0.5, 2.5, Math.min(p.z + 3.4, 16.2));
      lookTarget.set(0.38, 1.25, p.z - 3);
    } else if (p.z > 7.2 && t < 5.2) {
      camTarget.set(0.1, 2.3, Math.min(p.z + 2.6, 10.6));
      lookTarget.set(p.x * 0.5, 1.2, p.z - 3);
    } else {
      camTarget.set(1.7, 2.75, 8.25);
      lookTarget.set(-0.35, 1.05, 3.4);
    }

    const k = first || holdAt !== null ? 1 : 1 - Math.exp(-dt * 3.2);
    if (t < 7.0) {
      camera.position.lerp(camTarget, k);
      camLook.lerp(lookTarget, k);
    } else {
      // last stretch: blend from wherever the follow cam is into the seated first person view
      if (!intro.blendFrom) {
        intro.blendFrom = { pos: camera.position.clone(), look: camLook.clone() };
      }
      const b = phase(t, 7.0, intro.duration);
      camera.position.lerpVectors(intro.blendFrom.pos, camBase, b);
      camLook.lerpVectors(intro.blendFrom.look, camLookTarget, b);
    }
    return t;
  }

  // ---------- exit cinematic ----------
  // After the verdict the candidate stands, walks round the chair and out to the door. The
  // camera cuts to the hallway and the scene freezes with them in the doorway, the room behind.
  const EXIT_SIDE_CAM = new THREE.Vector3(-1.75, 2.2, 3.7);
  const EXIT_SIDE_LOOK = new THREE.Vector3(0.3, 1.35, 7.0);
  const EXIT_HALL_CAM = new THREE.Vector3(0.35, 1.7, 14.3);
  const EXIT_HALL_LOOK = new THREE.Vector3(-0.05, 1.35, 7.0);

  function playExit() {
    if (outro) {
      return outro.promise;
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });

    outro = {
      start: null,
      duration: OUTRO_DURATION,
      promise,
      resolve,
      from: camera.position.clone(),
      fromLook: camLook.clone(),
    };
    labelsEl.classList.add("intro");
    if (selfView) {
      selfView.classList.add("hidden");
    }

    const skip = () => {
      if (outro && outro.start !== null) {
        outro.skipped = true;
      }
    };
    addEventListener("pointerdown", skip);
    addEventListener("keydown", skip);
    promise.then(() => {
      removeEventListener("pointerdown", skip);
      removeEventListener("keydown", skip);
    });
    return promise;
  }

  function poseExit(t, dt) {
    const root = candidate.root;
    const pathLen = EXIT_PATH.getLength();

    // stand up and step forward out of the chair
    const stand = phase(t, 0.6, 1.4);
    const start = EXIT_PATH.getPointAt(0, tmpC);
    root.position.lerpVectors(SEAT_ROOT, start, stand);
    let heading = Math.PI;

    // round the chair and out
    const u = phase(t, 1.35, 4.9);
    if (u > 0) {
      EXIT_PATH.getPointAt(u, root.position);
      const along = headingOf(EXIT_PATH.getTangentAt(Math.min(Math.max(u, 0.02), 0.999), tmpB));
      heading = lerpAngle(Math.PI, along, phase(t, 1.35, 1.9));
    }
    // in the doorway, square up to the hallway
    heading = lerpAngle(heading, 0, phase(t, 4.6, 5.2));
    root.rotation.y = heading;

    candidate.walkPhase = ((pathLen * u) / (0.62 * CHAR_SCALE)) * Math.PI;

    // one look back over the shoulder at the panel, with a small wave goodbye
    const back = phase(t, 4.9, 5.5);
    poseCharacter(candidate, {
      t: clockT,
      dt,
      walk: stride(t, 1.35, 4.9, 0.45),
      sit: 1 - stand,
      yaw: 0.85 * back,
      pitch: -0.05 * back,
      wave: phase(t, 5.1, 5.6),
    });
  }

  function updateOutro(dt) {
    if (!outro) {
      return -1;
    }
    if (outro.start === null) {
      outro.start = 0;
    } else {
      outro.start += dt;
    }
    if (holdAt !== null) {
      outro.start = holdAt;
    }
    let t = outro.start;
    const last = outro.skipped || t >= outro.duration;
    if (last) {
      t = outro.duration;
    }

    poseExit(t, dt);

    if (t < 3.1) {
      // pull back from the seat to a wide shot across the table
      const b = phase(t, 0, 1.2);
      camera.position.lerpVectors(outro.from, EXIT_SIDE_CAM, b);
      camLook.lerpVectors(outro.fromLook, EXIT_SIDE_LOOK, b);
    } else {
      // cut to the hallway, looking back into the room as they come through the door
      const drift = phase(t, 3.1, outro.duration);
      camera.position.copy(EXIT_HALL_CAM);
      camera.position.z -= 0.35 * drift;
      camLook.copy(EXIT_HALL_LOOK);
    }

    if (last) {
      const done = outro;
      outro = null;
      for (const a of Object.values(avatars)) {
        a.waving = 0;
      }
      // render this exact frame once more below, then stop drawing so it stays as a still
      frozen = "next";
      document.body.classList.add("frozen");
      done.resolve();
      return t;
    }
    return t;
  }

  function unfreeze() {
    frozen = false;
    document.body.classList.remove("frozen");
  }

  // ---------- webcam ----------
  let introFinished = false;
  const selfView = document.getElementById("selfview");
  const selfVideo = document.getElementById("selfVideo");
  const selfToggle = document.getElementById("selfToggle");

  if (selfToggle) {
    selfToggle.addEventListener("click", (e) => {
      // the toggle sits inside the scene, so keep the click from also skipping the intro
      e.stopPropagation();
      const off = selfView.classList.toggle("off");
      selfToggle.textContent = off ? "Show me" : "Hide";
      selfToggle.title = off ? "Show your camera" : "Hide your camera";
    });
  }

  // The self view floats above the dock, whose height changes with captions and status text.
  const dock = document.getElementById("dock");
  if (dock && "ResizeObserver" in window) {
    new ResizeObserver(() => {
      document.documentElement.style.setProperty("--dock-h", `${dock.offsetHeight}px`);
    }).observe(dock);
  }

  function revealSelfView() {
    if (webcamStream && introFinished && selfView) {
      selfView.classList.remove("hidden");
    }
  }

  async function startWebcam() {
    if (webcamStream || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !selfVideo) {
      return false;
    }
    try {
      webcamStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
        audio: false,
      });
    } catch {
      // Denied or no camera: the interview works fine without the self view, so stay quiet.
      webcamStream = null;
      return false;
    }

    selfVideo.srcObject = webcamStream;
    // other modules (gaze tracking) reuse this stream instead of asking for the camera twice
    window.hotseatWebcam = { stream: webcamStream, video: selfVideo };
    dispatchEvent(new CustomEvent("hotseat:webcam", { detail: window.hotseatWebcam }));
    try {
      await selfVideo.play();
    } catch {
      // autoplay of a muted inline video is allowed, but never let a refusal break the interview
    }
    monitor.showVideo(selfVideo);
    revealSelfView();
    return true;
  }

  // ---------- animation loop ----------
  const timer = new THREE.Timer();
  const tmpA = new THREE.Vector3();
  const tmpB = new THREE.Vector3();
  const tmpC = new THREE.Vector3();
  let clockT = 0;

  function animate(timestamp) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();
    clockT = t;

    if (frozen === true) {
      // the verdict still: keep the last drawn frame instead of rendering
      requestAnimationFrame(animate);
      return;
    }

    const introT = updateIntro(dt);
    const outroT = updateOutro(dt);
    const conferring = hooks.isConferring();
    const whisperer = hooks.whisperer();
    updateCandidateVisibility();

    for (const a of Object.values(avatars)) {
      if (introT >= 0) {
        // heads down over their notes, then up at the door as it opens, following the walk in
        if (introT < 2.7) {
          a.look.set(a.g.position.x * 0.9, 1.0, 0.7);
        } else {
          a.look.copy(candidateHead);
        }
        if (a.id === "manager" && introT > 4.2 && introT < 5.8) {
          a.waving = 1;
        } else {
          a.waving = 0;
        }
        if (a.id === "manager" && introT > 7.0 && a.nod === 0 && !a.introNodded) {
          a.nod = 1;
          a.introNodded = true;
        }
        if (a.id === "tech" && introT > 4.6 && a.nod === 0 && !a.introNodded) {
          a.nod = 0.7;
          a.introNodded = true;
        }
      } else if (outroT >= 0) {
        // the panel watches the candidate leave, Maya waves goodbye
        a.look.copy(candidateHead);
        const waving = (outroT > 1.4 && outroT < 3.2) || (outroT > 5.1 && outroT < 6.3);
        a.waving = a.id === "manager" && waving ? 1 : 0;
      } else if (conferring) {
        // conferring: heads turn to each other and lean in
        const others = Object.keys(avatars).filter((k) => k !== a.id);
        if (whisperer && whisperer !== a.id) {
          lookAt(a.id, whisperer);
        } else {
          // the whisperer (or everyone, between whispers) glances from one colleague to the other
          const pick = others[Math.floor(((t * 0.7 + a.g.position.x) % 2) + 2) % 2];
          lookAt(a.id, pick);
        }
      }

      animateAvatar(a, t, dt, conferring, tmpA, tmpB);
    }

    if (debugCam) {
      camera.position.copy(debugCam.pos);
      camera.lookAt(debugCam.look);
    } else if (introT >= 0 || outroT >= 0 || frozen) {
      camera.lookAt(camLook);
    } else {
      // camera drifts toward speaker
      camera.position.x += (camBase.x + Math.sin(t * 0.25) * 0.15 - camera.position.x) * 0.02;
      camera.position.y += (camBase.y - camera.position.y) * 0.05;
      camera.position.z += (camBase.z - camera.position.z) * 0.05;
      camLook.lerp(camLookTarget, 0.04);
      camera.lookAt(camLook);
    }

    // ease the framing toward whatever panel is open; the still is framed for the score card
    const wanted = targetInset();
    const snap = frozen === "next" || holdAt !== null;
    inset += snap ? wanted - inset : (wanted - inset) * Math.min(1, dt * 4);
    applyFraming();

    // labels sit just above the heads; projected after the framing so they match this frame
    camera.updateMatrixWorld();
    for (const a of Object.values(avatars)) {
      tmpA.set(a.g.position.x, 2.62, a.g.position.z).project(camera);
      a.label.style.left = `${(tmpA.x * 0.5 + 0.5) * innerWidth}px`;
      a.label.style.top = `${(-tmpA.y * 0.5 + 0.5) * innerHeight}px`;
    }

    monitor.update(t);
    renderer.render(scene, camera);
    if (frozen === "next") {
      frozen = true;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Dev-only hooks for screenshot scripts: close-ups, a forced speaking state and a paused clock.
  if (import.meta.env.DEV) {
    window.__hotseatDebug = {
      closeUp(id) {
        if (!id) {
          debugCam = null;
          return;
        }
        const x = avatars[id].g.position.x;
        debugCam = { pos: new THREE.Vector3(x, 2.05, 1.9), look: new THREE.Vector3(x, 1.7, AVATAR_Z) };
      },
      view(pos, look) {
        debugCam = pos ? { pos: new THREE.Vector3(...pos), look: new THREE.Vector3(...look) } : null;
      },
      hold(t) {
        holdAt = t;
      },
      speak(id, on) {
        avatars[id].speaking = on;
      },
      mood: setMood,
    };
  }

  return { avatars, setMood, lookAt, allLookAt, focusOn, playIntro, playExit, startWebcam, setCandidate };
}

// ---------- lights and room ----------

function buildLights(scene) {
  scene.add(new THREE.HemisphereLight(0xffe7c8, 0x1a1410, 0.4));

  // Warm key from above and in front, with a wide soft shadow.
  const key = new THREE.SpotLight(0xffd2a0, 70, 22, Math.PI / 3.6, 0.65, 1.3);
  key.position.set(0.6, 6.2, 3.2);
  key.target.position.set(0, 1.2, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.radius = 6;
  key.shadow.blurSamples = 16;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);

  // Cool rim from the window side separates the heads from the dark wall.
  const rim = new THREE.DirectionalLight(0x8fb4ff, 0.9);
  rim.position.set(-4, 4, -5);
  scene.add(rim);

  // The city's glow coming through the window: a broad, cool wash over the panel's shoulders.
  const spill = new THREE.SpotLight(0x9bb6ff, 14, 14, Math.PI / 3, 0.9, 1.4);
  spill.position.set(0, 3.6, -4.4);
  spill.target.position.set(0, 0.6, 1.5);
  scene.add(spill, spill.target);

  // Low warm fill from the candidate side so faces never go muddy.
  const fill = new THREE.PointLight(0xffc48a, 6, 12, 1.6);
  fill.position.set(0, 1.6, 4.5);
  scene.add(fill);
}

function woodTexture() {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 128;
  const g = c.getContext("2d");
  g.fillStyle = "#6a462d";
  g.fillRect(0, 0, c.width, c.height);

  // long soft streaks are enough to read as grain from the candidate's chair
  for (let i = 0; i < 90; i++) {
    const y = Math.random() * c.height;
    g.strokeStyle = `rgba(${40 + Math.random() * 30}, ${22 + Math.random() * 16}, 10, ${0.08 + Math.random() * 0.14})`;
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    g.moveTo(0, y);
    for (let x = 0; x <= c.width; x += 32) {
      g.lineTo(x, y + Math.sin(x * 0.01 + i) * 3);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// The window opening in the back wall, centred above the panel.
const WIN = { w: 5.6, bottom: 2.2, top: 4.7, z: -4 };

function buildRoom(scene) {
  // The floor stops at the door wall, so it never overlaps the hallway floor beyond it.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(32, DOOR_Z + 4),
    new THREE.MeshStandardMaterial({ color: 0x2a221d, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(0, 0, (DOOR_Z - 4) / 2);
  floor.receiveShadow = true;
  scene.add(floor);

  // the back wall is one shape with the window cut out of it, so there are no seams to show
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a211c, roughness: 1 });
  const outline = new THREE.Shape();
  outline.moveTo(-15, 0);
  outline.lineTo(15, 0);
  outline.lineTo(15, 10);
  outline.lineTo(-15, 10);
  outline.lineTo(-15, 0);
  const hole = new THREE.Path();
  hole.moveTo(-WIN.w / 2, WIN.bottom);
  hole.lineTo(-WIN.w / 2, WIN.top);
  hole.lineTo(WIN.w / 2, WIN.top);
  hole.lineTo(WIN.w / 2, WIN.bottom);
  hole.lineTo(-WIN.w / 2, WIN.bottom);
  outline.holes.push(hole);
  const wall = new THREE.Mesh(new THREE.ShapeGeometry(outline), wallMat);
  wall.position.z = WIN.z;
  wall.receiveShadow = true;
  scene.add(wall);

  buildWindowFrame(scene, wallMat);

  // table: rounded top with grain, darker modesty panel in front
  const tex = woodTexture();
  tex.repeat.set(3, 1);
  const wood = new THREE.MeshStandardMaterial({ color: 0xffffff, map: tex, roughness: 0.48 });
  const table = new THREE.Mesh(new RoundedBoxGeometry(7.4, 0.12, 1.5, 4, 0.05), wood);
  table.position.set(0, TABLE_TOP - 0.06, 0.75);
  table.castShadow = true;
  table.receiveShadow = true;
  scene.add(table);

  const front = new THREE.Mesh(
    new RoundedBoxGeometry(7.2, 0.88, 0.06, 2, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x3f2a1c, roughness: 0.7 }),
  );
  front.position.set(0, 0.5, 1.4);
  front.castShadow = true;
  front.receiveShadow = true;
  scene.add(front);

  const floorShadow = contactShadow(8.5, 2.6, 0.55);
  floorShadow.position.set(0, 0.005, 0.7);
  scene.add(floorShadow);

  // a long pendant lamp over the table, the visible source of the warm key light
  const lamp = new THREE.Mesh(
    new RoundedBoxGeometry(3.2, 0.06, 0.16, 2, 0.02),
    new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.5 }),
  );
  lamp.position.set(0, 3.55, 0.6);
  scene.add(lamp);
  const glow = new THREE.Mesh(new THREE.PlaneGeometry(3.1, 0.1), new THREE.MeshBasicMaterial({ color: 0xffe2b8 }));
  glow.rotation.x = Math.PI / 2;
  glow.position.set(0, 3.515, 0.6);
  scene.add(glow);
  for (const s of [-1, 1]) {
    const wire = new THREE.Mesh(
      new THREE.CylinderGeometry(0.004, 0.004, 2.5),
      new THREE.MeshBasicMaterial({ color: 0x0c0a09 }),
    );
    wire.position.set(s * 1.4, 4.8, 0.6);
    scene.add(wire);
  }

  // plant in the corner, built from a pot and a few leaf clusters so it is not a lone cone
  const plant = new THREE.Group();
  const pot = new THREE.Mesh(
    new THREE.CylinderGeometry(0.3, 0.24, 0.55, 24),
    new THREE.MeshStandardMaterial({ color: 0x8a5a3c, roughness: 0.8 }),
  );
  pot.position.y = 0.275;
  pot.castShadow = true;
  plant.add(pot);
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x2f6b40, roughness: 0.7 });
  for (let i = 0; i < 7; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.28, 16, 12), leafMat);
    const a = (i / 7) * Math.PI * 2;
    leaf.position.set(Math.cos(a) * 0.18, 0.85 + (i % 3) * 0.28, Math.sin(a) * 0.18);
    leaf.scale.set(0.8, 1.3, 0.8);
    leaf.castShadow = true;
    plant.add(leaf);
  }
  plant.position.set(-4.6, 0, -1.6);
  scene.add(plant);
}

// Window reveal, frame, mullions, a transom and a sill, all with real depth so the opening
// reads as a window in a thick wall and not a picture on it.
function buildWindowFrame(scene, wallMat) {
  const depth = 0.32;
  const h = WIN.top - WIN.bottom;
  const midY = (WIN.top + WIN.bottom) / 2;

  // the reveal: inner faces of the opening, lit faintly blue by the city
  const revealMat = new THREE.MeshStandardMaterial({
    color: 0x2c2622,
    roughness: 0.95,
    emissive: 0x1a2440,
    emissiveIntensity: 0.35,
  });
  for (const s of [-1, 1]) {
    const jamb = new THREE.Mesh(new THREE.PlaneGeometry(depth, h), revealMat);
    jamb.rotation.y = -s * (Math.PI / 2);
    jamb.position.set(s * (WIN.w / 2), midY, WIN.z - depth / 2);
    scene.add(jamb);
  }
  const head = new THREE.Mesh(new THREE.PlaneGeometry(WIN.w, depth), revealMat);
  head.rotation.x = Math.PI / 2;
  head.position.set(0, WIN.top, WIN.z - depth / 2);
  scene.add(head);

  const frameMat = new THREE.MeshStandardMaterial({ color: 0x1b1714, roughness: 0.45, metalness: 0.35 });
  const glassZ = WIN.z - depth + 0.06;
  const bar = (w, hh, x, y, d = 0.1) => {
    const m = new THREE.Mesh(new RoundedBoxGeometry(w, hh, d, 2, 0.012), frameMat);
    m.position.set(x, y, glassZ);
    scene.add(m);
  };

  // outer frame
  bar(WIN.w, 0.09, 0, WIN.top - 0.045);
  bar(WIN.w, 0.09, 0, WIN.bottom + 0.045);
  bar(0.09, h, -WIN.w / 2 + 0.045, midY);
  bar(0.09, h, WIN.w / 2 - 0.045, midY);

  // four mullions make five tall panes, and a transom marks the low opening lights
  for (let i = 1; i < 5; i++) {
    bar(0.07, h, -WIN.w / 2 + (WIN.w / 5) * i, midY, 0.12);
  }
  bar(WIN.w, 0.06, 0, WIN.bottom + 0.55, 0.1);

  // glass: almost invisible, it only catches a little of the room's reflections
  const glass = new THREE.Mesh(
    new THREE.PlaneGeometry(WIN.w, h),
    new THREE.MeshStandardMaterial({
      color: 0x9fb8d8,
      transparent: true,
      opacity: 0.07,
      roughness: 0.05,
      metalness: 0.6,
      depthWrite: false,
    }),
  );
  glass.position.set(0, midY, glassZ - 0.02);
  scene.add(glass);

  // the sill sticks out into the room with a rounded nose, and catches a band of cool light
  const sill = new THREE.Mesh(new RoundedBoxGeometry(WIN.w + 0.4, 0.07, depth + 0.2, 3, 0.025), wallMat);
  sill.position.set(0, WIN.bottom - 0.03, WIN.z - depth / 2 + 0.1);
  sill.receiveShadow = true;
  scene.add(sill);
  const sillGlow = new THREE.Mesh(
    new THREE.PlaneGeometry(WIN.w, depth),
    new THREE.MeshBasicMaterial({ color: 0x3a4a7a, transparent: true, opacity: 0.35, depthWrite: false }),
  );
  sillGlow.rotation.x = -Math.PI / 2;
  sillGlow.position.set(0, WIN.bottom + 0.006, WIN.z - depth / 2);
  scene.add(sillGlow);

  // a soft glow on the wall around the opening, as if the night outside lights the plaster
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(WIN.w + 2.4, h + 1.6),
    new THREE.MeshBasicMaterial({ map: haloTexture(), transparent: true, depthWrite: false, opacity: 0.5 }),
  );
  halo.position.set(0, midY, WIN.z + 0.01);
  scene.add(halo);
}

function haloTexture() {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d");
  const grad = g.createRadialGradient(128, 64, 30, 128, 64, 128);
  grad.addColorStop(0, "rgba(90,110,170,0.55)");
  grad.addColorStop(1, "rgba(90,110,170,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- door and hallway for the walk in ----------

function buildDoorAndHallway(scene) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a211c, roughness: 1 });
  const hallMat = new THREE.MeshStandardMaterial({ color: 0x5b5147, roughness: 0.95 });
  const doorW = DOOR_W;
  const doorH = DOOR_H;

  // back wall of the interview room, with a doorway cut out of it
  const side = (30 - doorW) / 2;
  for (const s of [-1, 1]) {
    const part = new THREE.Mesh(new THREE.BoxGeometry(side, 6, 0.2), wallMat);
    part.position.set(s * (doorW / 2 + side / 2), 3, DOOR_Z);
    scene.add(part);
  }
  const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorW, 6 - doorH, 0.2), wallMat);
  lintel.position.set(0, doorH + (6 - doorH) / 2, DOOR_Z);
  scene.add(lintel);

  // frame trim around the doorway
  const trimMat = new THREE.MeshStandardMaterial({ color: 0xd8cbb8, roughness: 0.6 });
  for (const s of [-1, 1]) {
    // the trim overlaps the wall by a centimetre, so its faces never share a plane with the wall's
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.1, doorH + 0.09, 0.26), trimMat);
    post.position.set(s * (doorW / 2 + 0.04), (doorH + 0.09) / 2 - 0.01, DOOR_Z);
    scene.add(post);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.18, 0.1, 0.26), trimMat);
  head.position.set(0, doorH + 0.04, DOOR_Z);
  scene.add(head);

  // the hallway beyond: narrow, lighter, lit from the ceiling
  const hallLen = 8;
  const hallMid = DOOR_Z + hallLen / 2;
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3, hallLen), hallMat);
    w.position.set(s * 1.15, 1.5, hallMid);
    w.receiveShadow = true;
    scene.add(w);
  }
  const hallFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(2.3, hallLen),
    new THREE.MeshStandardMaterial({ color: 0x3b3029, roughness: 0.6 }),
  );
  hallFloor.rotation.x = -Math.PI / 2;
  hallFloor.position.set(0, 0, hallMid);
  hallFloor.receiveShadow = true;
  scene.add(hallFloor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2.3, hallLen), hallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 3, hallMid);
  scene.add(ceiling);
  const endWall = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 3), hallMat);
  endWall.rotation.y = Math.PI;
  endWall.position.set(0, 1.5, DOOR_Z + hallLen);
  scene.add(endWall);
  for (const z of [DOOR_Z + 1.4, DOOR_Z + 4, DOOR_Z + 6.6]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.9), new THREE.MeshBasicMaterial({ color: 0xfff1da }));
    panel.rotation.x = Math.PI / 2;
    panel.position.set(0, 2.99, z);
    scene.add(panel);
  }
  const hallLight = new THREE.PointLight(0xffeedd, 8, 6, 1.5);
  hallLight.position.set(0, 2.6, DOOR_Z + 2.2);
  scene.add(hallLight);
  const hallLight2 = new THREE.PointLight(0xffeedd, 5, 5, 1.5);
  hallLight2.position.set(0, 2.6, DOOR_Z + 5.2);
  scene.add(hallLight2);

  // a soft fill aimed back at the doorway, so a candidate standing in it is not a silhouette
  const doorFill = new THREE.SpotLight(0xffe2c4, 9, 7, Math.PI / 5, 0.8, 1.5);
  doorFill.position.set(0.4, 2.2, DOOR_Z + 3.2);
  doorFill.target.position.set(0, 1.4, DOOR_Z);
  scene.add(doorFill, doorFill.target);

  // the door itself, hinged on the left so it swings into the room
  const pivot = new THREE.Group();
  pivot.position.set(-doorW / 2, 0, DOOR_Z);
  const doorMesh = new THREE.Mesh(
    new RoundedBoxGeometry(doorW - 0.02, doorH - 0.02, 0.06, 2, 0.015),
    new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.55 }),
  );
  doorMesh.position.set(doorW / 2, doorH / 2, 0);
  doorMesh.castShadow = true;
  pivot.add(doorMesh);

  // recessed panels so the door is not a flat slab
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x5c3f2b, roughness: 0.6 });
  for (const y of [0.66, 1.84]) {
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new RoundedBoxGeometry(doorW - 0.3, 0.9, 0.02, 2, 0.01), panelMat);
      p.position.set(doorW / 2, y, s * 0.032);
      pivot.add(p);
    }
  }
  const knobMat = new THREE.MeshStandardMaterial({ color: 0xd6b46a, metalness: 0.8, roughness: 0.3 });
  for (const s of [-1, 1]) {
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), knobMat);
    knob.position.set(doorW - 0.12, 1.05, s * 0.06);
    pivot.add(knob);
  }
  // starts open, so the seated view never sees a closed door behind it
  const openAngle = 1.75;
  pivot.rotation.y = openAngle;
  scene.add(pivot);

  return { pivot, openAngle };
}

// ---------- webcam monitor on the table ----------

function buildWebcamMonitor(scene) {
  const group = new THREE.Group();
  const shell = new THREE.MeshStandardMaterial({ color: 0x1c1c1f, roughness: 0.4, metalness: 0.3 });

  const bezel = new THREE.Mesh(new RoundedBoxGeometry(0.62, 0.42, 0.03, 2, 0.012), shell);
  bezel.position.y = 0.34;
  bezel.castShadow = true;
  group.add(bezel);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.022, 0.16, 12), shell);
  neck.position.set(0, 0.1, -0.03);
  group.add(neck);
  const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.13, 0.015, 24), shell);
  foot.position.set(0, 0.008, -0.02);
  foot.castShadow = true;
  group.add(foot);

  // Placeholder until a camera stream arrives: a quiet "camera off" card.
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 160;
  const g = c.getContext("2d");
  g.fillStyle = "#15202b";
  g.fillRect(0, 0, 256, 160);
  g.fillStyle = "#6f8aa3";
  g.font = "600 20px Inter, sans-serif";
  g.textAlign = "center";
  g.fillText("camera off", 128, 88);
  const idleTex = new THREE.CanvasTexture(c);
  idleTex.colorSpace = THREE.SRGBColorSpace;

  const screenMat = new THREE.MeshBasicMaterial({ map: idleTex, toneMapped: false });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.57, 0.37), screenMat);
  screen.position.set(0, 0.34, 0.0165);
  group.add(screen);

  // a little red recording light, because it is a camera feed
  const led = new THREE.Mesh(new THREE.CircleGeometry(0.008, 12), new THREE.MeshBasicMaterial({ color: 0x3a1a1a }));
  led.position.set(0.27, 0.145, 0.0165);
  group.add(led);

  const shadow = contactShadow(0.5, 0.4, 0.5);
  shadow.position.y = 0.002;
  group.add(shadow);

  // on the table between Maya and Theo, turned so both the panel and the candidate can see the feed
  group.position.set(-1.0, TABLE_TOP, 1.12);
  group.rotation.y = 0.3;
  group.scale.setScalar(0.82);
  scene.add(group);

  let live = false;
  return {
    showVideo(video) {
      const tex = new THREE.VideoTexture(video);
      tex.colorSpace = THREE.SRGBColorSpace;
      // mirror it, the same way the picture-in-picture shows the candidate
      tex.repeat.x = -1;
      tex.offset.x = 1;
      screenMat.map = tex;
      screenMat.needsUpdate = true;
      live = true;
    },
    update(t) {
      led.material.color.setHex(live && Math.sin(t * 3) > -0.3 ? 0xff4a3a : 0x3a1a1a);
    },
  };
}
