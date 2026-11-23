"""Train the answer critic: a small model that scores interview answers on its own.

The panel's score comes from one LLM call. The critic is a second opinion trained on
labeled answers (Claude-generated seed answers plus every answer logged in real sessions),
so the engine can flag turns where the two disagree.

Features: TF-IDF over word unigrams and bigrams, plus a few hand-made signals (numbers,
"I" versus "we", length, hedging, technical words, the coding judge's pass rate).
Models: ridge regression for the 1 to 5 score, one logistic regression per habit tag.

The fitted model is exported as plain JSON (engine/critic-model.json) so the Node server
can run it without Python. engine/critic.js reimplements the features and the math, and
train/data/parity.json holds predictions the JS test must reproduce.

Usage:
    python3 train/critic.py           train, evaluate, export, print metrics
    python3 train/critic.py --quick   retrain on everything and export, no evaluation
"""

import argparse
import json
import math
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from scipy.sparse import csr_matrix, hstack
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression, Ridge
from sklearn.model_selection import cross_val_predict, train_test_split
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "train" / "data" / "seed_answers.jsonl"
TURNS = ROOT / "data" / "turns.jsonl"
MODEL_OUT = ROOT / "engine" / "critic-model.json"
PARITY_OUT = ROOT / "train" / "data" / "parity.json"
METRICS_OUT = ROOT / "train" / "data" / "metrics.json"

TAGS = [
    "no_numbers",
    "vague",
    "we_not_i",
    "deflects",
    "rambling",
    "strong_example",
    "clear_tradeoffs",
    "incomplete_code",
]

# Same folding as TAG_SYNONYMS in engine/checks.js, so logged tags line up with seed tags.
TAG_SYNONYMS = {
    "lacks_metrics": "no_numbers",
    "no_metrics": "no_numbers",
    "partial_numbers": "no_numbers",
    "missing_numbers": "no_numbers",
    "missing_metrics": "no_numbers",
    "evasive": "deflects",
    "deflected_question": "deflects",
    "deflected": "deflects",
    "dodged": "deflects",
    "dodged_question": "deflects",
    "incomplete_solution": "incomplete_code",
    "unfinished_code": "incomplete_code",
    "we_instead_of_i": "we_not_i",
    "used_we": "we_not_i",
    "no_example": "vague",
    "generic": "vague",
    "generic_answer": "vague",
}

# Kept small on purpose: the exported JSON has to stay well under 300 KB.
MAX_VOCAB = 2000
RIDGE_ALPHA = 3.0
LOGISTIC_C = 2.0
MAX_TAGS = 3
SEED_SPLIT = 7

SINGULAR = {"i", "me", "my", "mine", "myself"}
PLURAL = {"we", "us", "our", "ours", "ourselves"}
HEDGES = {
    "maybe",
    "probably",
    "kind",
    "sort",
    "basically",
    "honestly",
    "guess",
    "somewhat",
    "pretty",
    "stuff",
    "things",
    "like",
    "just",
    "um",
    "uh",
    "lot",
}
TECH = {
    "api",
    "cache",
    "caching",
    "latency",
    "database",
    "db",
    "postgres",
    "redis",
    "queue",
    "shard",
    "sharding",
    "index",
    "query",
    "throughput",
    "p99",
    "p95",
    "ms",
    "memory",
    "cpu",
    "thread",
    "lock",
    "race",
    "deploy",
    "rollback",
    "kafka",
    "load",
    "replica",
    "schema",
    "test",
    "tests",
    "bug",
    "profiler",
    "benchmark",
    "consistency",
    "partition",
    "timeout",
    "retry",
    "batch",
    "pipeline",
    "algorithm",
    "complexity",
    "hash",
    "tradeoff",
}

HAND_FEATURES = [
    "has_digit",
    "numbers",
    "percents",
    "i_rate",
    "we_rate",
    "i_share",
    "log_words",
    "hedge_rate",
    "tech_rate",
    "question_marks",
    "judge_fail",
    "is_coding",
]

TOKEN_RE = re.compile(r"[a-z0-9]+")
NUMBER_RE = re.compile(r"[0-9]+(?:[.,][0-9]+)*")
JUDGE_RE = re.compile(r"([0-9]+)/([0-9]+) hidden tests")


# ---------- features (engine/critic.js mirrors every line of this section) ----------


