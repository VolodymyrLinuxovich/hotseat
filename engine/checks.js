// Engine checks. Every model output passes through here before the candidate sees it.
//
// Each check repairs what it can and returns a short note about what it changed, so the
// ledger can show the candidate exactly where the engine stepped in.

import vm from "node:vm";

import { AGENT_IDS, AGENTS } from "./agents.js";
import { MAX_QUESTION_WORDS } from "./config.js";

const MIN_VALID_TESTS = 3;
const REFERENCE_TIMEOUT_MS = 500;

// Two questions this similar (word-set Jaccard) count as the same question asked twice.
const REPEAT_THRESHOLD = 0.6;

const MAX_VERDICT_ITEMS = 3;
const MAX_VERDICT_WORDS = 60;

// The model invents many names for the same habit. Bruin aggregates tags by exact string,
// so synonyms are folded onto one canonical tag or the profile splits one habit into five.
const TAG_SYNONYMS = {
  lacks_metrics: "no_numbers",
  no_metrics: "no_numbers",
  partial_numbers: "no_numbers",
  missing_numbers: "no_numbers",
  missing_metrics: "no_numbers",
  evasive: "deflects",
  deflected_question: "deflects",
  deflected: "deflects",
  dodged: "deflects",
  dodged_question: "deflects",
  incomplete_solution: "incomplete_code",
  incomplete_code: "incomplete_code",
  unfinished_code: "incomplete_code",
  we_instead_of_i: "we_not_i",
  used_we: "we_not_i",
  no_example: "vague",
  generic: "vague",
  generic_answer: "vague",
};

const NEGATIVE_TAGS = new Set(["no_numbers", "vague", "deflects", "we_not_i", "incomplete_code"]);
const STRONG_TAGS = new Set(["strong_example", "clear_tradeoffs"]);

// Topics a balanced behavioral and technical loop should touch. Each one also matches a few
// looser topic names the model tends to pick.
const COVERAGE_TOPICS = {
  ownership: ["ownership", "owner", "impact", "leadership"],
  metrics: ["metrics", "numbers", "measure", "results"],
  tradeoffs: ["tradeoff", "trade_off"],
  system_design: ["system_design", "design", "architecture", "scal"],
  conflict: ["conflict", "disagree", "teamwork", "collaboration"],
  debugging: ["debug", "incident", "outage", "bug"],
};

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

// Word-set Jaccard overlap between two texts, from 0 (nothing shared) to 1 (same words).
export function similarity(a, b) {
  const left = words(a);
  const right = words(b);

  let shared = 0;
  for (const w of left) {
    if (right.has(w)) {
      shared += 1;
    }
  }

  const union = left.size + right.size - shared;
  if (union === 0) {
    return 0;
  }
  return shared / union;
}

// Fold a synonym habit tag onto its canonical name. Unknown tags pass through untouched.
export function canonicalTag(tag) {
  const key = snakeCase(tag);
  return TAG_SYNONYMS[key] || key;
}

// Name the core topics nobody has asked about yet, so the panel steers toward them.
export function coverageHint(session) {
  const asked = session.turns.filter((t) => t.question);
  if (asked.length < 2) {
    return "";
  }

  const seen = asked.map((t) => snakeCase(t.topic));
  const missing = Object.keys(COVERAGE_TOPICS).filter((topic) => {
    const hints = COVERAGE_TOPICS[topic];
    return !seen.some((s) => hints.some((h) => s.includes(h)));
  });

  if (missing.length === 0) {
    return "";
  }
  return `Topics not covered yet: ${missing.join(", ")}. Prefer one of these unless a follow-up is clearly needed.`;
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
    out.assessment.tags = [...new Set(out.assessment.tags.map(canonicalTag))].slice(0, 3);
    checkScore(out.assessment, checks);
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

  // Rewriting a repeated question would need another model call, so the engine only flags it.
  // The coding round is skipped because its question is replaced by the problem intro.
  const repeated =
    !coding && session.turns.some((t) => t.question && similarity(t.question, out.question) >= REPEAT_THRESHOLD);
  if (repeated) {
    checks.push("Question overlapped an earlier one.");
  }

  return { out, checks };
}

// A score has to agree with the habits the same assessment tagged.
function checkScore(assessment, checks) {
  const tags = assessment.tags;
  const negative = tags.filter((t) => NEGATIVE_TAGS.has(t));

  if (assessment.score >= 4 && negative.length > 0) {
    checks.push(`Score ${assessment.score} clashed with the "${negative[0]}" tag; lowered to 3.`);
    assessment.score = 3;
    return;
  }

  const onlyStrong = tags.length > 0 && tags.every((t) => STRONG_TAGS.has(t));
  if (assessment.score <= 2 && onlyStrong) {
    checks.push(`Score ${assessment.score} clashed with only strong tags; raised to 3.`);
    assessment.score = 3;
  }
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

// Cut spoken text to a word limit on a sentence boundary, so the voice never stops mid thought.
export function limitSentences(text, maxWords) {
  const total = String(text || "")
    .split(/\s+/)
    .filter(Boolean).length;
  if (total <= maxWords) {
    return text;
  }

  const kept = [];
  let count = 0;
  for (const sentence of splitSentences(text)) {
    const n = sentence.split(/\s+/).length;
    if (count + n > maxWords) {
      break;
    }
    kept.push(sentence);
    count += n;
  }

  // The first sentence alone is too long, so fall back to a hard word cut.
  if (kept.length === 0) {
    const cut = String(text).split(/\s+/).slice(0, maxWords).join(" ");
    return `${cut.replace(/[,;:]$/, "")}.`;
  }
  return kept.join(" ");
}

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

  // Long lists bury the point. Keep the top three of each, before quotes are checked
  // so the ledger never mentions an item that was cut.
  if (v.strengths.length > MAX_VERDICT_ITEMS) {
    checks.push(`Cut strengths from ${v.strengths.length} to ${MAX_VERDICT_ITEMS}.`);
    v.strengths = v.strengths.slice(0, MAX_VERDICT_ITEMS);
  }
  if (v.growth.length > MAX_VERDICT_ITEMS) {
    checks.push(`Cut growth areas from ${v.growth.length} to ${MAX_VERDICT_ITEMS}.`);
    v.growth = v.growth.slice(0, MAX_VERDICT_ITEMS);
  }

  // Evidence must be the candidate's own words. Fix any quote that isn't.
  let quotesFixed = 0;
  const fixQuote = (quote, who) => {
    if (quoteIsReal(quote, answers)) {
      return quote;
    }
    quotesFixed += 1;
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

  // The verdict is read aloud, so it stays short.
  const spoken = limitSentences(v.spoken_verdict, MAX_VERDICT_WORDS);
  if (spoken !== v.spoken_verdict) {
    checks.push(`Spoken verdict was over ${MAX_VERDICT_WORDS} words; trimmed at a sentence.`);
    v.spoken_verdict = spoken;
  }

  if (quotesFixed === 0) {
    checks.push("Every quote matched your answers word for word.");
  }

  return { verdict: v, checks };
}
