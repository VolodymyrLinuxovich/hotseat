// Structured output shapes for every model call. The model must answer in exactly these forms.

import { z } from "zod";

import { AGENT_IDS } from "./agents.js";

const AgentId = z.enum(AGENT_IDS);
const Mood = z.enum(["neutral", "impressed", "skeptical", "concerned", "amused"]);

export const TurnSchema = z.object({
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
    }),
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

export const ProblemSchema = z.object({
  title: z.string(),
  spoken_intro: z.string(),
  description: z.string(),
  function_name: z.string(),
  starter_code: z.string(),
  starter_code_python: z.string(),
  // Never sent to the browser. The engine runs it to prove the tests are right.
  reference_solution_js: z.string(),
  tests: z.array(z.object({ args_json: z.string(), expected_json: z.string() })),
});

export const VerdictSchema = z.object({
  votes: z.array(
    z.object({
      agent: AgentId,
      vote: z.enum(["hire", "no_hire"]),
      reason: z.string(),
      evidence_quote: z.string(),
    }),
  ),
  verdict: z.enum(["hire", "lean_hire", "lean_no_hire", "no_hire"]),
  overall: z.number(),
  strengths: z.array(z.string()),
  growth: z.array(z.object({ area: z.string(), evidence_quote: z.string(), drill: z.string() })),
  summary: z.string(),
  spoken_verdict: z.string(),
});
