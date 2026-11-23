// The live coding round's conversation with Theo, and what the panel sees when code is submitted.
//
// While the candidate codes they can talk to Theo: ask clarifying questions or explain their
// approach. Every line is kept on the coding turn, and on submit it goes to the panel together
// with the integrity summary from the editor.

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

import { AGENTS } from "./agents.js";
import { checkChatReply, formatDuration, summarizeIntegrity } from "./checks.js";
import { MODEL } from "./config.js";

const client = new Anthropic();

// Theo says this once the problem is on screen, before the candidate types anything.
export const CODING_OPENER =
  "Before you start typing, talk me through your approach. Ask me anything about the problem.";

const MAX_MESSAGE_CHARS = 600;
const MAX_CODE_CHARS = 4000;
const MAX_CHAT_LINES = 40;

// Only the last few lines go back into the submission, so a chatty round can't crowd out the code.
const SUBMITTED_CHAT_LINES = 14;

const ChatSchema = z.object({
  reply: z.string(),
  kind: z.enum(["clarify", "react", "hint", "redirect"]),
});

// Called when the coding question is put to the candidate, so the chat starts with Theo's opener.
export function openCodingChat(turn) {
  turn.coding_chat = [{ who: "tech", text: CODING_OPENER }];
}

function currentCodingTurn(session) {
  const last = session.turns[session.turns.length - 1];
  if (!last || !last.problem || last.answer) {
    return null;
  }
  return last;
}

function chatLines(chat) {
  return chat
    .map((line) => {
      const who = line.who === "tech" ? "Theo" : "Candidate";
      return `${who}: ${line.text}`;
    })
    .join("\n");
}

function chatSystem(problem) {
  const theo = AGENTS.tech;
  const tests = problem.tests
    .slice(0, 4)
    .map((t) => `args ${t.args_json} -> ${t.expected_json}`)
    .join("\n");

  return `You are ${theo.name}, the ${theo.role}, running a live coding round in a job interview. ${theo.persona}
The candidate is solving this problem while you watch their editor:
Title: ${problem.title}
${problem.description}
Function: ${problem.function_name}
Some of the hidden tests (input -> expected output), so you can answer questions about edge cases honestly:
${tests}

They can talk to you while they code. Reply in character, in 1 or 2 short sentences, spoken aloud: no code, no markdown, no lists.
- A clarifying question (input size, edge cases, what to return): answer it honestly and directly from the problem and the tests. kind = clarify.
- An explanation of their approach: react like an interviewer. Name what is good, or ask one probing question about complexity, an edge case, or a data structure choice. Don't approve a wrong idea. kind = react.
- Give a hint only when they ask for one or are clearly stuck (many failing runs, long silence, or they say so). Keep it a nudge toward the idea, never the full algorithm. kind = hint.
- Never write code or the solution, even if asked. Steer them back to their own idea. kind = redirect.
Talk to the candidate as "you".`;
}

function chatUser(turn, message, code, context) {
  const parts = [];

  const seconds = Number(context && context.seconds);
  if (Number.isFinite(seconds) && seconds > 0) {
    parts.push(`Time since the round opened: ${formatDuration(seconds)}.`);
  }
  if (context && context.last_run) {
    parts.push(`Their last test run: ${String(context.last_run).slice(0, 200)}`);
  }

  const shown = String(code || "").slice(0, MAX_CODE_CHARS);
  parts.push(`Their code right now:\n${shown.trim() ? shown : "(empty)"}`);
  parts.push(`Conversation so far:\n${chatLines(turn.coding_chat)}`);
  parts.push(`The candidate just said: "${message}"`);

  return parts.join("\n\n");
}

// One exchange with Theo. Returns null when there is no open coding round to talk about.
export async function codingChat(session, { message, code, context } = {}) {
  const turn = currentCodingTurn(session);
  if (!turn) {
    return null;
  }

  const said = String(message || "")
    .trim()
    .slice(0, MAX_MESSAGE_CHARS);
  if (!said) {
    throw new Error("message is empty");
  }

  if (!Array.isArray(turn.coding_chat)) {
    openCodingChat(turn);
  }

  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system: chatSystem(turn.problem),
    messages: [{ role: "user", content: chatUser(turn, said, code, context) }],
    output_config: { effort: "low", format: zodOutputFormat(ChatSchema) },
  });
  if (!res.parsed_output) {
    throw new Error(`model returned no usable output (${res.stop_reason})`);
  }

  const { reply, checks } = checkChatReply(res.parsed_output.reply);

  // Both lines are stored only once the reply exists, so a failed call leaves no half exchange.
  turn.coding_chat.push({ who: "candidate", text: said }, { who: "tech", text: reply });
  turn.coding_chat = turn.coding_chat.slice(-MAX_CHAT_LINES);

  return { reply, kind: res.parsed_output.kind, checks };
}

// The text the panel scores for a coding answer: the code and judge report from the browser,
// then the integrity summary and the talk-through, which the browser can't edit.
export function codingAnswerText(turn, answer, coding) {
  const sections = [answer];

  const integrity = summarizeIntegrity(coding && coding.integrity);
  if (integrity) {
    turn.integrity = integrity;
    sections.push(`[INTEGRITY] ${integrity.line}`);
  }

  // The opener alone means the candidate never said anything to Theo.
  const chat = (turn.coding_chat || []).filter((line) => line.text !== CODING_OPENER);
  if (chat.length === 0) {
    sections.push("[TALK-THROUGH] The candidate did not talk to Theo during the round.");
  } else {
    sections.push(`[TALK-THROUGH WITH THEO]\n${chatLines(chat.slice(-SUBMITTED_CHAT_LINES))}`);
  }

  return sections.join("\n\n");
}
