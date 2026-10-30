# HumanizeAI — AI Paragraph Humanizer for Students

A web-based writing assistant. A student pastes a paragraph, picks a
**Mode** (Natural, Simple, Academic, Casual, Professional) and an
**Intensity** (Light, Medium, Strong), clicks **Humanize**, and gets the
same paragraph back in natural, human-sounding words — with the meaning,
names, numbers and dates provably unchanged.

Built with React + Vite (client) and Node + Express (server). No database
in this MVP: history is kept in the browser (localStorage).

## The algorithm — v2, built so there is no room for a silent mistake

```
 input paragraph
      │
      ▼
 ┌─────────────┐   names, numbers, dates, %, URLs, emails, quotes and
 │ 1. PROTECT  │   acronyms are locked behind placeholders (⟦E1⟧, ⟦E2⟧…)
 └─────────────┘
      │
      ▼
 ┌─────────────┐   up to 3 candidate rewrites are generated:
 │ 2. REWRITE  │   • LLM candidates if a key is set (temp 0.7 + a
 │  (x3 ways)  │     hotter, naturalness-focused 0.95 candidate)
 │             │   • or the offline demo engine's 3 strategies:
 │             │     A standard, B restructuring, C rotation emphasis
 └─────────────┘
      │
      ▼   every candidate, placeholders restored, must pass:
 ┌─────────────┐   THE GATE — six checks, run TWICE independently
 │ 3. GATE x2  │   (double verification; both runs must agree):
 │             │   1. entities preserved 100%
 │             │   2. numbers & dates preserved 100%
 │             │   3. NEGATION LOCK — "not / never / no / without…"
 │             │      match the original exactly (contractions
 │             │      expanded first), so meaning can never flip
 │             │   4. meaning score ≥ 85 (content-word overlap)
 │             │   5. fact coverage ≥ 85% of the original's concepts
 │             │   6. no-new-facts: ≤ 20% of output concepts may be new
 │             │   + length ratio inside 0.6×–1.5×
 └─────────────┘
      │
      ▼
 ┌─────────────┐   among the candidates that PASS, the one with the
 │ 4. SELECT   │   highest Naturalness Score wins (see below). The
 │             │   gate always outranks naturalness.
 └─────────────┘
      │
      ▼
 ┌─────────────┐   FAIL-SAFE: if NO candidate passes, the rewrite is
 │ 5. FAIL-    │   never delivered. The API returns the ORIGINAL
 │    SAFE     │   paragraph unchanged, status "Returned original",
 │             │   the failing checks, and the rejected candidate in
 │             │   "rejectedOutput" (shown in the UI only inside a
 │             │   "Why was it rejected?" expandable area).
 └─────────────┘
```

Two measurements are **report-only** — shown in the UI, never used to
reject a rewrite: **Readability** (Flesch Reading Ease of input vs
output) and the **Repetition index** (repeated content words/bigrams).

## Near-zero AI-signal design (the proposal's new feature)

The design target of this project is to push the measurable
characteristics of machine-written text **as close to zero as honestly
possible**. A **Naturalness Optimization Loop** does this:

1. Up to **3 rewrite candidates** are generated (strategies above).
2. Every candidate must pass the full meaning gate **first**.
3. Each surviving candidate gets a **Naturalness Score (0–100)** built
   from measurable natural-writing traits:
   - **Burstiness (25)** — variation in sentence lengths; uniform
     lengths are a machine trait, people mix short and long sentences.
   - **Lexical diversity (20)** — type-token ratio of the vocabulary.
   - **AI-marker phrases (25)** — a hard-penalty list (*furthermore,
     moreover, in conclusion, it is important to note, delve, crucial,
     plays a vital role…*); the target is **zero occurrences**.
   - **Starter variety (15)** — how many sentences start with a
     different word than the others.
   - **Repeated bigrams (7)** — repeated word pairs score down.
   - **Everyday vocabulary (8)** — share of words from a compact
     common-English list; natural writing is mostly everyday words.
