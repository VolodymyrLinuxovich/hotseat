import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(ROOT, "data");
const MODEL = "claude-opus-5-5";
const MAX_QUESTIONS = 5;

const client = new Anthropic();
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "dist")));

const AGENTS = {
  manager: "Maya, Hiring Manager. Warm but direct. Cares about ownership, impact, and how the candidate works with people.",
  tech: "Theo, Tech Lead. Curious and precise. Cares about technical depth, tradeoffs, and whether the candidate really built what they claim.",
  skeptic: "Sol, Bar Raiser. Polite but relentless. Pushes back on every claim, asks for numbers, and probes for hand waving.",
};
const AgentId = z.enum(["manager", "tech", "skeptic"]);
const Mood = z.enum(["neutral", "impressed", "skeptical", "concerned", "amused"]);

const TurnSchema = z.object({
  assessment: z
    .object({
      score: z.number().int().min(1).max(5),
      topic: z.string(),
      tags: z.array(z.string()),
      note: z.string(),
    })
    .nullable(),
  deliberation: z.array(
    z.object({
      agent: AgentId,
      says: z.string(),
      wants: z.enum(["press_harder", "move_on", "go_deeper", "ease_off"]),
      bid: z.number().min(0).max(1),
    })
  ),
  decision: z.object({
    asker: AgentId,
    reason: z.string(),
    difficulty: z.number().int().min(1).max(5),
    topic: z.string(),
  }),
  question: z.string(),
  moods: z.object({ manager: Mood, tech: Mood, skeptic: Mood }),
});

const VerdictSchema = z.object({
  votes: z.array(
    z.object({
      agent: AgentId,
      vote: z.enum(["hire", "no_hire"]),
      reason: z.string(),
      evidence_quote: z.string(),
    })
  ),
  verdict: z.enum(["hire", "lean_hire", "lean_no_hire", "no_hire"]),
  overall: z.number(),
  strengths: z.array(z.string()),
  growth: z.array(z.object({ area: z.string(), evidence_quote: z.string(), drill: z.string() })),
  summary: z.string(),
  spoken_verdict: z.string(),
});

const ProblemSchema = z.object({
  title: z.string(),
  spoken_intro: z.string(),
  description: z.string(),
  function_name: z.string(),
  starter_code: z.string(),
  tests: z.array(z.object({ args_json: z.string(), expected_json: z.string() })),
});

const sessions = new Map();
const CODING_ROUND = 3;

async function genProblem(s, difficulty) {
  const past = s.turns.filter((t) => t.answer).map((t) => `${t.topic}: ${t.score ?? "?"}/5`).join(", ");
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: `You write a live coding problem, HackerRank style, for a ${s.role} interview. Theo the Tech Lead will introduce it.
Difficulty ${difficulty}/5 (1 = warmup like reverse words, 3 = classic medium like two-sum or valid parentheses, 5 = harder like interval merge or LRU logic). It must be solvable in about 8 minutes in plain JavaScript.
Return: title; spoken_intro (Theo says it aloud, under 30 words, no code); description (clear statement with one example, plain text); function_name; starter_code (a JavaScript function stub with that name and parameters and an empty body with a comment); tests: 6 test cases, each with args_json (a JSON array of arguments) and expected_json (JSON of the expected return value). Include edge cases. Make sure every expected value is correct.`,
    messages: [{ role: "user", content: `Scores so far: ${past || "none"}. Make the problem.` }],
    output_config: { effort: "low", format: zodOutputFormat(ProblemSchema) },
  });
  if (!res.parsed_output) {
    throw new Error("problem gen failed");
  }
  return res.parsed_output;
}

function pushNext(s, out, problem) {
  s.turns.push({ asker: out.decision.asker, question: out.question, difficulty: out.decision.difficulty, topic: out.decision.topic, answer: null, problem });
}

function candidateId(name) {
  const id = String(name || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40);
  return id || "demo";
}

