// Stats core: ability estimate, bootstrap interval and quote alignment.
//
// The math lives in native/hotseat_core.cpp, compiled to native/hotseat_core.wasm (checked in,
// so deploys need no compiler). If the module can't load, the JS port below runs instead. It
// performs the same operations in the same order with the same RNG, so both give identical
// numbers; tests/core.test.js holds them to that.

import { readFileSync } from "node:fs";

// Keep these in step with the constants at the top of hotseat_core.cpp.
const PRIOR_MEAN = 3.0;
const PRIOR_VAR = 1.0;
const SLOPE = 1.5;
const TARGET_LOGIT = 0.4054651081081644;
const LN2 = 0.6931471805599453;
const INV_LN2 = 1.4426950408889634;
const MAX_NEWTON_STEPS = 50;
const NEWTON_TOLERANCE = 1e-10;
const MATCH = 2;
const MISMATCH = -1;
const GAP = -1;
const DEFAULT_SEED = 0x9e3779b9;

export const RESAMPLES = 5000;

// ---------- JS port ----------

function clamp(x, lo, hi) {
  if (x < lo) {
    return lo;
  }
  if (x > hi) {
    return hi;
  }
  return x;
}

// Same series as det_exp in the C++. Math.exp is not used because V8 and wasi-libc can
// disagree in the last bit, and that would show up as parity noise.
function detExp(x) {
  x = clamp(x, -700, 700);

  const k = Math.floor(x * INV_LN2 + 0.5);
  const r = x - k * LN2;

  let sum = 1;
  let term = 1;
  for (let i = 1; i <= 18; i++) {
    term = (term * r) / i;
    sum += term;
  }

  let steps = k;
  while (steps > 0) {
    sum *= 2;
    steps--;
  }
  while (steps < 0) {
    sum *= 0.5;
    steps++;
  }
  return sum;
}

function sigmoid(z) {
  return 1 / (1 + detExp(-z));
}

function success(score) {
  return (clamp(score, 1, 5) - 1) / 4;
}

function information(difficulty, theta) {
  let info = 1 / PRIOR_VAR;
  for (const d of difficulty) {
    const p = sigmoid(SLOPE * (theta - clamp(d, 1, 5)));
    info += SLOPE * SLOPE * p * (1 - p);
  }
  return info;
}

export function xorshift(state) {
  let x = state >>> 0;
  x = (x ^ (x << 13)) >>> 0;
  x = (x ^ (x >>> 17)) >>> 0;
  x = (x ^ (x << 5)) >>> 0;
  return x;
}

function jsAbility(difficulty, score) {
  let theta = PRIOR_MEAN;
  let steps = 0;
  while (steps < MAX_NEWTON_STEPS) {
    let grad = -(theta - PRIOR_MEAN) / PRIOR_VAR;
    for (let i = 0; i < difficulty.length; i++) {
      const p = sigmoid(SLOPE * (theta - clamp(difficulty[i], 1, 5)));
      grad += SLOPE * (success(score[i]) - p);
    }

    const step = clamp(grad / information(difficulty, theta), -1, 1);
    theta += step;
    steps++;

    if (Math.abs(step) < NEWTON_TOLERANCE) {
      break;
    }
  }

  const se = 1 / Math.sqrt(information(difficulty, theta));
  const reported = clamp(theta, 1, 5);
  const next = Math.floor(reported - TARGET_LOGIT / SLOPE + 0.5);

  return { theta: reported, se, next: clamp(next, 1, 5) };
}

function jsBootstrap(score, resamples, seed) {
  const n = score.length;

  let total = 0;
  for (const s of score) {
    total += s;
  }

  let state = seed >>> 0 === 0 ? DEFAULT_SEED : seed >>> 0;
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) {
      state = xorshift(state);
      sum += score[state % n];
    }
    means[r] = sum / n;
  }

  // Any correct sort gives the same order for plain numbers, so this matches the C++ heap sort.
  means.sort();

  const lo = Math.floor((25 * (resamples - 1)) / 1000);
  const hi = Math.floor((975 * (resamples - 1) + 999) / 1000);
  return { mean: total / n, low: means[lo], high: means[hi] };
}

function jsAlign(quote, answers) {
  const m = quote.length;
  const result = { answer: -1, start: 0, end: 0, score: 0 };
  if (m === 0 || answers.length === 0) {
    return result;
  }

  let prev = new Int32Array(m + 1);
  let cur = new Int32Array(m + 1);
  let prevStart = new Int32Array(m + 1);
  let curStart = new Int32Array(m + 1);

  let best = 0;
  for (let k = 0; k < answers.length; k++) {
    const words = answers[k];
    prev.fill(0);
    prevStart.fill(0);

    for (let j = 1; j <= words.length; j++) {
      const word = words[j - 1];
      cur[0] = 0;
      curStart[0] = j;

      for (let i = 1; i <= m; i++) {
        const diag = prev[i - 1] + (quote[i - 1] === word ? MATCH : MISMATCH);
        const up = prev[i] + GAP;
        const left = cur[i - 1] + GAP;

        let value = diag;
        let start = prev[i - 1] === 0 ? j - 1 : prevStart[i - 1];
        if (up > value) {
          value = up;
          start = prevStart[i];
        }
        if (left > value) {
          value = left;
          start = curStart[i - 1];
        }
        if (value <= 0) {
          value = 0;
          start = j;
        }

        cur[i] = value;
        curStart[i] = start;

        if (value > best) {
          best = value;
          result.answer = k;
          result.start = start;
          result.end = j;
        }
      }

      [prev, cur] = [cur, prev];
      [prevStart, curStart] = [curStart, prevStart];
    }
  }

  result.score = best / (MATCH * m);
  return result;
}