4. The gate-passing candidate with the **highest** score is delivered,
   and the response reports `naturalnessIn` (the original's score),
   `naturalnessScore` (the delivered output's), `candidatesTried` and
   `candidatesPassed`.

> **Honesty line:** the aim is *as close to zero as possible* — **no
> 0% / "undetectable" guarantee is claimed, here or anywhere in this
> project.** AI detectors disagree with each other, they false-positive
> on genuinely human writing, and their scores change with every
> update. This system makes writing patterns genuinely more natural;
> it cannot and does not promise any detector's result.

## Techniques used

The ten techniques behind the pipeline, and where each one lives in
`server/humanizer.js`:

| # | Technique | Where it lives |
|---|-----------|----------------|
| 1 | LLM-based Text Rewriting | `llmRewrite()` — OpenAI-compatible call when a key is set, with a strict per-mode system prompt; the offline demo engine is the no-key fallback |
| 2 | Sentence Restructuring | `splitLongSentences()` + `mergeShortSentences()` (demo), the varied-length rule in the LLM prompt, and strategy B of the candidate loop |
| 3 | Semantic Preservation | The whole gate: PROTECT pass, entity/number checks, negation lock, meaning score ≥ 85, fact coverage ≥ 85, no-new-facts ≤ 20%, double verification, fail-safe |
| 4 | Context-Aware Paraphrasing | The LLM receives the whole paragraph (not sentence-by-sentence) with mode guidance; the demo engine's phrase/synonym/contraction choices are driven by the selected Mode + Intensity |
| 5 | Vocabulary Variation | `SYNONYMS` — a 72-pair formal→simple map — plus `REPETITION_ALTERNATIVES` (student→learner, teacher→instructor) used by rotation |
| 6 | Transition Optimization | `optimizeTransitions()` — sentence-initial connectors are varied or dropped so the same transition never heads two sentences in a row (strictest form in strategy C) |
| 7 | Grammar Correction | `grammarFix()` — doubled function words, "i"→"I", "a"→"an" before vowel sounds, missing space after punctuation, spacing/capitalisation via `tidy()`; runs while entities are placeholders, and also as a safety net on LLM output (the LLM prompt demands clean grammar too) |
| 8 | Repetition Detection | `repetitionIndex()` reported in/out in every response, and `reduceRepetition()` which swaps the 3rd+ occurrence of a word for a safe alternative (2nd+ in strategy C) |
| 9 | Readability Analysis | `fleschReadingEase()` — Flesch Reading Ease for input and output, reported as `readabilityIn` / `readabilityOut`. Report-only by design, never a rejection reason |
| 10 | Style Transfer | The 5 **Modes** are the style transfer: Natural, Simple, Academic, Casual, Professional — `MODE_GUIDANCE` for the LLM, contraction/expansion voice rules in the demo engine |

## The API

`POST /api/humanize` with `{ "text": "…", "mode": "Natural", "intensity": "Medium" }`:

```json
{
  "output": "…",
  "mode": "Natural",
  "intensity": "Medium",
  "engine": "demo",
  "checks": {
    "entitiesPreserved": true,
    "numbersPreserved": true,
    "negationPreserved": true,
    "lengthRatio": 0.91,
    "meaningScore": 91,
    "coverage": 100,
    "newConceptRatio": 5,
    "readabilityIn": 41,
    "readabilityOut": 55.8,
    "repetitionIn": 3,
    "repetitionOut": 1,
    "doubleVerified": true,
    "naturalnessScore": 88,
    "naturalnessIn": 56,
    "candidatesTried": 3,
    "candidatesPassed": 3
  },
  "status": "Accepted"
}
```

On gate failure the same call returns `"status": "Returned original"`,
`"output"` set to the untouched original paragraph, the checks that
failed (with `missingConcepts` / `newConcepts` lists when those checks
fail), and the flawed candidate under `"rejectedOutput"`.

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
Naturalness scores measure writing patterns only; they are not any
detector's score and no detector result is guaranteed.
