/* @bruin
name: mart.habit_progress
type: duckdb.sql
description: |
  Did the candidate fix their bad habits? Per candidate and tag, how often the tag hit a weak answer
  (score 3 or below) in their earlier sessions versus their most recent session.
  Status is fixed (seen before, gone now), repeating (in both) or new (only in the latest session).
  Only candidates with at least two sessions get rows, since one session has nothing to compare against.
materialization:
  type: table
depends:
  - raw.turns
custom_checks:
  - name: one row per candidate and tag
    query: SELECT count(*) - count(DISTINCT candidate_id || '#' || tag) FROM mart.habit_progress
    value: 0
  - name: status matches the counts
    query: |
      SELECT count(*) FROM mart.habit_progress
      WHERE (status = 'fixed' AND NOT (before > 0 AND latest = 0))
         OR (status = 'repeating' AND NOT (before > 0 AND latest > 0))
         OR (status = 'new' AND NOT (before = 0 AND latest > 0))
    value: 0
  - name: only candidates with an earlier session
    query: SELECT count(*) FROM mart.habit_progress WHERE sessions_before < 1
    value: 0
columns:
  - name: candidate_id
    type: varchar
    checks:
      - name: not_null
  - name: tag
    type: varchar
    checks:
      - name: not_null
  - name: status
    type: varchar
    checks:
      - name: not_null
      - name: accepted_values
        value: [fixed, repeating, new]
  - name: before
    type: integer
    checks:
      - name: non_negative
  - name: latest
    type: integer
    checks:
      - name: non_negative
@bruin */

-- Order sessions by when they started. The turn log is the source of truth here,
-- because a session can have turns before its verdict row lands.
WITH session_order AS (
    SELECT
        candidate_id,
        session_id,
        row_number() OVER (PARTITION BY candidate_id ORDER BY min(ts) DESC, session_id DESC) AS recency,
        count(*) OVER (PARTITION BY candidate_id) AS total_sessions
    FROM raw.turns
    GROUP BY candidate_id, session_id
),

-- Same rule as mart.tag_counts: a tag only counts as a habit when it lands on a weak answer.
weak_tags AS (
    SELECT t.candidate_id, unnest(t.tags) AS tag, o.recency, o.total_sessions
    FROM raw.turns t
    JOIN session_order o USING (candidate_id, session_id)
    WHERE t.score <= 3
)

SELECT
    candidate_id,
    tag,
    count(*) FILTER (WHERE recency > 1)::INTEGER AS before,
    count(*) FILTER (WHERE recency = 1)::INTEGER AS latest,
    (any_value(total_sessions) - 1)::INTEGER AS sessions_before,
    CASE
        WHEN count(*) FILTER (WHERE recency = 1) = 0 THEN 'fixed'
        WHEN count(*) FILTER (WHERE recency > 1) = 0 THEN 'new'
        ELSE 'repeating'
    END AS status
FROM weak_tags
WHERE tag IS NOT NULL
  AND tag <> ''
  -- A borderline answer can still carry a praise tag like strong_example. That is not a habit to fix.
  AND NOT regexp_matches(tag, '^(strong|clear|good|structured)')
  AND total_sessions >= 2
GROUP BY candidate_id, tag
