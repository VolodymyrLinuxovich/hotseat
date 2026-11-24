/* @bruin
name: raw.sessions
type: duckdb.sql
description: One row per finished interview with the panel verdict, from data/sessions.jsonl.
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
      - name: unique
  - name: company
    type: varchar
    description: "Company mode the interview ran in, older rows without one are general"
    checks:
      - name: not_null
  - name: verdict
    type: varchar
    checks:
      - name: not_null
      - name: accepted_values
        value: [hire, no_hire, lean_hire, lean_no_hire]
  - name: overall
    type: double
    checks:
      - name: not_null
      - name: min
        value: 1
      - name: max
        value: 5
@bruin */

SELECT
    coalesce(nullif(trim(candidate_id), ''), 'demo') AS candidate_id,
    session_id,
    coalesce(nullif(lower(trim(company)), ''), 'general') AS company,
    CAST(ts AS TIMESTAMP) AS ts,
    verdict,
    overall
FROM read_json(
    'data/sessions.jsonl',
    format = 'newline_delimited',
    columns = {candidate_id: 'VARCHAR', session_id: 'VARCHAR', company: 'VARCHAR', ts: 'VARCHAR', verdict: 'VARCHAR', overall: 'DOUBLE'}
)
QUALIFY row_number() OVER (PARTITION BY session_id ORDER BY ts DESC) = 1
