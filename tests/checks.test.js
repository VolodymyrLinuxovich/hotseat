// Unit tests for the engine checks. No network: every check is a pure function.

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkProblem,
  checkTurn,
  checkVerdict,
  canonicalTag,
  closestSentence,
  coverageHint,
  limitSentences,
  limitWords,
  normalizeText,
  quoteIsReal,
  similarity,
  snakeCase,
} from "../engine/checks.js";

function turn(overrides = {}) {
  return {
    assessment: { score: 2, topic: "Metrics", tags: ["No Numbers", "vague", "vague"], note: "Vague." },
    deliberation: [
      { agent: "manager", says: "Who owned it?", wants: "press_harder", bid: 0.4 },
      { agent: "tech", says: "No tradeoffs.", wants: "go_deeper", bid: 0.6 },
      { agent: "skeptic", says: "No numbers.", wants: "press_harder", bid: 1.4 },
    ],
    decision: { asker: "skeptic", reason: "Needs numbers.", difficulty: 3, topic: "Metrics" },
    question: "How many users did it have?",
    moods: { manager: "neutral", tech: "neutral", skeptic: "skeptical" },
    ...overrides,
  };
}

function session(askers = [], answered = true) {
  return {
    turns: askers.map((asker) => ({ asker, question: "q", answer: answered ? "a" : null })),
  };
}

test("snakeCase and normalizeText", () => {
  assert.equal(snakeCase("System Design!"), "system_design");
  assert.equal(snakeCase(""), "general");
  assert.equal(normalizeText("“We cut it, by 2x.”"), "we cut it by 2x");
});

test("quotes match despite punctuation, and fakes don't", () => {
  const answers = ["I owned the change end to end. It cut cold reads to 5 seconds."];
  assert.equal(quoteIsReal("i owned the change, end to end", answers), true);
  assert.equal(quoteIsReal("I led a team of ten", answers), false);
  assert.equal(closestSentence("cut cold reads", answers), "It cut cold reads to 5 seconds.");
});

test("limitWords ends on a sentence when it can", () => {
  const long = "What did you build? " + "word ".repeat(60).trim();
  assert.equal(limitWords(long, 10), "What did you build?");
  assert.equal(limitWords("word ".repeat(20).trim(), 5), "word word word word word?");
  assert.equal(limitWords("Short one?", 10), "Short one?");
});

test("checkTurn cleans the assessment and clamps bids", () => {
  const { out } = checkTurn(turn(), session(["manager"]));
  assert.equal(out.assessment.topic, "metrics");
  assert.deepEqual(out.assessment.tags, ["no_numbers", "vague"]);
  assert.equal(out.deliberation[2].bid, 1);
});

test("checkTurn drops an assessment before any answer", () => {
  const { out } = checkTurn(turn(), session([], false));
  assert.equal(out.assessment, null);
});

test("checkTurn fills a missing score after an answer", () => {
  const { out, checks } = checkTurn(turn({ assessment: null }), session(["manager"]));
  assert.equal(out.assessment.score, 3);
  assert.equal(checks.length, 1);
});

test("checkTurn fills a missing interviewer and drops duplicates", () => {
  const raw = turn();
  raw.deliberation = [raw.deliberation[0], raw.deliberation[0], raw.deliberation[1]];
  const { out, checks } = checkTurn(raw, session(["manager"]));
  assert.deepEqual(
    out.deliberation.map((d) => d.agent),
    ["manager", "tech", "skeptic"],
  );
  assert.equal(out.deliberation[2].bid, 0);
  assert.match(checks[0], /Sol/);
});

test("checkTurn stops one interviewer asking three times in a row", () => {
  const { out, checks } = checkTurn(turn(), session(["skeptic", "skeptic"]));
  assert.equal(out.decision.asker, "tech");
  assert.match(checks[0], /Theo/);
});

test("checkTurn gives the coding round to Theo", () => {
  const { out } = checkTurn(turn(), session(["manager", "skeptic"]), { coding: true });
  assert.equal(out.decision.asker, "tech");
  assert.equal(out.decision.topic, "coding");
});

