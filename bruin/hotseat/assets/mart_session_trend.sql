/* @bruin
name: mart.session_trend
type: duckdb.sql
description: Verdict and overall score per session in time order.
materialization:
  type: table
depends:
  - raw.sessions
columns:
  - name: session_id
    type: varchar
    checks:
      - name: not_null
      - name: unique
@bruin */

SELECT session_id, ts, overall, verdict
FROM raw.sessions
ORDER BY ts
