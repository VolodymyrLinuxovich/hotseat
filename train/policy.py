"""Train the panel's question policy with reinforcement learning on simulated candidates.

Before each question the panel picks who asks (Maya, Theo or Sol), the topic and a
difficulty band. This script learns that choice with Q-learning over a linear function of hand-made
features (train/sim.py), then nudges it with the real sessions in data/turns.jsonl.

Why Q-learning and not REINFORCE: an episode is only four free decisions, and a Q value
gives the engine a number it can show next to the suggestion. The Q-learning is done in
batches (fitted Q-iteration): play a round of episodes, then solve a small ridge regression
of Q(s, a) on reward + max Q(s', a'). Plain online updates and Monte Carlo targets were
tried first and stayed below a one-step greedy baseline, because the return still to come
swamps the small differences between actions. The batch fit plus a few state-only features
that soak up that return fixed it, and every refit is deterministic for a given seed.

Reward per question: drop in total posterior variance over the seven topic skills, plus a
coaching bonus the first time a remembered weak topic is probed, minus penalties for
repeating a topic or letting the same interviewer ask twice in a row.

Usage:
    python3 train/policy.py           train from scratch, evaluate, plot, export
    python3 train/policy.py --quick   short fine-tune from the current weights, export
"""

import argparse
import json
import math
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import sim  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
TURNS = ROOT / "data" / "turns.jsonl"
MODEL_OUT = ROOT / "engine" / "policy-model.json"
PARITY_OUT = ROOT / "train" / "data" / "policy_parity.json"
METRICS_OUT = ROOT / "train" / "data" / "policy_metrics.json"
PLOT_OUT = ROOT / "docs" / "policy-learning.png"

SEED = 7
# Episodes per round. The first rounds are small so the learning curve shows the early
# climb; after that the policy is refit every 1,000 episodes.
SCHEDULE = [50, 100, 150, 200, 500] + [1_000] * 29
EPISODES = sum(SCHEDULE)
REPLAY_ROUNDS = 4
RIDGE = 1.0
REAL_RIDGE = 200.0
QUICK_RIDGE = 500.0
VALIDATION = 300
HELD_OUT = 2_000
QUICK_EPISODES = 1_500

# Looser topic names the panel's model tends to write, folded onto the seven topics.
# Same table as TOPIC_HINTS in engine/policy.js.
TOPIC_HINTS = [
    ("ownership", ["owner", "impact", "leadership"]),
    ("metrics", ["metric", "numbers", "measure", "results"]),
    ("tradeoffs", ["tradeoff", "trade_off"]),
    ("system_design", ["design", "architecture", "scal"]),
    ("conflict", ["conflict", "disagree", "teamwork", "collaboration"]),
    ("debugging", ["debug", "incident", "outage", "bug"]),
    ("coding", ["coding", "code", "algorithm"]),
]


def canonical_topic(topic):
    key = "".join(c if c.isalnum() else "_" for c in str(topic or "").lower()).strip("_")
    if key in sim.TOPICS:
        return key
    for name, hints in TOPIC_HINTS:
        if any(h in key for h in hints):
            return name
    return None


# ---------- choosers ----------


def q_values(weights, feats):
    return feats @ weights


def greedy(weights):
    def choose(state, feats, rng):
        return int(np.argmax(q_values(weights, feats)))

    return choose


def epsilon_greedy(weights, epsilon):
    def choose(state, feats, rng):
        if rng.random() < epsilon:
            return int(rng.integers(len(sim.ACTIONS)))
        return int(np.argmax(q_values(weights, feats)))

    return choose


def random_policy(state, feats, rng):
    return int(rng.integers(len(sim.ACTIONS)))


# Fixed rotation, the panel's habit before the policy: manager, skeptic, tech, and so on,
# each on their own first uncovered topic, always at medium difficulty.
ROTATION = ["manager", "skeptic", "tech"]
HOME_TOPICS = {
    "manager": ["ownership", "conflict", "metrics"],
    "skeptic": ["metrics", "ownership", "tradeoffs"],
    "tech": ["system_design", "tradeoffs", "debugging"],
}