def tokenize(text):
    return TOKEN_RE.findall(text.lower())


def analyze(text):
    """Unigrams then bigrams. A plain function, so the JS side can copy it exactly."""
    tokens = tokenize(text)
    grams = list(tokens)
    for a, b in zip(tokens, tokens[1:]):
        grams.append(a + " " + b)
    return grams


def hand_features(text):
    lower = text.lower()
    tokens = tokenize(text)
    n = len(tokens)
    # Rates divide by at least 1 so an empty answer gives zeros instead of NaN.
    per = max(n, 1)

    singular = sum(1 for t in tokens if t in SINGULAR)
    plural = sum(1 for t in tokens if t in PLURAL)
    if singular + plural > 0:
        i_share = singular / (singular + plural)
    else:
        i_share = 0.5

    judge_fail = 0.0
    match = JUDGE_RE.search(lower)
    if match and int(match.group(2)) > 0:
        judge_fail = 1.0 - int(match.group(1)) / int(match.group(2))

    numbers = len(NUMBER_RE.findall(lower))
    percents = lower.count("%") + sum(1 for t in tokens if t == "percent")

    return [
        1.0 if numbers > 0 else 0.0,
        math.log(1 + numbers),
        float(percents),
        singular / per,
        plural / per,
        i_share,
        math.log(1 + n),
        sum(1 for t in tokens if t in HEDGES) / per,
        sum(1 for t in tokens if t in TECH) / per,
        float(lower.count("?")),
        judge_fail,
        1.0 if "[live coding" in lower or "[judge]" in lower else 0.0,
    ]


# ---------- data ----------


def read_jsonl(path):
    rows = []
    if not path.exists():
        return rows
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            # One broken log line should not stop the retrain.
            continue
    return rows


def canonical_tags(tags):
    out = set()
    for tag in tags or []:
        key = re.sub(r"[^a-z0-9]+", "_", str(tag).lower()).strip("_")
        key = TAG_SYNONYMS.get(key, key)
        if key in TAGS:
            out.add(key)
    return sorted(out)


def load_rows():
    """Seed answers plus logged turns, deduplicated by answer text (seed wins)."""
    rows = []
    seen = set()

    for row in read_jsonl(SEED):
        key = row["answer"].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {"answer": row["answer"], "score": int(row["score"]), "tags": canonical_tags(row["tags"]), "real": False}
        )

    for row in read_jsonl(TURNS):
        answer = str(row.get("answer") or "").strip()
        score = row.get("score")
        if not answer or answer == "(silence)" or not isinstance(score, (int, float)):
            continue
        key = answer.lower()
        if key in seen:
            continue
        seen.add(key)
        rows.append(
            {"answer": answer, "score": int(score), "tags": canonical_tags(row.get("tags")), "real": True}
        )

    return rows


# ---------- training ----------


def fit(rows):
    texts = [r["answer"] for r in rows]
    vectorizer = TfidfVectorizer(analyzer=analyze, max_features=MAX_VOCAB, min_df=2, sublinear_tf=True)
    tfidf = vectorizer.fit_transform(texts)

    scaler = StandardScaler()
    hand = scaler.fit_transform(np.array([hand_features(t) for t in texts]))
    # A constant feature (say, no coding answers yet) gets scale 1 so nothing divides by 0.
    scaler.scale_[scaler.scale_ == 0] = 1.0
    x = hstack([tfidf, csr_matrix(hand)]).tocsr()

    score_model = Ridge(alpha=RIDGE_ALPHA)
    score_model.fit(x, [r["score"] for r in rows])

    tag_models = {}
    thresholds = {}
    for tag in TAGS:
        y = np.array([1 if tag in r["tags"] else 0 for r in rows])
        model = LogisticRegression(C=LOGISTIC_C, class_weight="balanced", max_iter=2000)
        if y.sum() < 3 or y.sum() > len(y) - 3:
            # Too few examples to learn anything; the tag is never predicted.
            tag_models[tag] = None
            thresholds[tag] = 1.0
            continue
        model.fit(x, y)
        tag_models[tag] = model
        thresholds[tag] = tune_threshold(x, y)

    return {
        "vectorizer": vectorizer,
        "scaler": scaler,
        "score": score_model,
        "tags": tag_models,
        "thresholds": thresholds,
    }


