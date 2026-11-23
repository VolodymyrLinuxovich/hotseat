/* @bruin
name: export.profile_json
type: duckdb.sql
description: Writes mart.profile to data/profile.json.tmp; run.sh atomically renames it to data/profile.json for the Node server.
depends:
  - mart.profile
@bruin */

COPY (SELECT * FROM mart.profile) TO 'data/profile.json.tmp' (FORMAT JSON);