def rotation_policy(state, feats, rng):
    asker = ROTATION[(state["question"] - 1) % len(ROTATION)]
    topics = HOME_TOPICS[asker]
    topic = next((t for t in topics if t not in state["covered"]), topics[0])
    return sim.ACTIONS.index((asker, topic, 1))


# Myopic baseline: always the action with the biggest one-step expected variance drop.
def greedy_gain_policy(state, feats, rng):
    return int(np.argmax(feats[:, sim.FEATURES.index("expected_gain")]))


# ---------- episodes ----------


def run_episode(candidate, choose, prior, rng, learner=None):
    """Play one five-question interview. learner(prev_feats, reward, next_feats) is called on
    every decision-to-decision transition, with next_feats None at the end."""
    history = []
    total = 0.0
    info = 0.0
    bonus = 0
    pending = None
    reward_since = 0.0

    for question in range(1, sim.MAX_QUESTIONS + 1):
        state = sim.build_state(history, candidate["weak"], *prior)

        if question == sim.CODING_ROUND:
            # Theo always runs the coding round, at the difficulty the core recommends.
            asker = "tech"
            topic = "coding"
            difficulty = sim.core_ability([(t["difficulty"], t["score"]) for t in history])[2]
        else:
            feats = sim.action_features(state)
            if pending is not None and learner is not None:
                learner(pending, reward_since, feats)
            index = choose(state, feats, rng)
            asker, topic, band = sim.ACTIONS[index]
            difficulty = sim.BAND_DIFFICULTY[band]
            pending = feats[index]
            reward_since = 0.0

        skill = candidate["skills"][sim.TOPICS.index(topic)]
        score = sim.answer_score(rng, skill, asker, topic, difficulty)
        gain = sim.update_belief(state["belief"], topic, asker, difficulty, score)
        reward = sim.step_reward(gain, state, asker, topic)
        if topic in state["weak"] and topic not in state["covered"]:
            bonus += 1

        total += reward
        info += gain
        reward_since += reward
        history.append({"asker": asker, "topic": topic, "difficulty": difficulty, "score": score})

    if learner is not None and pending is not None:
        learner(pending, reward_since, None)

    final = sim.build_state(history, candidate["weak"], *prior)
    error = final["belief"]["mean"] - candidate["skills"]
    return {"return": total, "info": info, "bonus": bonus, "sq_error": float(np.mean(error**2)), "history": history}


def candidates(seed, n):
    rng = np.random.default_rng(seed)
    return [sim.sample_candidate(rng) for _ in range(n)]


def evaluate(choose, pool, prior, seed):
    """Average return and skill error over a fixed pool. Every policy sees the same candidates
    and the same per-candidate random stream, so differences come from the choices."""
    returns = []
    infos = []
    errors = []
    probed = []
    for i, candidate in enumerate(pool):
        rng = np.random.default_rng([seed, i])
        result = run_episode(candidate, choose, prior, rng)
        returns.append(result["return"])
        infos.append(result["info"])
        errors.append(result["sq_error"])
        if candidate["weak"]:
            probed.append(1.0 if result["bonus"] > 0 else 0.0)
    return {
        "avg_return": round(float(np.mean(returns)), 4),
        "return_se": round(float(np.std(returns) / math.sqrt(len(returns))), 4),
        "avg_info_gain": round(float(np.mean(infos)), 4),
        "skill_rmse": round(math.sqrt(float(np.mean(errors))), 4),
        "weak_topic_probed": round(float(np.mean(probed)), 4) if probed else None,
    }


