// The trained question policy, run in Node with no Python.
//
// train/policy.py learns, with Q-learning on simulated candidates, which interviewer should
// ask which topic at which difficulty, and exports the weights to engine/policy-model.json.
// This file copies the belief update and the features from train/sim.py line by line, so
// both sides rank the actions the same way. tests/policy.test.js holds them to it.

import fs from "node:fs";
import path from "node:path";

import { AGENTS } from "./agents.js";
import { ROOT } from "./config.js";
import { estimateAbility } from "./core.js";

export const MODEL_PATH = path.join(ROOT, "engine", "policy-model.json");

const MAX_QUESTIONS = 5;
const CODING_ROUND = 3;

// Looser topic names the panel's model tends to write, folded onto the seven topics.
// Same table as TOPIC_HINTS in train/policy.py.
const TOPIC_HINTS = [
  ["ownership", ["owner", "impact", "leadership"]],
  ["metrics", ["metric", "numbers", "measure", "results"]],
  ["tradeoffs", ["tradeoff", "trade_off"]],
  ["system_design", ["design", "architecture", "scal"]],
  ["conflict", ["conflict", "disagree", "teamwork", "collaboration"]],
  ["debugging", ["debug", "incident", "outage", "bug"]],
  ["coding", ["coding", "code", "algorithm"]],
];

const TOPICS = TOPIC_HINTS.map(([name]) => name);

const BAND_WORDS = { low: "low", mid: "medium", high: "high" };

// ---------- topics ----------

export function canonicalTopic(topic) {
  const key = String(topic || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "_")
    .replace(/^_+|_+$/g, "");
  if (TOPICS.includes(key)) {
    return key;
  }
  for (const [name, hints] of TOPIC_HINTS) {
    if (hints.some((h) => key.includes(h))) {
      return name;
    }
  }
  return null;
}

// ---------- belief over topic skills (mirror of train/sim.py) ----------

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function trace(cov) {
  let total = 0;
  for (let i = 0; i < cov.length; i++) {
    total += cov[i][i];
  }
  return total;
}

// One Laplace step for one scored answer, the same assumed-density filter as update_belief.
function updateBelief(model, belief, topic, asker, difficulty, score) {
  const k = model.topics.indexOf(topic);
  let a = 1;
  if (model.affinity[asker]) {
    a = model.affinity[asker][topic];
  }
  const slope = model.slope * a;
  const y = (clamp(score, 1, 5) - 1) / 4;
  const d = clamp(difficulty, 1, 5);

  const mean = belief.mean;
  const cov = belief.cov;
  const mk = mean[k];
  const vk = cov[k][k];

  let u = mk;
  for (let i = 0; i < 20; i++) {
    const p = sigmoid(slope * (u - d));
    const grad = -(u - mk) / vk + slope * (y - p);
    const hess = 1 / vk + slope * slope * p * (1 - p);
    const step = clamp(grad / hess, -1, 1);
    u += step;
    if (Math.abs(step) < 1e-10) {
      break;
    }
  }

  const p = sigmoid(slope * (u - d));
  const info = slope * slope * p * (1 - p);
  const column = cov.map((row) => row[k]);
  const shrink = info / (1 + info * vk);

  belief.mean = mean.map((m, i) => m + column[i] * ((u - mk) / vk));
  belief.cov = cov.map((row, i) => row.map((c, j) => c - column[i] * column[j] * shrink));
}

// history items: { asker, topic (canonical or null), difficulty, score (or null) }.
export function buildState(model, history, weak) {
  const belief = { mean: [...model.prior_mean], cov: model.prior_cov.map((row) => [...row]) };
  const pairs = [];
  const covered = new Set();
  const counts = Object.fromEntries(model.askers.map((a) => [a, 0]));

  for (const turn of history) {
    const known = model.topics.includes(turn.topic);
    if (known && turn.score !== null) {
      updateBelief(model, belief, turn.topic, turn.asker, turn.difficulty, turn.score);
    }
    if (turn.score !== null) {
      pairs.push({ difficulty: turn.difficulty, score: turn.score });
    }
    if (known) {
      covered.add(turn.topic);
    }
    if (turn.asker in counts) {
      counts[turn.asker] += 1;
    }
  }

  const ability = estimateAbility(pairs);
  let last = null;
  if (history.length > 0) {
    last = history[history.length - 1].asker;
  }
  return {
    belief,
    theta: ability.theta,
    se: ability.se,
    covered,
    weak: new Set(weak),
    counts,
    last,
    question: history.length + 1,
  };
}

// Every free action in the trainer's order: asker, then topic, then band.
export function actions(model) {
  const out = [];
  for (const asker of model.askers) {
    for (const topic of model.free_topics) {
      for (let band = 0; band < model.bands.length; band++) {
        out.push({ asker, topic, band });
      }
    }
  }
  return out;
}