export const jsCore = { name: "js", ability: jsAbility, bootstrap: jsBootstrap, align: jsAlign };

// ---------- WebAssembly ----------

// Copies arrays into the module's memory, runs fn with their addresses, and frees them after.
function withBuffers(exports, specs, fn) {
  const pointers = specs.map((spec) => exports.malloc(Math.max(1, spec.values.length) * spec.type.BYTES_PER_ELEMENT));
  try {
    // Views are made after every malloc, since a malloc can grow and detach the old buffer.
    specs.forEach((spec, i) => {
      new spec.type(exports.memory.buffer, pointers[i], spec.values.length).set(spec.values);
    });
    return fn(...pointers);
  } finally {
    for (const p of pointers) {
      exports.free(p);
    }
  }
}

function readBack(exports, type, pointer, length) {
  return Array.from(new type(exports.memory.buffer, pointer, length));
}

function makeWasmCore(exports) {
  const ability = (difficulty, score) => {
    const specs = [
      { type: Float64Array, values: difficulty },
      { type: Float64Array, values: score },
      { type: Float64Array, values: [0, 0, 0] },
    ];
    return withBuffers(exports, specs, (d, s, out) => {
      const status = exports.hc_ability(d, s, difficulty.length, out);
      if (status < 0) {
        throw new Error("hc_ability rejected its input");
      }
      const [theta, se, next] = readBack(exports, Float64Array, out, 3);
      return { theta, se, next };
    });
  };

  const bootstrap = (score, resamples, seed) => {
    const specs = [
      { type: Float64Array, values: score },
      { type: Float64Array, values: [0, 0, 0] },
    ];
    return withBuffers(exports, specs, (s, out) => {
      const status = exports.hc_bootstrap(s, score.length, resamples, seed >>> 0, out);
      if (status < 0) {
        throw new Error("hc_bootstrap rejected its input");
      }
      const [mean, low, high] = readBack(exports, Float64Array, out, 3);
      return { mean, low, high };
    });
  };

  const align = (quote, answers) => {
    const offsets = [0];
    for (const words of answers) {
      offsets.push(offsets[offsets.length - 1] + words.length);
    }
    const specs = [
      { type: Int32Array, values: quote },
      { type: Int32Array, values: answers.flat() },
      { type: Int32Array, values: offsets },
      { type: Int32Array, values: [0, 0, 0] },
    ];
    return withBuffers(exports, specs, (q, w, o, out) => {
      const score = exports.hc_align(q, quote.length, w, o, answers.length, out);
      const [answer, start, end] = readBack(exports, Int32Array, out, 3);
      return { answer, start, end, score };
    });
  };

  return { name: "wasm", ability, bootstrap, align, xorshift: (s) => exports.hc_xorshift(s) >>> 0 };
}

async function loadWasm() {
  try {
    const bytes = readFileSync(new URL("../native/hotseat_core.wasm", import.meta.url));
    const { instance } = await WebAssembly.instantiate(bytes, {});
    return makeWasmCore(instance.exports);
  } catch (err) {
    console.warn(`hotseat: C++ core unavailable, using the JS port (${err.message})`);
    return null;
  }
}

// HOTSEAT_JS_CORE=1 forces the JS port, handy for checking the fallback end to end.
export const wasmCore = process.env.HOTSEAT_JS_CORE ? null : await loadWasm();
export const core = wasmCore || jsCore;

// ---------- public helpers ----------

function finite(x) {
  return typeof x === "number" && Number.isFinite(x);
}

// Ability from the (difficulty, score) pairs answered so far. Pairs missing either number
// are skipped; with none left the result is the prior (theta 3, next difficulty 3).
export function estimateAbility(pairs) {
  const usable = (pairs || []).filter((p) => finite(p.difficulty) && finite(p.score));
  return core.ability(
    usable.map((p) => p.difficulty),
    usable.map((p) => p.score),
  );
}

// Mean score with a 95% bootstrap interval. Null when there is nothing to average.
export function scoreInterval(scores, { resamples = RESAMPLES, seed = DEFAULT_SEED } = {}) {
  const usable = (scores || []).filter(finite);
  if (usable.length === 0) {
    return null;
  }
  return core.bootstrap(usable, resamples, seed);
}

// Best local alignment of a quote's words against each answer's words. Words are strings;
// they become small integer ids here so the C++ side only compares numbers.
export function alignWords(quoteWords, answersWords) {
  const ids = new Map();
  const id = (w) => {
    if (!ids.has(w)) {
      ids.set(w, ids.size);
    }
    return ids.get(w);
  };
  const answers = answersWords.map((words) => words.map(id));
  // Quote words that never occur in an answer still need an id, just one that matches nothing.
  const quote = quoteWords.map(id);
  return core.align(quote, answers);
}
