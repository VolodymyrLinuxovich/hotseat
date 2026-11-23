# Hotseat

A 3D interview panel of three AI agents that interviews you, argues about you, and remembers you next time.

Built for the Multiplayer AI Hackathon, Track 3: Grow with Agents.

## What happens

You sit across from three interviewers:

- **Maya**, Hiring Manager. Cares about ownership and impact.
- **Theo**, Tech Lead. Cares about depth and tradeoffs. Runs the live coding round.
- **Sol**, Bar Raiser. Pushes back on every claim and wants numbers.

After every answer the panel scores it, whispers about you in character, and each agent bids for the next question based on its own goal. The highest bidder asks. Difficulty goes up after strong answers and the panel presses on weak spots. Everything they decide shows up in the **Panel ledger**.

Question 3 is a live coding round. Theo generates a problem at your level, you write JavaScript in the editor, and hidden tests run in a sandboxed Web Worker. The code and the test results go back to the panel.

At the end each interviewer votes with an exact quote from your answers as evidence. You get strengths, growth areas, and a practice drill for each one.

## Memory with Bruin

Every session is written to `data/turns.jsonl` and `data/sessions.jsonl`. A Bruin pipeline loads them into DuckDB, runs quality checks, builds marts for topic scores, habit tags and the score trend, and exports `data/profile.json` with one profile per candidate, keyed by the name you enter. Your next session's panel reads your profile, so it opens on your known weak spots and notices when you fix an old habit. See [bruin/README.md](bruin/README.md).

## Run it

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY
npm run dev            # API on :8787, app on http://localhost:5173
```

Use Chrome for voice input. Typing works everywhere.

## Stack

Three.js, Web Speech API for voices and speech input, Express, Claude (`claude-opus-5-5`) with structured outputs for every agent decision, Bruin with DuckDB for memory.
