import { initScene } from "./scene.js";

import { createCodingRound } from "./coding.js";
import { initCreator } from "./creator.js";
import { initCompanyPicker, selectedCompany, showCompanyInHud, valuesHtml } from "./company.js";
import { beginQuestion, questionSummary, startGaze, stopGaze } from "./gaze.js";
import { bindMicButton } from "./listen.js";
import * as voice from "./voice.js";

// ---------- panel definition ----------
const PANEL = {
  manager: {
    name: "Maya",
    role: "Hiring Manager",
    color: 0xe8a33d,
    x: -2.3,
    voice: ["Samantha", "Google US English", "Microsoft Aria", "Karen"],
    pitch: 1.05,
    rate: 1.02,
  },
  tech: {
    name: "Theo",
    role: "Tech Lead",
    color: 0x5fa8d3,
    x: 0,
    voice: ["Daniel", "Google UK English Male", "Microsoft Guy", "Alex"],
    pitch: 0.95,
    rate: 1.05,
  },
  skeptic: {
    name: "Sol",
    role: "Bar Raiser",
    color: 0xd9634a,
    x: 2.3,
    voice: ["Moira", "Tessa", "Google UK English Female", "Microsoft Jenny", "Fiona"],
    pitch: 0.85,
    rate: 0.98,
  },
};
const MOOD_LABEL = {
  neutral: "listening",
  impressed: "impressed",
  skeptical: "skeptical",
  concerned: "concerned",
  amused: "amused",
};

// ---------- three.js scene ----------
// The room, avatars, door walk-in and webcam live in scene.js.
// conferring and whisperer stay here because the interview flow flips them; the scene reads them every frame.
let conferring = false;
// who is whispering right now, so the others can turn toward them
let whisperer = null;
const sceneHooks = {
  isConferring: () => conferring,
  whisperer: () => whisperer,
};
const { avatars, setMood, lookAt, allLookAt, focusOn, playIntro, playExit, startWebcam, setCandidate } = initScene(
  PANEL,
  MOOD_LABEL,
  sceneHooks,
);

// the candidate's own avatar, designed on the start card; it walks in and out of the room
const creator = initCreator();

// ---------- voice ----------
// voice.js owns the audio and plays one line at a time; this wrapper drives the avatars.
voice.configureVoices(PANEL);

function speak(id, text) {
  const a = avatars[id];
  return voice.speak(id, text, {
    // runs when this line actually starts, not when it was queued, so captions match the audio
    onStart: () => {
      showCaption(id, text);
      focusOn(id);
      allLookAt(id);
      a.speaking = true;
    },
    onEnd: () => {
      a.speaking = false;
      for (const k of Object.keys(avatars)) {
        lookAt(k, "candidate");
      }
      focusOn(null);
    },
  });
}

// ---------- speech input ----------
// listen.js records the answer and has the server transcribe it; the browser recognizer only
// fills in a grey preview while the candidate talks. Speak also cuts the panel off.
const micBtn = document.getElementById("micBtn");
const answerBox = document.getElementById("answerBox");
const { stopRec } = bindMicButton(micBtn, answerBox);

