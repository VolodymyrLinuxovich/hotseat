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

# Question policy

Reinforcement learning for the panel's choice before each question: who asks (manager, tech,
skeptic), which of six topics, and a difficulty band (2, 3 or 4). The coding round at Q3 is
always Theo and is not a choice.

## Files

| Path | What |
|------|------|
| `sim.py` | Synthetic candidates, answer scores, the belief update, features and reward |
| `policy.py` | Trains, evaluates, plots, exports `engine/policy-model.json` and `data/policy_parity.json` |
| `data/policy_metrics.json` | Held-out results, learning curve, weights, last quick run |
| `data/policy_parity.json` | Saved states and Q values that `tests/policy.test.js` checks the JS against |

## Simulator

Skill per topic = general level + people or technical cluster + topic noise, on the core's
1 to 5 scale. About 30% of candidates get one topic 1 to 2 points lower. Habits (no_numbers,
vague, deflects, we_not_i, rambling, shallow) subtract from the topics they hurt. A score is
1 plus four rubric points, each earned with probability sigmoid(1.5 x affinity x (skill -
difficulty) + noise). Affinity runs from 0.5 (Maya on coding) to 1.4 (Sol on metrics, Theo
on coding). 60% of candidates have past sessions; their remembered weak topics are the ones
whose noisy past average fell below the Bruin weak line.

The belief is a 7-dimensional Gaussian, starting from the population mean and covariance
(estimated from 50,000 sampled candidates and stored in the model file). Each answer is one
Laplace step on its topic with the core's likelihood, spread to the other topics through the
covariance.

## Training

Fitted Q-iteration with a linear Q over 32 features. Rounds of episodes (50, 100, 150, 200,
500, then 1,000 each, 30,000 in total), epsilon-greedy from 0.3 down to 0.05, a ridge fit on
the last four rounds, six Bellman iterations per refit, no discount. Seeded, so a full run
gives the same weights every time. It takes about 40 seconds.

Real sessions: each logged session is replayed through the belief; turns with a known asker
and topic become transitions, other turns (coding, motivation) add their reward to the
decision before them. The refit is anchored to the current weights with a strong ridge
(200), so two dozen transitions can only nudge it. No memory profile is used in the replay,
because the profile on disk was built from those same sessions.

## Run it

```bash
.venv/bin/python train/policy.py           # train from scratch, evaluate, plot, export
.venv/bin/python train/policy.py --quick   # 1,500 episodes + real sessions from current weights
```

`bruin/run.sh` runs the quick step after the critic retrain, only with `.venv/bin/python`,
and skips it silently without the venv. A quick run without a model file does nothing.

## Honest metrics

2,000 held-out simulated candidates, same random streams for every policy:

| Policy | Avg return | Skill RMSE | Weak topic probed |
|---|---|---|---|
| Trained | 2.84 | 0.626 | 99.7% |
| One-step greedy on expected gain | 2.79 | 0.626 | 87.6% |
| Fixed rotation | 2.61 | 0.650 | 86.8% |
| Random | 1.63 | 0.691 | 74.6% |
| No questions | | 0.878 | |

The trained policy ties the greedy baseline on skill error and wins on return through the
coaching bonus and fewer repeats. All of this is on the simulator. Real data so far is 25
turns from 5 sessions, none with a logged difficulty.
