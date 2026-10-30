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
| 10 | Style Transfer | The 5 **Modes** are the style transfer: Natural, Simple, Academic, Casual, Professional — `MODE_GUIDANCE` for the LLM, contraction/expansion voice rules in the demo engine — plus the v3 **Purpose presets** (`purposeTuning()`), which restyle the same engine per job (Email, Marketing, Story…) |

## v3 — premium-level features

Version 3 takes the project to the level of the established commercial
humanizers, feature by feature. The mapping below is grounded in a
sourced comparison of the three products' **official** pages
(30 Oct 2026) — only features a small independent project can honestly
reproduce were copied; their proprietary models were not, and none of
their marketing language was either.

| v3 feature | Pattern it follows | How it is implemented here |
|---|---|---|
| **Purpose presets** — General, Essay, Assignment, Article, Email, Marketing, Story | DeepAI's per-purpose humanizing | A preset sets Mode + Intensity defaults **and** tunes the engine: Email splits sentences earlier (short, scannable) with contractions; Marketing splits hardest and rotates synonyms from the 2nd use (punchy); Story raises the split thresholds so long flowing sentences survive; Essay/Assignment lock contractions off (formal). The LLM prompt gets a matching purpose line. |
| **Depth: Basic vs Advanced** | QuillBot's Basic vs Advanced split | Basic generates **one** candidate and verifies it **once** — the same six gate conditions, the same fail-safe, just faster. Advanced runs the full v2 loop: up to 3 candidates, **double** verification, naturalness competition. The response's `verificationRuns` (1 or 2) states honestly which path ran. |
| **Custom Voice** | Grammarly's personal voice profile | An optional writing sample (≥ 40 words) is reduced to **style statistics only** — average sentence length, contraction tendency, average word length. The raw sample never enters the LLM prompt and is stored only in the browser's localStorage. The stats bias contraction behaviour and add a voice-match bonus (≤ +12) when the winning candidate is chosen — after the gate, never instead of it. |
| **Compare rewrites** | QuillBot's Compare Modes | The API returns **every gate-passing candidate** with its own full checks (`candidates[]`, `winnerIndex`). The UI lists them under "Compare rewrites"; clicking one swaps the displayed output **and** its gate panel to that candidate's own checks. |
| **Word-click synonym swap** | QuillBot's click-a-word synonyms | In the output, words present in the synonym map (either direction) carry a dotted underline. Clicking one offers the alternatives; choosing replaces **that occurrence only** and the edited text is **re-verified locally** (`verifyEdit()` in the browser port). If the edit breaks the gate, the panel switches to a clear warning — *"Edited — this version no longer passes all checks"* — and the edit is **kept**, never silently reverted. |
| **Sentence stats rail** | Grammarly / QuillBot result statistics | The gate panel shows sentences in → out, average sentence length in → out, and a per-sentence length bar chart of the output, so the rhythm change is visible at a glance. |

> **Honesty note (kept from the research):** QuillBot and Grammarly
> themselves state on their official pages that their humanizers are
> **not** tools for bypassing AI detectors, and neither claims a
> guaranteed detector result. This project makes the same statement:
> it makes writing genuinely more natural and proves the meaning
> survived — it does **not** claim "undetectable" or any detector
> score, anywhere.

### Test battery (v3, demo engine — real measured results)

The v3 engine was run over a battery of 13 paragraphs across every
kind of text a student meets — academic/research, technical/software,
casual blog, business email (Email preset), marketing copy (Marketing
preset), a story opening (Story preset), a negation-heavy rules text,
a numbers/dates/percentages report, a quote + acronym paragraph, a
long ~250-word paragraph, and the three v2 regression cases
(entity-heavy, the built-in sample, and a planted grammar-fault
paragraph). Battery inputs were kept out of the repo; the measured
results were:

- **13 of 13 Accepted** — no case needed the fail-safe.
- **Meaning score 91–99** on every case; **fact coverage 97–100%**;
  **new-facts ratio 0–9%**; **negation lock passed on all 13**,
  including the negation-heavy text (93 meaning, all negations intact).
- **Naturalness rose sharply on robotic inputs**: academic 54 → 82,
  marketing 56 → 82, the long paragraph 62 → 93, the grammar-fault
  paragraph 49 → 91 (all planted faults fixed), the sample 56 → 88.
- Disclosed as-is: on inputs that were **already** natural human text
  (casual blog 96, story 85, negation rules 94) the delivered output
  landed within a few points of the input's own naturalness
  (95, 83, 90) — the meaning gate outranks naturalness, so a
  meaning-perfect rewrite is never traded for a score.
- The browser port was verified **identical** to the server on every
  battery-adjacent parity case (default, Email preset, Basic depth,
  Custom Voice, entity-heavy): same output, same checks.

## The API

`POST /api/humanize` with `{ "text": "…", "mode": "Natural", "intensity": "Medium" }`.
v3 adds three optional fields — `"purpose"` (one of `PURPOSES`,
default `"General"`), `"depth"` (`"Basic"` or `"Advanced"`, default
`"Advanced"`), and `"voiceSample"` (a writing sample; only its style
statistics are used) — and the response gains `purpose`, `depth`,
`voice` (the statistics or `null`), `candidates` (every gate-passing
rewrite with its own checks) and `winnerIndex`:

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

## Live on GitHub Pages

This site also runs as a **fully static build on GitHub Pages** — no
server, no API key. The Pages build carries the **same v3 demo
algorithm in the browser**: `client/src/humanizerClient.js` is a
browser port of the demo-engine pipeline in `server/humanizer.js`
(PROTECT → purpose-tuned candidate rewrites → the six-check gate →
naturalness loop → fail-safe), regenerated from the server file by
the documented port process so the two engines cannot drift apart —
and it includes the v3 surface (purpose presets, depth, Custom
Voice, compare candidates, the synonym swap's `verifyEdit()`). The
app always tries the Express API first; when no API answers (as on
Pages), it automatically falls back to the in-browser engine, and
the header shows **Demo Mode**. The full server version additionally
supports the **LLM engine** when an API key is configured — that is
the only difference.

## Roadmap — Phase 3 (not in this MVP)

- User accounts (register / login with JWT)
- MongoDB-backed history, saved per user instead of per browser
- Saved favourite rewrites and side-by-side diff view

## Note

AI Writing Assistant — always review the output yourself before using it.
Naturalness scores measure writing patterns only; they are not any
detector's score and no detector result is guaranteed.
