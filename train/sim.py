"""Interview simulator for training the panel's question policy.

A synthetic candidate has a latent skill per topic on the same 1 to 5 scale the C++ core
uses for ability and difficulty. Answers are scored with the core's Rasch model:
the chance of a good answer is sigmoid(slope * discrimination * (skill - difficulty)), and
the 1 to 5 score is 1 plus the number of four rubric points earned.

The panel side keeps a Gaussian belief over all seven topic skills at once. Each scored
answer updates it with one Laplace step (the same likelihood as the core, per topic), so a
strong coding answer also moves the belief about system design a little, through the
correlations in the prior. engine/policy.js copies the belief update and the features
below line by line; tests/policy.test.js holds the two to the same numbers.
"""

import math

import numpy as np

TOPICS = ["ownership", "metrics", "tradeoffs", "system_design", "conflict", "debugging", "coding"]
ASKERS = ["manager", "tech", "skeptic"]
BANDS = ["low", "mid", "high"]
BAND_DIFFICULTY = [2, 3, 4]

# The policy picks among the six spoken topics. Coding only happens in the forced Q3 round.
FREE_TOPICS = TOPICS[:6]
CODING = TOPICS.index("coding")
CODING_ROUND = 3
MAX_QUESTIONS = 5

# Same constants as engine/core.js and native/hotseat_core.cpp.
PRIOR_MEAN = 3.0
PRIOR_VAR = 1.0
SLOPE = 1.5
TARGET_LOGIT = 0.4054651081081644

# How sharply each interviewer's questions separate strong from weak answers on a topic.
# Sol pins down numbers better than anyone, Theo owns the technical topics, Maya the
# people topics. Off-topic askers still learn something, just less.
AFFINITY = {
    "manager": {
        "ownership": 1.3,
        "metrics": 0.9,
        "tradeoffs": 0.7,
        "system_design": 0.6,
        "conflict": 1.3,
        "debugging": 0.7,
        "coding": 0.5,
    },
    "tech": {
        "ownership": 0.8,
        "metrics": 0.9,
        "tradeoffs": 1.3,
        "system_design": 1.3,
        "conflict": 0.7,
        "debugging": 1.3,
        "coding": 1.4,
    },
    "skeptic": {
        "ownership": 1.1,
        "metrics": 1.4,
        "tradeoffs": 1.0,
        "system_design": 0.9,
        "conflict": 0.8,
        "debugging": 1.0,
        "coding": 0.8,
    },
}

# Habits drag specific topics down. Probabilities are rough guesses from the real logs,
# where vague and no_numbers are by far the most common tags.
HABITS = {
    "no_numbers": {"p": 0.35, "hits": {"metrics": 0.9}},
    "vague": {"p": 0.30, "hits": {"ownership": 0.4, "conflict": 0.3, "metrics": 0.3}},
    "deflects": {"p": 0.15, "hits": {"ownership": 0.8, "conflict": 0.4}},
    "we_not_i": {"p": 0.20, "hits": {"ownership": 0.6}},
    "rambling": {"p": 0.15, "hits": {"system_design": 0.4, "tradeoffs": 0.3}},
    "shallow": {"p": 0.20, "hits": {"tradeoffs": 0.5, "debugging": 0.4}},
}

BEHAVIORAL = {"ownership", "metrics", "conflict"}

# Extra per-answer wobble on the logit scale: a good candidate still has a bad answer now
# and then. It makes the scores about as noisy as the single-trial likelihood the core
# assumes, so the belief's variances stay roughly honest.
ANSWER_NOISE = 1.0


def sigmoid(z):
    return 1.0 / (1.0 + math.exp(-z))


def affinity_matrix():
    return np.array([[AFFINITY[a][t] for t in TOPICS] for a in ASKERS])


# ---------- candidates ----------


def sample_candidate(rng):
    """One synthetic candidate: latent skills, habits and what past sessions remember."""
    general = rng.normal(3.0, 0.6)
    people = rng.normal(0.0, 0.4)
    technical = rng.normal(0.0, 0.4)

    skills = np.empty(len(TOPICS))
    for k, topic in enumerate(TOPICS):
        cluster = people if topic in BEHAVIORAL else technical
        skills[k] = general + cluster + rng.normal(0.0, 0.35)

    # About a third of candidates have one topic that is far below the rest.
    if rng.random() < 0.3:
        k = rng.integers(len(TOPICS))
        skills[k] -= rng.uniform(1.0, 2.0)

    habits = []
    for name, habit in HABITS.items():
        if rng.random() < habit["p"]:
            habits.append(name)
            for topic, drop in habit["hits"].items():
                skills[TOPICS.index(topic)] -= drop

    skills = np.clip(skills, 0.5, 5.5)
    return {"skills": skills, "habits": habits, "weak": remembered_weak(rng, skills)}


