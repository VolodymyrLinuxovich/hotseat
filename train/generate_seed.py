"""Generate the labeled seed answers the critic trains on.

Runs once, offline. Six calls to Claude, each asking for 50 interview answers with a
score and habit tags, written to train/data/seed_answers.jsonl. The key comes from the
repo's .env on purpose: the shell can hold a stale ANTHROPIC_API_KEY.
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "train" / "data" / "seed_answers.jsonl"

TOPICS = ["metrics", "ownership", "tradeoffs", "system_design", "conflict", "debugging", "motivation"]
TAGS = [
    "no_numbers",
    "vague",
    "we_not_i",
    "deflects",
    "rambling",
    "strong_example",
    "clear_tradeoffs",
    "incomplete_code",
]

SCHEMA = {
    "type": "object",
    "properties": {
        "answers": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "topic": {"type": "string", "enum": TOPICS},
                    "question": {"type": "string"},
                    "answer": {"type": "string"},
                    "score": {"type": "integer", "enum": [1, 2, 3, 4, 5]},
                    "tags": {"type": "array", "items": {"type": "string", "enum": TAGS}},
                },
                "required": ["topic", "question", "answer", "score", "tags"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["answers"],
    "additionalProperties": False,
}

RUBRIC = """You label answers from mock software engineering interviews for students and junior engineers.

Score 1 to 5, the way a strict but fair panel would:
1 = dodges or says almost nothing, 2 = weak and unsupported, 3 = acceptable but thin,
4 = specific and owned, with evidence, 5 = specific, measured, owned, and shows judgment.

Habit tags (0 to 3 per answer, only when clearly present):
no_numbers: makes claims about impact or performance with no numbers at all.
vague: generic, no concrete example or detail.
we_not_i: says "we" throughout so the candidate's own part is unclear.
deflects: dodges the question, blames others, or answers a different question.
rambling: long and unfocused, circles without landing a point.
strong_example: a concrete, specific story with the candidate's own actions and a result.
clear_tradeoffs: names the options and why one was picked over the other.
incomplete_code: a coding answer that is unfinished, stubbed, or fails tests.

Negative tags and a score of 4 or 5 do not go together. Strong tags rarely go with a score of 1 or 2."""

# Each call gets a different slant so the six batches don't collapse into one style.
SLANTS = [
    "Mostly weak answers (scores 1 and 2): vague claims, missing numbers, deflection, short dismissive replies.",
    "Mostly strong answers (scores 4 and 5) with real numbers, percentages, latencies, user counts, and first person ownership.",
    "Middle answers (score 3) and mixed ones: some detail but missing a number, or good detail but all 'we'.",
    "Long answers: half of them rambling and unfocused, half long but well structured. Include some speech-to-text style filler.",
    "Technical answers about system design, debugging and tradeoffs, from shallow to excellent. Include 8 live coding answers "
    "written like '[LIVE CODING: <title>]' followed by code and a '[JUDGE] k/6 hidden tests passed' line.",
    "Very short answers (one sentence or a fragment) across all scores, plus a few answers to behavioral questions "
    "about conflict and motivation that are honest about mistakes.",
]


def load_key():
    for line in (ROOT / ".env").read_text().splitlines():
        if line.startswith("ANTHROPIC_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"')
    sys.exit("ANTHROPIC_API_KEY missing from .env")


def generate(client, slant):
    prompt = (
        "Write 50 different interview answers with their labels.\n\n"
        f"This batch: {slant}\n\n"
        "Spread them over all seven topics. Make each question realistic and each answer sound like a real "
        "candidate speaking, with different projects, companies and voices. Vary length from 3 words to about "
        "180 words. Label honestly with the rubric; the labels train a classifier, so they must be consistent."
    )
    res = client.messages.create(
        model="claude-opus-5-5",
        max_tokens=32000,
        system=RUBRIC,
        messages=[{"role": "user", "content": prompt}],
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
    )
    text = next(b.text for b in res.content if b.type == "text")
    return json.loads(text)["answers"]


def main():
    client = anthropic.Anthropic(api_key=load_key(), timeout=600)

    with ThreadPoolExecutor(max_workers=len(SLANTS)) as pool:
        batches = list(pool.map(lambda s: generate(client, s), SLANTS))

    seen = set()
    rows = []
    for batch in batches:
        for row in batch:
            key = row["answer"].strip().lower()
            if key in seen:
                continue
            seen.add(key)
            row["tags"] = sorted(set(row["tags"]))
            row["source"] = "seed"
            rows.append(row)

    with OUT.open("w") as f:
        for row in rows:
            f.write(json.dumps(row) + "\n")
    print(f"wrote {len(rows)} answers to {OUT}")


if __name__ == "__main__":
    main()