def collect(weights, prior, episodes, epsilon, rng):
    """Play episodes with an epsilon-greedy policy and keep every decision transition."""
    feats = []
    rewards = []
    nexts = []
    done = []
    returns = []
    blank = np.zeros((len(sim.ACTIONS), len(sim.FEATURES)), dtype=np.float32)

    def keep(f, reward, next_feats):
        feats.append(f)
        rewards.append(reward)
        done.append(next_feats is None)
        # float32 keeps a round of next-state matrices to a few dozen megabytes.
        nexts.append(blank if next_feats is None else next_feats.astype(np.float32))

    choose = epsilon_greedy(weights, epsilon)
    for _ in range(episodes):
        candidate = sim.sample_candidate(rng)
        returns.append(run_episode(candidate, choose, prior, rng, keep)["return"])

    batch = (np.array(feats), np.array(rewards), np.array(nexts), np.array(done))
    return batch, float(np.mean(returns))


def fit(weights, batches, anchor, ridge, iters=6):
    """Fitted Q-iteration: regress Q(s, a) on reward + max Q(s', a'), a few times over.

    The ridge term pulls toward anchor. From scratch the anchor is zero and the pull is
    light. For fine-tuning, the anchor is the current model, so a small batch can only move it
    a little.
    """
    x = np.concatenate([b[0] for b in batches])
    r = np.concatenate([b[1] for b in batches])
    nxt = np.concatenate([b[2] for b in batches])
    done = np.concatenate([b[3] for b in batches])

    gram = x.T @ x + ridge * np.eye(len(sim.FEATURES))
    for _ in range(iters):
        future = np.max(nxt @ weights, axis=1)
        future[done] = 0.0
        # No discount: the interview is five questions and every one counts the same.
        target = r + future
        weights[:] = np.linalg.solve(gram, x.T @ target + ridge * anchor)
    return weights


def train(weights, prior, schedule, seed, eps_start, eps_end, ridge, anchor=None, curve=None, val=None):
    """Rounds of: play a round of episodes (sizes in schedule) with the current policy, then
    refit on the last few rounds of data. Exploration decays from eps_start to eps_end."""
    rng = np.random.default_rng(seed)
    if anchor is None:
        anchor = np.zeros(len(sim.FEATURES))
    batches = []

    if curve is not None:
        point = evaluate(greedy(weights), val, prior, seed + 1)
        point["episode"] = 0
        curve.append(point)

    played_so_far = 0
    for round_index, episodes in enumerate(schedule):
        frac = round_index / max(1, len(schedule) - 1)
        epsilon = eps_start + (eps_end - eps_start) * frac

        batch, played = collect(weights, prior, episodes, epsilon, rng)
        played_so_far += episodes
        batches = (batches + [batch])[-REPLAY_ROUNDS:]
        fit(weights, batches, anchor, ridge)

        if curve is not None:
            point = evaluate(greedy(weights), val, prior, seed + 1)
            point["episode"] = played_so_far
            point["train_return"] = round(played, 4)
            curve.append(point)
            print(f"  episode {point['episode']}: return {point['avg_return']:.3f}, rmse {point['skill_rmse']:.3f}")
    return weights


# ---------- real sessions ----------


def real_sessions():
    """Logged turns grouped by session, in order. Turns logged before the difficulty field
    existed get the medium band, which is what the panel picked most often anyway."""
    if not TURNS.exists():
        return []
    sessions = {}
    for line in TURNS.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        sessions.setdefault(row.get("session_id"), []).append(row)

    out = []
    for rows in sessions.values():
        rows.sort(key=lambda r: r.get("turn") or 0)
        turns = []
        for r in rows:
            difficulty = r.get("difficulty")
            turns.append(
                {
                    "asker": r.get("asker"),
                    "topic": canonical_topic(r.get("topic")),
                    "difficulty": float(difficulty) if isinstance(difficulty, (int, float)) else 3.0,
                    "score": float(r["score"]) if isinstance(r.get("score"), (int, float)) else None,
                    "logged_difficulty": isinstance(difficulty, (int, float)),
                }
            )
        out.append(turns)
    return out


def band_of(difficulty):
    if difficulty <= 2:
        return 0
    if difficulty >= 4:
        return 2
    return 1