def remembered_weak(rng, skills):
    """Weak topics a Bruin profile would hold for this candidate, or none if they're new.

    Past sessions covered three or four free topics, each seen through a noisy average.
    Like mart.profile, a topic counts as weak below 3/5, which is about skill 2.6.
    """
    if rng.random() < 0.4:
        return []

    seen = rng.choice(len(FREE_TOPICS), size=rng.integers(3, 5), replace=False)
    noisy = {int(k): skills[k] + rng.normal(0.0, 0.5) for k in seen}
    weak = sorted((v, k) for k, v in noisy.items() if v < 2.6)
    return [TOPICS[k] for _, k in weak[:3]]


def population_prior(n=200_000, seed=12345):
    """Mean and covariance of topic skills over many candidates, the belief's starting point."""
    rng = np.random.default_rng(seed)
    draws = np.array([sample_candidate(rng)["skills"] for _ in range(n)])
    return draws.mean(axis=0), np.cov(draws, rowvar=False)


def answer_score(rng, skill, asker, topic, difficulty):
    a = AFFINITY[asker][topic]
    z = SLOPE * a * (skill - difficulty) + rng.normal(0.0, ANSWER_NOISE)
    p = sigmoid(z)
    return 1 + int(rng.binomial(4, p))


# ---------- belief over topic skills ----------


def new_belief(prior_mean, prior_cov):
    return {"mean": np.array(prior_mean, dtype=float), "cov": np.array(prior_cov, dtype=float)}


def update_belief(belief, topic, asker, difficulty, score):
    """One Laplace step for one scored answer. Returns the drop in total variance.

    The answer only touches topic k directly, so the mode is found along that one
    coordinate (Newton steps, like the core), and the rest of the mean and covariance follow
    through the prior correlations. This is the usual assumed-density filter.
    """
    k = TOPICS.index(topic)
    a = AFFINITY[asker][topic] if asker in AFFINITY else 1.0
    slope = SLOPE * a
    y = (min(5.0, max(1.0, score)) - 1.0) / 4.0
    d = min(5.0, max(1.0, difficulty))

    mean = belief["mean"]
    cov = belief["cov"]
    m_k = mean[k]
    v_k = cov[k, k]

    u = m_k
    for _ in range(20):
        p = sigmoid(slope * (u - d))
        grad = -(u - m_k) / v_k + slope * (y - p)
        hess = 1.0 / v_k + slope * slope * p * (1.0 - p)
        step = min(1.0, max(-1.0, grad / hess))
        u += step
        if abs(step) < 1e-10:
            break

    p = sigmoid(slope * (u - d))
    info = slope * slope * p * (1.0 - p)
    column = cov[:, k].copy()
    before = float(np.trace(cov))

    belief["mean"] = mean + column * ((u - m_k) / v_k)
    belief["cov"] = cov - np.outer(column, column) * (info / (1.0 + info * v_k))
    return before - float(np.trace(belief["cov"]))


def core_ability(pairs):
    """Python copy of the core's ability estimate (estimateAbility in engine/core.js)."""
    theta = PRIOR_MEAN
    for _ in range(50):
        grad = -(theta - PRIOR_MEAN) / PRIOR_VAR
        info = 1.0 / PRIOR_VAR
        for d, s in pairs:
            d = min(5.0, max(1.0, d))
            p = sigmoid(SLOPE * (theta - d))
            grad += SLOPE * ((min(5.0, max(1.0, s)) - 1.0) / 4.0 - p)
            info += SLOPE * SLOPE * p * (1.0 - p)
        step = min(1.0, max(-1.0, grad / info))
        theta += step
        if abs(step) < 1e-10:
            break

    info = 1.0 / PRIOR_VAR
    for d, s in pairs:
        p = sigmoid(SLOPE * (theta - min(5.0, max(1.0, d))))
        info += SLOPE * SLOPE * p * (1.0 - p)
    reported = min(5.0, max(1.0, theta))
    nxt = math.floor(reported - TARGET_LOGIT / SLOPE + 0.5)
    return reported, 1.0 / math.sqrt(info), int(min(5, max(1, nxt)))


# ---------- state and features ----------

# Every free action, in a fixed order the JS side shares: asker, then topic, then band.
ACTIONS = [(a, t, b) for a in ASKERS for t in FREE_TOPICS for b in range(len(BANDS))]

FEATURES = [
    "bias",
    "expected_gain",
    "expected_reward",
    "topic_variance",
    "topic_mean",
    "difficulty_gap_sq",
    "asker_affinity",
    "topic_covered",
    "topic_weak",
    "weak_not_covered",
    "same_asker",
    "asker_count",
    "late_gain",
    "theta_x_difficulty",
    "core_se",
    "band_low",
    "band_high",
    "questions_left",
    "total_variance",
    "left_x_variance",
    "weak_left",
    "coding_overlap",
    "tech_before_coding",
] + [f"topic_{t}" for t in FREE_TOPICS] + [f"asker_{a}" for a in ASKERS]


