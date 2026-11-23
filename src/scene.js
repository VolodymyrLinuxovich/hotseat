import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

// The 3D interview room: the panel avatars, their animation, the door walk-in and the webcam.
// main.js owns the interview flow and hands us read-only hooks for the flags it flips.

const TABLE_TOP = 1.01;

// Avatars sit a little behind the table edge so their chests never cut into the wood.
const AVATAR_Z = -0.35;
const HIP_Y = 0.7;

// Where the candidate sits, and where the camera starts in the hallway.
const SEAT_POS = new THREE.Vector3(0, 1.75, 6.2);
const SEAT_LOOK = new THREE.Vector3(0, 1.48, 0);
const DOOR_Z = 8.6;
const HALL_START = new THREE.Vector3(0, 1.66, 11.6);

const LOOK_CANDIDATE = new THREE.Vector3(0, 1.8, 6);

// Per person looks. Skin, hair and outfit are what make the three read as different people.
const LOOKS = {
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

const MOOD_BROWS = {
  neutral: { lift: 0, tilt: 0 },
  impressed: { lift: 0.018, tilt: 0.05 },
  skeptical: { lift: 0, tilt: -0.18 },
  concerned: { lift: 0.008, tilt: 0.28 },
  amused: { lift: 0.012, tilt: 0.08 },
};

const ease = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x) => Math.min(1, Math.max(0, x));

