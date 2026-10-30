# HumanizeAI — AI Paragraph Humanizer for Students

A web-based writing assistant. A student pastes a paragraph, picks a
**Mode** (Natural, Simple, Academic, Casual, Professional) and an
**Intensity** (Light, Medium, Strong), clicks **Humanize**, and gets the
same paragraph back in natural, human-sounding words — with the meaning,
names, numbers and dates provably unchanged.

Built with React + Vite (client) and Node + Express (server). No database
in this MVP: history is kept in the browser (localStorage).

## The algorithm — a 4-pass pipeline (server/humanizer.js)

```
 input paragraph
      │
      ▼
 ┌─────────────┐   names, numbers, dates, %, URLs, emails, quotes and
 │ 1. PROTECT  │   acronyms are locked behind placeholders (⟦E1⟧, ⟦E2⟧…)
 └─────────────┘
      │
      ▼
 ┌─────────────┐   LLM with a strict per-mode prompt IF a key is set,
 │ 2. REWRITE  │   otherwise a built-in rule-based engine (demo mode):
 │             │   robotic-phrase removal, formal→simple synonyms,
 │             │   contractions, connector swaps, sentence splitting
 └─────────────┘
      │
      ▼   placeholders restored, then measured:
 ┌─────────────┐   • entities preserved?  • numbers preserved?
 │ 3. CHECK    │   • length ratio (safe band 0.6×–1.5×)
 │             │   • meaning score = content-word overlap, 0–100
 └─────────────┘
      │
      ▼
 ┌─────────────┐   "Accepted" ONLY if entities + numbers are 100%,
 │ 4. GATE     │   meaning score ≥ 70 and length is in band. If the LLM
 │             │   fails, it retries once with a stricter prompt. Any
 │             │   other result is honestly labelled "Check manually".
 └─────────────┘
```

The API returns the gate result with every rewrite:

```json
{
  "output": "…",
  "mode": "Natural",
  "intensity": "Medium",
  "engine": "demo",
  "checks": {
    "entitiesPreserved": true,
    "numbersPreserved": true,
    "lengthRatio": 0.91,
    "meaningScore": 94
  },
  "status": "Accepted"
}
```

**Demo mode** is the default: no API key is needed and everything works
offline. To use a real LLM, copy `server/.env.example` values into your
environment (`OPENAI_API_KEY` or `GEMINI_API_KEY`, optional `LLM_BASE_URL`
/ `LLM_MODEL`) before starting the server. If the LLM is unreachable the
server falls back to the demo engine and says so (`"engine": "demo"`).

## How to run

Server (terminal 1):

```bash
cd server
npm install
npm start          # http://localhost:5000  (GET /api/health to check)
```

Client (terminal 2):

```bash
cd client
npm install
npm run dev        # http://localhost:5173 — /api is proxied to port 5000
```

Input rules: a paragraph of **10–1000 words**. Errors (too short, too
long, unknown mode) come back as clean JSON messages.

> **Windows note:** if `npm install` or `npm run dev` fails on Windows
> (for example a missing `@rollup/rollup-win32-x64-msvc` package), delete
> the `node_modules` folder **and** `package-lock.json`, then run
> `npm install` again. For that reason this project is shared **without**
> `package-lock.json` files.

## Roadmap — Phase 3 (not in this MVP)

- User accounts (register / login with JWT)
- MongoDB-backed history, saved per user instead of per browser
- Saved favourite rewrites and side-by-side diff view

## Note

AI Writing Assistant — always review the output yourself before using it.
