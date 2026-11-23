// Tests for the stats core: the C++ (WebAssembly) build and the JS fallback must agree exactly,
// and the numbers have to make sense on their own.

import assert from "node:assert/strict";
import { test } from "node:test";

import { alignedQuote, closestSentence, quoteIsReal } from "../engine/checks.js";
import { alignWords, estimateAbility, jsCore, RESAMPLES, scoreInterval, wasmCore, xorshift } from "../engine/core.js";

const SEED = 0x9e3779b9;

const ABILITY_CASES = [
  [[], []],
  [[3], [3]],
  [
    [5, 5, 5],
    [5, 5, 5],
  ],
  [
    [1, 1, 2],
    [1, 2, 1],
  ],
  [
    [2, 3, 4, 5, 4],
    [4, 4, 5, 5, 3],
  ],
  [
    [5, 4],
    [1, 2],
  ],
  [
    [3, 3.5, 2],
    [2.5, 4, 1],
  ],
];

const SCORE_CASES = [[3], [1, 5], [4, 4, 5, 3, 2], [2.5, 3.5, 4], [1, 1, 1, 2, 5]];

const ALIGN_CASES = [
  [
    [1, 2, 3],
    [
      [9, 9, 1, 2, 3, 8],
      [1, 7, 2, 3],
    ],
  ],
  [
    [4, 5, 6, 7],
    [
      [4, 5, 0, 6, 7],
      [7, 6, 5, 4],
    ],
  ],
  [[1], [[2, 3], []]],
  [[], [[1, 2]]],
  [[1, 2], []],
];

// HOTSEAT_JS_CORE=1 runs the whole file against the JS port on purpose.
test("the WebAssembly core loads in Node", { skip: Boolean(process.env.HOTSEAT_JS_CORE) }, () => {
  assert.ok(wasmCore, "native/hotseat_core.wasm failed to load; run npm run build:native");
});

test("WASM and JS agree exactly on ability", { skip: !wasmCore }, () => {
  for (const [difficulty, score] of ABILITY_CASES) {
    assert.deepEqual(wasmCore.ability(difficulty, score), jsCore.ability(difficulty, score));
  }
});

test("WASM and JS agree exactly on the bootstrap interval", { skip: !wasmCore }, () => {
  for (const scores of SCORE_CASES) {
    for (const seed of [SEED, 1, 0, 123456789]) {
      assert.deepEqual(wasmCore.bootstrap(scores, RESAMPLES, seed), jsCore.bootstrap(scores, RESAMPLES, seed));
    }
  }
});

test("WASM and JS agree exactly on alignment", { skip: !wasmCore }, () => {
  for (const [quote, answers] of ALIGN_CASES) {
    assert.deepEqual(wasmCore.align(quote, answers), jsCore.align(quote, answers));
  }
});

test("WASM and JS share the same xorshift stream", { skip: !wasmCore }, () => {
  let state = SEED;
  for (let i = 0; i < 1000; i++) {
    assert.equal(wasmCore.xorshift(state), xorshift(state));
    state = xorshift(state);
  }
});

test("no answers gives the prior", () => {
  const ability = estimateAbility([]);
  assert.equal(ability.theta, 3);
  assert.equal(ability.se, 1);
  assert.equal(ability.next, 3);
});

test("strong answers on hard questions mean high ability", () => {
  const strong = estimateAbility([
    { difficulty: 4, score: 5 },
    { difficulty: 5, score: 5 },
    { difficulty: 5, score: 4 },
  ]);
  const weak = estimateAbility([
    { difficulty: 1, score: 2 },
    { difficulty: 2, score: 1 },
    { difficulty: 2, score: 1 },
  ]);

  assert.ok(strong.theta > 4, `strong theta ${strong.theta}`);
  assert.ok(weak.theta < 2, `weak theta ${weak.theta}`);
  assert.ok(strong.next >= 4);
  assert.ok(weak.next <= 2);
});

test("more answers shrink the standard error", () => {
  const one = estimateAbility([{ difficulty: 3, score: 4 }]);
  const four = estimateAbility([
    { difficulty: 3, score: 4 },
    { difficulty: 3, score: 4 },
    { difficulty: 3, score: 4 },
    { difficulty: 3, score: 4 },
  ]);
  assert.ok(four.se < one.se);
});

test("pairs with a missing number are skipped", () => {
  const clean = estimateAbility([{ difficulty: 3, score: 4 }]);
  const noisy = estimateAbility([{ difficulty: 3, score: 4 }, { difficulty: 3 }, { score: 5 }, null].filter(Boolean));
  assert.deepEqual(noisy, clean);
});

test("the bootstrap interval contains the mean and is deterministic", () => {
  for (const scores of SCORE_CASES) {
    const ci = scoreInterval(scores);
    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;

    assert.equal(ci.mean, mean);
    assert.ok(ci.low <= ci.mean && ci.mean <= ci.high, JSON.stringify(ci));
    assert.deepEqual(scoreInterval(scores), ci);
  }
  assert.equal(scoreInterval([]), null);
});

test("alignment finds an exact substring", () => {
  const hit = alignWords(
    ["we", "cut", "latency", "by", "half"],
    [
      ["i", "led", "the", "team"],
      ["then", "we", "cut", "latency", "by", "half", "in", "a", "week"],
    ],
  );
  assert.deepEqual(hit, { answer: 1, start: 1, end: 6, score: 1 });
});

test("alignedQuote returns the candidate's own words for a near-miss quote", () => {
  const answers = [
    "I built the parser first. Then we cut the p95 latency by half, mostly with caching.",
    "My manager was happy.",
  ];
  const quote = "we cut latency by half with caching";
  assert.equal(quoteIsReal(quote, answers), false);

  const fixed = alignedQuote(quote, answers);
  assert.ok(quoteIsReal(fixed, answers), fixed);
  assert.match(fixed, /cut the p95 latency by half/);
});

test("alignedQuote falls back to the closest sentence when nothing lines up", () => {
  const answers = ["Short answer.", "Another one here."];
  const quote = "completely unrelated words";
  assert.equal(alignedQuote(quote, answers), closestSentence(quote, answers));
});