// data/profile.json is newline-delimited JSON written by the Bruin pipeline, one row per candidate.
function readProfile(candidate) {
  try {
    const rows = fs.readFileSync(path.join(DATA, "profile.json"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    return rows.find((r) => r.candidate_id === candidate) || null;
  } catch {
    return null;
  }
}

function panelSystem(s) {
  const profile = s.profile;
  const memory = profile && profile.sessions > 0
    ? `MEMORY FROM PAST SESSIONS (computed by the Bruin pipeline over ${profile.sessions} past interviews):
${profile.focus || ""}
Weak topics: ${JSON.stringify(profile.weak_topics || [])}
Weak habits: ${JSON.stringify(profile.weak_tags || [])}
Strong topics: ${JSON.stringify(profile.strong_topics || [])}
Use this memory. Probe the weak spots early, and mention in deliberation when the candidate repeats or fixes a past habit.`
    : "MEMORY: this is the candidate's first session. No history yet.";

  return `You run a live interview panel of three interviewers for the role: ${s.role}.
The panel:
- manager: ${AGENTS.manager}
- tech: ${AGENTS.tech}
- skeptic: ${AGENTS.skeptic}

${memory}

Each turn you do three things:
1. assessment: score the candidate's LAST answer 1-5 (5 = specific, quantified, owns the outcome; 1 = vague or evasive). topic is one snake_case word for what was tested (e.g. metrics, system_design, conflict, ownership, debugging, tradeoffs, motivation). tags are 1-3 snake_case habits seen (e.g. no_numbers, vague, rambling, strong_example, clear_tradeoffs, we_not_i). note is one short sentence. Use null for assessment only when there is no answer yet.
2. deliberation: exactly three short lines, one per interviewer, as they whisper to each other about the candidate. Each in character, max 18 words, referencing what the candidate actually said. bid is how strongly that interviewer wants to ask next (0-1), driven by their own goal: manager bids high when the candidate's personal role is vague, tech bids high when tradeoffs or depth are missing, skeptic bids high when a claim is unproven or has no numbers.
3. decision and question: the highest bidder usually asks next (say why in one sentence), sets difficulty 1-5 that adapts to performance (raise after strong answers, press on weak spots), and writes the next question in that interviewer's voice. The question is spoken aloud, so keep it under 35 words, no lists, no markdown.
Rotate askers so all three speak over the session. Never assume the candidate's gender: refer to them as "they" or "the candidate". moods reflect each interviewer's current reaction.`;
}

function transcriptText(s) {
  if (s.turns.length === 0) {
    return "The candidate just sat down. Open the interview with a warm intro question.";
  }
  const lines = s.turns.map(
    (t, i) => `Q${i + 1} (${t.asker}, difficulty ${t.difficulty}): ${t.question}\nCandidate: ${t.answer ?? "(no answer yet)"}`
  );
  const next = s.turns.length + 1;
  const coding = next === CODING_ROUND
    ? " This next question is the LIVE CODING ROUND: the asker must be tech, topic must be coding, and the question is one sentence that introduces the coding exercise (the problem itself is shown separately)."
    : "";
  return `Transcript so far:\n${lines.join("\n\n")}\n\nThis will be question ${next} of ${MAX_QUESTIONS}.${coding}`;
}

async function panelTurn(s) {
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    system: panelSystem(s),
    messages: [{ role: "user", content: transcriptText(s) }],
    output_config: { effort: "low", format: zodOutputFormat(TurnSchema) },
  });
  if (!res.parsed_output) {
    throw new Error(`panel parse failed: ${res.stop_reason}`);
  }
  return res.parsed_output;
}

app.get("/api/profile", (req, res) => {
  res.json(readProfile(candidateId(req.query.name)));
});

