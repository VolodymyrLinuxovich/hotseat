// Tests for the trained question policy: JS inference must match the Python trainer, and the
// engine glue must skip the coding round and describe the panel's choice correctly.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  buildState,
  canonicalTopic,
  loadPolicy,
  MODEL_PATH,
  policyCheck,
  policyLine,
  rankActions,
  sessionHistory,
  suggestNext,
} from "../engine/policy.js";

const PARITY = new URL("../train/data/policy_parity.json", import.meta.url);

function close(a, b, what) {
  assert.ok(Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(b)), `${what}: ${a} vs ${b}`);
}

test("JS features and Q values match the Python trainer on the saved cases", () => {
  const model = loadPolicy();
  assert.ok(model, "engine/policy-model.json should exist");
  const { cases } = JSON.parse(fs.readFileSync(PARITY, "utf8"));
  assert.ok(cases.length >= 15);

  for (const c of cases) {
    const state = buildState(model, c.history, c.weak);
    close(state.theta, c.theta, "theta");
    close(state.se, c.se, "se");
    state.belief.mean.forEach((m, i) => close(m, c.mean[i], `mean ${i}`));

    const { feats, values, best } = rankActions(model, state);
    assert.equal(feats.length, c.features.length);
    feats.forEach((row, i) => {
      row.forEach((x, j) => close(x, c.features[i][j], `feature ${model.features[j]} of action ${i}`));
    });
    values.forEach((v, i) => close(v, c.values[i], `value of action ${i}`));
    assert.equal(best, c.best);
  }
});

test("topic folding matches the trainer", () => {
  const { topics } = JSON.parse(fs.readFileSync(PARITY, "utf8"));
  for (const [raw, expected] of topics) {
    assert.equal(canonicalTopic(raw), expected, `topic ${JSON.stringify(raw)}`);
  }
});

function session(turns, profile = null) {
  return { turns, profile };
}

test("suggests a free action and skips the forced coding round", () => {
  const first = suggestNext(session([]));
  assert.ok(first);
  assert.ok(["manager", "tech", "skeptic"].includes(first.asker));
  assert.ok([2, 3, 4].includes(first.difficulty));
  assert.notEqual(first.topic, "coding");

  const two = [
    { asker: "manager", topic: "ownership", difficulty: 3, question: "Q1", answer: "A", score: 3 },
    { asker: "skeptic", topic: "metrics", difficulty: 3, question: "Q2", answer: "A", score: null },
  ];
  assert.equal(suggestNext(session(two), { lastScore: 2 }), null);
});

test("the critic's score stands in for the answer the panel has not scored yet", () => {
  const turns = [{ asker: "skeptic", topic: "numbers", difficulty: 4, question: "Q1", answer: "A", score: null }];
  assert.deepEqual(sessionHistory(session(turns), 2), [
    { asker: "skeptic", topic: "metrics", difficulty: 4, score: 2 },
  ]);
  assert.equal(sessionHistory(session(turns))[0].score, null);
});

test("a remembered weak topic is worth more to ask about", () => {
  const model = loadPolicy();
  const conflictValue = (weak) => {
    const { values } = rankActions(model, buildState(model, [], weak));
    const asked = model.askers.flatMap((a) => model.free_topics.flatMap((t) => model.bands.map(() => t)));
    return Math.max(...values.filter((_, i) => asked[i] === "conflict"));
  };
  assert.ok(conflictValue(["conflict"]) > conflictValue([]));

  // Profile topics go through the same folding as the panel's own topic names.
  const profile = { weak_topics: [{ topic: "teamwork", avg_score: 1.5, n: 3 }] };
  assert.ok(suggestNext(session([], profile)));
});

test("prompt line and engine note read the way the ledger shows them", () => {
  const policy = { asker: "skeptic", name: "Sol", topic: "system_design", band: "mid", difficulty: 3, gain: 0.423 };
  assert.equal(
    policyLine(policy),
    "[POLICY] Trained policy suggests: Sol asks about system design at medium difficulty (expected info gain 0.42).",
  );
  assert.equal(policyCheck(policy, { asker: "skeptic", topic: "System Design" }), "Panel followed the trained policy.");
  assert.equal(
    policyCheck(policy, { asker: "manager", topic: "ownership" }),
    "Panel overrode the policy: chose Maya on ownership.",
  );
  assert.equal(policyLine(null), "");
  assert.equal(policyCheck(null, { asker: "manager", topic: "x" }), null);
});

test("a newer model file is picked up and a broken one keeps the last good model", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-"));
  const file = path.join(dir, "policy-model.json");
  const model = JSON.parse(fs.readFileSync(MODEL_PATH, "utf8"));

  fs.writeFileSync(file, JSON.stringify(model));
  assert.equal(loadPolicy(file).weights[0], model.weights[0]);

  model.weights[0] = 123;
  fs.writeFileSync(file, JSON.stringify(model));
  // Push the mtime forward so the change is seen even on a coarse clock.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(loadPolicy(file).weights[0], 123);

  fs.writeFileSync(file, "{ not json");
  const evenLater = new Date(Date.now() + 10000);
  fs.utimesSync(file, evenLater, evenLater);
  assert.equal(loadPolicy(file).weights[0], 123);

  assert.equal(loadPolicy(path.join(dir, "missing.json")), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