def tune_threshold(x, y):
    """Pick the probability cutoff with the best out-of-fold F1, instead of a blind 0.5."""
    folds = min(5, int(y.sum()), int(len(y) - y.sum()))
    model = LogisticRegression(C=LOGISTIC_C, class_weight="balanced", max_iter=2000)
    probs = cross_val_predict(model, x, y, cv=folds, method="predict_proba")[:, 1]
    best, best_f1 = 0.5, -1.0
    for cut in np.arange(0.2, 0.81, 0.05):
        f1 = f1_score(y, probs >= cut)
        if f1 > best_f1:
            best, best_f1 = float(round(cut, 2)), f1
    return best


# ---------- export and pure-Python inference ----------


def rounded(values, digits=6):
    return [round(float(v), digits) for v in values]


def export(fitted, rows):
    vocab = fitted["vectorizer"].vocabulary_
    terms = sorted(vocab, key=vocab.get)
    tags = {}
    for tag in TAGS:
        model = fitted["tags"][tag]
        if model is None:
            continue
        tags[tag] = {
            "coef": rounded(model.coef_[0]),
            "intercept": round(float(model.intercept_[0]), 6),
            "threshold": fitted["thresholds"][tag],
        }
    return {
        "version": 1,
        "trained_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "rows": len(rows),
        "real_rows": sum(1 for r in rows if r["real"]),
        "max_tags": MAX_TAGS,
        "vocab": terms,
        "idf": rounded(fitted["vectorizer"].idf_),
        "hand_features": HAND_FEATURES,
        "hand_mean": rounded(fitted["scaler"].mean_),
        "hand_scale": rounded(fitted["scaler"].scale_),
        "score": {
            "coef": rounded(fitted["score"].coef_),
            "intercept": round(float(fitted["score"].intercept_), 6),
        },
        "tags": tags,
    }


def features_from_export(model, text):
    """The feature vector exactly as engine/critic.js builds it: a dict of index to value."""
    index = {term: i for i, term in enumerate(model["vocab"])}
    counts = {}
    for gram in analyze(text):
        if gram in index:
            counts[index[gram]] = counts.get(index[gram], 0) + 1

    weights = {}
    for i, c in counts.items():
        weights[i] = (1 + math.log(c)) * model["idf"][i]
    norm = math.sqrt(sum(w * w for w in weights.values()))
    if norm > 0:
        for i in weights:
            weights[i] /= norm

    offset = len(model["vocab"])
    for j, value in enumerate(hand_features(text)):
        weights[offset + j] = (value - model["hand_mean"][j]) / model["hand_scale"][j]
    return weights


def dot(weights, coef):
    total = 0.0
    for i in sorted(weights):
        total += weights[i] * coef[i]
    return total


def predict_from_export(model, text):
    x = features_from_export(model, text)
    raw = dot(x, model["score"]["coef"]) + model["score"]["intercept"]
    clipped = min(5.0, max(1.0, raw))

    probs = {}
    picked = []
    for tag, part in model["tags"].items():
        z = dot(x, part["coef"]) + part["intercept"]
        p = 1.0 / (1.0 + math.exp(-z))
        probs[tag] = p
        if p >= part["threshold"]:
            picked.append(tag)
    picked.sort(key=lambda t: -probs[t])

    return {
        "raw": raw,
        # floor(x + 0.5) rather than round(): Python rounds halves to even, JS does not.
        "score": int(math.floor(clipped + 0.5)),
        "tags": picked[: model["max_tags"]],
        "probs": probs,
    }


# ---------- metrics ----------


def f1_score(y, pred):
    y = np.asarray(y).astype(bool)
    pred = np.asarray(pred).astype(bool)
    tp = int((y & pred).sum())
    fp = int((~y & pred).sum())
    fn = int((y & ~pred).sum())
    if tp == 0:
        return 0.0
    precision = tp / (tp + fp)
    recall = tp / (tp + fn)
    return 2 * precision * recall / (precision + recall)


