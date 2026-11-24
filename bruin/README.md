# Hotseat memory pipeline (Bruin)

Bruin is the panel's memory. After each interview the Node server appends to
`data/turns.jsonl` and `data/sessions.jsonl`, then runs this pipeline. It loads
every past session into DuckDB, checks the data, builds a candidate weakness
profile and writes `data/profile.json`. The agents read that file before the
next session so they press on the candidate's known weak spots.

## Run

```bash
bruin/run.sh            # from any directory
```

Uses `.tools/bruin` (or `$BRUIN_BIN`, or `bruin` on PATH). Exits nonzero if any
asset or quality check fails. On failure the previous `data/profile.json` is
kept. A full run takes well under a second.

## Assets (`bruin/hotseat/assets`)

| Asset | What it does |
| --- | --- |
| `raw.turns` | Loads `data/turns.jsonl` with DuckDB `read_json` |
| `raw.sessions` | Loads `data/sessions.jsonl`, latest row per session |
| `mart.topic_stats` | Average score and answer count per topic |
| `mart.tag_counts` | Tag counts on weak answers (score 3 or below) |
| `mart.session_trend` | Overall score and verdict per session, in time order |
| `mart.habit_progress` | Per candidate and tag: weak-answer hits in earlier sessions vs the latest one, status fixed, repeating or new |
| `mart.topic_progress` | Per candidate and topic: earlier average vs latest average, delta, status improved, regressed or steady |
| `mart.profile` | One profile row per candidate: weak and strong topics, weak tags, trend, focus sentence, `habits`, `topic_deltas` |
| `export.profile_json` | `COPY` of `mart.profile` to `data/profile.json.tmp`; `run.sh` renames it atomically |

The focus sentence is a deterministic template. It takes the weakest topic and
the tag seen most on that topic's weak answers, then adds a probing hint for
that tag.

The progress marts split each candidate's turns into their latest session and
everything before it. A habit is a tag on a weak answer (score 3 or below), and
praise tags like `strong_example` are ignored. A topic counts as improved or
regressed when its average moved half a point or more. Candidates with one
session get empty `habits` and `topic_deltas`.

## Quality checks (57)

- `raw.turns`: `not_null` on session_id, company, turn, asker, topic, score; `asker`
  accepted values manager, tech, skeptic; `score` min 1 and max 5; `turn`
  positive; custom check for duplicate turns within a session.
- `raw.sessions`: `session_id` not null and unique; `company` not null; `verdict` accepted values
  hire, no_hire, lean_hire, lean_no_hire; `overall` between 1 and 5.
- `mart.habit_progress`: one row per candidate and tag, `status` accepted values
  fixed, repeating, new, counts non negative, custom check that the status
  matches the before and latest counts, only candidates with an earlier session.
- `mart.topic_progress`: one row per candidate and topic, both averages between
  1 and 5, `status` accepted values improved, regressed, steady, custom checks
  that delta equals latest minus before and that the status matches the delta.
- Marts: unique keys, score ranges, positive counts, one row per candidate and topic or tag, one profile row per candidate, and every candidate with turns has a profile. Every table carries `candidate_id`; rows without one fall back to `demo`. Both raw tables carry `company` (the company mode the interview ran in); older rows without one become `general`, and candidate memory still aggregates across companies.

## Config

- `bruin/.bruin.yml`: DuckDB connection `hotseat-duckdb` at `data/hotseat.duckdb`
  (path is relative to this config file).
- `bruin/hotseat/pipeline.yml`: pipeline `hotseat-memory`, default type `duckdb.sql`.
- SQL file paths (`data/...`) resolve against the repo root, which `run.sh` cds into.