// Progress of a sub-step that runs from a to b inside a timeline, eased at both ends.
function phase(t, a, b) {
  return ease(clamp01((t - a) / (b - a)));
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
  scene.fog = new THREE.Fog(0x14110f, 9, 22);

  // A soft studio environment gives every surface gentle bounce light, which reads like ambient occlusion
  // without paying for a post pass.
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.22;

  const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
  const camBase = SEAT_POS.clone();
  camera.position.copy(camBase);
  const camLook = SEAT_LOOK.clone();
  const camLookTarget = camLook.clone();

  // exit cinematic state; frozen holds the last frame as a still behind the score card
  let outro = null;
  let frozen = false;

  buildLights(scene);
  buildRoom(scene);
  const door = buildDoorAndHallway(scene);
  const monitor = buildWebcamMonitor(scene);

  const avatars = {};
  for (const id of Object.keys(PANEL)) {
    avatars[id] = makeAvatar(scene, id, PANEL[id]);
  }

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

  function focusOn(id) {
    if (!id) {
      camLookTarget.copy(SEAT_LOOK);
      camBase.x = 0;
      return;
    }
    camLookTarget.set(avatars[id].g.position.x * 0.55, 1.62, 0);
    camBase.x = avatars[id].g.position.x * 0.25;
  }

  function resize() {
    const w = innerWidth;
    const h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (frozen === true) {
      renderer.render(scene, camera);
    }
  }
  addEventListener("resize", resize);
  resize();

  // ---------- door intro ----------
  // While intro is set, the camera follows the walk-in path instead of the seated drift.
  let intro = null;
  let debugCam = null;
  const labelsEl = document.getElementById("labels");

  function playIntro() {
    if (intro) {
      return intro.promise;
    }

    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    intro = { start: null, duration: 3.3, promise, resolve };
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
    labelsEl.classList.remove("intro");
    document.body.classList.remove("intro-playing");
    for (const a of Object.values(avatars)) {
      a.waving = 0;
    }
    introFinished = true;
    revealSelfView();
    done.resolve();
  }

  // Returns how far into the walk-in we are, or -1 when no intro is running.
  // Time advances by the clamped frame delta, so a main-thread stall (model loading on the
  // same click) pauses the walk instead of skipping half of it.
  function updateIntro(dt) {
    if (!intro) {
      return -1;
    }
    if (intro.start === null) {
      intro.start = 0;
      door.pivot.rotation.y = 0;
    } else {
      intro.start += dt;
    }
    const t = intro.start;
    if (intro.skipped || t >= intro.duration) {
      finishIntro();
      return -1;
    }

    // Door swings first, the walk overlaps it so the motion never stalls.
    door.pivot.rotation.y = door.openAngle * phase(t, 0.15, 1.25);
    const walk = phase(t, 0.55, intro.duration);
    camera.position.lerpVectors(HALL_START, camBase, walk);

    // A light footstep bob that dies out as we sit down.
    const bob = Math.sin(walk * Math.PI * 6) * 0.025 * (1 - walk);
    camera.position.y += bob;

    // Early on we look at the door, then settle on the panel.
    const doorLook = tmpA.set(0, 1.5, DOOR_Z - 4);
    camLook.lerpVectors(doorLook, camLookTarget, phase(t, 0.3, intro.duration));
    return t;
  }

  // ---------- exit cinematic ----------
  // The reverse of the walk-in: stand up, turn to the door, walk into the hallway, look back
  // through the doorway as the door swings half shut, and freeze on that still.
  const OUTRO_END = new THREE.Vector3(0.1, 1.72, 9.9);

  function playExit() {
    if (outro) {
      return outro.promise;
    }
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });

    // Turning is done with a yaw angle, because blending two look points that sit on
    // opposite sides of the camera would swing the view through the camera itself.
    const dir = tmpA.subVectors(camLook, camera.position);
    outro = {
      start: null,
      duration: 5.0,
      promise,
      resolve,
      from: camera.position.clone(),
      yaw: Math.atan2(dir.x, -dir.z),
      pitch: Math.atan2(dir.y, Math.hypot(dir.x, dir.z)),
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

  function setYawPitch(yaw, pitch) {
    camLook.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
    camLook.add(camera.position);
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
    let t = outro.start;
    const last = outro.skipped || t >= outro.duration;
    if (last) {
      t = outro.duration;
    }

    // stand up out of the chair
    const stand = phase(t, 0, 0.9);
    camera.position.copy(outro.from);
    camera.position.y += (2.0 - outro.from.y) * stand;
    camera.position.z += 0.25 * stand;

    // walk to the hallway, with the same footstep bob as the walk-in
    const walk = phase(t, 1.5, 3.6);
    const standing = tmpB.set(outro.from.x, 2.0, outro.from.z + 0.25);
    if (walk > 0) {
      camera.position.lerpVectors(standing, OUTRO_END, walk);
      camera.position.y += Math.sin(walk * Math.PI * 6) * 0.025 * (1 - walk);
    }

    // turn to the door, then turn back at the end for one last look at the panel
    // the final look is aimed a little right, so the doorway sits left of the score card
    const yaw = outro.yaw + Math.PI * phase(t, 0.6, 1.8) + (Math.PI + 0.12) * phase(t, 3.4, 4.6);
    const pitch = outro.pitch * (1 - stand) - 0.03 * phase(t, 3.4, 4.6);
    setYawPitch(yaw, pitch);

    door.pivot.rotation.y = door.openAngle + (1.4 - door.openAngle) * phase(t, 3.9, 5.0);

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

  function animate(timestamp) {
    timer.update(timestamp);
    const dt = Math.min(timer.getDelta(), 0.05);
    const t = timer.getElapsed();

    if (frozen === true) {
      // the verdict still: keep the last drawn frame instead of rendering
      requestAnimationFrame(animate);
      return;
    }

    const introT = updateIntro(dt);
    const outroT = updateOutro(dt);
    const conferring = hooks.isConferring();
    const whisperer = hooks.whisperer();

    for (const a of Object.values(avatars)) {
      if (introT >= 0) {
        // heads down over their notes, then up at the door as it opens
        if (introT < 0.75) {
          a.look.set(a.g.position.x * 0.9, 1.0, 0.7);
        } else {
          a.look.copy(camera.position);
        }
        if (a.id === "manager" && introT > 1.1 && introT < 2.8) {
          a.waving = 1;
        } else {
          a.waving = 0;
        }
        if (a.id === "manager" && introT > 2.55 && a.nod === 0 && !a.introNodded) {
          a.nod = 1;
          a.introNodded = true;
        }
        if (a.id === "tech" && introT > 1.6 && a.nod === 0 && !a.introNodded) {
          a.nod = 0.7;
          a.introNodded = true;
        }
      } else if (outroT >= 0) {
        // the panel watches the candidate leave, Maya waves goodbye
        a.look.copy(camera.position);
        a.waving = a.id === "manager" && outroT > 0.4 && outroT < 2.4 ? 1 : 0;
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

      // label sits just above the head
      tmpA.set(a.g.position.x, 2.62, a.g.position.z).project(camera);
      a.label.style.left = `${(tmpA.x * 0.5 + 0.5) * innerWidth}px`;
      a.label.style.top = `${(-tmpA.y * 0.5 + 0.5) * innerHeight}px`;
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

    monitor.update(t);
    renderer.render(scene, camera);
    if (frozen === "next") {
      frozen = true;
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);

  // Dev-only hooks for screenshot scripts: close-ups and a forced speaking state.
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
      speak(id, on) {
        avatars[id].speaking = on;
      },
      mood: setMood,
    };
  }

  return { avatars, setMood, lookAt, allLookAt, focusOn, playIntro, playExit, startWebcam };
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

function contactShadow(w, d, opacity) {
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

function buildRoom(scene) {
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(16, 64),
    new THREE.MeshStandardMaterial({ color: 0x2a221d, roughness: 0.9 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a211c, roughness: 1 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), wallMat);
  wall.position.set(0, 5, -4);
  wall.receiveShadow = true;
  scene.add(wall);

  // night window behind the panel, with mullions
  const win = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 2.4), new THREE.MeshBasicMaterial({ color: 0x35546f }));
  win.position.set(0, 3.4, -3.98);
  scene.add(win);
  const sill = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.08, 0.16), wallMat);
  sill.position.set(0, 2.18, -3.92);
  scene.add(sill);
  for (let i = -2; i <= 2; i++) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.06, 2.4), new THREE.MeshBasicMaterial({ color: 0x231c18 }));
    bar.position.set(i * 1.1, 3.4, -3.97);
    scene.add(bar);
  }

  // city lights in the window, so it reads as a window and not a blue panel
  const dots = new THREE.Group();
  for (let i = 0; i < 70; i++) {
    const d = new THREE.Mesh(
      new THREE.PlaneGeometry(0.03 + Math.random() * 0.04, 0.03 + Math.random() * 0.05),
      new THREE.MeshBasicMaterial({ color: Math.random() > 0.3 ? 0xf6d58e : 0xbfd8ff }),
    );
    d.position.set((Math.random() - 0.5) * 5.3, 2.3 + Math.random() * 1.1, -3.975);
    dots.add(d);
  }
  scene.add(dots);

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

