/* @bruin
name: mart.profile
type: duckdb.sql
description: |
  The candidate weakness profile the interview agents read before the next session.
  One row. The focus sentence is a deterministic template built from the top weak topic and tag.
materialization:
  type: table
depends:
  - raw.turns
  - raw.sessions
  - mart.topic_stats
  - mart.tag_counts
  - mart.session_trend
custom_checks:
  - name: profile has exactly one row
    query: SELECT count(*) FROM mart.profile
    value: 1
@bruin */

WITH
weak AS (
    SELECT topic, avg_score, n FROM mart.topic_stats
    WHERE avg_score < 3 ORDER BY avg_score ASC, n DESC, topic LIMIT 3
),
strong AS (
    SELECT topic, avg_score, n FROM mart.topic_stats
    WHERE avg_score >= 4 ORDER BY avg_score DESC, n DESC, topic LIMIT 3
),
tags AS (
    SELECT tag, count FROM mart.tag_counts
    ORDER BY count DESC, tag LIMIT 3
),
top_weak AS (SELECT * FROM weak ORDER BY avg_score ASC, n DESC, topic LIMIT 1),
-- Prefer the tag that shows up most on the weakest topic, so the focus line is coherent.
topic_tag AS (
    SELECT tag, count(*)::INTEGER AS count
    FROM (SELECT unnest(tags) AS tag FROM raw.turns
          WHERE score <= 3 AND topic = (SELECT topic FROM top_weak))
    WHERE tag IS NOT NULL AND tag <> ''
    GROUP BY tag
),
top_tag AS (
    SELECT tag, count FROM (
        SELECT tag, count, 0 AS pri FROM topic_tag
        UNION ALL
        SELECT tag, count, 1 AS pri FROM tags
    ) ORDER BY pri, count DESC, tag LIMIT 1
),
hint AS (
    SELECT CASE (SELECT tag FROM top_tag)
        WHEN 'no_numbers' THEN 'press for quantified impact with concrete numbers'
        WHEN 'vague' THEN 'press for one specific example with names, dates and outcomes'
        WHEN 'deflects' THEN 'press on what they personally owned and got wrong'
        WHEN 'shallow' THEN 'push one level deeper into root causes and tradeoffs'
        WHEN 'rambling' THEN 'ask for the answer in two sentences first'
        WHEN 'no_tradeoffs' THEN 'ask what they gave up and why'
        ELSE 'press for concrete specifics'
    END AS h
)
SELECT
    (SELECT count(*) FROM raw.sessions)::INTEGER AS sessions,
    (SELECT count(*) FROM raw.turns)::INTEGER AS turns,
    coalesce((SELECT list({'topic': topic, 'avg_score': avg_score, 'n': n} ORDER BY avg_score ASC, n DESC, topic) FROM weak), []) AS weak_topics,
    coalesce((SELECT list({'tag': tag, 'count': count} ORDER BY count DESC, tag) FROM tags), []) AS weak_tags,
    coalesce((SELECT list({'topic': topic, 'avg_score': avg_score, 'n': n} ORDER BY avg_score DESC, n DESC, topic) FROM strong), []) AS strong_topics,
    coalesce((SELECT list({'session_id': session_id, 'overall': overall, 'verdict': verdict} ORDER BY ts) FROM mart.session_trend), []) AS trend,
    CASE
        WHEN (SELECT count(*) FROM top_weak) = 1 AND (SELECT count(*) FROM top_tag) = 1 THEN
            'Candidate is weakest on ' || replace((SELECT topic FROM top_weak), '_', ' ')
            || ' questions (avg ' || printf('%.1f', (SELECT avg_score FROM top_weak)) || '/5 over '
            || (SELECT n FROM top_weak) || ' answers), and those answers keep getting tagged '
            || replace((SELECT tag FROM top_tag), '_', ' ') || ' (' || (SELECT count FROM top_tag)
            || 'x); ' || (SELECT h FROM hint) || '.'
        WHEN (SELECT count(*) FROM top_weak) = 1 THEN
            'Candidate is weakest on ' || replace((SELECT topic FROM top_weak), '_', ' ')
            || ' questions (avg ' || printf('%.1f', (SELECT avg_score FROM top_weak)) || '/5); dig into that topic early.'
        WHEN (SELECT count(*) FROM top_tag) = 1 THEN
            'No topic averages below 3, but answers keep getting tagged '
            || replace((SELECT tag FROM top_tag), '_', ' ') || '; ' || (SELECT h FROM hint) || '.'
        ELSE 'No history yet; run a balanced first interview across all topics.'
    END AS focus,
    strftime(now() AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS generated_at