def real_transitions(prior):
    """Replay each real session through the belief and turn it into Q-learning transitions.

    Only turns whose asker and topic land in the action space count as decisions. Rewards
    from the other turns (coding, motivation) are added to the decision before them, like
    the forced coding round in the simulator. No memory profile is used, because the
    profile on disk was built from these same sessions.
    """
    transitions = []
    for turns in real_sessions():
        steps = []
        history = []
        for turn in turns:
            state = sim.build_state(history, [], *prior)
            reward = 0.0
            if turn["topic"] is not None and turn["score"] is not None:
                belief = state["belief"]
                gain = sim.update_belief(belief, turn["topic"], turn["asker"], turn["difficulty"], turn["score"])
                reward = sim.step_reward(gain, state, turn["asker"], turn["topic"])

            decision = turn["asker"] in sim.ASKERS and turn["topic"] in sim.FREE_TOPICS
            if decision:
                action = sim.ACTIONS.index((turn["asker"], turn["topic"], band_of(turn["difficulty"])))
                steps.append({"feats": sim.action_features(state), "action": action, "reward": reward})
            elif steps:
                steps[-1]["reward"] += reward
            history.append(turn)

        for i, step in enumerate(steps):
            nxt = steps[i + 1]["feats"] if i + 1 < len(steps) else None
            transitions.append({"feats": step["feats"][step["action"]], "reward": step["reward"], "next": nxt})
    return transitions


def td_error(weights, transitions):
    if not transitions:
        return None
    errors = []
    for t in transitions:
        target = t["reward"]
        if t["next"] is not None:
            target += float(np.max(t["next"] @ weights))
        errors.append((target - float(t["feats"] @ weights)) ** 2)
    return math.sqrt(float(np.mean(errors)))


def learn_from_real(weights, prior, ridge=REAL_RIDGE):
    """Fitted Q-iteration on the real transitions, anchored to the current weights.

    The anchor is strong on purpose: a couple dozen transitions from a handful of sessions
    should nudge what thousands of simulated interviews taught, not replace it.
    """
    transitions = real_transitions(prior)
    before = td_error(weights, transitions)
    start = weights.copy()
    if transitions:
        blank = np.zeros((len(sim.ACTIONS), len(sim.FEATURES)))
        batch = (
            np.array([t["feats"] for t in transitions]),
            np.array([t["reward"] for t in transitions]),
            np.array([blank if t["next"] is None else t["next"] for t in transitions]),
            np.array([t["next"] is None for t in transitions]),
        )
        fit(weights, [batch], start, ridge)
    after = td_error(weights, transitions)

    sessions = real_sessions()
    return {
        "sessions": len(sessions),
        "turns": sum(len(s) for s in sessions),
        "turns_with_difficulty": sum(1 for s in sessions for t in s if t["logged_difficulty"]),
        "transitions": len(transitions),
        "td_rmse_before": None if before is None else round(before, 4),
        "td_rmse_after": None if after is None else round(after, 4),
        "weight_change": round(float(np.linalg.norm(weights - start)), 4),
    }


# ---------- export ----------


def export(weights, prior, meta):
    model = {
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "topics": sim.TOPICS,
        "free_topics": sim.FREE_TOPICS,
        "askers": sim.ASKERS,
        "bands": sim.BANDS,
        "band_difficulty": sim.BAND_DIFFICULTY,
        "affinity": sim.AFFINITY,
        "slope": sim.SLOPE,
        "prior_mean": [float(x) for x in prior[0]],
        "prior_cov": [[float(x) for x in row] for row in prior[1]],
        "features": sim.FEATURES,
        "weights": [float(x) for x in weights],
        "reward": {
            "coaching_bonus": sim.COACHING_BONUS,
            "repeat_topic_penalty": sim.REPEAT_TOPIC_PENALTY,
            "repeat_asker_penalty": sim.REPEAT_ASKER_PENALTY,
        },
        "meta": meta,
    }
    tmp = MODEL_OUT.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(model, indent=1) + "\n")
    tmp.replace(MODEL_OUT)


