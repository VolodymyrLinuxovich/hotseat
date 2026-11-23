/* @bruin
name: mart.tag_counts
type: duckdb.sql
description: How often each tag was applied to a weak answer (score <= 3), across all sessions. Positive tags on strong answers drop out.
materialization:
  type: table
depends:
  - raw.turns
custom_checks:
  - name: one row per candidate and tag
    query: SELECT count(*) - count(DISTINCT candidate_id || '#' || tag) FROM mart.tag_counts
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
  - name: count
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    candidate_id,
    tag,
    count(*)::INTEGER AS count
FROM (SELECT candidate_id, unnest(tags) AS tag FROM raw.turns WHERE score <= 3)
WHERE tag IS NOT NULL AND tag <> ''
GROUP BY candidate_id, tag
