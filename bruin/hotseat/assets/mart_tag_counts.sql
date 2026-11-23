/* @bruin
name: mart.tag_counts
type: duckdb.sql
description: How often each tag was applied to a weak answer (score <= 3), across all sessions. Positive tags on strong answers drop out.
materialization:
  type: table
depends:
  - raw.turns
columns:
  - name: tag
    type: varchar
    checks:
      - name: not_null
      - name: unique
  - name: count
    type: integer
    checks:
      - name: positive
@bruin */

SELECT
    tag,
    count(*)::INTEGER AS count
FROM (SELECT unnest(tags) AS tag FROM raw.turns WHERE score <= 3)
WHERE tag IS NOT NULL AND tag <> ''
GROUP BY tag
