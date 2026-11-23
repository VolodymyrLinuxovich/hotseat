/* @bruin
name: mart.topic_stats
type: duckdb.sql
description: Average score per interview topic across all sessions.
materialization:
  type: table
depends:
  - raw.turns
columns:
  - name: topic
    type: varchar
    checks:
      - name: not_null
      - name: unique
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
    topic,
    round(avg(score), 2) AS avg_score,
    count(*)::INTEGER AS n
FROM raw.turns
GROUP BY topic
