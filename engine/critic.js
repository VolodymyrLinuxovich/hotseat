// The trained answer critic, run in Node with no Python.
//
// train/critic.py fits the model and exports it to engine/critic-model.json. This file is a
// line-by-line copy of that script's feature code and prediction math, so both sides give
// the same score for the same answer. tests/critic.test.js holds them to it.

import fs from "node:fs";
import path from "node:path";

import { ROOT } from "./config.js";

export const MODEL_PATH = path.join(ROOT, "engine", "critic-model.json");

const SINGULAR = new Set(["i", "me", "my", "mine", "myself"]);
const PLURAL = new Set(["we", "us", "our", "ours", "ourselves"]);
const HEDGES = new Set([
  "maybe",
  "probably",
  "kind",
  "sort",
  "basically",
  "honestly",
  "guess",
  "somewhat",
  "pretty",
  "stuff",
  "things",
  "like",
  "just",
  "um",
  "uh",
  "lot",
]);
const TECH = new Set([
  "api",
  "cache",
  "caching",
  "latency",
  "database",
  "db",
  "postgres",
  "redis",
  "queue",
  "shard",
  "sharding",
  "index",
  "query",
  "throughput",
  "p99",
  "p95",
  "ms",
  "memory",
  "cpu",
  "thread",
  "lock",
  "race",
  "deploy",
  "rollback",
  "kafka",
  "load",
  "replica",
  "schema",
  "test",
  "tests",
  "bug",
  "profiler",
  "benchmark",
  "consistency",
  "partition",
  "timeout",
  "retry",
  "batch",
  "pipeline",
  "algorithm",
  "complexity",
  "hash",
  "tradeoff",
]);

const TOKEN_RE = /[a-z0-9]+/g;
const NUMBER_RE = /[0-9]+(?:[.,][0-9]+)*/g;
const JUDGE_RE = /([0-9]+)\/([0-9]+) hidden tests/;

// ---------- features (mirror of train/critic.py) ----------

export function tokenize(text) {
  return String(text).toLowerCase().match(TOKEN_RE) || [];
}

export function analyze(text) {
  const tokens = tokenize(text);
  const grams = [...tokens];
  for (let i = 0; i + 1 < tokens.length; i++) {
    grams.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return grams;
}

function countIn(tokens, set) {
  return tokens.filter((t) => set.has(t)).length;
}

export function handFeatures(text) {
  const lower = String(text).toLowerCase();
  const tokens = tokenize(text);
  const n = tokens.length;
  // Rates divide by at least 1 so an empty answer gives zeros instead of NaN.
  const per = Math.max(n, 1);

  const singular = countIn(tokens, SINGULAR);
  const plural = countIn(tokens, PLURAL);
  let iShare = 0.5;
  if (singular + plural > 0) {
    iShare = singular / (singular + plural);
  }

  let judgeFail = 0;
  const match = lower.match(JUDGE_RE);
  if (match && Number(match[2]) > 0) {
    judgeFail = 1 - Number(match[1]) / Number(match[2]);
  }

  const numbers = (lower.match(NUMBER_RE) || []).length;
  const percents = lower.split("%").length - 1 + tokens.filter((t) => t === "percent").length;

  return [
    numbers > 0 ? 1 : 0,
    Math.log(1 + numbers),
    percents,
    singular / per,
    plural / per,
    iShare,
    Math.log(1 + n),
    countIn(tokens, HEDGES) / per,
    countIn(tokens, TECH) / per,
    lower.split("?").length - 1,
    judgeFail,
    lower.includes("[live coding") || lower.includes("[judge]") ? 1 : 0,
  ];
}

// Sparse feature vector: Map of column index to value, TF-IDF columns first, then hand features.
export function features(model, text) {
  const counts = new Map();
  for (const gram of analyze(text)) {
    const i = model.index.get(gram);
    if (i !== undefined) {
      counts.set(i, (counts.get(i) || 0) + 1);
    }
  }

  const weights = new Map();
  for (const [i, c] of counts) {
    weights.set(i, (1 + Math.log(c)) * model.idf[i]);
  }
  let sumSquares = 0;
  for (const w of weights.values()) {
    sumSquares += w * w;
  }
  const norm = Math.sqrt(sumSquares);
  if (norm > 0) {
    for (const [i, w] of weights) {
      weights.set(i, w / norm);
    }
  }

  const offset = model.vocab.length;
  handFeatures(text).forEach((value, j) => {
    weights.set(offset + j, (value - model.hand_mean[j]) / model.hand_scale[j]);
  });
  return weights;
}

// Summed in index order, like the Python side, so floating point rounding matches too.
function dot(weights, coef) {
  const keys = [...weights.keys()].sort((a, b) => a - b);
  let total = 0;
  for (const i of keys) {
    total += weights.get(i) * coef[i];
  }
  return total;
}

export function predictWith(model, text) {
  const x = features(model, text);
  const raw = dot(x, model.score.coef) + model.score.intercept;
  const clipped = Math.min(5, Math.max(1, raw));

  const probs = {};
  const picked = [];
  for (const [tag, part] of Object.entries(model.tags)) {
    const z = dot(x, part.coef) + part.intercept;
    const p = 1 / (1 + Math.exp(-z));
    probs[tag] = p;
    if (p >= part.threshold) {
      picked.push(tag);
    }
  }
  picked.sort((a, b) => probs[b] - probs[a]);

  return { raw, score: Math.floor(clipped + 0.5), tags: picked.slice(0, model.max_tags), probs };
}

// ---------- loading ----------

let cached = null;
let cachedMtime = 0;

// The Bruin run retrains the critic and rewrites the JSON while the server is up, so the
// file's mtime is checked on every call and a newer model is picked up without a restart.
export function loadModel(file = MODEL_PATH) {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (cached && cached.file === file && mtime === cachedMtime) {
    return cached.model;
  }
  try {
    const model = JSON.parse(fs.readFileSync(file, "utf8"));
    model.index = new Map(model.vocab.map((term, i) => [term, i]));
    cached = { file, model };
    cachedMtime = mtime;
    return model;
  } catch {
    // A half-written or broken file: keep using the last good model if there is one.
    return cached ? cached.model : null;
  }
}

// Score one answer. Returns null when no model has been trained yet, so callers can skip.
export function critique(answer, file = MODEL_PATH) {
  const model = loadModel(file);
  if (!model) {
    return null;
  }
  const result = predictWith(model, answer);
  return { score: result.score, raw: result.raw, tags: result.tags };
}
