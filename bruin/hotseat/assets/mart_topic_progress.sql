/* @bruin
name: mart.topic_progress
type: duckdb.sql
description: |
  Is the candidate getting better at each topic? Per candidate and topic, the average score in earlier
  sessions versus the most recent session. A move of half a point or more counts as improved or regressed.
  Only topics asked both before and in the latest session get a row, so every delta is a real comparison.
materialization:
  type: table
depends:
  - raw.turns
custom_checks:
  - name: one row per candidate and topic
    query: SELECT count(*) - count(DISTINCT candidate_id || '#' || topic) FROM mart.topic_progress
    value: 0
  - name: delta is latest minus before
    query: SELECT count(*) FROM mart.topic_progress WHERE abs(delta - (latest_avg - before_avg)) > 0.011
    value: 0
  - name: status matches the delta
    query: |
      SELECT count(*) FROM mart.topic_progress
      WHERE (status = 'improved' AND delta < 0.5)
         OR (status = 'regressed' AND delta > -0.5)
         OR (status = 'steady' AND abs(delta) >= 0.5)
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
  - name: before_avg
    type: double
    checks:
      - name: min
        value: 1
      - name: max
        value: 5
  - name: latest_avg
    type: double
    checks:
      - name: min
        value: 1
      - name: max
        value: 5
  - name: status
    type: varchar
    checks:
      - name: not_null
      - name: accepted_values
        value: [improved, regressed, steady]
@bruin */

-- Same session ordering as mart.habit_progress, so "latest" means the same session in both marts.
WITH session_order AS (
    SELECT
        candidate_id,
        session_id,
        row_number() OVER (PARTITION BY candidate_id ORDER BY min(ts) DESC, session_id DESC) AS recency
    FROM raw.turns
    GROUP BY candidate_id, session_id
),

split AS (
    SELECT
        t.candidate_id,
        t.topic,
        round(avg(t.score) FILTER (WHERE o.recency > 1), 2) AS before_avg,
        count(*) FILTER (WHERE o.recency > 1)::INTEGER AS before_n,
        round(avg(t.score) FILTER (WHERE o.recency = 1), 2) AS latest_avg,
        count(*) FILTER (WHERE o.recency = 1)::INTEGER AS latest_n
    FROM raw.turns t
    JOIN session_order o USING (candidate_id, session_id)
    GROUP BY t.candidate_id, t.topic
)

SELECT
    candidate_id,
    topic,
    before_avg,
    before_n,
    latest_avg,
    latest_n,
    round(latest_avg - before_avg, 2) AS delta,
    -- Half a point is one rubric step on a single answer; smaller moves are noise.
    CASE
        WHEN round(latest_avg - before_avg, 2) >= 0.5 THEN 'improved'
        WHEN round(latest_avg - before_avg, 2) <= -0.5 THEN 'regressed'
        ELSE 'steady'
    END AS status
FROM split
WHERE before_n > 0
  AND latest_n > 0