def evaluate(model, rows):
    preds = [predict_from_export(model, r["answer"]) for r in rows]
    errors = [abs(p["score"] - r["score"]) for p, r in zip(preds, rows)]
    result = {
        "n": len(rows),
        "score_mae": round(float(np.mean(errors)), 3),
        "within_1": round(float(np.mean([e <= 1 for e in errors])), 3),
        "exact": round(float(np.mean([e == 0 for e in errors])), 3),
        "tag_f1": {},
    }
    for tag in TAGS:
        y = [tag in r["tags"] for r in rows]
        # F1 is meaningless for a tag that never shows up in this slice.
        if not any(y):
            continue
        pred = [tag in p["tags"] for p in preds]
        result["tag_f1"][tag] = {"f1": round(f1_score(y, pred), 3), "support": int(sum(y))}
    return result


def print_metrics(name, m):
    print(f"\n{name} (n={m['n']}): score MAE {m['score_mae']}, within 1: {m['within_1']:.0%}, exact: {m['exact']:.0%}")
    for tag, v in m["tag_f1"].items():
        print(f"  {tag:16s} F1 {v['f1']:.2f}  (support {v['support']})")


# ---------- main ----------


def write_json(path, data, indent=None):
    # Write then rename, so the server never reads a half-written model.
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=indent, separators=(",", ":") if indent is None else None) + "\n")
    tmp.replace(path)


def write_parity(model, rows):
    """About 20 answers and their exported-model predictions, for the JS parity test."""
    picks = rows[::max(1, len(rows) // 18)][:18]
    extra = [
        "",
        "We did it.",
        "I cut p99 latency from 900ms to 120ms (87%) by adding a Redis cache. Why? Reads were 95% of traffic.",
    ]
    cases = []
    for text in [r["answer"] for r in picks] + extra:
        p = predict_from_export(model, text)
        cases.append({"answer": text, "raw": p["raw"], "score": p["score"], "tags": p["tags"], "probs": p["probs"]})
    write_json(PARITY_OUT, {"cases": cases}, indent=2)


def check_against_sklearn(fitted, model, rows):
    """The exported JSON must predict what sklearn predicts, up to the rounding of coefficients."""
    texts = [r["answer"] for r in rows[:40]]
    tfidf = fitted["vectorizer"].transform(texts)
    hand = fitted["scaler"].transform(np.array([hand_features(t) for t in texts]))
    x = hstack([tfidf, csr_matrix(hand)]).tocsr()
    expected = fitted["score"].predict(x)
    got = np.array([predict_from_export(model, t)["raw"] for t in texts])
    gap = float(np.max(np.abs(expected - got)))
    if gap > 1e-3:
        sys.exit(f"exported model drifted from sklearn by {gap}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true", help="retrain on all rows and export, skip evaluation")
    args = parser.parse_args()
    started = time.time()

    rows = load_rows()
    if len(rows) < 50:
        sys.exit(f"only {len(rows)} labeled answers; need the seed file at {SEED}")

    metrics = None
    if not args.quick:
        metrics = {}

        # Held-out 20%, stratified by score, from seed and real rows together.
        train_rows, test_rows = train_test_split(
            rows, test_size=0.2, random_state=SEED_SPLIT, stratify=[r["score"] for r in rows]
        )
        held = export(fit(train_rows), train_rows)
        metrics["holdout"] = evaluate(held, test_rows)
        print_metrics("Held-out 20% (seed + real)", metrics["holdout"])

        # The honest test: train on generated answers only, score answers from real sessions.
        seed_rows = [r for r in rows if not r["real"]]
        real_rows = [r for r in rows if r["real"]]
        if real_rows:
            seed_only = export(fit(seed_rows), seed_rows)
            metrics["real_sessions"] = evaluate(seed_only, real_rows)
            print_metrics("Real session answers, model trained on seed only", metrics["real_sessions"])

    fitted = fit(rows)
    model = export(fitted, rows)
    check_against_sklearn(fitted, model, rows)
    if metrics:
        model["metrics"] = metrics
        write_json(METRICS_OUT, metrics, indent=2)
    elif MODEL_OUT.exists():
        # Quick retrains keep the last full evaluation so the numbers stay visible.
        previous = json.loads(MODEL_OUT.read_text()).get("metrics")
        if previous:
            model["metrics"] = previous

    write_json(MODEL_OUT, model)
    write_parity(model, rows)

    size_kb = MODEL_OUT.stat().st_size / 1024
    real = model["real_rows"]
    seconds = time.time() - started
    print(f"critic trained on {len(rows)} answers ({real} real) in {seconds:.1f}s, model {size_kb:.0f} KB")


if __name__ == "__main__":
    main()
