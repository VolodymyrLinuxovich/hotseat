// Speech input for the candidate.
//
// The browser recognizer is quick but bad at numbers and technical terms, so it only drives a
// live preview. At the same time we record the mic, and on Stop the clip goes to /api/stt for an
// accurate transcript that replaces the preview. If the server can't help, the preview stays.
//
// Two layers live here:
//   startListening / stopListening / cancelListening: the plain recorder, usable by any input.
//   bindMicButton: wires a Speak button and a textarea together (the main answer box).

import { stopSpeaking } from "./voice.js";

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Vercel rejects request bodies over about 4.5 MB. At 24 kbps opus two minutes is about 360 KB,
// which leaves plenty of room, and no interview answer should run longer than that anyway.
const BITRATE = 24_000;
const MAX_RECORDING_MS = 120_000;

// Auto stop: once the candidate has said something, this much quiet ends the answer.
const SILENCE_MS = 2500;

// RMS levels on the float time domain signal. Speech near a laptop mic sits around 0.03 to 0.2
// after noise suppression; a quiet room sits well under 0.01.
const SPEECH_RMS = 0.03;
const SILENCE_RMS = 0.012;

// Needs a few loud frames in a row before counting as speech, so a click or a cough doesn't arm
// the silence timer.
const SPEECH_FRAMES = 4;
const METER_INTERVAL_MS = 50;

// The server tries up to three models with a 10 second cap each, so allow a little more than that.
const STT_TIMEOUT_MS = 35_000;

export const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
export const canListen = canRecord || Boolean(SR);

// One session at a time. Everything it holds is torn down by finish().
let session = null;

export function isListening() {
  return session !== null && !session.stopping;
}

// Starts the mic. onPreview(text) gets the browser's running guess, onLevel(0..1) the input level,
// and onSilence() fires when the candidate has gone quiet (or hit the time cap) so the caller can
// stop. Resolves once recording has started; rejects if the mic is unavailable.
export async function startListening({ onPreview, onLevel, onSilence } = {}) {
  if (session) {
    return;
  }

  // Cut the panel off first so the mic doesn't hear the interviewer instead of the candidate.
  stopSpeaking();

  const s = {
    onPreview: onPreview || (() => {}),
    onLevel: onLevel || (() => {}),
    onSilence: onSilence || (() => {}),
    preview: "",
    chunks: [],
    stopping: false,
  };
  session = s;

  try {
    if (canRecord) {
      await startRecorder(s);
    }
  } catch (err) {
    // No recording (permission denied, no device). The recognizer alone still works in Chrome.
    console.warn("listen: recording unavailable, using browser recognition only", err);
    teardownAudio(s);
    if (!SR) {
      session = null;
      throw err;
    }
  }

  // Cancelled while waiting for mic permission.
  if (session !== s) {
    teardownAudio(s);
    return;
  }

  startRecognizer(s);
}

// Stops the mic and resolves to the best transcript we can get: the server's if it answers,
// otherwise whatever the browser heard.
export async function stopListening() {
  const s = session;
  if (!s || s.stopping) {
    return s ? s.preview : "";
  }
  s.stopping = true;

  stopRecognizer(s);
  const blob = await stopRecorder(s);
  finish(s);

  if (!blob || blob.size === 0) {
    return s.preview.trim();
  }

  try {
    const text = await transcribe(blob);
    return text || s.preview.trim();
  } catch (err) {
    console.warn("listen: server transcription failed, keeping the browser transcript", err);
    return s.preview.trim();
  }
}

// Stops everything without sending audio anywhere. Returns the preview text.
export function cancelListening() {
  const s = session;
  if (!s) {
    return "";
  }
  s.stopping = true;
  stopRecognizer(s);
  if (s.recorder && s.recorder.state !== "inactive") {
    s.recorder.ondataavailable = null;
    s.recorder.onstop = null;
    s.recorder.stop();
  }
  finish(s);
  return s.preview.trim();
}

// Leaving the tab or closing the page: drop the recording and release the mic at once, so the
// browser's mic indicator goes off and nothing half-heard gets sent.
window.addEventListener("hotseat:leave", () => {
  cancelListening();
});

async function transcribe(blob) {
  const res = await fetch("/api/stt", {
    method: "POST",
    headers: { "Content-Type": blob.type || "audio/webm" },
    body: blob,
    signal: AbortSignal.timeout(STT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`stt ${res.status}`);
  }
  const data = await res.json();
  return String(data.text || "").trim();
}

// ---------- recorder ----------

function pickMimeType() {
  const options = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
  return options.find((t) => MediaRecorder.isTypeSupported(t)) || "";
}

async function startRecorder(s) {
  s.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });

  const mimeType = pickMimeType();
  const options = { audioBitsPerSecond: BITRATE };
  if (mimeType) {
    options.mimeType = mimeType;
  }
  s.recorder = new MediaRecorder(s.stream, options);
  s.recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      s.chunks.push(e.data);
    }
  };
  // Timeslices keep the data flowing, so a stop never waits on one huge final chunk.
  s.recorder.start(1000);

  s.capTimer = setTimeout(() => s.onSilence(), MAX_RECORDING_MS);
  startMeter(s);
}