// typing is a barge-in too: once the candidate starts answering, the panel goes quiet
answerBox.addEventListener("input", () => {
  if (voice.isSpeaking()) {
    voice.stopSpeaking();
  }
});

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
  $("progress").innerHTML = Array.from(
    { length: total },
    (_, i) => `<i class="${i < index - 1 ? "done" : i === index - 1 ? "now" : ""}"></i>`,
  ).join("");
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
    if (out.attention) {
      html += `<div class="ledger-attn">Attention: ${out.attention.lookingPct}% on screen</div>`;
    }
    // The trained critic's second opinion, shown quietly next to the panel's score.
    if (out.critic) {
      const tags = out.critic.tags.length ? ` · ${out.critic.tags.map(esc).join(", ")}` : "";
      html += `<div class="ledger-attn">Critic: ${out.critic.score}/5${tags}</div>`;
    }
    // The C++ core's ability estimate, and the difficulty it steered the next question toward.
    if (out.ability) {
      const ab = out.ability;
      html += `<div class="ledger-attn">Ability ${ab.theta.toFixed(1)} ± ${ab.se.toFixed(1)} · engine suggests difficulty ${ab.next}</div>`;
    }
  } else {
    html += `<div class="tag">OPENING</div>`;
  }
  html += `<div class="tag" style="margin-top:10px">PANEL WHISPERS</div>`;
  for (const d of out.deliberation) {
    const p = PANEL[d.agent];
    html += `<div class="line"><span class="who" style="color:#${p.color.toString(16)}">${p.name}</span><span>${esc(d.says)}</span><span class="bid">bid ${d.bid.toFixed(2)}</span></div>`;
  }
  // The trained policy's pick for this question, shown quietly next to the panel's choice.
  if (out.policy) {
    const band = out.policy.band === "mid" ? "medium" : out.policy.band;
    html += `<div class="ledger-attn">Policy: ${esc(out.policy.name)} · ${esc(out.policy.topic.replace(/_/g, " "))} · ${esc(band)}</div>`;
  }
  const asker = PANEL[out.decision.asker];
  if (out.checks && out.checks.length) {
    html += `<div class="checks"><div class="checkhead">Engine checks</div>`;
    html += out.checks.map((c) => `<div class="check">${esc(c)}</div>`).join("");
    html += `</div>`;
  }
  if (out.final) {
    html += `<div class="decision"><b>Final deliberation</b><br>Interview complete. The panel moves to the verdict.</div>`;
  } else {
    html += `<div class="decision"><b>${asker.name} takes Q${qIndex}</b> · difficulty ${out.decision.difficulty}/5<br>${esc(out.decision.reason)}</div>`;
  }
  // Each entry folds into one summary line, so the ledger stays readable as it grows.
  let summary = out.assessment
    ? `Answer ${qIndex - 1} · ${esc(out.assessment.topic)} · ${out.assessment.score}/5`
    : "Opening";
  if (out.final) {
    summary += " → verdict";
  } else {
    summary += ` → ${asker.name} asks`;
  }
  el.innerHTML = `<details open><summary>${summary}</summary><div class="entrybody">${html}</div></details>`;

  // Only the newest entry stays open; older ones collapse but can be reopened.
  for (const older of $("ledgerList").querySelectorAll("details[open]")) {
    older.open = false;
  }
  $("ledgerList").prepend(el);
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setBid(id, bid) {
  const meter = avatars[id].label.querySelector(".bidmeter");
  const value = Math.max(0, Math.min(1, Number(bid) || 0));
  meter.classList.add("on");
  meter.querySelector("i").style.width = `${Math.round(value * 100)}%`;
  meter.querySelector("span").textContent = `wants the floor ${value.toFixed(2)}`;
}

function clearBids() {
  for (const a of Object.values(avatars)) {
    const meter = a.label.querySelector(".bidmeter");
    meter.classList.remove("on");
    meter.querySelector("i").style.width = "0%";
    a.label.classList.remove("floor", "yield");
  }
}

async function playDeliberation(out) {
  conferring = true;
  clearBids();

  for (const d of out.deliberation) {
    const a = avatars[d.agent];
    whisperer = d.agent;
    a.label.querySelector(".m").textContent = `“${d.says.length > 60 ? d.says.slice(0, 58) + "…" : d.says}”`;
    a.speaking = true;
    setBid(d.agent, d.bid);
    await wait(1500);
    a.speaking = false;
  }
  whisperer = null;

  // show who won the floor for a beat before they speak, so the decision is visible
  const winner = out.decision && out.decision.asker;
  if (winner && avatars[winner] && !out.done) {
    for (const a of Object.values(avatars)) {
      a.label.classList.add(a.id === winner ? "floor" : "yield");
    }
    lookAt(winner, "candidate");
    await wait(1100);
  }

  conferring = false;
  for (const [id, mood] of Object.entries(out.moods)) {
    setMood(id, mood);
  }
}