// One feature row per action, columns in model.features order (see action_features).
export function actionFeatures(model, state) {
  const { mean, cov } = state.belief;
  const reward = model.reward;
  const coding = model.topics.indexOf("coding");
  const late = (state.question - 1) / (MAX_QUESTIONS - 1);
  const left = (MAX_QUESTIONS - state.question) / (MAX_QUESTIONS - 1);
  const total = trace(cov);
  const weakLeft = [...state.weak].filter((t) => !state.covered.has(t)).length;
  const beforeCoding = state.question < CODING_ROUND ? 1 : 0;
  const nextIsCoding = state.question === CODING_ROUND - 1 ? 1 : 0;

  return actions(model).map(({ asker, topic, band }) => {
    const k = model.topics.indexOf(topic);
    const a = model.affinity[asker][topic];
    const d = model.band_difficulty[band];
    const vk = cov[k][k];

    const p = sigmoid(model.slope * a * (mean[k] - d));
    const info = model.slope * model.slope * a * a * p * (1 - p);
    let spread = 0;
    for (let i = 0; i < cov.length; i++) {
      spread += cov[i][k] * cov[i][k];
    }
    const gain = (info * spread) / (1 + info * vk);

    const covered = state.covered.has(topic) ? 1 : 0;
    const weak = state.weak.has(topic) ? 1 : 0;
    const same = asker === state.last ? 1 : 0;

    let expected = gain + reward.coaching_bonus * weak * (1 - covered);
    expected -= reward.repeat_topic_penalty * covered + reward.repeat_asker_penalty * same;

    const row = [
      1,
      gain,
      expected,
      vk,
      mean[k] - 3,
      (d - mean[k]) ** 2,
      a - 1,
      covered,
      weak,
      weak * (1 - covered),
      same,
      state.counts[asker] / MAX_QUESTIONS,
      late * gain,
      (state.theta - 3) * (d - 3),
      state.se,
      band === 0 ? 1 : 0,
      band === 2 ? 1 : 0,
      left,
      total,
      left * total,
      weakLeft,
      (beforeCoding * cov[k][coding] ** 2) / (cov[coding][coding] * vk),
      nextIsCoding * (asker === "tech" ? 1 : 0),
    ];
    for (const t of model.free_topics) {
      row.push(topic === t ? 1 : 0);
    }
    for (const x of model.askers) {
      row.push(asker === x ? 1 : 0);
    }
    return row;
  });
}

// Q value of every action, and the best one. Ties go to the first, like numpy's argmax.
export function rankActions(model, state) {
  const feats = actionFeatures(model, state);
  const values = feats.map((row) => {
    let total = 0;
    for (let i = 0; i < row.length; i++) {
      total += row[i] * model.weights[i];
    }
    return total;
  });

  let best = 0;
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[best]) {
      best = i;
    }
  }
  return { feats, values, best };
}

// ---------- loading ----------

let cached = null;
let cachedMtime = 0;

// The Bruin run fine-tunes the policy and rewrites the JSON while the server is up, so the
// file's mtime is checked on every call and newer weights are picked up without a restart.
export function loadPolicy(file = MODEL_PATH) {
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
    if (model.weights.length !== model.features.length) {
      throw new Error("weights and features disagree");
    }
    cached = { file, model };
    cachedMtime = mtime;
    return model;
  } catch {
    // A half-written or broken file: keep using the last good model if there is one.
    return cached ? cached.model : null;
  }
}

// ---------- session glue ----------

function weakTopics(profile) {
  const topics = ((profile && profile.weak_topics) || []).map((w) => canonicalTopic(w.topic));
  return topics.filter((t) => t && t !== "coding");
}

// The answered turns as the trainer sees them. The panel scores the latest answer in the
// same call that picks the next question, so lastScore (the critic's score) stands in for it.
export function sessionHistory(session, lastScore = null) {
  const asked = session.turns.filter((t) => t.question);
  return asked.map((t, i) => {
    let score = typeof t.score === "number" ? t.score : null;
    if (score === null && i === asked.length - 1 && typeof lastScore === "number") {
      score = lastScore;
    }
    if (!t.answer) {
      score = null;
    }
    return {
      asker: t.asker,
      topic: canonicalTopic(t.topic),
      difficulty: typeof t.difficulty === "number" ? t.difficulty : 3,
      score,
    };
  });
}

// The policy's pick for the next question, or null when there is no model or no free choice.
export function suggestNext(session, { lastScore = null, file = MODEL_PATH } = {}) {
  const model = loadPolicy(file);
  if (!model) {
    return null;
  }
  const history = sessionHistory(session, lastScore);
  if (history.length + 1 === CODING_ROUND || history.length >= MAX_QUESTIONS) {
    return null;
  }

  const state = buildState(model, history, weakTopics(session.profile));
  const { feats, values, best } = rankActions(model, state);
  const action = actions(model)[best];
  const gainColumn = model.features.indexOf("expected_gain");
  return {
    asker: action.asker,
    name: AGENTS[action.asker].name,
    topic: action.topic,
    band: model.bands[action.band],
    difficulty: model.band_difficulty[action.band],
    value: Math.round(values[best] * 100) / 100,
    gain: Math.round(feats[best][gainColumn] * 100) / 100,
  };
}

export function policyLine(policy) {
  if (!policy) {
    return "";
  }
  const topic = policy.topic.replace(/_/g, " ");
  const band = BAND_WORDS[policy.band] || policy.band;
  return `[POLICY] Trained policy suggests: ${policy.name} asks about ${topic} at ${band} difficulty (expected info gain ${policy.gain.toFixed(2)}).`;
}

// One engine note on whether the panel took the suggestion. Asker and topic decide it;
// difficulty is left out because the engine nudges it toward the core's estimate anyway.
export function policyCheck(policy, decision) {
  if (!policy) {
    return null;
  }
  const topic = canonicalTopic(decision.topic);
  if (decision.asker === policy.asker && topic === policy.topic) {
    return "Panel followed the trained policy.";
  }
  const name = AGENTS[decision.asker] ? AGENTS[decision.asker].name : decision.asker;
  const shown = String(decision.topic || "general").replace(/_/g, " ");
  return `Panel overrode the policy: chose ${name} on ${shown}.`;
}