function stopRecorder(s) {
  const recorder = s.recorder;
  if (!recorder || recorder.state === "inactive") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    recorder.onstop = () => {
      resolve(new Blob(s.chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    recorder.stop();
  });
}

// ---------- level meter and silence detection ----------

function startMeter(s) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) {
    return;
  }

  s.audioCtx = new Ctx();
  const source = s.audioCtx.createMediaStreamSource(s.stream);
  const analyser = s.audioCtx.createAnalyser();
  analyser.fftSize = 1024;
  source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  let loudFrames = 0;
  let spoke = false;
  let quietSince = 0;

  s.meterTimer = setInterval(() => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) {
      sum += v * v;
    }
    const rms = Math.sqrt(sum / samples.length);

    // Map onto 0..1 with a little headroom; speech mostly lands in the upper half.
    s.onLevel(Math.min(1, rms / 0.15));

    if (rms > SPEECH_RMS) {
      loudFrames++;
      if (loudFrames >= SPEECH_FRAMES) {
        spoke = true;
      }
    } else {
      loudFrames = 0;
    }

    if (!spoke) {
      return;
    }
    if (rms > SILENCE_RMS) {
      quietSince = 0;
      return;
    }

    const now = performance.now();
    if (!quietSince) {
      quietSince = now;
    } else if (now - quietSince > SILENCE_MS && !s.stopping) {
      quietSince = 0;
      s.onSilence();
    }
  }, METER_INTERVAL_MS);
}

// ---------- browser recognizer (preview only) ----------

function startRecognizer(s) {
  if (!SR) {
    return;
  }

  try {
    s.rec = openRecognizer(s, "");
  } catch (err) {
    console.warn("listen: browser recognition failed to start", err);
  }
}

// A restarted recognizer begins with an empty result list, so prefix what the last one heard.
function openRecognizer(s, prefix) {
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  rec.onresult = (e) => {
    let text = "";
    for (let i = 0; i < e.results.length; i++) {
      text += e.results[i][0].transcript;
    }
    s.preview = prefix + text;
    s.onPreview(s.preview);
  };
  // Chrome ends continuous recognition on its own after a long pause. The recording is what
  // counts, so just restart the preview while we are still listening.
  rec.onend = () => {
    if (session === s && !s.stopping) {
      try {
        s.rec = openRecognizer(s, s.preview ? s.preview + " " : "");
      } catch {
        // the preview stops, the recording carries on
      }
    }
  };
  rec.onerror = () => {};
  rec.start();
  return rec;
}

function stopRecognizer(s) {
  if (!s.rec) {
    return;
  }

  // Late results must not overwrite the box after we've moved on.
  s.rec.onresult = null;
  s.rec.onend = null;
  try {
    s.rec.stop();
  } catch {
    // already stopped
  }
  s.rec = null;
}

// ---------- teardown ----------

function teardownAudio(s) {
  clearInterval(s.meterTimer);
  clearTimeout(s.capTimer);
  if (s.audioCtx) {
    s.audioCtx.close().catch(() => {});
    s.audioCtx = null;
  }
  if (s.stream) {
    for (const track of s.stream.getTracks()) {
      track.stop();
    }
    s.stream = null;
  }
}

function finish(s) {
  teardownAudio(s);
  s.onLevel(0);
  if (session === s) {
    session = null;
  }
}

// ---------- the Speak button for a textarea ----------

// Wires a Speak/Stop button to a textarea. Text typed before Speak is kept and the transcript
// goes after it. Returns startRec/stopRec for older callers: stopRec drops the recording and
// keeps the preview, which is what sending mid sentence should do.
export function bindMicButton(button, box, { idleLabel = "🎙 Speak", stopLabel = "■ Stop" } = {}) {
  let base = "";
  let state = "idle";

  // Bumped whenever a result should no longer land in the box (a send, a new recording).
  let generation = 0;

  if (!canListen) {
    button.disabled = true;
    button.title = "Speech input needs microphone access";
  }

  const setState = (next) => {
    state = next;
    button.classList.toggle("rec", next === "recording");
    button.classList.toggle("transcribing", next === "transcribing");
    box.classList.toggle("previewing", next === "recording");
    button.disabled = next === "transcribing" || !canListen;
    if (next === "recording") {
      button.textContent = stopLabel;
    } else if (next === "transcribing") {
      button.textContent = "Transcribing…";
    } else {
      button.textContent = idleLabel;
    }
    if (next !== "recording") {
      button.style.setProperty("--level", "0");
    }
  };

  const write = (text) => {
    box.value = base + text;
  };

  const startRec = async () => {
    if (state !== "idle" || !canListen) {
      return;
    }
    generation++;
    base = box.value.trim() ? box.value.replace(/\s+$/, "") + " " : "";
    setState("recording");

    try {
      await startListening({
        onPreview: write,
        onLevel: (level) => button.style.setProperty("--level", level.toFixed(2)),
        onSilence: () => stopRec(true),
      });
    } catch (err) {
      console.warn("listen: microphone unavailable", err);
      button.title = "Microphone unavailable";
      setState("idle");
    }
  };

  // transcribeIt=false (the default for old callers) keeps the preview and sends nothing.
  const stopRec = async (transcribeIt = false) => {
    if (state !== "recording") {
      if (!transcribeIt) {
        // a send while transcribing: let the late transcript fall on the floor
        generation++;
      }
      return;
    }

    if (!transcribeIt) {
      generation++;
      cancelListening();
      setState("idle");
      return;
    }

    const mine = ++generation;
    setState("transcribing");
    const text = await stopListening();
    if (mine === generation && text) {
      write(text);
    }
    setState("idle");
  };

  button.onclick = () => {
    if (state === "recording") {
      stopRec(true);
    } else {
      startRec();
    }
  };

  // Leaving the page drops a recording in progress, so reset the button with it.
  window.addEventListener("hotseat:leave", () => {
    if (state === "recording") {
      generation++;
      setState("idle");
    }
  });

  return { startRec, stopRec, isRecording: () => state === "recording" };
}
