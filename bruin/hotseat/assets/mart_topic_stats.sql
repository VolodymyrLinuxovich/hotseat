/* @bruin
name: mart.topic_stats
type: duckdb.sql
description: Average score per candidate and interview topic across all their sessions.
materialization:
  type: table
depends:
  - raw.turns
custom_checks:
  - name: one row per candidate and topic
    query: SELECT count(*) - count(DISTINCT candidate_id || '#' || topic) FROM mart.topic_stats
    value: 0
columns:
  - name: candidate_id
    type: varchar
    checks:
      - name: not_null
  - name: topic
    type: varchar
    checks:
      - name: not_null
  - name: avg_score
    type: double
    checks:
      - name: min
        value: 1
      - name: max
        value: 5
  - name: n
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    candidate_id,
    topic,
    round(avg(score), 2) AS avg_score,
    count(*)::INTEGER AS n
FROM raw.turns
GROUP BY candidate_id, topic
