/* @bruin
name: mart.profile
type: duckdb.sql
description: |
  The weakness profile the interview agents read before a candidate's next session.
  One row per candidate. The focus sentence is a deterministic template built from the top weak topic and tag.
materialization:
  type: table
depends:
  - raw.turns
  - raw.sessions
  - mart.topic_stats
  - mart.tag_counts
  - mart.session_trend
  - mart.habit_progress
  - mart.topic_progress
custom_checks:
  - name: one profile row per candidate
    query: SELECT count(*) - count(DISTINCT candidate_id) FROM mart.profile
    value: 0
  - name: every candidate with turns has a profile
    query: SELECT count(*) FROM (SELECT DISTINCT candidate_id FROM raw.turns) t ANTI JOIN mart.profile p USING (candidate_id)
    value: 0
  - name: habits and topic deltas are lists, never null
    query: SELECT count(*) FROM mart.profile WHERE habits IS NULL OR topic_deltas IS NULL
    value: 0
columns:
  - name: candidate_id
    type: varchar
    checks:
      - name: not_null
@bruin */

WITH
cands AS (
    SELECT candidate_id FROM raw.turns
    UNION
    SELECT candidate_id FROM raw.sessions
),
weak AS (
    SELECT *, row_number() OVER (PARTITION BY candidate_id ORDER BY avg_score ASC, n DESC, topic) AS rn
    FROM mart.topic_stats WHERE avg_score < 3
),
strong AS (
    SELECT *, row_number() OVER (PARTITION BY candidate_id ORDER BY avg_score DESC, n DESC, topic) AS rn
    FROM mart.topic_stats WHERE avg_score >= 4
),
tags AS (
    SELECT *, row_number() OVER (PARTITION BY candidate_id ORDER BY count DESC, tag) AS rn
    FROM mart.tag_counts
),
top_weak AS (SELECT candidate_id, topic, avg_score, n FROM weak WHERE rn = 1),
-- Prefer the tag that shows up most on the candidate's weakest topic, so the focus line is coherent.
topic_tag AS (
    SELECT t.candidate_id, t.tag, count(*)::INTEGER AS count
    FROM (SELECT candidate_id, topic, unnest(tags) AS tag FROM raw.turns WHERE score <= 3) t
    JOIN top_weak w ON w.candidate_id = t.candidate_id AND w.topic = t.topic
    WHERE t.tag IS NOT NULL AND t.tag <> ''
    GROUP BY t.candidate_id, t.tag
),
top_tag AS (
    SELECT candidate_id, tag, count FROM (
        SELECT candidate_id, tag, count, 0 AS pri FROM topic_tag
        UNION ALL
        SELECT candidate_id, tag, count, 1 AS pri FROM tags
    )
    QUALIFY row_number() OVER (PARTITION BY candidate_id ORDER BY pri, count DESC, tag) = 1
),
base AS (
    SELECT
        c.candidate_id,
        w.topic AS w_topic, w.avg_score AS w_avg, w.n AS w_n,
        tt.tag AS t_tag, tt.count AS t_count,
        CASE tt.tag
            WHEN 'no_numbers' THEN 'press for quantified impact with concrete numbers'
            WHEN 'vague' THEN 'press for one specific example with names, dates and outcomes'
            WHEN 'deflects' THEN 'press on what they personally owned and got wrong'
            WHEN 'shallow' THEN 'push one level deeper into root causes and tradeoffs'
            WHEN 'rambling' THEN 'ask for the answer in two sentences first'
            WHEN 'no_tradeoffs' THEN 'ask what they gave up and why'
            WHEN 'incomplete_code' THEN 'give a coding warmup and ask them to test edge cases out loud'
            WHEN 'we_not_i' THEN 'ask what they personally did, not the team'
            ELSE 'press for concrete specifics'
        END AS hint
    FROM cands c
    LEFT JOIN top_weak w ON w.candidate_id = c.candidate_id
    LEFT JOIN top_tag tt ON tt.candidate_id = c.candidate_id
)
SELECT
    b.candidate_id,
    (SELECT count(*) FROM raw.sessions s WHERE s.candidate_id = b.candidate_id)::INTEGER AS sessions,
    (SELECT count(*) FROM raw.turns t WHERE t.candidate_id = b.candidate_id)::INTEGER AS turns,
    coalesce((SELECT list({'topic': topic, 'avg_score': avg_score, 'n': n} ORDER BY rn) FROM weak x WHERE x.candidate_id = b.candidate_id AND rn <= 3), []) AS weak_topics,
    coalesce((SELECT list({'tag': tag, 'count': count} ORDER BY rn) FROM tags x WHERE x.candidate_id = b.candidate_id AND rn <= 3), []) AS weak_tags,
    coalesce((SELECT list({'topic': topic, 'avg_score': avg_score, 'n': n} ORDER BY rn) FROM strong x WHERE x.candidate_id = b.candidate_id AND rn <= 3), []) AS strong_topics,
    coalesce((SELECT list({'session_id': session_id, 'overall': overall, 'verdict': verdict} ORDER BY ts) FROM mart.session_trend x WHERE x.candidate_id = b.candidate_id), []) AS trend,
    CASE
        WHEN b.w_topic IS NOT NULL AND b.t_tag IS NOT NULL THEN
            'Candidate is weakest on ' || replace(b.w_topic, '_', ' ')
            || ' questions (avg ' || printf('%.1f', b.w_avg) || '/5 over '
            || b.w_n || ' answers), and those answers keep getting tagged '
            || replace(b.t_tag, '_', ' ') || ' (' || b.t_count || 'x); ' || b.hint || '.'
        WHEN b.w_topic IS NOT NULL THEN
            'Candidate is weakest on ' || replace(b.w_topic, '_', ' ')
            || ' questions (avg ' || printf('%.1f', b.w_avg) || '/5); dig into that topic early.'
        WHEN b.t_tag IS NOT NULL THEN
            'No topic averages below 3, but answers keep getting tagged '
            || replace(b.t_tag, '_', ' ') || '; ' || b.hint || '.'
        ELSE 'No weak spots yet; run a balanced interview and raise the difficulty.'
    END AS focus,
    -- Habit changes since the earlier sessions. Repeating habits come first because the panel should press on
    -- them; fixed ones next so the panel can say so out loud. Capped so the prompt stays short.
    coalesce((
        SELECT list({'tag': tag, 'status': status, 'before': before, 'latest': latest} ORDER BY pri, latest + before DESC, tag)
        FROM (
            SELECT *, CASE status WHEN 'repeating' THEN 0 WHEN 'fixed' THEN 1 ELSE 2 END AS pri
            FROM mart.habit_progress h
            WHERE h.candidate_id = b.candidate_id
            ORDER BY pri, latest + before DESC, tag
            LIMIT 8
        )
    ), []) AS habits,

    -- Biggest score moves first, so the top of the list is what changed most.
    coalesce((
        SELECT list({'topic': topic, 'status': status, 'before': before_avg, 'latest': latest_avg, 'delta': delta} ORDER BY abs(delta) DESC, topic)
        FROM mart.topic_progress p
        WHERE p.candidate_id = b.candidate_id
    ), []) AS topic_deltas,

    strftime(now() AT TIME ZONE 'UTC', '%Y-%m-%dT%H:%M:%SZ') AS generated_at
FROM base b