test("checkTurn strips markdown from the spoken question", () => {
  const { out } = checkTurn(turn({ question: "**How** many `users`?" }), session(["manager"]));
  assert.equal(out.question, "How many users?");
});

const problem = {
  title: "Sum",
  spoken_intro: "Sum a list.",
  description: "Sum it.",
  function_name: "sum_list",
  starter_code: "function sum_list(nums) {}",
  starter_code_python: "def sum_list(nums):\n    pass",
  reference_solution_js: "function sum_list(nums) { return nums.reduce((a, b) => a + b, 0); }",
  tests: [
    { args_json: "[[1, 2, 3]]", expected_json: "6" },
    { args_json: "[[]]", expected_json: "0" },
    { args_json: "[[5]]", expected_json: "5" },
    { args_json: "[[2, 2]]", expected_json: "5" },
    { args_json: "[[1,", expected_json: "1" },
  ],
};

test("checkProblem keeps verified tests and drops wrong or broken ones", () => {
  const { problem: checked, checks, valid } = checkProblem(structuredClone(problem));
  assert.equal(valid, true);
  assert.equal(checked.tests.length, 3);
  assert.equal(checked.reference_solution_js, undefined);
  assert.equal(checks.length, 2);
});

test("checkProblem rejects a problem with too few good tests", () => {
  const bad = structuredClone(problem);
  bad.tests = bad.tests.slice(3);
  assert.equal(checkProblem(bad).valid, false);
});

test("checkProblem survives a reference solution that loops forever", () => {
  const looping = structuredClone(problem);
  looping.reference_solution_js = "function sum_list() { while (true) {} }";
  const { checks } = checkProblem(looping);
  assert.match(checks.at(-1), /unverified/);
});

test("checkProblem rejects a bad function name", () => {
  const bad = structuredClone(problem);
  bad.function_name = "sum-list";
  assert.equal(checkProblem(bad).valid, false);
});

function verdict(overrides = {}) {
  return {
    votes: [
      { agent: "manager", vote: "no_hire", reason: "Vague.", evidence_quote: "we improved stuff a lot" },
      { agent: "tech", vote: "no_hire", reason: "No depth.", evidence_quote: "I built a distributed cache" },
      { agent: "skeptic", vote: "no_hire", reason: "No numbers.", evidence_quote: "people liked it" },
    ],
    verdict: "hire",
    overall: 7,
    strengths: ["Friendly"],
    growth: [{ area: "Metrics", evidence_quote: "people liked it", drill: "Add numbers." }],
    summary: "Not yet.",
    spoken_verdict: "Thanks.",
    ...overrides,
  };
}

const answered = [{ answer: "It went pretty well and people liked it, we improved stuff a lot." }];

test("checkVerdict replaces invented quotes with real lines", () => {
  const { verdict: v, checks } = checkVerdict(verdict(), answered);
  assert.equal(v.votes[1].evidence_quote, "It went pretty well and people liked it, we improved stuff a lot.");
  assert.ok(checks.some((c) => c.startsWith("Theo quoted")));
  assert.equal(v.votes[0].evidence_quote, "we improved stuff a lot");
});

test("checkVerdict clamps the score and fixes a verdict that contradicts the votes", () => {
  const { verdict: v } = checkVerdict(verdict(), answered);
  assert.equal(v.overall, 5);
  assert.equal(v.verdict, "lean_no_hire");
});

test("checkVerdict keeps one vote per interviewer", () => {
  const raw = verdict();
  raw.votes.push({ ...raw.votes[0] });
  assert.equal(checkVerdict(raw, answered).verdict.votes.length, 3);
});

test("canonicalTag folds synonyms and keeps unknown tags", () => {
  assert.equal(canonicalTag("lacks_metrics"), "no_numbers");
  assert.equal(canonicalTag("Missing Numbers"), "no_numbers");
  assert.equal(canonicalTag("dodged"), "deflects");
  assert.equal(canonicalTag("incomplete_solution"), "incomplete_code");
  assert.equal(canonicalTag("we_instead_of_i"), "we_not_i");
  assert.equal(canonicalTag("generic"), "vague");
  assert.equal(canonicalTag("strong_example"), "strong_example");
});

