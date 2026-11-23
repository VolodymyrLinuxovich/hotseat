// Prompt text for the panel, the coding problem, and the verdict.

import { AGENT_IDS, AGENTS, describeAgent } from "./agents.js";
import { attentionLine } from "./checks.js";
import { CODING_ROUND, MAX_QUESTIONS, MAX_QUESTION_WORDS } from "./config.js";

const PANEL_LIST = AGENT_IDS.map((id) => `- ${describeAgent(id)}`).join("\n");

function humanize(name) {
  return String(name).replace(/_/g, " ");
}

function habitNames(habits, status) {
  return habits
    .filter((h) => h.status === status)
    .map((h) => humanize(h.tag))
    .join(", ");
}

// One compact line on what changed since the earlier sessions, from mart.habit_progress and mart.topic_progress.
function progressLines(profile) {
  const habits = profile.habits || [];
  const deltas = profile.topic_deltas || [];
  const lines = [];

  const fixed = habitNames(habits, "fixed");
  if (fixed) {
    lines.push(`Fixed since last time: ${fixed}.`);
  }

  const repeating = habits
    .filter((h) => h.status === "repeating")
    .map((h) => `${humanize(h.tag)} (${h.before}x before, ${h.latest}x last session)`)
    .join(", ");
  if (repeating) {
    lines.push(`Still repeating: ${repeating}.`);
  }

  const fresh = habitNames(habits, "new");
  if (fresh) {
    lines.push(`New last session: ${fresh}.`);
  }

  const moved = (status) => {
    return deltas
      .filter((d) => d.status === status)
      .map((d) => `${humanize(d.topic)} ${d.before} to ${d.latest}`)
      .join(", ");
  };
  const improved = moved("improved");
  if (improved) {
    lines.push(`Improved on: ${improved}.`);
  }
  const regressed = moved("regressed");
  if (regressed) {
    lines.push(`Regressed on: ${regressed}.`);
  }

  return lines;
}

function memoryBlock(profile) {
  if (!profile || !profile.sessions) {
    return "MEMORY: this is the candidate's first session. No history yet.";
  }

  const progress = progressLines(profile);
  let progressText = "";
  if (progress.length > 0) {
    progressText = `\nProgress since earlier sessions:\n${progress.join("\n")}
When a fixed habit or improved topic shows up, acknowledge it out loud in the question or a whisper. Press hard on repeating habits and regressed topics.`;
  }

  return `MEMORY FROM PAST SESSIONS (computed by the Bruin pipeline over ${profile.sessions} past interviews):
${profile.focus || ""}
Weak topics: ${JSON.stringify(profile.weak_topics || [])}
Weak habits: ${JSON.stringify(profile.weak_tags || [])}
Strong topics: ${JSON.stringify(profile.strong_topics || [])}${progressText}
Use this memory. Probe the weak spots early, and mention in deliberation when the candidate repeats or fixes a past habit.`;
}

export function panelSystem(session) {
  const bidRules = AGENT_IDS.map((id) => `${id} bids high when ${AGENTS[id].bidsWhen}`).join(", ");

  return `You run a live interview panel of three interviewers for the role: ${session.role}.
The panel:
${PANEL_LIST}

${memoryBlock(session.profile)}

Each turn you do three things:
1. assessment: score the candidate's LAST answer 1-5 (5 = specific, quantified, owns the outcome; 1 = vague or evasive). topic is one snake_case word for what was tested (e.g. metrics, system_design, conflict, ownership, debugging, tradeoffs, motivation). tags are 1-3 snake_case habits seen (e.g. no_numbers, vague, rambling, strong_example, clear_tradeoffs, we_not_i). note is one short sentence. Use null for assessment only when there is no answer yet.
2. deliberation: exactly three short lines, one per interviewer, as they whisper to each other about the candidate. Each in character, max 18 words, referencing what the candidate actually said. bid is how strongly that interviewer wants to ask next (0-1), driven by their own goal: ${bidRules}.
3. decision and question: the highest bidder usually asks next (say why in one sentence), sets difficulty 1-5 that adapts to performance (raise after strong answers, press on weak spots), and writes the next question in that interviewer's voice. The question is spoken aloud, so keep it under ${MAX_QUESTION_WORDS} words, no lists, no markdown.
Coding answers carry the code, the judge's report, an [INTEGRITY] line from the editor, and the [TALK-THROUGH] with Theo. Score the whole thing: clear explanation of the approach and good clarifying questions earn credit, and silence or a pasted solution the candidate never explained costs points. When the integrity line notes a large paste, Theo's whisper mentions it and he asks the candidate to walk him through the part they pasted.
An [ATTENTION] line means the candidate stepped away from the screen for a while: you may mention a long absence neutrally (for example, asking if everything is okay), weigh it lightly, and never accuse them of cheating.
Rotate askers so all three speak over the session. Never assume the candidate's gender: refer to them as "they" or "the candidate". moods reflect each interviewer's current reaction.`;
}

