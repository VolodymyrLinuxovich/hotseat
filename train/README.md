# Answer critic

A small trained model that scores interview answers 1 to 5 and tags habits, as a second
opinion next to the LLM panel. The engine flags a turn when the two disagree by 2 or more.

## Files

| Path | What |
|------|------|
| `generate_seed.py` | One-off: asks Claude (6 calls) for 300 labeled answers |
| `data/seed_answers.jsonl` | The 299 seed answers after dedupe |
| `critic.py` | Trains, evaluates, exports `engine/critic-model.json` and `data/parity.json` |
| `data/metrics.json` | Metrics from the last full run |
| `data/parity.json` | Saved predictions that `tests/critic.test.js` checks the JS against |

## Data

Seed answers cover metrics, ownership, tradeoffs, system design, conflict, debugging and
motivation, with scores 1 to 5 and the tags no_numbers, vague, we_not_i, deflects, rambling,
strong_example, clear_tradeoffs and incomplete_code. Real answers from `data/turns.jsonl` are
added on every run. Their tags are folded with the same synonym table as `engine/checks.js`,
and tags outside the eight are dropped.

## Model

TF-IDF on word unigrams and bigrams (up to 2000 terms, min df 2, sublinear tf) plus 12
hand-made features, standardized. Ridge regression predicts the score. One logistic
regression per tag, class balanced, with a threshold chosen on 5-fold out-of-fold F1.

The export is plain JSON. `engine/critic.js` copies the tokenizer, the features and the math,
and `critic.py` checks its own pure Python reading of the JSON against sklearn before saving.

## Run it

```bash
uv venv .venv && uv pip install -r train/requirements.txt
.venv/bin/python train/critic.py           # train, evaluate, export
.venv/bin/python train/critic.py --quick   # retrain on everything, no evaluation
```

`bruin/run.sh` runs the quick retrain after every pipeline run. It looks for Python in
`CRITIC_PYTHON`, then `.venv/bin/python`, then `python3`, and skips quietly if scikit-learn
is missing. The server reloads the model when the file's mtime changes.

## Honest metrics

| Slice | n | Score MAE | Within 1 |
|---|---|---|---|
| Held-out 20%, seed and real | 64 | 0.52 | 92% |
| Real sessions, trained on seed only | 20 | 1.10 | 75% |

Tag F1 on the held-out slice: strong_example 0.84, we_not_i 0.91, vague 0.70,
incomplete_code 0.67, clear_tradeoffs 0.57, deflects 0.50, no_numbers 0.22, rambling 0.00
(1 example). The real-session numbers come from 20 answers, so treat them as a rough read.
