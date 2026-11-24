// Speech to text for the candidate's spoken answers.
//
// The browser recognizer is fast but mangles numbers and technical terms, so the client records
// the answer and sends the clip here once the candidate stops. Gemini hears the whole clip at once,
// which is what makes "4.8 seconds" or "Postgres" come out right.

// gemini-2.5-flash is closed to new keys like ours (404), so we use the 3.x flash models.
// 3.5 flash was the most accurate and fastest in testing; the others are there because
// Gemini regularly answers 503 "high demand" for a model for a few minutes at a time.
const STT_MODELS = (process.env.STT_MODELS || "gemini-3.5-flash,gemini-3.1-flash-lite,gemini-3.8-flash")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

// Vercel rejects request bodies over about 4.5 MB. The client records 24 kbps opus and stops at
// two minutes (about 360 KB), so this cap only guards against odd clients and local abuse.
export const MAX_AUDIO_BYTES = 15 * 1024 * 1024;

// Gemini accepts these container types for inline audio. Browsers record webm or ogg (Firefox),
// Safari records mp4, and the tests send wav.
const ACCEPTED = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/aac",
  "audio/flac",
];

// A normal answer comes back in about 2 seconds. When a model is overloaded it can hang for
// minutes, so give up on it early and try the next one; the browser waits about 35 seconds.
const ATTEMPT_TIMEOUT_MS = 10_000;

const PROMPT = [
  "This is a recording of a candidate answering a question in a job interview.",
  "Transcribe what they say verbatim and add normal punctuation.",
  "Keep technical terms, product names and numbers exactly as spoken, and write numbers as digits (for example 4.8 seconds, 10x, 200 ms).",
  "Drop filler sounds like um and uh, but do not reword, summarize or fix their grammar.",
  "Return only the transcript text, with no commentary, labels or quotes.",
  "If there is no speech, return an empty response.",
].join(" ");

export function sttAvailable() {
  return Boolean(process.env.GEMINI_API_KEY);
}

// "audio/webm;codecs=opus" -> "audio/webm", since Gemini wants the bare container type.
export function normalizeMime(type) {
  const base = String(type || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  // A recorder given no type can label an audio-only clip as video (Chrome says video/webm,
  // Safari video/mp4). The container is the same, so Gemini gets the audio type.
  const audio = base.replace(/^video\/(webm|mp4|ogg)$/, "audio/$1");
  if (!ACCEPTED.includes(audio)) {
    return null;
  }
  return audio === "audio/x-wav" ? "audio/wav" : audio;
}

export async function transcribe(audio, type) {
  if (!sttAvailable()) {
    throw new Error("no speech to text provider configured");
  }

  const mime = normalizeMime(type);
  if (!mime) {
    throw new Error(`unsupported audio type ${type}`);
  }

  const data = Buffer.from(audio).toString("base64");
  let lastError = null;

  for (const model of STT_MODELS) {
    try {
      return await askGemini(model, mime, data);
    } catch (err) {
      lastError = err;
      console.warn(`stt: ${model} failed, ${err.message || err}`);
    }
  }

  throw lastError || new Error("no speech to text model configured");
}

async function askGemini(model, mime, data) {
  // This key type only works as a query parameter, not as a header.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime, data } }] }],
    generationConfig: {
      temperature: 0,
      // Transcription needs no reasoning, and with thinking on 3.5 flash took 30 s instead of 2.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`gemini stt ${res.status}`);
  }

  const out = await res.json();
  const parts = out.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((p) => p.text || "")
    .join("")
    .trim();

  return cleanTranscript(text);
}

// The model sometimes wraps the answer in quotes or adds a "Transcript:" label anyway.
export function cleanTranscript(text) {
  let out = String(text || "").trim();

  out = out.replace(/^(transcript|transcription)\s*:\s*/i, "");
  out = out.replace(/^["“]+/, "").replace(/["”]+$/, "");
  out = out.replace(/\s+/g, " ");

  return out.trim();
}
