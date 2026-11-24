// One voice at a time for the whole panel.
//
// Every line goes through a single queue. A new speak() never interrupts the current line,
// it waits its turn, and its audio starts downloading the moment it is queued so the gap
// between speakers stays short. stopSpeaking() is the only way to cut someone off (barge in).
// If the server can't make audio we fall back to the browser's speechSynthesis.

// Each interviewer must keep one voice for the whole interview. A single failed clip is
// retried instead of switching that line to a different browser voice. Only when the server
// fails this many lines in a row do we give up on it, and then for the rest of the session,
// so everyone switches together once instead of flickering between voices.
const MAX_CONSECUTIVE_FAILURES = 3;
const CLIP_ATTEMPTS = 2;

// A clip that takes longer than this to arrive is not worth waiting for.
const FETCH_TIMEOUT_MS = 15_000;

let profiles = {};
let failuresInARow = 0;
let serverVoicesOff = false;

const queue = [];
let current = null;

// Reusing one element keeps the autoplay unlock from the first click working later on.
const audio = new Audio();
audio.preload = "auto";

// Browser voice fallback settings (voice names, pitch, rate) keyed by agent id.
export function configureVoices(panel) {
  profiles = panel;
}

export function isSpeaking() {
  return current !== null || queue.length > 0;
}

// Leaving the tab or closing the page must silence the panel right away, including the browser
// voice fallback, which otherwise keeps talking in the background.
function silence() {
  stopSpeaking();
  if ("speechSynthesis" in window) {
    window.speechSynthesis.cancel();
  }
  window.dispatchEvent(new Event("hotseat:leave"));
}

window.addEventListener("pagehide", silence);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    silence();
  }
});

export function speak(agentId, text, hooks = {}) {
  // A reply that arrives while the tab is hidden is skipped rather than played to nobody.
  if (document.hidden) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const item = {
      agentId,
      text: String(text || ""),
      hooks,
      resolve,
      controller: new AbortController(),
      stopped: false,
      clip: null,
    };
    item.clip = fetchClip(item);
    queue.push(item);
    pump();
  });
}

export function stopSpeaking() {
  // Queued lines never started, so they resolve without their onStart/onEnd hooks.
  for (const item of queue.splice(0)) {
    item.stopped = true;
    item.controller.abort();
    item.resolve();
  }

  if (current) {
    current.stopped = true;
    current.controller.abort();
    if (current.halt) {
      current.halt();
    }
  }
}

// Call from a click handler: playing something inside the gesture lets later clips autoplay.
export function unlockVoice() {
  audio.src = SILENT_WAV;
  audio.play().catch(() => {});

  if ("speechSynthesis" in window) {
    speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }
}

async function pump() {
  if (current || queue.length === 0) {
    return;
  }

  current = queue.shift();
  const item = current;
  try {
    await play(item);
  } catch (err) {
    console.warn("voice:", err);
  }

  item.resolve();
  current = null;
  pump();
}

async function play(item) {
  const blob = await item.clip;
  if (item.stopped) {
    return;
  }

  if (item.hooks.onStart) {
    item.hooks.onStart();
  }

  try {
    let played = false;
    if (blob) {
      played = await playBlob(item, blob);
    }
    if (!played && !item.stopped) {
      await playBrowserVoice(item);
    }
  } finally {
    if (item.hooks.onEnd) {
      item.hooks.onEnd();
    }
  }
}

async function fetchClip(item) {
  if (!item.text.trim() || serverVoicesOff) {
    return null;
  }

  for (let attempt = 1; attempt <= CLIP_ATTEMPTS; attempt++) {
    const blob = await requestClip(item);
    if (blob) {
      failuresInARow = 0;
      return blob;
    }
    if (item.stopped) {
      return null;
    }
  }

  failuresInARow += 1;
  if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) {
    serverVoicesOff = true;
    console.warn("voice: server voices keep failing, using browser voices for the rest of the session");
  }
  return null;
}

async function requestClip(item) {
  // Each attempt gets its own abort, so a timeout on the first try doesn't cancel the retry.
  // A barge-in (the item's own abort) still cancels whichever attempt is running.
  const attempt = new AbortController();
  const cancel = () => attempt.abort();
  item.controller.signal.addEventListener("abort", cancel);
  const timer = setTimeout(cancel, FETCH_TIMEOUT_MS);
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agent: item.agentId, text: item.text }),
      signal: attempt.signal,
    });
    if (!res.ok) {
      throw new Error(`tts ${res.status}`);
    }
    return await res.blob();
  } catch (err) {
    if (!item.stopped) {
      console.warn("voice: clip failed, retrying", err);
    }
    return null;
  } finally {
    clearTimeout(timer);
    item.controller.signal.removeEventListener("abort", cancel);
  }
}

// Resolves true once the clip has played to the end (or was stopped), false if it couldn't play.
function playBlob(item, blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    let settled = false;

    const finish = (ok) => {
      if (settled) {
        return;
      }
      settled = true;
      audio.onended = null;
      audio.onerror = null;
      item.halt = null;
      URL.revokeObjectURL(url);
      resolve(ok);
    };

    item.halt = () => {
      audio.pause();
      finish(true);
    };
    audio.onended = () => finish(true);
    audio.onerror = () => finish(false);

    audio.src = url;
    audio.play().catch((err) => {
      console.warn("voice: audio playback blocked", err);
      finish(false);
    });
  });
}

// --- browser speechSynthesis fallback ---

let voices = [];

function loadVoices() {
  voices = speechSynthesis.getVoices();
}

if ("speechSynthesis" in window) {
  loadVoices();
  speechSynthesis.addEventListener("voiceschanged", loadVoices);
}

const usedVoices = new Set();
const voiceFor = {};

// Give each panelist a different system voice, preferring the names listed in their profile.
function pickVoice(id) {
  if (voiceFor[id]) {
    return voiceFor[id];
  }

  const en = voices.filter((v) => v.lang.startsWith("en"));
  const wanted = (profiles[id] && profiles[id].voice) || [];
  let v = null;
  for (const name of wanted) {
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

function playBrowserVoice(item) {
  if (!("speechSynthesis" in window) || !item.text.trim()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const profile = profiles[item.agentId] || {};
    const u = new SpeechSynthesisUtterance(item.text);
    const v = pickVoice(item.agentId);
    if (v) {
      u.voice = v;
    }
    u.pitch = profile.pitch || 1;
    u.rate = profile.rate || 1;

    let settled = false;
    let poll = null;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(poll);
      item.halt = null;
      resolve();
    };

    item.halt = () => {
      speechSynthesis.cancel();
      finish();
    };
    u.onend = finish;
    u.onerror = finish;

    // Chrome sometimes drops onend. Instead of a length-based timer (which let the next line
    // start over this one), only finish once the engine itself says it's no longer talking.
    const startedAt = Date.now();
    poll = setInterval(() => {
      const quiet = !speechSynthesis.speaking && !speechSynthesis.pending;
      if (quiet && Date.now() - startedAt > 1500) {
        finish();
      }
    }, 300);

    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// 0.05s of silent 8kHz mono PCM, used only to unlock audio playback on the first click.
const SILENT_WAV = (() => {
  const samples = 400;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, s) => {
    for (let i = 0; i < s.length; i++) {
      bytes[offset + i] = s.charCodeAt(i);
    }
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, "data");
  view.setUint32(40, samples, true);

  // 8-bit PCM is unsigned, so 128 is silence
  bytes.fill(128, 44);

  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return `data:audio/wav;base64,${btoa(binary)}`;
})();