async function api(path, body) {
  const r = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {
    // a gateway timeout comes back as HTML, not JSON
    throw new Error("The panel took too long. Try again.");
  }
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
  const weak = (p.weak_topics || [])
    .map((w) => `<span class="chip bad">${esc(w.topic)} ${w.avg_score.toFixed(1)}</span>`)
    .join("");
  const tags = (p.weak_tags || []).map((w) => `<span class="chip bad">${esc(w.tag)} ×${w.count}</span>`).join("");
  const strong = (p.strong_topics || [])
    .map((w) => `<span class="chip good">${esc(w.topic)} ${w.avg_score.toFixed(1)}</span>`)
    .join("");
  $("memory").innerHTML =
    `<b>Panel memory</b> from ${p.sessions} past session${p.sessions > 1 ? "s" : ""} (Bruin pipeline):<br>${esc(p.focus || "")}
    <div class="chips">${weak}${tags}${strong}</div>`;
}
function loadMemory() {
  const name = $("name").value.trim();
  localStorage.setItem("hotseat_name", name);
  api(`/api/profile?name=${encodeURIComponent(name)}`)
    .then(renderMemory)
    .catch(() => renderMemory(null));
}
$("name").value = localStorage.getItem("hotseat_name") || "";
$("name").addEventListener("change", loadMemory);
loadMemory();
// The company picker fills in once the list arrives; until then the saved choice stands.
initCompanyPicker();

// ---------- flow ----------
let sessionId = null;
let sessionState = null;
let hosted = false;
let busy = false;

// ---------- coding round ----------
// The editor, judge, integrity counters and the chat with Theo live in coding.js.
const coding = createCodingRound({
  api,
  speak,
  stopSpeaking: voice.stopSpeaking,
  setMood,
  setStatus,
  getSession: () => ({ id: sessionId, state: sessionState }),
  setSessionState: (state) => {
    sessionState = state || sessionState;
  },
  submitAnswer: (text, extra) => sendAnswer(text, extra),
});

async function handleTurn(out) {
  setProgress(out.index, out.total);
  setDifficulty(out.decision.difficulty);
  addLedger(out, out.index);
  await playDeliberation(out);
  await speak(out.decision.asker, out.question);
  clearBids();
  if (out.problem) {
    $("sendBtn").disabled = true;
    coding.open(out.problem);
    beginQuestion(out.index, "coding");
    setStatus("Coding round. Talk Theo through your approach in the chat, then submit your code.");
    return;
  }
  setStatus("Your turn. Speak or type, then press Answer.");
  beginQuestion(out.index, "answer");
  $("sendBtn").disabled = false;
  answerBox.focus();
}

$("startBtn").onclick = async () => {
  $("startBtn").disabled = true;
  $("startBtn").textContent = "The panel is getting ready…";
  // unlock audio inside the click so the panel's clips can autoplay later
  voice.unlockVoice();
  // the camera prompt rides on this click; a denial just leaves the self view hidden
  startWebcam();
  // attention tracking reuses that camera and stays off quietly if it was denied
  startGaze();

  // walk in through the door while the panel prepares its opening question
  $("intro").classList.add("hidden");
  // "Come back in" lands here too, so the same character walks back in
  setCandidate(creator.character());
  const walkIn = playIntro();
  const started = api("/api/start", {
    role: $("role").value,
    name: $("name").value.trim(),
    company: selectedCompany(),
  });
  showCompanyInHud($("role").value);
  // the error is handled below once the walk-in ends; this only stops an early unhandled-rejection warning
  started.catch(() => {});
  try {
    await walkIn;
    conferring = true;
    // no answering until the opening question has been asked aloud
    $("sendBtn").disabled = true;
    for (const id of ["hud", "ledger", "dock"]) {
      $(id).classList.remove("hidden");
    }
    setStatus("The panel is getting ready…");

    const out = await started;
    sessionId = out.session_id;
    sessionState = out.state;
    hosted = Boolean(out.hosted);
    await handleTurn(out);
  } catch (e) {
    conferring = false;
    for (const id of ["hud", "ledger", "dock"]) {
      $(id).classList.add("hidden");
    }
    $("intro").classList.remove("hidden");
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Take the seat";
    alert(`Could not start: ${e.message}`);
  }
};

