// Engine checks. Every model output passes through here before the candidate sees it.
//
// Each check repairs what it can and returns a short note about what it changed, so the
// ledger can show the candidate exactly where the engine stepped in.

import vm from "node:vm";

import { AGENT_IDS, AGENTS } from "./agents.js";
import { MAX_QUESTION_WORDS } from "./config.js";
import { alignWords } from "./core.js";
import { critique } from "./critic.js";

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

// Words of a text with the character range each came from, so an aligned word span can be
// cut back out of the original answer with its capitals and punctuation intact.
function wordsWithOffsets(text) {
  const out = [];
  for (const match of String(text || "").matchAll(/\S+/g)) {
    for (const word of normalizeText(match[0]).split(" ").filter(Boolean)) {
      out.push({ word, from: match.index, to: match.index + match[0].length });
    }
  }
  return out;
}

// Below this the "closest" span is mostly coincidence, and a whole sentence reads better.
const MIN_ALIGN_SCORE = 0.4;
const MIN_ALIGN_WORDS = 3;

// The stretch of the candidate's answers that best lines up with the quote, word for word and
// in order (local alignment in the C++ core). Unlike closestSentence it keeps word order and
// can cross a sentence break, so a paraphrase lands on the line it was paraphrasing.
// Falls back to closestSentence when nothing lines up well enough.
export function alignedQuote(quote, answers) {
  const tokens = answers.map(wordsWithOffsets);
  const quoteWords = normalizeText(quote).split(" ").filter(Boolean);
  const hit = alignWords(
    quoteWords,
    tokens.map((list) => list.map((t) => t.word)),
  );

  if (hit.answer < 0 || hit.score < MIN_ALIGN_SCORE || hit.end - hit.start < MIN_ALIGN_WORDS) {
    return closestSentence(quote, answers);
  }

  const list = tokens[hit.answer];
  const text = answers[hit.answer].slice(list[hit.start].from, list[hit.end - 1].to);
  return text.trim().replace(/[,;:]+$/, "");
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

export function checkTurn(out, session, { coding = false, pasteFollowUp = false } = {}) {
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
  // Pasted code gets a follow-up from the person who ran the round, even if he asked last time.
  if (pasteFollowUp && !coding) {
    if (out.decision.asker !== "tech") {
      checks.push(
        `Code was pasted in the coding round; the floor goes from ${AGENTS[out.decision.asker].name} to Theo to ask about it.`,
      );
      out.decision.asker = "tech";
    } else {
      checks.push("Code was pasted in the coding round; Theo follows up on it.");
    }
  }
  if (!coding && !pasteFollowUp) {
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

// ---------- coding integrity ----------

// One paste longer than this is more than a variable name or a line from the problem statement.
// The browser shows its "paste noticed" note at the same size (LARGE_PASTE_CHARS in src/coding.js).
export const LARGE_PASTE_CHARS = 80;

const MAX_SAMPLE_CHARS = 120;

function count(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function formatDuration(seconds) {
  const s = count(seconds);
  if (s < 60) {
    return `${s}s`;
  }
  const rest = String(s % 60).padStart(2, "0");
  return `${Math.floor(s / 60)}m ${rest}s`;
}

// Turn the editor's raw counters into one line the panel reads next to the code. The browser
// sends the numbers, so everything is clamped and recomputed here rather than trusted as text.
export function summarizeIntegrity(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const typed = count(raw.typed_chars);
  const pasted = count(raw.pasted_chars);
  const pastes = count(raw.pastes);
  const largest = Math.min(count(raw.largest_paste), pasted);
  const runs = count(raw.test_runs);
  const seconds = count(raw.seconds_open);
  const sample = String(raw.largest_paste_sample || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_SAMPLE_CHARS);

  const total = typed + pasted;
  const share = total === 0 ? 0 : Math.round((pasted / total) * 100);
  const flagged = largest > LARGE_PASTE_CHARS;

  let line = `Typed ${plural(typed, "char")}, pasted ${plural(pasted, "char")} in ${plural(pastes, "paste")}`;
  if (pastes > 0) {
    line += ` (largest ${largest} at once)`;
  }
  line += `, ${plural(runs, "test run")} before submitting, ${formatDuration(seconds)} from open to submit.`;

  if (flagged) {
    line += ` Large paste noticed: ${share}% of the input arrived by paste.`;
    if (sample) {
      line += ` The largest paste began: "${sample}"`;
    }
  }

  return { line, flagged, typed, pasted, pastes, largest, runs, seconds, share };
}

// What the panel is told before the question after a coding round with a big paste.
export function pasteFollowUpHint(integrity) {
  if (!integrity || !integrity.flagged) {
    return "";
  }
  return `The candidate pasted ${integrity.largest} characters at once in the coding round (${integrity.share}% of their input). Theo (tech) takes the next question and asks them to walk him through the part they pasted, line by line, and why it works. Theo's whisper mentions the paste.`;
}

const MAX_CHAT_SENTENCES = 2;
const MAX_CHAT_WORDS = 45;
const CHAT_FALLBACK = "I'd rather hear your idea first. What's your plan?";

// Theo's chat replies are spoken, and he must never hand over code. Fenced code is cut out,
// and the reply is kept to two short sentences.
export function checkChatReply(reply) {
  const checks = [];
  let text = String(reply || "");

  if (/```/.test(text)) {
    text = text.replace(/```[\s\S]*?(```|$)/g, " ");
    checks.push("Theo's reply had a code block; the engine removed it.");
  }
  text = stripMarkdown(text);

  const sentences = splitSentences(text);
  if (sentences.length > MAX_CHAT_SENTENCES) {
    text = sentences.slice(0, MAX_CHAT_SENTENCES).join(" ");
    checks.push(`Theo's reply was over ${MAX_CHAT_SENTENCES} sentences; trimmed.`);
  }
  text = limitSentences(text, MAX_CHAT_WORDS);

  if (!text.trim()) {
    text = CHAT_FALLBACK;
  }
  return { reply: text, checks };
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
    const real = alignedQuote(quote, answers);
    checks.push(`${who} quoted words you never said; replaced with your closest real line.`);
    return real;
  };
  for (const vote of v.votes) {
    vote.evidence_quote = fixQuote(vote.evidence_quote, AGENTS[vote.agent].name);
  }
  for (const g of v.growth) {
    g.evidence_quote = fixQuote(g.evidence_quote, `The "${g.area}" note`);
  }
  // A value nobody showed has no quote to check, and older verdicts have no values at all.
  for (const val of v.values || []) {
    if (val.signal === "not_seen" || !val.evidence_quote) {
      val.evidence_quote = "";
      continue;
    }
    val.evidence_quote = fixQuote(val.evidence_quote, `The "${val.value}" rating`);
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

// ---------- attention ----------
//
// The browser tracks whether the candidate looks at the screen (src/gaze.js) and sends only
// numbers with each answer. Like the integrity counters, they are clamped here, never trusted.

const MAX_ATTENTION_EVENTS = 10;
const ATTENTION_EVENT_TYPES = ["absent", "looking_away"];

export function sanitizeAttention(raw) {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const lookingPct = Math.min(100, count(raw.lookingPct));
  const trackedSeconds = count(raw.trackedSeconds);
  const events = Array.isArray(raw.awayEvents) ? raw.awayEvents : [];

  const awayEvents = events
    .filter((e) => e && ATTENTION_EVENT_TYPES.includes(e.type))
    .slice(0, MAX_ATTENTION_EVENTS)
    .map((e) => ({
      type: e.type,
      seconds: Math.min(3600, count(e.seconds)),
      during: e.during === "coding" ? "coding" : "answer",
    }));

  return { lookingPct, trackedSeconds, awayEvents };
}

// One short line for the transcript, e.g. "[ATTENTION] looked at screen 82% of the answer; away 7s once".
export function attentionLine(raw) {
  // Turns can come back from the browser's copy of the session, so clean them again.
  const attention = sanitizeAttention(raw);
  if (!attention) {
    return "";
  }

  const during = attention.awayEvents.some((e) => e.during === "coding") ? "the coding round" : "the answer";
  let line = `[ATTENTION] looked at screen ${attention.lookingPct}% of ${during}`;

  const absent = attention.awayEvents.filter((e) => e.type === "absent");
  const away = attention.awayEvents.filter((e) => e.type === "looking_away");
  const describe = (list, label) => {
    const total = list.reduce((sum, e) => sum + e.seconds, 0);
    const times = list.length === 1 ? "once" : `${list.length} times`;
    return `${label} ${formatDuration(total)} ${times}`;
  };

  if (absent.length > 0) {
    line += `; ${describe(absent, "left the camera for")}`;
  }
  if (away.length > 0) {
    line += `; ${describe(away, "looked away")}`;
  }
  if (absent.length === 0 && away.length === 0) {
    line += "; no long absences";
  }

  return line;
}

// Totals across the whole interview for the verdict, or null when no answer was tracked.
export function summarizeAttention(turns) {
  const tracked = (turns || []).map((t) => sanitizeAttention(t && t.attention)).filter(Boolean);
  if (tracked.length === 0) {
    return null;
  }

  // Weight each answer by how long it was tracked so a 3 minute coding round counts more than a quick reply.
  const seconds = tracked.reduce((sum, a) => sum + a.trackedSeconds, 0);
  let lookingPct = 0;
  if (seconds > 0) {
    lookingPct = Math.round(tracked.reduce((sum, a) => sum + a.lookingPct * a.trackedSeconds, 0) / seconds);
  } else {
    lookingPct = Math.round(tracked.reduce((sum, a) => sum + a.lookingPct, 0) / tracked.length);
  }

  const events = tracked.flatMap((a) => a.awayEvents);
  const longest = events.reduce((max, e) => Math.max(max, e.seconds), 0);

  let line = `Looked at the screen ${lookingPct}% of the time across ${plural(tracked.length, "answer")}.`;
  if (events.length === 0) {
    line += " No long absences.";
  } else {
    line += ` Away more than 5s ${events.length === 1 ? "once" : `${events.length} times`} (longest ${formatDuration(longest)}).`;
  }

  return {
    answers: tracked.length,
    lookingPct,
    awayEvents: events.length,
    absentEvents: events.filter((e) => e.type === "absent").length,
    longestAway: longest,
    line,
  };
}

// ---------- trained critic ----------

// The critic and the panel disagree enough to flag the turn at this many points apart.
export const CRITIC_FLAG_GAP = 2;

// A second opinion from the trained critic (engine/critic.js). It never changes the panel's
// score: the panel heard the whole conversation, the critic only sees one answer. A big gap
// just gets a note in the ledger. judge is swappable so tests don't depend on the model file.
export function checkWithCritic(assessment, answer, judge = critique) {
  const checks = [];
  if (!assessment || !answer) {
    return { critic: null, checks };
  }

  let result = null;
  try {
    result = judge(answer);
  } catch {
    // A broken model file must never break a turn.
    result = null;
  }
  if (!result) {
    return { critic: null, checks };
  }

  const critic = { score: result.score, tags: result.tags.slice(0, 3) };
  if (Math.abs(critic.score - assessment.score) >= CRITIC_FLAG_GAP) {
    checks.push(`Trained critic scored this ${critic.score}/5, panel gave ${assessment.score}/5. Flagged for review.`);
  }
  return { critic, checks };
}