export function transcriptText(session) {
  if (session.turns.length === 0) {
    return "The candidate just sat down. Open the interview with a warm intro question.";
  }

  const lines = session.turns.map((t, i) => {
    const attention = t.attention ? `\n${attentionLine(t.attention)}` : "";
    return `Q${i + 1} (${t.asker}, difficulty ${t.difficulty}): ${t.question}\nCandidate: ${t.answer ?? "(no answer yet)"}${attention}`;
  });
  const next = session.turns.length + 1;

  let coding = "";
  if (next === CODING_ROUND) {
    coding =
      " This next question is the LIVE CODING ROUND: the asker must be tech, topic must be coding, and the question is one sentence that introduces the coding exercise (the problem itself is shown separately).";
  }

  return `Transcript so far:\n${lines.join("\n\n")}\n\nThis will be question ${next} of ${MAX_QUESTIONS}.${coding}`;
}

export function problemSystem(session, difficulty) {
  return `You write a live coding problem, HackerRank style, for a ${session.role} interview. Theo the Tech Lead will introduce it.
Difficulty ${difficulty}/5 (1 = warmup like reverse words, 3 = classic medium like two-sum or valid parentheses, 5 = harder like interval merge or LRU logic). It must be solvable in about 8 minutes in plain Python or JavaScript (the candidate picks).
Return:
- title
- spoken_intro: Theo says it aloud, under 30 words, no code
- description: clear statement with one example, plain text
- function_name: snake_case, valid in both languages
- starter_code: a JavaScript function stub with that name and parameters and an empty body with a comment
- starter_code_python: a Python def stub with the same name and parameters, a comment, and pass
- reference_solution_js: a complete, correct JavaScript solution with the same function name
- tests: 6 test cases, each with args_json (a JSON array of arguments) and expected_json (JSON of the expected return value)
Arguments and return values must be plain JSON types (numbers, strings, booleans, lists, objects) so both languages compare the same way. Include edge cases. Every expected value must be what reference_solution_js returns.`;
}

export function verdictSystem(session) {
  return `You are the closing deliberation of an interview panel for ${session.role}:
${PANEL_LIST}
Each interviewer votes hire or no_hire with one reason and an exact short quote from the candidate as evidence. Then give the panel verdict, overall score 1-5 (one decimal), 2-3 strengths, 2-3 growth areas each with an exact evidence quote and one concrete practice drill, a 2 sentence summary, and spoken_verdict: what the manager says aloud to the candidate, under 45 words, kind and honest.
For the coding round, weigh the [INTEGRITY] line (a large paste the candidate couldn't explain is a red flag) and the [TALK-THROUGH] with Theo (how they communicated while coding).
[ATTENTION] lines count for very little: never accuse the candidate over them.
Quotes must be copied word for word from the candidate's answers, never from Theo's lines. Never invent evidence. Refer to the candidate as "they", never he or she.`;
}

export function verdictTranscript(answered) {
  if (answered.length === 0) {
    return "The candidate did not answer any question.";
  }

  return answered
    .map((t, i) => {
      const attention = t.attention ? `\n${attentionLine(t.attention)}` : "";
      return `Q${i + 1} (${t.asker}, topic ${t.topic}, score ${t.score ?? "?"}): ${t.question}\nCandidate: ${t.answer}${attention}`;
    })
    .join("\n\n");
}