// Sends one answer and plays the panel's reply. text comes from the coding round; typed and
// spoken answers come from the answer box. Resolves to { ok, error } so the caller knows whether
// the panel got it.
async function sendAnswer(text, extra = {}) {
  if (busy) {
    return { ok: false, error: "the panel is still busy" };
  }
  stopRec();
  const fromBox = typeof text !== "string";
  const answer = (fromBox ? answerBox.value : text).trim();
  if (!answer) {
    answerBox.focus();
    return { ok: false, error: "the answer is empty" };
  }
  busy = true;
  $("sendBtn").disabled = true;
  setStatus("The panel is conferring…");
  conferring = true;

  // The answer stays in the box until the panel has it, so a failed request can simply be sent again.
  let out = null;
  try {
    // Only numbers go with the answer; null when tracking is off, so the field is left out.
    const attention = questionSummary();
    const body = { session_id: sessionId, answer, state: sessionState, ...extra };
    if (attention) {
      body.attention = attention;
    }
    out = await api("/api/answer", body);
    out.attention = attention;
  } catch (e) {
    conferring = false;
    setStatus(`Error: ${e.message}. Try again.`);
    $("sendBtn").disabled = false;
    busy = false;
    return { ok: false, error: e.message };
  }

  if (fromBox) {
    answerBox.value = "";
  }
  sessionState = out.state || sessionState;

  // The panel already has the answer, so a playback problem must not leave the interview stuck.
  try {
    if (out.done) {
      addLedger({ ...out, final: true }, out.index + 1);
      await playDeliberation(out);
      await finish();
    } else {
      await handleTurn(out);
    }
  } catch (e) {
    console.error(e);
    conferring = false;
    if (out.problem && !coding.isOpen()) {
      coding.open(out.problem);
    } else if (!out.done && !coding.isOpen()) {
      setStatus(`Your turn: ${out.question}`);
      $("sendBtn").disabled = false;
    }
  }
  busy = false;
  return { ok: true };
}
$("sendBtn").onclick = () => sendAnswer();
answerBox.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
    $("sendBtn").click();
  }
});

async function finish() {
  // Attention only matters while answering; stop it before the verdict and the exit scene.
  stopGaze();
  await speak("manager", "Thank you. Give us a moment to talk it over.");
  await finishVerdict();
}

async function finishVerdict() {
  setStatus("Final deliberation, then the Bruin pipeline updates your memory…");
  conferring = true;
  let v = null;
  try {
    v = await api("/api/verdict", { session_id: sessionId, state: sessionState });
  } catch (e) {
    conferring = false;
    showVerdictRetry(e.message);
    return;
  }
  conferring = false;
  for (const vote of v.votes) {
    setMood(vote.agent, vote.vote === "hire" ? "impressed" : "concerned");
  }
  await speak("manager", v.spoken_verdict);

  // walk out of the room and freeze on a last look back, then lay the score card over that still
  for (const id of ["hud", "ledger", "dock", "ide"]) {
    $(id).classList.add("hidden");
  }
  await playExit();
  renderVerdict(v);
}

// the interview is over, so the Answer button is useless here; offer a retry instead
function showVerdictRetry(message) {
  setStatus(`Verdict failed: ${message}`);
  $("sendBtn").classList.add("hidden");
  let retry = $("retryVerdict");
  if (!retry) {
    retry = document.createElement("button");
    retry.id = "retryVerdict";
    retry.className = "primary";
    retry.textContent = "Retry verdict";
    $("sendBtn").after(retry);
  }
  retry.classList.remove("hidden");
  retry.disabled = false;
  retry.onclick = async () => {
    retry.disabled = true;
    retry.classList.add("hidden");
    setStatus("Asking the panel again…");
    await finishVerdict();
  };
}