def build_state(history, weak, prior_mean, prior_cov):
    """Everything the policy looks at, from the answered turns so far and the memory profile.

    history items are dicts with asker, topic (one of TOPICS or None), difficulty, score.
    """
    belief = new_belief(prior_mean, prior_cov)
    pairs = []
    covered = set()
    counts = {a: 0 for a in ASKERS}
    for turn in history:
        if turn["topic"] in TOPICS and turn["score"] is not None:
            update_belief(belief, turn["topic"], turn["asker"], turn["difficulty"], turn["score"])
        if turn["score"] is not None:
            pairs.append((turn["difficulty"], turn["score"]))
        if turn["topic"] in TOPICS:
            covered.add(turn["topic"])
        if turn["asker"] in counts:
            counts[turn["asker"]] += 1

    theta, se, _ = core_ability(pairs)
    last = history[-1]["asker"] if history else None
    return {
        "belief": belief,
        "theta": theta,
        "se": se,
        "covered": covered,
        "weak": set(weak),
        "counts": counts,
        "last": last,
        "question": len(history) + 1,
    }


def action_features(state):
    """Feature matrix, one row per action in ACTIONS, columns in FEATURES order."""
    mean = state["belief"]["mean"]
    cov = state["belief"]["cov"]
    late = (state["question"] - 1) / (MAX_QUESTIONS - 1)

    # State-only columns. They don't change which action wins, but they soak up how much
    # return is still to come, so the action columns can fit the differences between actions.
    left = (MAX_QUESTIONS - state["question"]) / (MAX_QUESTIONS - 1)
    total = float(np.trace(cov))
    weak_left = len([t for t in state["weak"] if t not in state["covered"]])
    before_coding = 1.0 if state["question"] < CODING_ROUND else 0.0
    next_is_coding = 1.0 if state["question"] == CODING_ROUND - 1 else 0.0

    rows = []
    for asker, topic, band in ACTIONS:
        k = TOPICS.index(topic)
        a = AFFINITY[asker][topic]
        d = BAND_DIFFICULTY[band]
        v_k = cov[k, k]

        p = sigmoid(SLOPE * a * (mean[k] - d))
        info = SLOPE * SLOPE * a * a * p * (1.0 - p)
        spread = float(np.sum(cov[:, k] * cov[:, k]))
        gain = info * spread / (1.0 + info * v_k)

        covered = 1.0 if topic in state["covered"] else 0.0
        weak = 1.0 if topic in state["weak"] else 0.0
        same = 1.0 if asker == state["last"] else 0.0

        # The one-step reward this action should earn on average (see step_reward). The
        # learned weights add what happens over the rest of the interview on top of it.
        expected = gain + COACHING_BONUS * weak * (1.0 - covered)
        expected -= REPEAT_TOPIC_PENALTY * covered + REPEAT_ASKER_PENALTY * same

        row = [
            1.0,
            gain,
            expected,
            v_k,
            mean[k] - 3.0,
            (d - mean[k]) ** 2,
            a - 1.0,
            covered,
            weak,
            weak * (1.0 - covered),
            same,
            state["counts"][asker] / MAX_QUESTIONS,
            late * gain,
            (state["theta"] - 3.0) * (d - 3.0),
            state["se"],
            1.0 if band == 0 else 0.0,
            1.0 if band == 2 else 0.0,
            left,
            total,
            left * total,
            weak_left,
            # Share of this topic's uncertainty the coding round will clear up anyway.
            before_coding * cov[k, CODING] ** 2 / (cov[CODING, CODING] * v_k),
            # Theo runs the coding round, so asking him right before it repeats the asker.
            next_is_coding * (1.0 if asker == "tech" else 0.0),
        ]
        row += [1.0 if topic == t else 0.0 for t in FREE_TOPICS]
        row += [1.0 if asker == x else 0.0 for x in ASKERS]
        rows.append(row)
    return np.array(rows)


# ---------- reward ----------

COACHING_BONUS = 0.25
REPEAT_TOPIC_PENALTY = 0.3
REPEAT_ASKER_PENALTY = 0.1


def step_reward(gain, state, asker, topic):
    """Information gain, plus a bonus for probing a remembered weak topic, minus repetition."""
    reward = gain
    if topic in state["weak"] and topic not in state["covered"]:
        reward += COACHING_BONUS
    if topic in state["covered"]:
        reward -= REPEAT_TOPIC_PENALTY
    if asker == state["last"]:
        reward -= REPEAT_ASKER_PENALTY
    return reward
