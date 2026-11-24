// Behind-the-scenes attention tracking. MediaPipe's face landmarker runs on the webcam a few
// times a second and we keep only numbers: how much of each answer the candidate spent looking
// at the screen, and any stretch longer than five seconds where they looked away or left.
// No frame, image or landmark ever leaves the browser.

const TASKS_VERSION = "0.10.21";
const TASKS_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VERSION}`;
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

// About 6 detections a second is plenty for "is the candidate here" and keeps the 3D scene smooth.
const FRAME_MS = 160;

// A streak of looking away or being gone this long becomes an event and a quiet toast.
const AWAY_LIMIT_S = 5;

// Blinks are short; eyes shut for longer than this count as looking away.
const CLOSED_LIMIT_S = 1.5;

// Head turned further than this is not looking at the screen.
const MAX_YAW_DEG = 32;
const MAX_PITCH_DEG = 28;

// Blendshape scores (0-1) above which the eyes are clearly pointed off screen. Looking down
// is allowed more slack because people glance at the keyboard while they type.
const LOOK_SIDE = 0.6;
const LOOK_UP = 0.6;
const LOOK_DOWN = 0.8;
const BLINK = 0.6;

// How long we wait for the scene's self view to share its camera before asking ourselves.
const SHARED_STREAM_WAIT_MS = 4000;

let landmarker = null;
let video = null;
let ownStream = null;
let running = false;
let tickTimer = null;
let state = "idle"; // idle | starting | on | off
let offReason = "";

let lastFrameAt = 0;
let closedSince = 0;

// The current away streak, if any.
let streak = null;
let toastShown = false;

// Per-question totals, reset when a new question starts.
let question = null;

let dot = null;
let toast = null;

function now() {
  return performance.now();
}

// ---------- tiny UI: a status dot and a toast ----------

function ensureUi() {
  if (dot) {
    return;
  }

  dot = document.createElement("div");
  dot.id = "attnDot";
  dot.className = "hidden";
  dot.innerHTML = `<i></i><span>attention: on</span>`;
  document.body.appendChild(dot);

  toast = document.createElement("div");
  toast.id = "attnToast";
  toast.className = "hidden";
  toast.setAttribute("role", "status");
  document.body.appendChild(toast);
}

function setDot(text, on) {
  ensureUi();
  dot.querySelector("span").textContent = text;
  dot.classList.toggle("off", !on);
  dot.classList.remove("hidden");
}

function showToast(text) {
  ensureUi();
  toast.textContent = text;
  toast.classList.remove("hidden");
}

function hideToast() {
  if (toast) {
    toast.classList.add("hidden");
  }
}

// ---------- camera ----------

// The scene owns the self view. Reuse its stream when it has one so the candidate only sees
// one permission prompt and the camera light only turns on once.
function sharedStream() {
  const shared = window.hotseatWebcam && window.hotseatWebcam.stream;
  if (shared && shared.active) {
    return shared;
  }

  const selfVideo = document.getElementById("selfVideo");
  if (selfVideo && selfVideo.srcObject && selfVideo.srcObject.active) {
    return selfVideo.srcObject;
  }

  return null;
}

async function waitForStream() {
  const deadline = now() + SHARED_STREAM_WAIT_MS;
  while (now() < deadline) {
    const stream = sharedStream();
    if (stream) {
      return stream;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error("no camera API in this browser");
  }
  ownStream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" },
    audio: false,
  });
  return ownStream;
}

// A private, invisible video element. Detection reads from it, so hiding the self view
// never stops tracking.
async function attachVideo(stream) {
  video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.setAttribute("aria-hidden", "true");
  video.style.cssText = "position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none";
  video.srcObject = stream;
  document.body.appendChild(video);
  try {
    await video.play();
  } catch {
    // muted inline video normally plays; if not, the frame loop just waits for data
  }
}

// ---------- model ----------

async function loadModel() {
  const vision = await import(/* @vite-ignore */ `${TASKS_URL}/vision_bundle.mjs`);
  const fileset = await vision.FilesetResolver.forVisionTasks(`${TASKS_URL}/wasm`);

  const options = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_URL, delegate },
    runningMode: "VIDEO",
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  });

  // The GPU delegate is faster but not available everywhere (some headless or older machines).
  try {
    return await vision.FaceLandmarker.createFromOptions(fileset, options("GPU"));
  } catch {
    return await vision.FaceLandmarker.createFromOptions(fileset, options("CPU"));
  }
}

// ---------- classification ----------

function blendshapeMap(result) {
  const scores = {};
  const shapes = result.faceBlendshapes && result.faceBlendshapes[0];
  if (shapes) {
    for (const c of shapes.categories) {
      scores[c.categoryName] = c.score;
    }
  }
  return scores;
}

// Head yaw and pitch in degrees from the face's 4x4 transform (column major).
function headAngles(result) {
  const m = result.facialTransformationMatrixes && result.facialTransformationMatrixes[0];
  if (!m || !m.data) {
    return { yaw: 0, pitch: 0 };
  }

  const d = m.data;
  const yaw = (Math.atan2(d[8], d[10]) * 180) / Math.PI;
  const pitch = (Math.asin(Math.max(-1, Math.min(1, -d[9]))) * 180) / Math.PI;
  return { yaw, pitch };
}

// Returns "looking", "away", "closed" or "absent" for one frame.
export function classifyFrame(result, at = now()) {
  if (!result || !result.faceLandmarks || result.faceLandmarks.length === 0) {
    closedSince = 0;
    return "absent";
  }

  const s = blendshapeMap(result);
  const get = (name) => s[name] || 0;

  // Both eyes shut. A blink is fine; only a long close counts.
  if (get("eyeBlinkLeft") > BLINK && get("eyeBlinkRight") > BLINK) {
    if (!closedSince) {
      closedSince = at;
    }
    if ((at - closedSince) / 1000 > CLOSED_LIMIT_S) {
      return "closed";
    }
    return "looking";
  }
  closedSince = 0;

  const { yaw, pitch } = headAngles(result);
  if (Math.abs(yaw) > MAX_YAW_DEG || Math.abs(pitch) > MAX_PITCH_DEG) {
    return "away";
  }

  // Both eyes turned the same way: out of one and into the other.
  const toLeft = (get("eyeLookOutLeft") + get("eyeLookInRight")) / 2;
  const toRight = (get("eyeLookInLeft") + get("eyeLookOutRight")) / 2;
  const up = (get("eyeLookUpLeft") + get("eyeLookUpRight")) / 2;
  const down = (get("eyeLookDownLeft") + get("eyeLookDownRight")) / 2;
  if (toLeft > LOOK_SIDE || toRight > LOOK_SIDE || up > LOOK_UP || down > LOOK_DOWN) {
    return "away";
  }

  return "looking";
}

// ---------- bookkeeping ----------

// The running streak as an event, or null while it is still under the limit.
function streakEvent() {
  const seconds = streak ? streak.absent + streak.away : 0;
  if (seconds <= AWAY_LIMIT_S || !question) {
    return null;
  }

  return {
    type: streak.absent >= streak.away ? "absent" : "looking_away",
    seconds: Math.round(seconds),
    question: question.index,
    during: question.during,
  };
}

function closeStreak() {
  if (!streak) {
    return;
  }

  const event = streakEvent();
  if (event) {
    question.events.push(event);
  }

  streak = null;
  toastShown = false;
  hideToast();
}

function record(kind, dt) {
  if (question) {
    question.tracked += dt;
    if (kind === "looking") {
      question.looking += dt;
    }
  }

  if (kind === "looking") {
    closeStreak();
    return;
  }

  if (!streak) {
    streak = { absent: 0, away: 0 };
  }
  if (kind === "absent") {
    streak.absent += dt;
  } else {
    streak.away += dt;
  }

  if (!toastShown && streak.absent + streak.away > AWAY_LIMIT_S) {
    toastShown = true;
    showToast("You've been away from the screen for 5 s");
  }
}

function tick() {
  if (!running) {
    return;
  }

  if (video && video.readyState >= 2 && landmarker) {
    const at = now();
    let result = null;
    try {
      result = landmarker.detectForVideo(video, at);
    } catch (err) {
      console.warn("attention: detection failed", err);
    }

    // Cap the step so a backgrounded tab doesn't count minutes of time in one frame.
    const dt = lastFrameAt ? Math.min(1, (at - lastFrameAt) / 1000) : 0;
    lastFrameAt = at;
    if (result) {
      record(classifyFrame(result, at), dt);
    }
  }

  tickTimer = setTimeout(tick, FRAME_MS);
}

// ---------- public API ----------

// Starts tracking. Safe to call more than once; resolves to true when tracking is on.
export async function startGaze() {
  if (state === "starting") {
    return false;
  }

  // "Come back in" after stopGaze: the model and camera are still loaded, only the loop stopped.
  if (state === "on") {
    if (!running) {
      resume();
    }
    return true;
  }
  state = "starting";

  try {
    const [stream, model] = await Promise.all([waitForStream(), loadModel()]);
    landmarker = model;
    await attachVideo(stream);
  } catch (err) {
    // Denied camera or no network for the model: the interview goes on without tracking.
    state = "off";
    offReason = err && err.name === "NotAllowedError" ? "camera permission denied" : "tracking unavailable";
    console.warn("attention tracking off:", err && err.message ? err.message : err);
    setDot(`attention: off (${offReason})`, false);
    return false;
  }

  state = "on";
  resume();
  return true;
}

function resume() {
  running = true;
  lastFrameAt = 0;
  setDot("attention: on", true);
  tick();
}

export function gazeStatus() {
  return { on: state === "on", state, reason: offReason };
}

// Starts counting for a new question. during is "answer" or "coding".
export function beginQuestion(index, during = "answer") {
  closeStreak();
  question = { index, during, tracked: 0, looking: 0, events: [] };
}

// The current question's numbers, or null when tracking is off. It doesn't reset anything, so
// a failed send can simply be retried; the next beginQuestion starts fresh.
export function questionSummary() {
  if (state !== "on" || !question || question.tracked < 1) {
    return null;
  }

  // A streak still running when the answer is sent counts too.
  const awayEvents = [...question.events];
  const ongoing = streakEvent();
  if (ongoing) {
    awayEvents.push(ongoing);
  }

  return {
    lookingPct: Math.round((question.looking / question.tracked) * 100),
    trackedSeconds: Math.round(question.tracked),
    awayEvents,
  };
}

export function stopGaze() {
  running = false;
  clearTimeout(tickTimer);
  tickTimer = null;
  closeStreak();
  if (ownStream) {
    for (const track of ownStream.getTracks()) {
      track.stop();
    }
    ownStream = null;

    // Our own camera is off now, so the next startGaze has to open it again from scratch.
    if (video) {
      video.remove();
      video = null;
    }
    state = "idle";
  }
  if (dot) {
    dot.classList.add("hidden");
  }

  // The interview is over, so any "you've been away" note no longer applies.
  if (toast) {
    toast.classList.add("hidden");
  }
}