app.post("/api/start", async (req, res) => {
  try {
    const id = `s_${Date.now()}`;
    const s = {
      id,
      role: req.body.role || "Software Engineer Intern",
      candidate: candidateId(req.body.name),
      profile: readProfile(candidateId(req.body.name)),
      turns: [],
      started: new Date().toISOString(),
    };
    sessions.set(id, s);
    const out = await panelTurn(s);
    s.turns.push({ asker: out.decision.asker, question: out.question, difficulty: out.decision.difficulty, topic: out.decision.topic, answer: null });
    res.json({ session_id: id, profile: s.profile, ...out, index: 1, total: MAX_QUESTIONS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/answer", async (req, res) => {
  try {
    const s = sessions.get(req.body.session_id);
    if (!s) {
      return res.status(404).json({ error: "no session" });
    }
    const last = s.turns[s.turns.length - 1];
    last.answer = String(req.body.answer || "").slice(0, 4000) || "(silence)";
    const nextIsCoding = s.turns.length + 1 === CODING_ROUND;
    const avg = s.turns.filter((t) => t.score).reduce((a, t, _, arr) => a + t.score / arr.length, 0) || 3;
    const [out, problem] = await Promise.all([
      panelTurn(s),
      nextIsCoding ? genProblem(s, Math.max(1, Math.min(5, Math.round(avg)))) : Promise.resolve(null),
    ]);
    if (problem) {
      out.decision.asker = "tech";
      out.decision.topic = "coding";
      out.question = problem.spoken_intro;
    }
    if (out.assessment) {
      Object.assign(last, { score: out.assessment.score, tags: out.assessment.tags, topic: out.assessment.topic, note: out.assessment.note });
    }
    const done = s.turns.length >= MAX_QUESTIONS;
    if (!done) {
      pushNext(s, out, problem);
    }
    res.json({ ...out, problem, done, index: s.turns.length, total: MAX_QUESTIONS });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

let bruinChain = Promise.resolve();
function runBruin() {
  const p = bruinChain.then(runBruinOnce);
  bruinChain = p.catch(() => {});
  return p;
}
function runBruinOnce() {
  return new Promise((resolve) => {
    const script = path.join(ROOT, "bruin", "run.sh");
    if (!fs.existsSync(script)) {
      return resolve({ ok: false, log: "bruin/run.sh missing" });
    }
    const t0 = Date.now();
    const p = spawn("bash", [script], { cwd: ROOT });
    let log = "";
    p.stdout.on("data", (d) => (log += d));
    p.stderr.on("data", (d) => (log += d));
    p.on("close", (code) => resolve({ ok: code === 0, ms: Date.now() - t0, log: log.slice(-3000) }));
  });
}

app.post("/api/verdict", async (req, res) => {
  try {
    const s = sessions.get(req.body.session_id);
    if (!s) {
      return res.status(404).json({ error: "no session" });
    }
    const answered = s.turns.filter((t) => t.answer);
    const transcript = answered
      .map((t, i) => `Q${i + 1} (${t.asker}, topic ${t.topic}, score ${t.score ?? "?"}): ${t.question}\nCandidate: ${t.answer}`)
      .join("\n\n");
    const r = await client.messages.parse({
      model: MODEL,
      max_tokens: 6000,
      system: `You are the closing deliberation of an interview panel for ${s.role}: manager (${AGENTS.manager}), tech (${AGENTS.tech}), skeptic (${AGENTS.skeptic}).
Each interviewer votes hire or no_hire with one reason and an exact short quote from the candidate as evidence. Then give the panel verdict, overall score 1-5 (one decimal), 2-3 strengths, 2-3 growth areas each with an exact evidence quote and one concrete practice drill, a 2 sentence summary, and spoken_verdict: what the manager says aloud to the candidate, under 45 words, kind and honest.
Quotes must be copied from the candidate's answers. Never invent evidence. Refer to the candidate as "they", never he or she.`,
      messages: [{ role: "user", content: transcript || "The candidate did not answer any question." }],
      output_config: { effort: "low", format: zodOutputFormat(VerdictSchema) },
    });
    const v = r.parsed_output;
    if (!v) {
      throw new Error(`verdict parse failed: ${r.stop_reason}`);
    }

    fs.mkdirSync(DATA, { recursive: true });
    const turnLines = answered.map((t, i) =>
      JSON.stringify({
        candidate_id: s.candidate,
        session_id: s.id,
        ts: new Date().toISOString(),
        turn: i + 1,
        asker: t.asker,
        topic: t.topic || "general",
        question: t.question,
        answer: t.answer,
        score: t.score ?? 3,
        tags: t.tags || [],
      })
    );
    if (turnLines.length) {
      fs.appendFileSync(path.join(DATA, "turns.jsonl"), turnLines.join("\n") + "\n");
    }
    fs.appendFileSync(
      path.join(DATA, "sessions.jsonl"),
      JSON.stringify({ candidate_id: s.candidate, session_id: s.id, ts: new Date().toISOString(), verdict: v.verdict, overall: v.overall }) + "\n"
    );
    const bruin = await runBruin();
    res.json({ ...v, bruin: { ok: bruin.ok, ms: bruin.ms }, profile: readProfile(s.candidate) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/bruin/run", async (_req, res) => {
  res.json({ ...(await runBruin()), profile: readProfile(candidateId(_req.query.name)) });
});

const PORT = process.env.PORT || 8787;
app.listen(PORT, () => console.log(`hotseat api on :${PORT}`));
