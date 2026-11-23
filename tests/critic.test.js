// Tests for the trained critic: JS inference must match the Python trainer, and the engine
// check must flag big disagreements without ever touching the panel's score.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkWithCritic } from "../engine/checks.js";
import { critique, handFeatures, loadModel, MODEL_PATH, predictWith, tokenize } from "../engine/critic.js";

const PARITY = new URL("../train/data/parity.json", import.meta.url);

test("JS predictions match the Python trainer on the saved parity cases", () => {
  const model = loadModel();
  assert.ok(model, "engine/critic-model.json should exist");
  const { cases } = JSON.parse(fs.readFileSync(PARITY, "utf8"));
  assert.ok(cases.length >= 15);

  for (const c of cases) {
    const got = predictWith(model, c.answer);
    // Only the last few bits of a float may differ between the two math libraries.
    assert.ok(Math.abs(got.raw - c.raw) < 1e-9, `raw score drifted for: ${c.answer.slice(0, 60)}`);
    assert.equal(got.score, c.score);
    assert.deepEqual(got.tags, c.tags);
    for (const [tag, p] of Object.entries(c.probs)) {
      assert.ok(Math.abs(got.probs[tag] - p) < 1e-9, `${tag} probability drifted`);
    }
  }
});

test("model file stays small", () => {
  assert.ok(fs.statSync(MODEL_PATH).size < 300 * 1024);
});

test("tokenizer and hand features read numbers, I versus we, and judge results", () => {
  assert.deepEqual(tokenize("I cut p99 by 40%, we shipped."), ["i", "cut", "p99", "by", "40", "we", "shipped"]);

  const f = handFeatures("I cut latency 40% and I owned it. We helped?");
  assert.equal(f[0], 1);
  assert.equal(f[2], 1);
  assert.equal(f[5], 2 / 3);
  assert.equal(f[9], 1);

  const code = handFeatures("[LIVE CODING: X]\nfunction x(){}\n\n[JUDGE] 2/6 hidden tests passed.");
  assert.equal(code[10], 1 - 2 / 6);
  assert.equal(code[11], 1);
  assert.deepEqual(handFeatures(""), [0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 0, 0]);
});

test("critic tells a strong measured answer from a vague one", () => {
  const strong = critique(
    "I owned the checkout rewrite. I profiled it, found an N+1 query, added an index and a Redis cache, " +
      "and cut p95 latency from 1.2s to 180ms, which lifted conversion 4% over two weeks.",
  );
  const weak = critique("It went well, people liked it.");
  assert.ok(strong.score > weak.score);
  assert.ok(strong.score >= 4);
  assert.ok(weak.score <= 2);
});

test("checkWithCritic flags a gap of 2 or more and keeps the panel score", () => {
  const assessment = { score: 1, topic: "metrics", tags: ["vague"], note: "" };
  const { critic, checks } = checkWithCritic(assessment, "answer", () => ({
    score: 4,
    raw: 4.2,
    tags: ["strong_example", "clear_tradeoffs", "we_not_i", "vague"],
  }));
  assert.equal(assessment.score, 1);
  assert.deepEqual(critic, { score: 4, tags: ["strong_example", "clear_tradeoffs", "we_not_i"] });
  assert.deepEqual(checks, ["Trained critic scored this 4/5, panel gave 1/5. Flagged for review."]);
});

test("checkWithCritic stays quiet when the critic roughly agrees", () => {
  const assessment = { score: 3, topic: "metrics", tags: [], note: "" };
  const { critic, checks } = checkWithCritic(assessment, "answer", () => ({ score: 4, raw: 3.6, tags: [] }));
  assert.equal(critic.score, 4);
  assert.deepEqual(checks, []);
});

test("checkWithCritic skips when there is no assessment, no model, or the model throws", () => {
  const assessment = { score: 3, topic: "x", tags: [], note: "" };
  assert.deepEqual(checkWithCritic(null, "answer"), { critic: null, checks: [] });
  assert.deepEqual(
    checkWithCritic(assessment, "answer", () => null),
    { critic: null, checks: [] },
  );
  assert.deepEqual(
    checkWithCritic(assessment, "answer", () => {
      throw new Error("bad model");
    }),
    { critic: null, checks: [] },
  );
});

test("loadModel picks up a rewritten model file without a restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "critic-"));
  const file = path.join(dir, "model.json");
  const base = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));

  fs.writeFileSync(file, JSON.stringify({ ...base, score: { ...base.score, intercept: -100 } }));
  assert.equal(critique("Anything at all.", file).score, 1);

  // Push the mtime forward so the change is visible even on coarse filesystem clocks.
  fs.writeFileSync(file, JSON.stringify({ ...base, score: { ...base.score, intercept: 100 } }));
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(critique("Anything at all.", file).score, 5);

  fs.rmSync(dir, { recursive: true, force: true });
});