def suggest(weights, state):
    feats = sim.action_features(state)
    values = q_values(weights, feats)
    best = int(np.argmax(values))
    return feats, values, best


def write_parity(weights, prior):
    """Saved states and the Python policy's outputs, for tests/policy.test.js."""
    rng = np.random.default_rng(99)
    cases = []

    # Simulated interviews cut at every decision point, some with remembered weak topics.
    for i in range(4):
        candidate = sim.sample_candidate(rng)
        weak = candidate["weak"] or (["metrics", "ownership"] if i % 2 else [])
        result = run_episode(candidate, greedy(weights), prior, np.random.default_rng([5, i]))
        for cut in [0, 1, 3, 4]:
            cases.append({"history": result["history"][:cut], "weak": weak})

    # The start of real sessions from the log, after topic folding and the default difficulty.
    for turns in real_sessions()[:2]:
        history = [{k: t[k] for k in ("asker", "topic", "difficulty", "score")} for t in turns[:2]]
        cases.append({"history": history, "weak": []})

    # An unmapped topic and an unscored turn must be skipped the same way on both sides.
    cases.append(
        {
            "history": [
                {"asker": "manager", "topic": None, "difficulty": 3, "score": 2},
                {"asker": "skeptic", "topic": "metrics", "difficulty": 4, "score": None},
            ],
            "weak": ["conflict"],
        }
    )

    out = []
    for case in cases:
        state = sim.build_state(case["history"], case["weak"], *prior)
        feats, values, best = suggest(weights, state)
        out.append(
            {
                "history": case["history"],
                "weak": case["weak"],
                "theta": state["theta"],
                "se": state["se"],
                "mean": [float(x) for x in state["belief"]["mean"]],
                "features": [[float(x) for x in row] for row in feats],
                "values": [float(x) for x in values],
                "best": best,
            }
        )

    topics = [
        "leadership",
        "Metrics",
        "trade-offs",
        "System Design",
        "teamwork",
        "incident_review",
        "live coding",
        "motivation",
        "",
    ]
    payload = {"cases": out, "topics": [[t, canonical_topic(t)] for t in topics]}
    PARITY_OUT.write_text(json.dumps(payload) + "\n")


def plot(curve, baselines):
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    bg = "#0d1117"
    amber = "#e8a33d"
    grey = "#8b949e"
    text = "#c9d1d9"

    # Log scale, since most of the learning happens in the first thousand episodes. The
    # untrained start (episode 0) is left off the axis; it is in the metrics file.
    curve = [p for p in curve if p["episode"] > 0]
    episodes = [p["episode"] for p in curve]
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.2), facecolor=bg)
    panels = [
        ("avg_return", "Average return (higher is better)"),
        ("skill_rmse", "Skill estimate RMSE (lower is better)"),
    ]
    for ax, (key, title) in zip(axes, panels):
        ax.set_facecolor(bg)
        values = [p[key] for p in curve]
        ax.plot(episodes, values, color=amber, linewidth=2.2, marker="o", markersize=3, label="trained")
        ax.axhline(baselines["random"][key], color=grey, linestyle="--", linewidth=1.4, label="random")
        ax.axhline(baselines["rotation"][key], color=grey, linestyle=":", linewidth=1.8, label="rotation")
        ax.set_title(title, color=text, fontsize=12)
        ax.set_xscale("log")
        ax.set_xlabel("training episodes (log scale)", color=text, fontsize=10)
        ax.tick_params(colors=text, labelsize=9)
        for spine in ax.spines.values():
            spine.set_color("#30363d")
        ax.grid(color="#21262d", linewidth=0.8)
        ax.legend(facecolor=bg, edgecolor="#30363d", labelcolor=text, fontsize=9)

    fig.suptitle("Hotseat question policy, fitted Q-learning on simulated candidates", color=text, fontsize=13)
    fig.tight_layout()
    PLOT_OUT.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(PLOT_OUT, dpi=140, facecolor=bg)
    plt.close(fig)


