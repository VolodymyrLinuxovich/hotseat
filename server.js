// HTTP layer. The interview logic lives in engine/; this file only routes requests to it.

import path from "node:path";

import express from "express";

import { HOSTED, MAX_QUESTIONS, ROOT } from "./engine/config.js";
import { candidateId, readProfile, runBruin } from "./engine/memory.js";
import { answerQuestion, closeInterview, newSession, openInterview } from "./engine/panel.js";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "dist")));

// Simple per-visitor limit so a public link can't burn through API credits.
const START_LIMIT = Number(process.env.START_LIMIT_PER_HOUR || 30);
const starts = new Map();

function allowStart(req) {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "?")
    .split(",")[0]
    .trim();
  const now = Date.now();
  const recent = (starts.get(ip) || []).filter((t) => now - t < 3_600_000);
  if (recent.length >= START_LIMIT) {
    return false;
  }
  recent.push(now);
  starts.set(ip, recent);
  return true;
}

// The browser carries the interview state, so any server instance can handle the next request.
const sessions = new Map();

function getSession(body) {
  let session = sessions.get(body.session_id);
  if (!session && body.state && body.state.id === body.session_id) {
    session = body.state;
    session.turns = Array.isArray(session.turns) ? session.turns.slice(0, MAX_QUESTIONS) : [];
    sessions.set(session.id, session);
  }
  return session || null;
}

function fail(res, err) {
  console.error(err);
  res.status(500).json({ error: String(err.message || err) });
}

app.get("/api/profile", (req, res) => {
  res.json(readProfile(candidateId(req.query.name)));
});

app.post("/api/start", async (req, res) => {
  if (!allowStart(req)) {
    res
      .status(429)
      .json({ error: "You've hit the demo limit for this hour. Try again later, or run Hotseat locally." });
    return;
  }

  try {
    const session = newSession(req.body);
    sessions.set(session.id, session);
    const turn = await openInterview(session);
    res.json({ session_id: session.id, profile: session.profile, ...turn, state: session, hosted: HOSTED });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/answer", async (req, res) => {
  const session = getSession(req.body);
  if (!session) {
    res.status(404).json({ error: "no session" });
    return;
  }

  try {
    const turn = await answerQuestion(session, req.body.answer);
    res.json({ ...turn, state: session });
  } catch (err) {
    fail(res, err);
  }
});

app.post("/api/verdict", async (req, res) => {
  const session = getSession(req.body);
  if (!session) {
    res.status(404).json({ error: "no session" });
    return;
  }

  try {
    const verdict = await closeInterview(session);
    res.json({ ...verdict, hosted: HOSTED });
  } catch (err) {
    fail(res, err);
  }
});

app.get("/api/bruin/run", async (req, res) => {
  const result = await runBruin();
  res.json({ ...result, profile: readProfile(candidateId(req.query.name)) });
});

export default app;

if (!HOSTED) {
  const port = process.env.PORT || 8787;
  app.listen(port, () => console.log(`hotseat api on :${port}`));
}
