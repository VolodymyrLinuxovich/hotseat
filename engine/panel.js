// The interview engine. It asks the model for each panel decision, runs every result through
// the checks, and keeps the session state up to date.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

import { checkProblem, checkTurn, checkVerdict } from "./checks.js";
import { CODING_ROUND, MAX_QUESTIONS, MODEL } from "./config.js";
import { candidateId, logSession, readProfile, runBruin } from "./memory.js";
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

function pushQuestion(session, out, problem) {
  session.turns.push({
    asker: out.decision.asker,
    question: out.question,
    difficulty: out.decision.difficulty,
    topic: out.decision.topic,
    answer: null,
    problem,
  });
}

export function newSession({ name, role }) {
  const candidate = candidateId(name);
  return {
    id: `s_${Date.now()}`,
    role: role || "Software Engineer Intern",
    candidate,
    profile: readProfile(candidate),
    turns: [],
    started: new Date().toISOString(),
  };
}

export async function openInterview(session) {
  const raw = await ask(panelSystem(session), transcriptText(session), TurnSchema);
  const { out, checks } = checkTurn(raw, session);

  pushQuestion(session, out, null);
  return { ...out, checks, index: 1, total: MAX_QUESTIONS };
}

export async function answerQuestion(session, answer) {
  const last = session.turns[session.turns.length - 1];
  last.answer = String(answer || "").slice(0, 4000) || "(silence)";

  const coding = session.turns.length + 1 === CODING_ROUND;

  // The panel call and the problem call don't depend on each other, so they run together.
  const [raw, made] = await Promise.all([
    ask(panelSystem(session), transcriptText(session), TurnSchema),
    coding ? makeProblem(session) : Promise.resolve(null),
  ]);
  const { out, checks } = checkTurn(raw, session, { coding });

  let problem = null;
  if (made) {
    problem = made.problem;
    out.question = problem.spoken_intro;
    checks.push(...made.checks);
  }

  if (out.assessment) {
    last.score = out.assessment.score;
    last.tags = out.assessment.tags;
    last.topic = out.assessment.topic;
    last.note = out.assessment.note;
  }

  const done = session.turns.length >= MAX_QUESTIONS;
  if (!done) {
    pushQuestion(session, out, problem);
  }

  return { ...out, checks, problem, done, index: session.turns.length, total: MAX_QUESTIONS };
}

export async function closeInterview(session) {
  const answered = session.turns.filter((t) => t.answer);

  const raw = await ask(verdictSystem(session), verdictTranscript(answered), VerdictSchema, 6000);
  const { verdict, checks } = checkVerdict(raw, answered);

  logSession(session, answered, verdict);
  const bruin = await runBruin();

  return {
    ...verdict,
    checks,
    bruin: { ok: bruin.ok, ms: bruin.ms },
    profile: readProfile(session.candidate),
  };
}