def load_model():
    model = json.loads(MODEL_OUT.read_text())
    weights = np.array(model["weights"], dtype=float)
    prior = (np.array(model["prior_mean"]), np.array(model["prior_cov"]))
    return model, weights, prior


def full():
    started = time.time()
    print("estimating the population prior...")
    prior = sim.population_prior(n=50_000)

    val = candidates(SEED + 100, VALIDATION)
    held = candidates(2027, HELD_OUT)

    print("baselines on the validation pool...")
    val_baselines = {
        "random": evaluate(random_policy, val, prior, SEED + 1),
        "rotation": evaluate(rotation_policy, val, prior, SEED + 1),
    }

    print(f"training {EPISODES} episodes...")
    weights = np.zeros(len(sim.FEATURES))
    curve = []
    train(weights, prior, SCHEDULE, SEED, 0.3, 0.05, RIDGE, curve=curve, val=val)

    print(f"evaluating on {HELD_OUT} held-out candidates...")
    sim_only = evaluate(greedy(weights), held, prior, 4242)
    real = learn_from_real(weights, prior)
    results = {
        "trained": evaluate(greedy(weights), held, prior, 4242),
        "trained_sim_only": sim_only,
        "random": evaluate(random_policy, held, prior, 4242),
        "rotation": evaluate(rotation_policy, held, prior, 4242),
        "greedy_one_step_gain": evaluate(greedy_gain_policy, held, prior, 4242),
    }

    # Reference point: the error with no questions at all, just the population average.
    skills = np.array([c["skills"] for c in held])
    prior_rmse = round(math.sqrt(float(np.mean((skills - prior[0]) ** 2))), 4)

    plot(curve, val_baselines)
    seconds = round(time.time() - started, 1)
    meta = {"episodes": EPISODES, "seed": SEED, "real": real, "quick_runs": 0}
    export(weights, prior, meta)
    write_parity(weights, prior)

    metrics = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "algorithm": "fitted Q-iteration (batch Q-learning), linear features, epsilon-greedy rounds, no discount",
        "episodes": EPISODES,
        "seed": SEED,
        "held_out_candidates": HELD_OUT,
        "train_seconds": seconds,
        "held_out": results,
        "prior_only_rmse": prior_rmse,
        "real_sessions": real,
        "learning_curve": curve,
        "weights": dict(zip(sim.FEATURES, [round(float(w), 4) for w in weights])),
    }
    METRICS_OUT.write_text(json.dumps(metrics, indent=1) + "\n")

    print(json.dumps(results, indent=1))
    print(json.dumps(real, indent=1))
    print(f"done in {seconds}s")


def quick():
    """Short fine-tune from the exported weights, then the real-session update. Under 3 s."""
    started = time.time()
    model, weights, prior = load_model()
    meta = model.get("meta", {})
    runs = int(meta.get("quick_runs", 0)) + 1

    train(weights, prior, [QUICK_EPISODES], SEED + runs, 0.1, 0.1, QUICK_RIDGE, anchor=weights.copy())
    real = learn_from_real(weights, prior)

    meta.update({"real": real, "quick_runs": runs})
    export(weights, prior, meta)
    write_parity(weights, prior)

    if METRICS_OUT.exists():
        metrics = json.loads(METRICS_OUT.read_text())
        metrics["last_quick"] = {
            "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "seconds": round(time.time() - started, 2),
            "sim_episodes": QUICK_EPISODES,
            "real_sessions": real,
        }
        METRICS_OUT.write_text(json.dumps(metrics, indent=1) + "\n")
    print(f"policy fine-tuned in {time.time() - started:.1f}s ({real['transitions']} real transitions)")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--quick", action="store_true", help="short fine-tune from the current weights")
    args = parser.parse_args()

    if not args.quick:
        full()
    elif MODEL_OUT.exists():
        quick()
    else:
        # The quick step runs inside the Bruin pipeline, which must stay fast. A full
        # training run is a deliberate, separate step.
        print("no policy model yet; run train/policy.py without --quick first")


if __name__ == "__main__":
    main()