function parseTrend(trend) {
  let list = trend;
  if (typeof list === "string") {
    try {
      list = JSON.parse(list);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) {
    return [];
  }
  return list.map((x) => Number(x && x.overall)).filter((n) => Number.isFinite(n));
}

// tiny line chart of overall score per session, on a fixed 1 to 5 scale so sessions compare honestly
function sparkline(scores) {
  const w = 240;
  const h = 84;
  const pad = 14;
  const x = (i) => pad + (i * (w - pad * 2)) / (scores.length - 1);
  const y = (s) => h - pad - ((s - 1) / 4) * (h - pad * 2);
  const points = scores.map((s, i) => `${x(i).toFixed(1)},${y(s).toFixed(1)}`).join(" ");
  const dots = scores
    .map((s, i) => {
      const last = i === scores.length - 1;
      const dot = `<circle cx="${x(i).toFixed(1)}" cy="${y(s).toFixed(1)}" r="${last ? 4 : 2.5}" fill="${last ? "#e8a33d" : "#a89c8d"}" />`;
      const text = `<text x="${x(i).toFixed(1)}" y="${(y(s) - 7).toFixed(1)}" text-anchor="middle">${s.toFixed(1)}</text>`;
      return dot + text;
    })
    .join("");

  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Overall score per session">
    <line x1="${pad}" x2="${w - pad}" y1="${y(3).toFixed(1)}" y2="${y(3).toFixed(1)}" class="mid" />
    <polyline points="${points}" fill="none" stroke="#e8a33d" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    ${dots}
  </svg>`;
}

function renderTrend(profile) {
  const scores = parseTrend(profile && profile.trend);
  if (scores.length < 2) {
    return "";
  }

  const delta = scores[scores.length - 1] - scores[0];
  let note = "Holding steady across sessions.";
  if (delta > 0.05) {
    note = `Up ${delta.toFixed(1)} since your first session.`;
  } else if (delta < -0.05) {
    note = `Down ${Math.abs(delta).toFixed(1)} since your first session. The panel is pushing harder.`;
  }

  return `<div class="trend"><div><h3>Your trend</h3><p>${scores.length} sessions. ${note}</p></div>${sparkline(scores)}</div>`;
}

const VERDICT_LABEL = { hire: "Hire", lean_hire: "Lean hire", lean_no_hire: "Lean no hire", no_hire: "No hire" };
const VERDICT_COLOR = { hire: "#7cc47f", lean_hire: "#b8c46a", lean_no_hire: "#e8a33d", no_hire: "#d9634a" };

// score ring: the arc fills by overall / 5
function scoreRing(overall, color) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const filled = Math.max(0, Math.min(1, overall / 5)) * c;
  return `<svg class="ring" viewBox="0 0 84 84" width="84" height="84" aria-hidden="true">
    <circle cx="42" cy="42" r="${r}" class="track" />
    <circle cx="42" cy="42" r="${r}" class="fill" stroke="${color}" stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" />
    <text x="42" y="47" text-anchor="middle">${overall.toFixed(1)}</text>
  </svg>`;
}

// one collapsible section of the score card; empty sections are left out
function verdictSection(title, count, body, open = false) {
  if (!body) {
    return "";
  }
  const badge = count ? `<span class="count">${count}</span>` : "";
  return `<details class="vfold"${open ? " open" : ""}><summary><span>${title}</span>${badge}</summary><div class="vfoldbody">${body}</div></details>`;
}

function renderVerdict(v) {
  clearBids();
  const overall = Number(v.overall) || 0;
  const label = VERDICT_LABEL[v.verdict] || esc(v.verdict);
  const color = VERDICT_COLOR[v.verdict] || "#e8a33d";

  const votes = v.votes
    .map((x) => {
      const p = PANEL[x.agent];
      const hex = `#${p.color.toString(16)}`;
      const yes = x.vote === "hire";
      return `<div class="vcard" style="--who:${hex}">
        <div class="vcardhead"><b style="color:${hex}">${p.name}</b><span class="pill ${yes ? "yes" : "no"}">${yes ? "Hire" : "No hire"}</span></div>
        <p>${esc(x.reason)}</p>
      </div>`;
    })
    .join("");

  const strengths = (v.strengths || []).map((s) => `<li>${esc(s)}</li>`).join("");
  const growth = (v.growth || [])
    .map(
      (g) =>
        `<li><b>${esc(g.area)}</b>${g.evidence_quote ? `<q>${esc(g.evidence_quote)}</q>` : ""}<div class="drill">Drill: ${esc(g.drill)}</div></li>`,
    )
    .join("");
  const checks = (v.checks || []).map((c) => `<li>${esc(c)}</li>`).join("");
  const quotes = v.votes
    .filter((x) => x.evidence_quote)
    .map((x) => {
      const who = PANEL[x.agent];
      return `<li><b style="color:#${who.color.toString(16)}">${who.name}</b><q>${esc(x.evidence_quote)}</q></li>`;
    })
    .join("");

  const p = v.profile;
  const bruin =
    v.bruin && v.bruin.ok
      ? `<b>Memory updated by Bruin</b> in ${(v.bruin.ms / 1000).toFixed(1)}s · ${p ? p.sessions : "?"} sessions, ${p ? p.turns : "?"} answers on file.<br>Next time the panel will focus on: ${esc(p?.focus || "")}`
      : v.hosted
        ? `<b>Memory runs with Bruin on the full install.</b> This hosted demo doesn't keep sessions. Clone the repo and run it locally to see the panel remember you.`
        : `<b>Bruin pipeline</b> did not run this time.`;
  const memory = `${renderTrend(p)}<div class="bruinbox">${bruin}</div>`;

  $("verdict").innerHTML = `
    <div class="vhead">
      ${scoreRing(overall, color)}
      <div>
        <div class="tag">Panel verdict${v.company && v.company.id !== "general" ? ` · ${esc(v.company.name)}` : ""}</div>
        <div class="vbig" style="color:${color}">${label}</div>
        <div class="vscore">${overall.toFixed(1)} / 5 overall${v.score_ci ? ` · 95% CI ${v.score_ci.low.toFixed(1)}-${v.score_ci.high.toFixed(1)}` : ""}</div>
      </div>
    </div>
    <p class="vsummary">${esc(v.summary)}</p>
    <div class="vcards">${votes}</div>
    ${verdictSection(v.company && v.company.id !== "general" ? `${esc(v.company.name)} values` : "Values", (v.values || []).length, valuesHtml(v.values))}
    ${verdictSection("Strengths", (v.strengths || []).length, strengths && `<ul>${strengths}</ul>`)}
    ${verdictSection("Work on", (v.growth || []).length, growth && `<ul>${growth}</ul>`)}
    ${verdictSection("What they heard", 0, quotes && `<ul class="quotes">${quotes}</ul>`)}
    ${verdictSection("Attention", v.attention ? v.attention.awayEvents : 0, v.attention && `<p>${esc(v.attention.line)}</p>`)}
    ${verdictSection("Engine checks", (v.checks || []).length, checks && `<ul>${checks}</ul>`)}
    ${verdictSection("Memory and trend", 0, memory)}
    <div class="vactions">
      <button class="primary" id="comeBackIn">Come back in</button>
      <span>${v.hosted ? "A fresh panel each time on the hosted demo." : "Same name, so the panel remembers you."}</span>
    </div>`;
  $("verdict").classList.remove("hidden");
  $("dock").classList.add("hidden");
  $("comeBackIn").onclick = comeBackIn;
}

// Walk back in through the door and start a new session under the same name.
function comeBackIn() {
  $("verdict").classList.add("hidden");
  $("ledgerList").innerHTML = "";
  // the last spoken line from the old session should not greet the new one
  $("captionWho").textContent = "";
  $("captionText").textContent = "";
  $("sendBtn").classList.remove("hidden");
  const retry = $("retryVerdict");
  if (retry) {
    retry.classList.add("hidden");
  }
  $("startBtn").disabled = false;
  $("startBtn").click();
}
