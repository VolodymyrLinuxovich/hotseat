// Engine checks. Every model output passes through here before the candidate sees it.
//
// Each check repairs what it can and returns a short note about what it changed, so the
// ledger can show the candidate exactly where the engine stepped in.

import vm from "node:vm";

import { AGENT_IDS, AGENTS } from "./agents.js";
import { MAX_QUESTION_WORDS } from "./config.js";

const MIN_VALID_TESTS = 3;
const REFERENCE_TIMEOUT_MS = 500;

// ---------- small helpers ----------

export function snakeCase(text) {
  const s = String(text || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
  return s || "general";
}

// Lowercase, drop punctuation and collapse spaces, so quotes match regardless of commas or curly quotes.
export function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[‘’“”"'`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function words(text) {
  return new Set(normalizeText(text).split(" ").filter(Boolean));
}

export function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The answer sentence that shares the most words with the quote (Jaccard overlap).
export function closestSentence(quote, answers) {
  const target = words(quote);
  let best = "";
  let bestScore = -1;

  for (const answer of answers) {
    for (const sentence of splitSentences(answer)) {
      const candidate = words(sentence);
      let shared = 0;
      for (const w of candidate) {
        if (target.has(w)) {
          shared += 1;
        }
      }
      const union = target.size + candidate.size - shared;
      const score = union === 0 ? 0 : shared / union;
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
  }

  return best;
}

export function quoteIsReal(quote, answers) {
  const q = normalizeText(quote);
  if (!q) {
    return false;
  }
  return answers.some((a) => normalizeText(a).includes(q));
}

function stripMarkdown(text) {
  return String(text || "")
    .replace(/[*_#`>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Cut a spoken question to the word limit, ending on a full sentence when one fits.
export function limitWords(text, maxWords) {
  const all = text.split(" ");
  if (all.length <= maxWords) {
    return text;
  }

  // Prefer ending on the last full question, then on a sentence past the halfway point.
  const cut = all.slice(0, maxWords).join(" ");
  const lastQuestion = cut.lastIndexOf("?");
  if (lastQuestion > 0) {
    return cut.slice(0, lastQuestion + 1);
  }
  const lastStop = cut.lastIndexOf(".");
  if (lastStop > cut.length / 2) {
    return cut.slice(0, lastStop + 1);
  }
  return `${cut}?`;
}

// ---------- panel turn ----------

export function checkTurn(out, session, { coding = false } = {}) {
  const checks = [];
  const answeredCount = session.turns.filter((t) => t.answer).length;

  // Assessment: none before the first answer, always one after.
  if (answeredCount === 0 && out.assessment) {
    out.assessment = null;
  }
  if (answeredCount > 0 && !out.assessment) {
    out.assessment = {
      score: 3,
      topic: "general",
      tags: [],
      note: "No score came back, so the engine used a neutral 3.",
    };
    checks.push("Missing score on the last answer; used a neutral 3.");
  }
  if (out.assessment) {
    out.assessment.topic = snakeCase(out.assessment.topic);
    out.assessment.tags = [...new Set(out.assessment.tags.map(snakeCase))].slice(0, 3);
  }

  // Deliberation: exactly one whisper per interviewer, in panel order, bids clamped to 0..1.
  const byAgent = new Map();
  for (const line of out.deliberation) {
    if (!byAgent.has(line.agent)) {
      byAgent.set(line.agent, { ...line, bid: Math.min(1, Math.max(0, Number(line.bid) || 0)) });
    }
  }
  const missing = AGENT_IDS.filter((id) => !byAgent.has(id));
  if (missing.length > 0) {
    checks.push(`No whisper from ${missing.map((id) => AGENTS[id].name).join(", ")}; filled with a silent bid of 0.`);
  }
  out.deliberation = AGENT_IDS.map((id) => {
    return byAgent.get(id) || { agent: id, says: "(stays quiet)", wants: "move_on", bid: 0 };
  });

  // Who asks next.
  if (coding && out.decision.asker !== "tech") {
    out.decision.asker = "tech";
    checks.push("Coding round goes to Theo, so the engine handed him the question.");
  }
  if (!coding) {
    const lastTwo = session.turns.slice(-2).map((t) => t.asker);
    const repeats = lastTwo.length === 2 && lastTwo.every((a) => a === out.decision.asker);
    if (repeats) {
      const others = out.deliberation.filter((d) => d.agent !== out.decision.asker);
      const next = others.sort((a, b) => b.bid - a.bid)[0];
      checks.push(
        `${AGENTS[out.decision.asker].name} already asked twice in a row; the floor goes to ${AGENTS[next.agent].name} (bid ${next.bid.toFixed(2)}).`,
      );
      out.decision.asker = next.agent;
    }
  }

  out.decision.difficulty = Math.min(5, Math.max(1, Math.round(out.decision.difficulty)));
  out.decision.topic = coding ? "coding" : snakeCase(out.decision.topic);

  // The question is spoken aloud: no markdown, not too long.
  const clean = stripMarkdown(out.question);
  const short = limitWords(clean, MAX_QUESTION_WORDS);
  if (short !== clean) {
    checks.push(`Question was over ${MAX_QUESTION_WORDS} words; trimmed for speech.`);
  }
  out.question = short;

  return { out, checks };
}

// ---------- coding problem ----------

// Run the reference solution on one test inside a fresh VM context with a hard timeout.
export function runReference(code, fnName, argsJson) {
  const context = vm.createContext({ ARGS: JSON.parse(argsJson) });
  const script = new vm.Script(`${code}\n;JSON.stringify(${fnName}(...ARGS));`);
  return script.runInContext(context, { timeout: REFERENCE_TIMEOUT_MS });
}

function sameJson(a, b) {
  return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
}

export function checkProblem(problem) {
  const checks = [];
  const kept = [];
  let malformed = 0;
  let wrong = 0;
  let referenceBroken = false;

  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(problem.function_name)) {
    return {
      problem: null,
      checks: [`Function name "${problem.function_name}" isn't valid in Python and JavaScript.`],
      valid: false,
    };
  }

  for (const t of problem.tests) {
    try {
      JSON.parse(t.args_json);
      JSON.parse(t.expected_json);
    } catch {
      malformed += 1;
      continue;
    }

    let got;
    try {
      got = runReference(problem.reference_solution_js, problem.function_name, t.args_json);
    } catch {
      referenceBroken = true;
      kept.push(t);
      continue;
    }

    if (got !== undefined && sameJson(got, t.expected_json)) {
      kept.push(t);
    } else {
      wrong += 1;
    }
  }

  if (malformed > 0) {
    checks.push(`Dropped ${malformed} test${malformed > 1 ? "s" : ""} with broken JSON.`);
  }
  if (wrong > 0) {
    checks.push(
      `Dropped ${wrong} test${wrong > 1 ? "s" : ""} whose expected answer disagreed with the reference solution.`,
    );
  }
  if (referenceBroken) {
    checks.push("The reference solution failed to run, so some tests are unverified.");
  }
  if (!referenceBroken && malformed === 0 && wrong === 0) {
    checks.push(`All ${kept.length} hidden tests verified against a reference solution.`);
  }

  // The reference solution stays on the server.
  const { reference_solution_js: _hidden, ...rest } = problem;
  const valid = kept.length >= MIN_VALID_TESTS;

  return { problem: valid ? { ...rest, tests: kept } : null, checks, valid };
}

// ---------- verdict ----------

const VERDICT_RANK = { no_hire: 0, lean_no_hire: 1, lean_hire: 2, hire: 3 };

export function checkVerdict(v, answered) {
  const checks = [];
  const answers = answered.map((t) => t.answer).filter(Boolean);

  // One vote per interviewer.
  const seen = new Set();
  v.votes = v.votes.filter((vote) => {
    if (seen.has(vote.agent)) {
      return false;
    }
    seen.add(vote.agent);
    return true;
  });

  // Evidence must be the candidate's own words. Fix any quote that isn't.
  const fixQuote = (quote, who) => {
    if (quoteIsReal(quote, answers)) {
      return quote;
    }
    const real = closestSentence(quote, answers);
    checks.push(`${who} quoted words you never said; replaced with your closest real line.`);
    return real;
  };
  for (const vote of v.votes) {
    vote.evidence_quote = fixQuote(vote.evidence_quote, AGENTS[vote.agent].name);
  }
  for (const g of v.growth) {
    g.evidence_quote = fixQuote(g.evidence_quote, `The "${g.area}" note`);
  }

  // Overall score in range, one decimal.
  const overall = Math.round(Math.min(5, Math.max(1, Number(v.overall) || 1)) * 10) / 10;
  if (overall !== v.overall) {
    checks.push(`Overall score ${v.overall} was out of range; set to ${overall}.`);
  }
  v.overall = overall;

  // The panel verdict can't contradict a unanimous vote.
  const hires = v.votes.filter((vote) => vote.vote === "hire").length;
  if (hires === v.votes.length && v.votes.length > 0 && VERDICT_RANK[v.verdict] < 2) {
    checks.push(`Every vote was hire but the verdict said ${v.verdict}; changed to lean hire.`);
    v.verdict = "lean_hire";
  }
  if (hires === 0 && VERDICT_RANK[v.verdict] >= 2) {
    checks.push(`Every vote was no hire but the verdict said ${v.verdict}; changed to lean no hire.`);
    v.verdict = "lean_no_hire";
  }

  if (checks.length === 0) {
    checks.push("Every quote matched your answers word for word.");
  }

  return { verdict: v, checks };
}
