// The interview engine. It asks the model for each panel decision, runs every result through
// the checks, and keeps the session state up to date.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import {
  checkProblem,
  checkTurn,
  checkVerdict,
  checkWithCritic,
  coverageHint,
  pasteFollowUpHint,
  sanitizeAttention,
  summarizeAttention,
} from "./checks.js";
import { CODING_OPENER, codingAnswerText, openCodingChat } from "./coding.js";
import { getCompany } from "./companies.js";
import { CODING_ROUND, MAX_QUESTIONS, MODEL } from "./config.js";
import { estimateAbility, scoreInterval } from "./core.js";
import { critique } from "./critic.js";
import { candidateId, logSession, readProfile, runBruin } from "./memory.js";
import { policyCheck, policyLine, suggestNext } from "./policy.js";
import { panelSystem, problemSystem, transcriptText, verdictSystem, verdictTranscript } from "./prompts.js";
import { ProblemSchema, TurnSchema, VerdictSchema } from "./schemas.js";

const client = new Anthropic();

// Used only if the model can't produce a problem whose tests check out twice in a row.
const FALLBACK_PROBLEM = {
  title: "Balanced Brackets",
  spoken_intro: "Let's code. Check whether a string of brackets is balanced. Talk me through your edge cases.",
  description:
    'Write is_balanced(s) that returns true if every bracket in s is closed in the right order.\nBrackets are (), [] and {}.\nExample: is_balanced("([]{})") returns true, is_balanced("(]") returns false.',
  function_name: "is_balanced",
  starter_code: "function is_balanced(s) {\n  // your code here\n}\n",
  starter_code_python: "def is_balanced(s):\n    # your code here\n    pass\n",
  tests: [
    { args_json: '["([]{})"]', expected_json: "true" },
    { args_json: '["(]"]', expected_json: "false" },
    { args_json: '[""]', expected_json: "true" },
    { args_json: '["((("]', expected_json: "false" },
    { args_json: '["{[()()]}"]', expected_json: "true" },
    { args_json: '["())("]', expected_json: "false" },
  ],
};

async function ask(system, user, schema, maxTokens = 4000) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort: "low", format: zodOutputFormat(schema) },
  });
  if (!res.parsed_output) {
    throw new Error(`model returned no usable output (${res.stop_reason})`);
  }
  return res.parsed_output;
}

function averageScore(session) {
  const scored = session.turns.filter((t) => t.score);
  if (scored.length === 0) {
    return 3;
  }
  return scored.reduce((sum, t) => sum + t.score, 0) / scored.length;
}

async function makeProblem(session) {
  const difficulty = Math.max(1, Math.min(5, Math.round(averageScore(session))));
  const system = problemSystem(session, difficulty);

  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = await ask(system, "Make the problem.", ProblemSchema);
    const result = checkProblem(draft);
    if (result.valid) {
      return result;
    }
  }

  return {
    problem: FALLBACK_PROBLEM,
    checks: ["Generated problems failed the test check twice; using a verified backup problem."],
  };
}

function round2(x) {
  return Math.round(x * 100) / 100;
}

// Ability on the 1-5 difficulty scale from every scored answer so far (C++ core, Rasch model).
function abilityOf(session) {
  const pairs = session.turns
    .filter((t) => t.answer && t.score)
    .map((t) => ({ difficulty: t.difficulty, score: t.score }));
  const est = estimateAbility(pairs);
  return { theta: round2(est.theta), se: round2(est.se), next: est.next, answers: pairs.length };
}

// One line for the panel so its difficulty pick starts from the engine's estimate.
// Nothing before the first score, since the prior alone says nothing about this candidate.
function abilityHint(session) {
  const ability = abilityOf(session);
  if (ability.answers === 0) {
    return "";
  }
  return `[ENGINE] Ability estimate ${ability.theta.toFixed(1)} ± ${ability.se.toFixed(1)}. Recommended next difficulty ${ability.next}.`;
}

// The panel keeps the final say on difficulty, but not a jump of more than one step away from
// what the candidate's record supports.
function nudgeDifficulty(decision, ability, checks) {
  const picked = decision.difficulty;
  const nudged = Math.min(ability.next + 1, Math.max(ability.next - 1, picked));
  if (nudged === picked) {
    return;
  }
  decision.difficulty = nudged;
  checks.push(
    `Panel picked difficulty ${picked}; ability ${ability.theta.toFixed(1)} ± ${ability.se.toFixed(1)} suggests ${ability.next}, so the engine set ${nudged}.`,
  );
}

// The transcript plus a nudge toward topics the panel hasn't covered yet. A pasted coding
// answer comes first, since following up on it matters more than coverage. The trained
// policy's pick goes last; the panel weighs it like any other hint and keeps the final say.
function panelUser(session, pasteHint = "", policyHint = "") {
  const hints = [pasteHint, coverageHint(session), abilityHint(session), policyHint].filter(Boolean);
  if (hints.length === 0) {
    return transcriptText(session);
  }
  return `${transcriptText(session)}\n\n${hints.join("\n")}`;
}

