import * as THREE from "three";

// ---------- panel definition ----------
const PANEL = {
  manager: { name: "Maya", role: "Hiring Manager", color: 0xe8a33d, x: -2.3, voice: ["Samantha", "Google US English", "Microsoft Aria", "Karen"], pitch: 1.05, rate: 1.02 },
  tech: { name: "Theo", role: "Tech Lead", color: 0x5fa8d3, x: 0, voice: ["Daniel", "Google UK English Male", "Microsoft Guy", "Alex"], pitch: 0.95, rate: 1.05 },
  skeptic: { name: "Sol", role: "Bar Raiser", color: 0xd9634a, x: 2.3, voice: ["Moira", "Tessa", "Google UK English Female", "Microsoft Jenny", "Fiona"], pitch: 0.85, rate: 0.98 },
};
const MOOD_LABEL = { neutral: "listening", impressed: "impressed", skeptical: "skeptical", concerned: "concerned", amused: "amused" };

// ---------- three.js scene ----------
const canvas = document.getElementById("scene");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x14110f);
scene.fog = new THREE.Fog(0x14110f, 9, 22);

const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 100);
const camBase = new THREE.Vector3(0, 1.75, 6.2);
camera.position.copy(camBase);
const camLook = new THREE.Vector3(0, 1.35, 0);
const camLookTarget = camLook.clone();

scene.add(new THREE.HemisphereLight(0xffe7c8, 0x1a1410, 0.55));
const key = new THREE.SpotLight(0xffd9a8, 60, 20, Math.PI / 4, 0.5, 1.4);
key.position.set(0, 6, 2.5);
key.target.position.set(0, 0.8, 0);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x7fa8ff, 0.6);
rim.position.set(-4, 3, -5);
scene.add(rim);

// room
const floor = new THREE.Mesh(new THREE.CircleGeometry(14, 64), new THREE.MeshStandardMaterial({ color: 0x2a221d, roughness: 0.9 }));
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);
const wall = new THREE.Mesh(new THREE.PlaneGeometry(30, 10), new THREE.MeshStandardMaterial({ color: 0x231c18, roughness: 1 }));
wall.position.set(0, 5, -4);
scene.add(wall);
// window glow on wall
const win = new THREE.Mesh(new THREE.PlaneGeometry(5.5, 2.4), new THREE.MeshBasicMaterial({ color: 0x3b5a78 }));
win.position.set(0, 3.4, -3.98);
scene.add(win);
for (let i = -2; i <= 2; i++) {
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(0.05, 2.4), new THREE.MeshBasicMaterial({ color: 0x231c18 }));
  bar.position.set(i * 1.1, 3.4, -3.97);
  scene.add(bar);
}

// table
const wood = new THREE.MeshStandardMaterial({ color: 0x5a3b26, roughness: 0.55 });
const table = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.12, 1.5), wood);
table.position.set(0, 0.95, 0.75);
table.castShadow = true;
table.receiveShadow = true;
scene.add(table);
const front = new THREE.Mesh(new THREE.BoxGeometry(7.4, 0.9, 0.06), new THREE.MeshStandardMaterial({ color: 0x3f2a1c, roughness: 0.7 }));
front.position.set(0, 0.5, 1.48);
front.castShadow = true;
scene.add(front);

// candidate's chair hint (foreground)
const plant = new THREE.Mesh(new THREE.ConeGeometry(0.45, 1.6, 7), new THREE.MeshStandardMaterial({ color: 0x2f5b3a, flatShading: true }));
plant.position.set(-4.6, 0.8, -1.5);
scene.add(plant);

