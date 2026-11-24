/* @bruin
name: raw.turns
type: duckdb.sql
description: Every interview turn the panel has asked, loaded from data/turns.jsonl.
materialization:
  type: table
columns:
  - name: candidate_id
    type: varchar
    checks:
      - name: not_null
  - name: session_id
    type: varchar
    checks:
      - name: not_null
  - name: company
    type: varchar
    description: "Company mode the interview ran in, older rows without one are general"
    checks:
      - name: not_null
  - name: turn
    type: integer
    checks:
      - name: not_null
      - name: positive
  - name: asker
    type: varchar
    checks:
      - name: not_null
      - name: accepted_values
        value: [manager, tech, skeptic]
  - name: topic
    type: varchar
    checks:
      - name: not_null
  - name: score
    type: integer
    checks:
      - name: not_null
      - name: min
        value: 1
      - name: max
        value: 5
custom_checks:
  - name: no duplicate turns within a session
    query: SELECT COUNT(*) - COUNT(DISTINCT session_id || '#' || turn) FROM raw.turns
    value: 0
@bruin */

SELECT
    coalesce(nullif(trim(candidate_id), ''), 'demo') AS candidate_id,
    session_id,
    coalesce(nullif(lower(trim(company)), ''), 'general') AS company,
    CAST(ts AS TIMESTAMP) AS ts,
    turn,
    asker,
    lower(trim(topic)) AS topic,
    question,
    answer,
    score,
    coalesce(tags, []::VARCHAR[]) AS tags
FROM read_json(
    'data/turns.jsonl',
    format = 'newline_delimited',
    columns = {
        candidate_id: 'VARCHAR', session_id: 'VARCHAR', company: 'VARCHAR', ts: 'VARCHAR', turn: 'INTEGER', asker: 'VARCHAR',
        topic: 'VARCHAR', question: 'VARCHAR', answer: 'VARCHAR',
        score: 'INTEGER', tags: 'VARCHAR[]'
    }
)