// ---------- door and hallway for the walk-in ----------

function buildDoorAndHallway(scene) {
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x2a211c, roughness: 1 });
  const hallMat = new THREE.MeshStandardMaterial({ color: 0x5b5147, roughness: 0.95 });
  const doorW = 1.1;
  const doorH = 2.35;

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
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, doorH + 0.08, 0.26), trimMat);
    post.position.set(s * (doorW / 2 + 0.04), doorH / 2, DOOR_Z);
    scene.add(post);
  }
  const head = new THREE.Mesh(new THREE.BoxGeometry(doorW + 0.16, 0.08, 0.26), trimMat);
  head.position.set(0, doorH + 0.04, DOOR_Z);
  scene.add(head);

  // the hallway beyond: narrow, lighter, lit from the ceiling
  const hallLen = 6;
  const hallMid = DOOR_Z + hallLen / 2;
  for (const s of [-1, 1]) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.1, 3, hallLen), hallMat);
    w.position.set(s * 1.1, 1.5, hallMid);
    scene.add(w);
  }
  const hallFloor = new THREE.Mesh(
    new THREE.PlaneGeometry(2.2, hallLen),
    new THREE.MeshStandardMaterial({ color: 0x3b3029, roughness: 0.6 }),
  );
  hallFloor.rotation.x = -Math.PI / 2;
  hallFloor.position.set(0, 0.01, hallMid);
  scene.add(hallFloor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2.2, hallLen), hallMat);
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.set(0, 3, hallMid);
  scene.add(ceiling);
  const endWall = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 3), hallMat);
  endWall.rotation.y = Math.PI;
  endWall.position.set(0, 1.5, DOOR_Z + hallLen);
  scene.add(endWall);
  for (const z of [DOOR_Z + 1.4, DOOR_Z + 4]) {
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.9), new THREE.MeshBasicMaterial({ color: 0xfff1da }));
    panel.rotation.x = Math.PI / 2;
    panel.position.set(0, 2.99, z);
    scene.add(panel);
  }
  const hallLight = new THREE.PointLight(0xffeedd, 8, 6, 1.5);
  hallLight.position.set(0, 2.6, DOOR_Z + 2.2);
  scene.add(hallLight);

  // the door itself, hinged on the left so it swings into the room
  const pivot = new THREE.Group();
  pivot.position.set(-doorW / 2, 0, DOOR_Z);
  const doorMesh = new THREE.Mesh(
    new RoundedBoxGeometry(doorW - 0.02, doorH - 0.02, 0.06, 2, 0.015),
    new THREE.MeshStandardMaterial({ color: 0x6b4a33, roughness: 0.55 }),
  );
  doorMesh.position.set(doorW / 2, doorH / 2, 0);
  pivot.add(doorMesh);

  // recessed panels so the door is not a flat slab
  const panelMat = new THREE.MeshStandardMaterial({ color: 0x5c3f2b, roughness: 0.6 });
  for (const y of [0.62, 1.68]) {
    for (const s of [-1, 1]) {
      const p = new THREE.Mesh(new RoundedBoxGeometry(0.8, 0.8, 0.02, 2, 0.01), panelMat);
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
const TORSO_DEPTH = 0.66;

const torsoCurve = new THREE.SplineCurve(TORSO_PROFILE.map(([r, y]) => new THREE.Vector2(r, y)));
const torsoPoints = torsoCurve.getPoints(40);

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

function torsoFrontZ(x, y, lift) {
  const r = torsoRadius(y);
  return Math.sqrt(Math.max(0, r * r - x * x)) * TORSO_DEPTH + lift;
}

// A strip that hugs the chest: for t in 0..1 from top to bottom, edge(t) gives { y, left, right }.
function chestPatch(edge, lift, mat) {
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
const HEAD_R = 0.27;
const HEAD_SCALE = new THREE.Vector3(0.97, 1.06, 0.95);

function onHead(x, y, out = new THREE.Vector3(), lift = 0) {
  const a = HEAD_R * HEAD_SCALE.x;
  const b = HEAD_R * HEAD_SCALE.y;
  const c = HEAD_R * HEAD_SCALE.z;
  const k = 1 - (x / a) ** 2 - (y / b) ** 2;
  return out.set(x, y, c * Math.sqrt(Math.max(0, k)) + lift);
}

function std(color, extra = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...extra });
}

function shadowed(mesh) {
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function makeAvatar(scene, id, p) {
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

  buildChair(g);

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

  const face = buildFace(head, id, look, { skin, hairMat, darkMat });
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

function buildChair(g) {
  const fabric = std(0x221c19, { roughness: 0.85 });
  const back = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.72, 0.82, 0.1, 4, 0.05), fabric));
  back.position.set(0, 1.42, -0.34);
  back.rotation.x = -0.08;
  g.add(back);
  const seat = shadowed(new THREE.Mesh(new RoundedBoxGeometry(0.7, 0.1, 0.62, 4, 0.04), fabric));
  seat.position.set(0, HIP_Y - 0.06, 0.0);
  g.add(seat);
  const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 12), std(0x2b2b2e, { metalness: 0.6 }));
  stem.position.set(0, 0.32, 0);
  g.add(stem);
}