// ---------- avatars ----------
const avatars = {};
function makeAvatar(id) {
  const p = PANEL[id];
  const g = new THREE.Group();
  g.position.set(p.x, 0, -0.1);
  const skin = new THREE.MeshStandardMaterial({ color: 0xe0b896, roughness: 0.6 });
  const cloth = new THREE.MeshStandardMaterial({ color: p.color, roughness: 0.5, emissive: p.color, emissiveIntensity: 0 });

  // chair
  const chair = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.5, 0.12), new THREE.MeshStandardMaterial({ color: 0x1c1714 }));
  chair.position.set(0, 1.25, -0.45);
  chair.castShadow = true;
  g.add(chair);

  const body = new THREE.Group();
  g.add(body);
  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.38, 0.6, 6, 16), cloth);
  torso.position.y = 1.45;
  torso.castShadow = true;
  body.add(torso);

  // arms resting on table
  for (const s of [-1, 1]) {
    const arm = new THREE.Mesh(new THREE.CapsuleGeometry(0.1, 0.55, 4, 8), cloth);
    arm.position.set(s * 0.42, 1.2, 0.25);
    arm.rotation.x = Math.PI / 2.4;
    arm.castShadow = true;
    body.add(arm);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 12), skin);
    hand.position.set(s * 0.38, 1.06, 0.58);
    body.add(hand);
  }

  const head = new THREE.Group();
  head.position.y = 2.22;
  body.add(head);
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.3, 32, 32), skin);
  skull.castShadow = true;
  head.add(skull);
  const eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1412 });
  const eyes = [];
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.035, 12, 12), eyeMat);
    eye.position.set(s * 0.1, 0.04, 0.27);
    head.add(eye);
    eyes.push(eye);
  }
  const brows = [];
  for (const s of [-1, 1]) {
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.018, 0.02), eyeMat);
    brow.position.set(s * 0.1, 0.12, 0.27);
    head.add(brow);
    brows.push(brow);
  }
  const mouth = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.025, 0.02), new THREE.MeshStandardMaterial({ color: 0x6b2c26 }));
  mouth.position.set(0, -0.1, 0.28);
  head.add(mouth);

  // identity props
  const hairMat = new THREE.MeshStandardMaterial({ color: id === "manager" ? 0x3a2416 : id === "tech" ? 0x1f1a17 : 0x8c8c8c, roughness: 0.8 });
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.31, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2.1), hairMat);
  hair.position.y = 0.03;
  hair.rotation.x = -0.25;
  head.add(hair);
  if (id === "manager") {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 16), hairMat);
    bun.position.set(0, 0.22, -0.2);
    head.add(bun);
  }
  if (id === "tech") {
    const frame = new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.4 });
    for (const s of [-1, 1]) {
      const lens = new THREE.Mesh(new THREE.TorusGeometry(0.065, 0.012, 8, 24), frame);
      lens.position.set(s * 0.1, 0.04, 0.29);
      head.add(lens);
    }
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.012, 0.012), frame);
    bridge.position.set(0, 0.05, 0.3);
    head.add(bridge);
    const laptop = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.38, 0.02), new THREE.MeshStandardMaterial({ color: 0x9aa3ad, metalness: 0.6, roughness: 0.3 }));
    laptop.position.set(0, 1.2, 0.55);
    laptop.rotation.x = -0.3;
    g.add(laptop);
  }
  if (id === "skeptic") {
    brows[0].rotation.z = -0.3;
    const pad = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.02, 0.6), new THREE.MeshStandardMaterial({ color: 0xf1e9d8 }));
    pad.position.set(0.15, 1.02, 0.65);
    pad.rotation.y = -0.2;
    g.add(pad);
  }

  // speaking ring on table
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.025, 8, 48), new THREE.MeshBasicMaterial({ color: p.color, transparent: true, opacity: 0 }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(0, 1.02, 0.55);
  g.add(ring);

  scene.add(g);

  const label = document.createElement("div");
  label.className = "label";
  label.innerHTML = `<div class="n" style="color:#${p.color.toString(16)}">${p.name}</div><div class="r">${p.role}</div><div class="m">listening</div>`;
  document.getElementById("labels").appendChild(label);

  return {
    id, g, body, head, mouth, brows, cloth, ring, label,
    speaking: false, mood: "neutral", look: new THREE.Vector3(0, 1.8, 6), nod: 0, bubbleUntil: 0,
  };
}
for (const id of Object.keys(PANEL)) {
  avatars[id] = makeAvatar(id);
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
    avatars[id].look.set(0, 1.8, 6);
  } else {
    const t = avatars[target];
    avatars[id].look.set(t.g.position.x, 2.2, t.g.position.z);
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

let conferring = false;
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

function animate() {
  const t = clock.getElapsedTime();
  const dt = Math.min(clock.getDelta(), 0.05);
  for (const a of Object.values(avatars)) {
    // breathing
    a.body.position.y = Math.sin(t * 1.6 + a.g.position.x) * 0.012;
    // conferring: heads turn to each other and lean in
    if (conferring) {
      const others = Object.keys(avatars).filter((k) => k !== a.id);
      const pick = others[Math.floor((t * 0.7 + a.g.position.x) % 2 + 2) % 2];
      lookAt(a.id, pick);
    }
    // head look
    const local = a.head.worldToLocal(tmpV.copy(a.look));
    const yaw = Math.atan2(local.x, local.z);
    a.head.rotation.y += (THREE.MathUtils.clamp(yaw, -0.9, 0.9) - a.head.rotation.y) * 0.08;
    // mood poses
    const tilt = a.mood === "skeptical" ? 0.18 : a.mood === "amused" ? -0.1 : 0;
    a.head.rotation.z += (tilt - a.head.rotation.z) * 0.05;
    const lean = a.mood === "concerned" ? -0.12 : conferring ? 0.12 : a.speaking ? 0.06 : 0;
    a.body.rotation.x += (lean - a.body.rotation.x) * 0.05;
    if (a.nod > 0) {
      a.head.rotation.x = Math.sin((1 - a.nod) * Math.PI * 4) * 0.15;
      a.nod = Math.max(0, a.nod - dt * 0.8);
    } else {
      a.head.rotation.x *= 0.9;
    }
    // speaking
    const talk = a.speaking ? 0.5 + Math.abs(Math.sin(t * 13 + a.g.position.x)) * 3.2 : 1;
    a.mouth.scale.y += (talk - a.mouth.scale.y) * 0.4;
    a.cloth.emissiveIntensity += ((a.speaking ? 0.35 : 0) - a.cloth.emissiveIntensity) * 0.1;
    a.ring.material.opacity += ((a.speaking ? 0.9 : 0) - a.ring.material.opacity) * 0.1;
    a.ring.scale.setScalar(1 + (a.speaking ? Math.sin(t * 4) * 0.05 : 0));
    // label
    tmpV.set(a.g.position.x, 2.75, a.g.position.z).project(camera);
    a.label.style.left = `${(tmpV.x * 0.5 + 0.5) * innerWidth}px`;
    a.label.style.top = `${(-tmpV.y * 0.5 + 0.5) * innerHeight}px`;
  }
  // camera drifts toward speaker
  camera.position.x += (camBase.x + Math.sin(t * 0.25) * 0.15 - camera.position.x) * 0.02;
  camLook.lerp(camLookTarget, 0.04);
  camera.lookAt(camLook);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}
animate();

function focusOn(id) {
  if (!id) {
    camLookTarget.set(0, 1.35, 0);
    camBase.x = 0;
    return;
  }
  camLookTarget.set(avatars[id].g.position.x * 0.55, 1.55, 0);
  camBase.x = avatars[id].g.position.x * 0.25;
}

// ---------- voice ----------
let voices = [];
function loadVoices() {
  voices = speechSynthesis.getVoices();
}
loadVoices();
speechSynthesis.onvoiceschanged = loadVoices;
const usedVoices = new Set();
const voiceFor = {};
function pickVoice(id) {
  if (voiceFor[id]) {
    return voiceFor[id];
  }
  const en = voices.filter((v) => v.lang.startsWith("en"));
  let v = null;
  for (const name of PANEL[id].voice) {
    v = en.find((x) => x.name.includes(name) && !usedVoices.has(x.name));
    if (v) {
      break;
    }
  }
  if (!v) {
    v = en.find((x) => !usedVoices.has(x.name)) || en[0] || null;
  }
  if (v) {
    usedVoices.add(v.name);
    voiceFor[id] = v;
  }
  return v;
}

function speak(id, text) {
  return new Promise((resolve) => {
    const a = avatars[id];
    showCaption(id, text);
    focusOn(id);
    allLookAt(id);
    a.speaking = true;
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice(id);
    if (v) {
      u.voice = v;
    }
    u.pitch = PANEL[id].pitch;
    u.rate = PANEL[id].rate;
    let finished = false;
    const done = () => {
      if (finished) {
        return;
      }
      finished = true;
      a.speaking = false;
      for (const k of Object.keys(avatars)) {
        lookAt(k, "candidate");
      }
      focusOn(null);
      resolve();
    };
    u.onend = done;
    u.onerror = done;
    // safety: ~70ms per char
    setTimeout(done, Math.max(2500, text.length * 75));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// ---------- speech recognition ----------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recording = false;
let baseText = "";
const micBtn = document.getElementById("micBtn");
const answerBox = document.getElementById("answerBox");
if (!SR) {
  micBtn.disabled = true;
  micBtn.title = "Speech recognition needs Chrome";
}
function startRec() {
  if (!SR || recording) {
    return;
  }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  baseText = answerBox.value ? answerBox.value + " " : "";
  rec.onresult = (e) => {
    let finalT = "";
    let interim = "";
    for (let i = 0; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        finalT += e.results[i][0].transcript;
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    answerBox.value = baseText + finalT + interim;
  };
  rec.onend = () => {
    recording = false;
    micBtn.classList.remove("rec");
    micBtn.textContent = "🎙 Speak";
  };
  rec.start();
  recording = true;
  micBtn.classList.add("rec");
  micBtn.textContent = "■ Stop";
}
function stopRec() {
  if (rec && recording) {
    rec.stop();
  }
}
micBtn.onclick = () => (recording ? stopRec() : startRec());

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
function showCaption(id, text) {
  $("captionWho").textContent = `${PANEL[id].name}:`;
  $("captionWho").style.color = `#${PANEL[id].color.toString(16)}`;
  $("captionText").textContent = text;
}
function setStatus(s) {
  $("status").textContent = s;
}
function setProgress(index, total) {
  $("progress").innerHTML = Array.from({ length: total }, (_, i) => `<i class="${i < index - 1 ? "done" : i === index - 1 ? "now" : ""}"></i>`).join("");
}
function setDifficulty(d) {
  $("diffBar").innerHTML = Array.from({ length: 5 }, (_, i) => `<i class="${i < d ? "on" : ""}"></i>`).join("");
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function addLedger(out, qIndex) {
  const el = document.createElement("div");
  el.className = "entry";
  let html = "";
  if (out.assessment) {
    const a = out.assessment;
    html += `<div class="tag">ANSWER ${qIndex - 1} · ${esc(a.topic)}</div>
      <div class="line"><span class="score s${a.score}">${a.score}/5</span><span>${esc(a.note)}</span></div>
      <div class="line" style="flex-wrap:wrap;gap:4px">${a.tags.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}</div>`;
  } else {
    html += `<div class="tag">OPENING</div>`;
  }
  html += `<div class="tag" style="margin-top:10px">PANEL WHISPERS</div>`;
  for (const d of out.deliberation) {
    const p = PANEL[d.agent];
    html += `<div class="line"><span class="who" style="color:#${p.color.toString(16)}">${p.name}</span><span>${esc(d.says)}</span><span class="bid">bid ${d.bid.toFixed(2)}</span></div>`;
  }
  const asker = PANEL[out.decision.asker];
  html += `<div class="decision"><b>${asker.name} takes Q${qIndex}</b> · difficulty ${out.decision.difficulty}/5<br>${esc(out.decision.reason)}</div>`;
  el.innerHTML = html;
  $("ledgerList").prepend(el);
}

async function playDeliberation(out) {
  conferring = true;
  for (const d of out.deliberation) {
    const a = avatars[d.agent];
    a.label.querySelector(".m").textContent = `“${d.says.length > 60 ? d.says.slice(0, 58) + "…" : d.says}”`;
    a.speaking = true;
    await new Promise((r) => setTimeout(r, 1500));
    a.speaking = false;
  }
  conferring = false;
  for (const [id, mood] of Object.entries(out.moods)) {
    setMood(id, mood);
  }
}

async function api(path, body) {
  const r = await fetch(path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json();
  if (!r.ok) {
    throw new Error(j.error || r.statusText);
  }
  return j;
}

// ---------- memory card ----------
function renderMemory(p) {
  if (!p || !p.sessions) {
    $("memory").innerHTML = `<b>Panel memory:</b> empty. This is your first session, so the panel starts fresh.`;
    return;
  }
  const weak = (p.weak_topics || []).map((w) => `<span class="chip bad">${esc(w.topic)} ${w.avg_score.toFixed(1)}</span>`).join("");
  const tags = (p.weak_tags || []).map((w) => `<span class="chip bad">${esc(w.tag)} ×${w.count}</span>`).join("");
  const strong = (p.strong_topics || []).map((w) => `<span class="chip good">${esc(w.topic)} ${w.avg_score.toFixed(1)}</span>`).join("");
  $("memory").innerHTML = `<b>Panel memory</b> from ${p.sessions} past session${p.sessions > 1 ? "s" : ""} (Bruin pipeline):<br>${esc(p.focus || "")}
    <div class="chips">${weak}${tags}${strong}</div>`;
}
api("/api/profile").then(renderMemory).catch(() => renderMemory(null));

// ---------- flow ----------
let sessionId = null;
let busy = false;

// ---------- coding round (in-browser judge) ----------
let problem = null;
let lastRun = null;
const codeEl = $("code");
codeEl.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const { selectionStart: a, selectionEnd: b } = codeEl;
    codeEl.value = codeEl.value.slice(0, a) + "  " + codeEl.value.slice(b);
    codeEl.selectionStart = codeEl.selectionEnd = a + 2;
  }
});

const WORKER_SRC = `
onmessage = (e) => {
  const { code, fn, tests } = e.data;
  const results = [];
  let f;
  try {
    f = new Function(code + "\\n;return " + fn + ";")();
  } catch (err) {
    postMessage({ compileError: String(err) });
    return;
  }
  for (const t of tests) {
    try {
      const args = JSON.parse(t.args_json);
      const expected = JSON.parse(t.expected_json);
      const got = f(...structuredClone(args));
      const pass = JSON.stringify(got) === JSON.stringify(expected);
      results.push({ args: t.args_json, expected: t.expected_json, got: JSON.stringify(got), pass });
    } catch (err) {
      results.push({ args: t.args_json, expected: t.expected_json, got: "error: " + err.message, pass: false });
    }
  }
  postMessage({ results });
};`;
const workerUrl = URL.createObjectURL(new Blob([WORKER_SRC], { type: "text/javascript" }));

function runTests() {
  return new Promise((resolve) => {
    const w = new Worker(workerUrl);
    const timer = setTimeout(() => {
      w.terminate();
      resolve({ compileError: "Timed out after 3s (infinite loop?)" });
    }, 3000);
    w.onmessage = (e) => {
      clearTimeout(timer);
      w.terminate();
      resolve(e.data);
    };
    w.postMessage({ code: codeEl.value, fn: problem.function_name, tests: problem.tests });
  });
}

$("runBtn").onclick = async () => {
  $("testSummary").textContent = "Running…";
  const r = await runTests();
  lastRun = r;
  if (r.compileError) {
    $("testSummary").textContent = r.compileError;
    $("testList").innerHTML = "";
    return;
  }
  const passed = r.results.filter((x) => x.pass).length;
  $("testSummary").textContent = `${passed}/${r.results.length} tests passed`;
  $("testList").innerHTML = r.results.map((x, i) => `<span class="t ${x.pass ? "pass" : "fail"}" title="args ${esc(x.args)} → expected ${esc(x.expected)}, got ${esc(x.got)}">#${i + 1} ${x.pass ? "✓" : "✗"}</span>`).join("");
  setMood("tech", passed === r.results.length ? "impressed" : passed > r.results.length / 2 ? "neutral" : "concerned");
};

$("submitCode").onclick = async () => {
  const r = await runTests();
  lastRun = r;
  const summary = r.compileError
    ? `Code did not run: ${r.compileError}`
    : `${r.results.filter((x) => x.pass).length}/${r.results.length} hidden tests passed. Failures: ${r.results.filter((x) => !x.pass).map((x) => `args ${x.args} expected ${x.expected} got ${x.got}`).join("; ") || "none"}`;
  const notes = answerBox.value.trim();
  answerBox.value = `[LIVE CODING: ${problem.title}]\n${codeEl.value}\n\n[JUDGE] ${summary}${notes ? `\n[CANDIDATE EXPLANATION] ${notes}` : ""}`;
  $("ide").classList.add("hidden");
  $("dock").classList.remove("hidden");
  problem = null;
  $("sendBtn").click();
};

function openIde(p) {
  problem = p;
  $("pTitle").textContent = p.title;
  $("pDesc").textContent = p.description;
  codeEl.value = p.starter_code;
  $("testSummary").textContent = `${p.tests.length} hidden tests`;
  $("testList").innerHTML = "";
  $("ide").classList.remove("hidden");
  $("dock").classList.add("hidden");
  codeEl.focus();
}

async function handleTurn(out) {
  setProgress(out.index, out.total);
  setDifficulty(out.decision.difficulty);
  addLedger(out, out.index);
  await playDeliberation(out);
  await speak(out.decision.asker, out.question);
  if (out.problem) {
    openIde(out.problem);
    setStatus("Coding round. Talk through your approach in the answer box if you like, then submit.");
    $("sendBtn").disabled = true;
    return;
  }
  setStatus("Your turn. Speak or type, then press Answer.");
  $("sendBtn").disabled = false;
  answerBox.focus();
}

$("startBtn").onclick = async () => {
  $("startBtn").disabled = true;
  $("startBtn").textContent = "The panel is getting ready…";
  // unlock speech on user gesture
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  try {
    conferring = true;
    const out = await api("/api/start", { role: $("role").value });
    sessionId = out.session_id;
    $("intro").classList.add("hidden");
    for (const id of ["hud", "ledger", "dock"]) {
      $(id).classList.remove("hidden");
    }
    await handleTurn(out);
  } catch (e) {
    conferring = false;
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Take the seat";
    alert(`Could not start: ${e.message}`);
  }
};

$("sendBtn").onclick = async () => {
  if (busy) {
    return;
  }
  stopRec();
  const answer = answerBox.value.trim();
  if (!answer) {
    answerBox.focus();
    return;
  }
  busy = true;
  $("sendBtn").disabled = true;
  $("ide").classList.add("hidden");
  answerBox.value = "";
  setStatus("The panel is conferring…");
  conferring = true;
  try {
    const out = await api("/api/answer", { session_id: sessionId, answer });
    if (out.done) {
      addLedger({ ...out, decision: { ...out.decision, reason: "Interview complete. Panel moves to final deliberation." } }, out.index + 1);
      await playDeliberation(out);
      await finish();
    } else {
      await handleTurn(out);
    }
  } catch (e) {
    conferring = false;
    setStatus(`Error: ${e.message}. Try again.`);
    $("sendBtn").disabled = false;
  }
  busy = false;
};
answerBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    $("sendBtn").click();
  }
});

async function finish() {
  await speak("manager", "Thank you. Give us a moment to talk it over.");
  setStatus("Final deliberation, then the Bruin pipeline updates your memory…");
  conferring = true;
  const v = await api("/api/verdict", { session_id: sessionId });
  conferring = false;
  for (const vote of v.votes) {
    setMood(vote.agent, vote.vote === "hire" ? "impressed" : "concerned");
  }
  await speak("manager", v.spoken_verdict);
  renderVerdict(v);
}

function renderVerdict(v) {
  const label = { hire: "Hire", lean_hire: "Lean hire", lean_no_hire: "Lean no hire", no_hire: "No hire" }[v.verdict];
  const votes = v.votes.map((x) => {
    const p = PANEL[x.agent];
    return `<div class="vote"><div style="color:#${p.color.toString(16)};font-weight:600">${p.name}</div><div class="v">${x.vote === "hire" ? "Hire" : "No hire"}</div>${esc(x.reason)}<q>${esc(x.evidence_quote)}</q></div>`;
  }).join("");
  const p = v.profile;
  const bruin = v.bruin && v.bruin.ok
    ? `<b>Memory updated by Bruin</b> in ${(v.bruin.ms / 1000).toFixed(1)}s · ${p ? p.sessions : "?"} sessions, ${p ? p.turns : "?"} answers on file.<br>Next time the panel will focus on: ${esc(p?.focus || "")}`
    : `<b>Bruin pipeline</b> did not run this time.`;
  $("verdict").innerHTML = `
    <div class="tag" style="color:#8a7e70;font-size:12px;font-weight:600">PANEL VERDICT</div>
    <div class="vbig">${label} · ${Number(v.overall).toFixed(1)}/5</div>
    <p style="color:#cfc4b6;line-height:1.5">${esc(v.summary)}</p>
    <div class="votes">${votes}</div>
    <div class="vsec"><h3>STRENGTHS</h3><ul>${v.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>
    <div class="vsec"><h3>WORK ON</h3><ul>${v.growth.map((g) => `<li><b>${esc(g.area)}</b> <q>${esc(g.evidence_quote)}</q><br>Drill: ${esc(g.drill)}</li>`).join("")}</ul></div>
    <div class="bruinbox">${bruin}</div>
    <div style="margin-top:18px;display:flex;gap:10px"><button class="primary" onclick="location.reload()">Go again (the panel remembers)</button></div>`;
  $("verdict").classList.remove("hidden");
  $("dock").classList.add("hidden");
}