test("checkTurn remaps synonym tags silently and dedupes them", () => {
  const raw = turn({
    assessment: { score: 2, topic: "metrics", tags: ["no_metrics", "partial_numbers", "evasive"], note: "" },
  });
  const { out, checks } = checkTurn(raw, session(["manager"]));
  assert.deepEqual(out.assessment.tags, ["no_numbers", "deflects"]);
  assert.equal(checks.length, 0);
});

test("similarity is word-set Jaccard", () => {
  assert.equal(similarity("How many users?", "how many USERS"), 1);
  assert.equal(similarity("a b", "c d"), 0);
  assert.equal(similarity("", ""), 0);
});

test("checkTurn flags a question that repeats an earlier one", () => {
  const s = session(["manager"]);
  s.turns[0].question = "How many users did the product have?";
  const { checks } = checkTurn(turn(), s);
  assert.ok(checks.includes("Question overlapped an earlier one."));
});

test("checkTurn does not flag a fresh question", () => {
  const s = session(["manager"]);
  s.turns[0].question = "Tell me about a conflict with a teammate.";
  const { checks } = checkTurn(turn(), s);
  assert.equal(checks.length, 0);
});

test("coverageHint names uncovered topics after two questions", () => {
  assert.equal(coverageHint({ turns: [{ question: "q", topic: "ownership" }] }), "");

  const hint = coverageHint({
    turns: [
      { question: "q1", topic: "ownership" },
      { question: "q2", topic: "system_design_scaling" },
    ],
  });
  assert.match(hint, /metrics, tradeoffs, conflict, debugging/);
  assert.doesNotMatch(hint, /ownership|system_design/);
});

test("coverageHint is empty once every topic is covered", () => {
  const topics = ["ownership", "metrics", "tradeoffs", "system_design", "conflict", "debugging"];
  const turns = topics.map((topic) => ({ question: "q", topic }));
  assert.equal(coverageHint({ turns }), "");
});

test("checkTurn lowers a high score that has a negative habit", () => {
  const raw = turn({ assessment: { score: 5, topic: "metrics", tags: ["lacks_metrics"], note: "" } });
  const { out, checks } = checkTurn(raw, session(["manager"]));
  assert.equal(out.assessment.score, 3);
  assert.match(checks[0], /lowered to 3/);
});

test("checkTurn raises a low score that has only strong tags", () => {
  const raw = turn({
    assessment: { score: 1, topic: "tradeoffs", tags: ["strong_example", "clear_tradeoffs"], note: "" },
  });
  const { out, checks } = checkTurn(raw, session(["manager"]));
  assert.equal(out.assessment.score, 3);
  assert.match(checks[0], /raised to 3/);
});

test("checkTurn leaves a consistent score alone", () => {
  const raw = turn({ assessment: { score: 2, topic: "metrics", tags: ["strong_example", "vague"], note: "" } });
  const { out } = checkTurn(raw, session(["manager"]));
  assert.equal(out.assessment.score, 2);
});

test("limitSentences cuts at a sentence boundary", () => {
  const text = "First part is here. " + "word ".repeat(10).trim() + ".";
  assert.equal(limitSentences(text, 8), "First part is here.");
  assert.equal(limitSentences("Short.", 8), "Short.");
  assert.equal(limitSentences("one two three four five", 3), "one two three.");
});

test("checkVerdict caps strengths, growth and the spoken verdict", () => {
  const growth = { area: "Metrics", evidence_quote: "people liked it", drill: "Add numbers." };
  const raw = verdict({
    strengths: ["a", "b", "c", "d"],
    growth: [growth, growth, growth, growth, growth],
    spoken_verdict: "Thanks for coming in today. " + "We liked a lot of what we heard. ".repeat(10),
  });
  const { verdict: v, checks } = checkVerdict(raw, answered);
  assert.equal(v.strengths.length, 3);
  assert.equal(v.growth.length, 3);
  assert.ok(v.spoken_verdict.split(" ").length <= 60);
  assert.ok(v.spoken_verdict.endsWith("."));
  assert.ok(checks.some((c) => c.startsWith("Spoken verdict")));
});
