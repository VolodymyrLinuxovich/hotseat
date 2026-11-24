// Candidate memory: the session log the Bruin pipeline reads, and the profile it writes back.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { DATA, HOSTED, ROOT } from "./config.js";

export function candidateId(name) {
  const id = String(name || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
  return id || "demo";
}

// data/profile.json is newline-delimited JSON from Bruin, one row per candidate.
export function readProfile(candidate) {
  try {
    const rows = fs
      .readFileSync(path.join(DATA, "profile.json"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    return rows.find((r) => r.candidate_id === candidate) || null;
  } catch {
    return null;
  }
}

// Append one finished interview to the logs the pipeline loads.
export function logSession(session, answered, verdict) {
  fs.mkdirSync(DATA, { recursive: true });
  const now = new Date().toISOString();

  const turnLines = answered.map((t, i) => {
    return JSON.stringify({
      candidate_id: session.candidate,
      session_id: session.id,
      company: session.company || "general",
      ts: now,
      turn: i + 1,
      asker: t.asker,
      topic: t.topic || "general",
      // The question policy learns from logged sessions and needs the difficulty each was asked at.
      difficulty: t.difficulty ?? null,
      question: t.question,
      answer: t.answer,
      score: t.score ?? 3,
      tags: t.tags || [],
    });
  });
  if (turnLines.length > 0) {
    fs.appendFileSync(path.join(DATA, "turns.jsonl"), `${turnLines.join("\n")}\n`);
  }

  const sessionLine = {
    candidate_id: session.candidate,
    session_id: session.id,
    company: session.company || "general",
    ts: now,
    verdict: verdict.verdict,
    overall: verdict.overall,
  };
  fs.appendFileSync(path.join(DATA, "sessions.jsonl"), `${JSON.stringify(sessionLine)}\n`);
}

// DuckDB allows one writer at a time, so pipeline runs are queued.
let queue = Promise.resolve();

export function runBruin() {
  const run = queue.then(runBruinOnce);
  queue = run.catch(() => {});
  return run;
}

function runBruinOnce() {
  if (HOSTED) {
    return Promise.resolve({ ok: false, log: "Bruin is not installed on the hosted demo" });
  }

  const script = path.join(ROOT, "bruin", "run.sh");
  if (!fs.existsSync(script)) {
    return Promise.resolve({ ok: false, log: "bruin/run.sh missing" });
  }

  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", [script], { cwd: ROOT });
    let log = "";
    child.stdout.on("data", (d) => {
      log += d;
    });
    child.stderr.on("data", (d) => {
      log += d;
    });
    child.on("close", (code) => {
      resolve({ ok: code === 0, ms: Date.now() - started, log: log.slice(-3000) });
    });
  });
}