function pushQuestion(session, out, problem) {
  const turn = {
    asker: out.decision.asker,
    question: out.question,
    difficulty: out.decision.difficulty,
    topic: out.decision.topic,
    answer: null,
    problem,
  };
  if (problem) {
    openCodingChat(turn);
  }
  session.turns.push(turn);
}

export function newSession({ name, role, company }) {
  const candidate = candidateId(name);
  return {
    id: `s_${Date.now()}`,
    role: role || "Software Engineer Intern",
    // Only the id travels with the browser's state; the details are looked up on every call.
    company: getCompany(company).id,
    candidate,
    profile: readProfile(candidate),
    turns: [],
    started: new Date().toISOString(),
  };
}

// One engine note on whether the panel took the trained policy's suggestion.
function notePolicy(policy, decision, checks) {
  const note = policyCheck(policy, decision);
  if (note) {
    checks.push(note);
  }
}

export async function openInterview(session) {
  const policy = suggestNext(session);
  const raw = await ask(panelSystem(session), panelUser(session, "", policyLine(policy)), TurnSchema);
  const { out, checks } = checkTurn(raw, session);
  notePolicy(policy, out.decision, checks);

  pushQuestion(session, out, null);
  return { ...out, checks, policy, index: 1, total: MAX_QUESTIONS };
}

// editor carries the browser's integrity counters when the answer is a coding submission.
// attention is the browser's look-at-the-screen numbers for this answer, if tracking is on.
export async function answerQuestion(session, answer, editor = null, attention = null) {
  const last = session.turns[session.turns.length - 1];
  let text = String(answer || "").slice(0, 4000) || "(silence)";
  if (last.problem) {
    text = codingAnswerText(last, text, editor);
  }
  last.answer = text;
  last.attention = sanitizeAttention(attention);
  const pasteHint = pasteFollowUpHint(last.integrity);

  const coding = session.turns.length + 1 === CODING_ROUND;

  // The trained policy picks before the panel call, so it can't see the panel's score for
  // this answer yet; the critic's score stands in. No pick for the coding round (always
  // Theo) or after the last answer.
  let policy = null;
  if (!coding && session.turns.length < MAX_QUESTIONS) {
    const provisional = critique(text);
    policy = suggestNext(session, { lastScore: provisional ? provisional.score : null });
  }

  // The panel call and the problem call don't depend on each other, so they run together.
  let raw = null;
  let made = null;
  try {
    [raw, made] = await Promise.all([
      ask(panelSystem(session), panelUser(session, pasteHint, policyLine(policy)), TurnSchema),
      coding ? makeProblem(session) : Promise.resolve(null),
    ]);
  } catch (err) {
    // Leave the question open so the browser can send the same answer again.
    last.answer = null;
    last.attention = null;
    throw err;
  }
  const { out, checks } = checkTurn(raw, session, { coding, pasteFollowUp: Boolean(pasteHint) });

  // Second opinion from the trained critic; it only adds a note, the panel's score stands.
  const second = checkWithCritic(out.assessment, text);
  out.critic = second.critic;
  checks.push(...second.checks);

  let problem = null;
  if (made) {
    // The browser shows and speaks the same opener the chat log starts with.
    problem = { ...made.problem, opener: CODING_OPENER };
    out.question = problem.spoken_intro;
    checks.push(...made.checks);
  }

  if (out.assessment) {
    last.score = out.assessment.score;
    last.tags = out.assessment.tags;
    last.topic = out.assessment.topic;
    last.note = out.assessment.note;
  }

  // Re-estimate with this answer's score, then hold the next question near what it supports.
  const ability = abilityOf(session);
  session.ability = ability;

  const done = session.turns.length >= MAX_QUESTIONS;
  if (!done) {
    nudgeDifficulty(out.decision, ability, checks);
    notePolicy(policy, out.decision, checks);
    pushQuestion(session, out, problem);
  }

  return { ...out, checks, problem, done, ability, policy, index: session.turns.length, total: MAX_QUESTIONS };
}

export async function closeInterview(session) {
  const answered = session.turns.filter((t) => t.answer);

  const raw = await ask(verdictSystem(session), verdictTranscript(answered), VerdictSchema, 6000);
  const { verdict, checks } = checkVerdict(raw, answered);

  logSession(session, answered, verdict);
  const bruin = await runBruin();

  const company = getCompany(session.company);
  return {
    ...verdict,
    company: { id: company.id, name: company.name },
    checks,
    bruin: { ok: bruin.ok, ms: bruin.ms },
    profile: readProfile(session.candidate),
    attention: summarizeAttention(answered),
    score_ci: scoreCi(answered),
    ability: abilityOf(session),
  };
}

// Mean answer score with a 95% bootstrap interval from the C++ core. With five answers the
// interval is wide, which is the honest answer to "how sure is this score".
function scoreCi(answered) {
  const ci = scoreInterval(answered.map((t) => t.score));
  if (!ci) {
    return null;
  }
  return { mean: round2(ci.mean), low: round2(ci.low), high: round2(ci.high) };
}
