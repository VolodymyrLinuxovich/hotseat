// Text to speech for the panel. Each interviewer gets their own voice and a short acting note,
// so the three of them sound like different people instead of one browser voice.
//
// Gemini is tried first when GEMINI_API_KEY is set, then OpenAI when OPENAI_API_KEY is set.

import OpenAI from "openai";

const TTS_MODEL = "gpt-4o-mini-tts";

// Questions are capped well below this, but the spoken verdict can run longer.
const MAX_CHARS = 1500;

// Every model in this chain offers the same prebuilt voices, so a fallback keeps each
// interviewer sounding like themselves. OpenAI voices are different people, so OpenAI is
// only used when no Gemini key is set at all.
const GEMINI_MODELS = ["gemini-2.5-flash-preview-tts", "gemini-3.1-flash-tts-preview", "gemini-2.5-pro-preview-tts"];

export const VOICES = {
  manager: {
    gemini: "Sulafat",
    geminiStyle: "Say this warmly and directly, like a friendly hiring manager",
    voice: "coral",
    instructions:
      "You are Maya, a hiring manager running a job interview. Speak warmly and directly, at a relaxed conversational pace, like a friendly person who still expects a real answer. Natural pauses between sentences.",
  },
  tech: {
    gemini: "Charon",
    geminiStyle: "Say this in a curious, precise, clear voice, like a tech lead",
    voice: "ash",
    instructions:
      "You are Theo, a tech lead interviewing an engineer. Sound curious and precise. Medium pace, clear articulation of technical terms, a little energy when asking a follow up.",
  },
  skeptic: {
    gemini: "Alnilam",
    geminiStyle: "Say this calmly and a little dryly, slightly slow, quietly skeptical",
    voice: "sage",
    instructions:
      "You are Sol, the bar raiser on an interview panel. Speak calmly and dryly, slightly slower than normal, with a quietly skeptical tone. Never theatrical, never sarcastic.",
  },
};

let client = null;

function getClient() {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

// The same question gets replayed and prefetched, so keep recent clips around.
// Map keeps insertion order, which is enough for a simple oldest-first eviction.
const CACHE_LIMIT = 200;
const cache = new Map();

function remember(key, audio) {
  cache.set(key, audio);
  if (cache.size > CACHE_LIMIT) {
    cache.delete(cache.keys().next().value);
  }
}

// The model writes plain sentences, but stray markdown or wrapping quotes get read out loud
// ("asterisk", odd pauses), so strip them before synthesis.
export function cleanForSpeech(text) {
  let out = String(text || "");

  // [label](url) reads as just the label
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/```[\s\S]*?```/g, " ");
  out = out.replace(/`([^`]*)`/g, "$1");
  out = out.replace(/[*_#>~|]+/g, " ");
  out = out.replace(/^\s*[-•]\s+/gm, "");
  out = out.replace(/\s+/g, " ").trim();

  // a line wrapped in quotes is still just the line
  out = out.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "");

  return out.trim().slice(0, MAX_CHARS);
}

export async function synthesize(agent, text) {
  const profile = VOICES[agent];
  if (!profile) {
    throw new Error(`unknown agent ${agent}`);
  }

  const input = cleanForSpeech(text);
  if (!input) {
    throw new Error("nothing to say");
  }

  const key = `${agent}\n${input}`;
  if (cache.has(key)) {
    return cache.get(key);
  }

  let clip = null;
  let lastError = null;

  if (process.env.GEMINI_API_KEY) {
    for (const model of GEMINI_MODELS) {
      try {
        clip = await geminiSpeech(profile, input, model);
        break;
      } catch (err) {
        lastError = err;
      }
    }
  }
  if (!clip && !process.env.GEMINI_API_KEY && process.env.OPENAI_API_KEY) {
    try {
      clip = await openaiSpeech(profile, input);
    } catch (err) {
      lastError = err;
    }
  }
  if (!clip) {
    throw lastError || new Error("no speech provider configured");
  }

  remember(key, clip);
  return clip;
}

async function openaiSpeech(profile, input) {
  const response = await getClient().audio.speech.create({
    model: TTS_MODEL,
    voice: profile.voice,
    input,
    instructions: profile.instructions,
    response_format: "mp3",
  });
  return { audio: Buffer.from(await response.arrayBuffer()), type: "audio/mpeg" };
}

async function geminiSpeech(profile, input, model) {
  // This key type only works as a query parameter, not as a header.
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const body = {
    contents: [{ parts: [{ text: `${profile.geminiStyle}: ${input}` }] }],
    generationConfig: {
      responseModalities: ["AUDIO"],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: profile.gemini } } },
    },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`gemini tts ${res.status}`);
  }

  const data = await res.json();
  const part = data.candidates?.[0]?.content?.parts?.[0]?.inlineData;
  if (!part) {
    throw new Error("gemini tts returned no audio");
  }

  // Gemini sends raw 16-bit PCM; browsers need a WAV header to play it.
  const rate = Number(/rate=(\d+)/.exec(part.mimeType)?.[1] || 24000);
  return { audio: pcmToWav(Buffer.from(part.data, "base64"), rate), type: "audio/wav" };
}

function pcmToWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}