function buildOutfit(body, look, { cloth, lapelMat, shirtMat }) {
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

function buildFace(head, id, look, { skin, hairMat, darkMat }) {
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
  const iris = std(id === "tech" ? 0x3b2618 : id === "skeptic" ? 0x4a6a78 : 0x5a3a1e, { roughness: 0.3 });
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
  const browTube = id === "skeptic" ? 0.014 : 0.01;
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

  if (id === "skeptic") {
    // grey moustache, part of what makes Sol read as the seasoned one
    const stache = new THREE.Mesh(new THREE.CapsuleGeometry(0.018, 0.07, 6, 12), hairMat);
    stache.rotation.z = Math.PI / 2;
    onHead(0, -0.082, stache.position, 0.012);
    stache.scale.set(1, 1, 0.7);
    head.add(stache);
  }

  if (id === "tech") {
    buildGlasses(head);
  }

  return { mouth, brows, eyes };
}

function buildGlasses(head) {
  const frame = new THREE.MeshStandardMaterial({ color: 0x141414, metalness: 0.3, roughness: 0.35 });
  const glass = new THREE.MeshStandardMaterial({
    color: 0xcfe6ff,
    transparent: true,
    opacity: 0.12,
    roughness: 0.05,
    metalness: 0.2,
  });
  for (const s of [-1, 1]) {
    const center = onHead(s * 0.088, 0.02, new THREE.Vector3(), 0.035);
    const lens = new THREE.Mesh(new THREE.TorusGeometry(0.058, 0.009, 10, 32), frame);
    lens.position.copy(center);
    lens.scale.set(1.08, 0.88, 1);
    lens.rotation.y = s * 0.18;
    head.add(lens);
    const pane = new THREE.Mesh(new THREE.CircleGeometry(0.056, 24), glass);
    pane.position.copy(center);
    pane.scale.set(1.08, 0.88, 1);
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
function rod(a, b, r, mat) {
  const dir = new THREE.Vector3().subVectors(b, a);
  const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 1, 8), mat);
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.scale.y = dir.length();
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return m;
}

function hairCap(r, thetaLength, tiltX, mat) {
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

function buildArm(g, side, { cloth, skin, shirtMat }) {
  const upper = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.072, 0.06, 1, 18, 1, true), cloth));
  const fore = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.058, 0.05, 1, 18, 1, true), cloth));
  const shoulderBall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.076, 20, 16), cloth));
  const elbowBall = shadowed(new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), cloth));
  const cuff = shadowed(new THREE.Mesh(new THREE.TorusGeometry(0.046, 0.012, 8, 20), shirtMat));

  // Hand: a soft palm, four fingers in a gentle curl, and a thumb, modelled pointing down +z.
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

function animateAvatar(a, t, dt, conferring, tmpA, tmpB) {
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
