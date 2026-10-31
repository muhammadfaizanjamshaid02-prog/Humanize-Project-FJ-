# HumanizeAI — AI Paragraph Humanizer for Students

A web-based writing assistant. A student pastes a paragraph, picks a
**Mode** (Natural, Simple, Academic, Casual, Professional) and an
**Intensity** (Light, Medium, Strong), clicks **Humanize**, and gets the
same paragraph back in natural, human-sounding words — with the meaning,
names, numbers and dates provably unchanged.

Built with React + Vite (client) and Node + Express (server). No database
in this MVP: history is kept in the browser (localStorage).

## Login gate

The app opens behind a playful, cartoon-style **login gate**: an animated
transparent (glass) screen with the author's avatar greeting you and a
single password field. The password is checked **entirely in the browser
against a SHA-256 hash only** — the plaintext password appears nowhere in
the code. A correct entry unlocks the app for that browser session
(`sessionStorage`); the 🔒 Lock button in the header locks it again.

Be clear about what this is: a **personal/show gate for the demo, not real
security**. Anyone technical can read a client-side hash check. Real user
accounts (server-side auth) arrive with the Phase-3 server work.

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
 ┌─────────────┐   up to 4 candidate rewrites are generated:
 │ 2. REWRITE  │   • LLM candidates if a key is set (temp 0.7 + a
 │  (x4 ways)  │     hotter, naturalness-focused 0.95 candidate)
 │             │   • or the offline demo engine's 4 strategies:
 │             │     A standard, B restructuring, C rotation emphasis,
 │             │     D Fidelity+Flow (light touch + burstiness pass)
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
 ┌─────────────┐   among the candidates that PASS, the best
 │ 4. SELECT   │   selection score wins (naturalness + a fidelity
 │             │   bonus for meaning above 85 — formula below). The
 │             │   gate always outranks the score.
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

1. Up to **4 rewrite candidates** are generated (strategies above).
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
4. The winner is the gate-passing candidate with the highest
   **selection score**:

   ```
   selectionScore = naturalnessScore
                  + min(22.5, 1.5 × max(0, meaningScore − 85))
                  + voice-match bonus (≤ +12, Custom Voice only)
   ```

   The middle term (v3.1) rewards fidelity above the gate line, so a
   meaning-99 candidate beats a meaning-86 candidate of equal
   naturalness. One hard rule sits above the formula: a candidate
   beaten on **both** meaning and naturalness by another passer
   (Pareto-dominated) can never win. The response reports
   `naturalnessIn` (the original's score), `naturalnessScore` (the
   delivered output's), `candidatesTried` and `candidatesPassed`.

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
| 2 | Sentence Restructuring | `splitLongSentences()` + `mergeShortSentences()` (demo), the varied-length rule in the LLM prompt, strategy B of the candidate loop, and strategy D's greedy **burstiness pass** (`varySentenceLengths()` — clause-boundary splits and short-sentence merges chosen by the sentence-length spread they produce; no content word is added, dropped or reordered inside a clause) |
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
| **Depth: Basic vs Advanced** | QuillBot's Basic vs Advanced split | Basic generates **one** candidate and verifies it **once** — the same six gate conditions, the same fail-safe, just faster. Advanced runs the full loop: up to 4 candidates (A/B/C + D Fidelity+Flow), **double** verification, naturalness competition. The response's `verificationRuns` (1 or 2) states honestly which path ran. |
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

### Test battery (v3.1, demo engine — real measured results, re-run 31 Oct 2026)

The battery is 13 paragraphs across every kind of text a student
meets — academic/research, technical/software, casual blog, business
email (Email preset), marketing copy (Marketing preset), a story
opening (Story preset), a negation-heavy rules text, a
numbers/dates/percentages report, a quote + acronym paragraph, a
long ~285-word paragraph, and the three regression cases
(entity-heavy, the built-in sample, and a planted grammar-fault
paragraph). Battery inputs were kept out of the repo; the measured
results of the shipped engine were:

| # | Case | Status | Meaning | Coverage | New facts | Naturalness In → Out |
|---|------|--------|---------|----------|-----------|----------------------|
| a | Academic (Essay preset) | Accepted | 100 | 100% | 0% | 56 → 89 |
| b | Technical / software | Accepted | 100 | 100% | 0% | 84 → 83 |
| c | Casual blog | Accepted | 100 | 100% | 0% | 89 → 99 |
| d | Business email (Email preset) | Accepted | 99 | 98% | 0% | 94 → 95 |
| e | Marketing (Marketing preset) | Accepted | 100 | 100% | 0% | 69 → 97 |
| f | Story opening (Story preset) | Accepted | 100 | 100% | 0% | 99 → 99 |
| g | Negation-heavy rules | Accepted | 100 | 100% | 0% | 84 → 96 |
| h | Numbers / dates / % (Article preset) | Accepted | 100 | 100% | 0% | 75 → 95 |
| i | Quote + acronym | Accepted | 100 | 100% | 0% | 84 → 98 |
| j | Long paragraph (~285 words) | Accepted | 100 | 100% | 0% | 71 → 84 |
| k1 | Entity-heavy (regression) | Accepted | 100 | 100% | 0% | 77 → 93 |
| k2 | Built-in sample (regression) | Accepted | 99 | 100% | 0% | 56 → 98 |
| k3 | Grammar-fault (regression) | Accepted | 100 | 100% | 0% | 47 → 93 |

- **13 of 13 Accepted** — no case needed the fail-safe; the negation
  lock passed on all 13.
- **8 of 13 cases reached Meaning ≥ 95 AND Naturalness ≥ 95**,
  including the built-in sample (99 / 56 → 98). Meaning is ≥ 99 on
  every case.
- **What changed in v3.1** (gate thresholds unchanged — meaning ≥ 85,
  coverage ≥ 85, new-facts ≤ 20%, entities/numbers 100%, exact
  negation match, double verification, fail-safe):
  1. **Checker canonicalisation completed.** Both sides of the
     meaning/coverage comparison now pass through
     `normalizeForCheck()`, which applies *only* equivalences the
     engine itself can produce: the approved synonym map (both
     directions, including multi-word phrases), the engine's own
     phrase-replacement table, and the same contraction expansion
     the negation lock uses ("can't" ≡ "cannot", "don't" leaves no
     phantom concept). Earlier, the checker charged the engine for
     its own legal swaps — e.g. "in order to" → "to" deleted a
     concept the rewrite was *supposed* to delete. No loose or
     topic-related words are equated; a word the engine never
     touches keeps its identity on both sides.
  2. **Strategy D — Fidelity+Flow.** A fourth Advanced candidate:
     light-touch rewrite (phrase fixes, contractions, grammar;
     synonym swaps minimal) plus a greedy **burstiness pass** that
     varies sentence lengths by clause-boundary splits and
     short-sentence merges only.
  3. **Selection upgrade.** The winner is picked by the selection
     score documented above (naturalness + fidelity bonus), under a
     Pareto guard.
- **Honest ceilings, disclosed as-is:** five cases land below 95
  naturalness for content reasons, not engine laziness — the
  academic text must keep its terminology (everyday-vocabulary axis)
  and two of its sentences legitimately start with "The"; the
  technical text must repeat its stack's names (lexical-diversity
  axis), and its output (83) sits a point below its already-natural
  input (84); the long paragraph's topical words necessarily repeat
  across 285 words; the entity-heavy and grammar-fault cases stop at
  93, capped by name density and repeated topical bigrams. The gate
  outranks the score in every case: no content word was traded away
  to buy points.
- The browser port was verified **identical** to the server on the
  full battery (all 13 cases: same output text, same checks) — the
  static Pages build runs exactly the engine measured above.

## Professor View — a Turnitin-style AI-writing report

The header's **🎓 Professor View** button (after the login gate) opens
the instructor side of the app: paste a student's text and get an
AI-writing report modelled on Turnitin's. The design was researched
from Turnitin's official guides and whitepaper (31 Oct 2026;
`research_notes/turnitin-ai-detection-professor-view-res-20261031-0401/report.md`,
§8 clone design + the report-layout and indicator sections) and
reproduces the parts a small tool honestly can:

**Turnitin design points reproduced**

- The score is the percentage of **qualifying text** — prose sentences
  in long-form writing only. List items, ALL-CAPS short headings and
  quoted blocks are segmented out and never counted, and the report
  says the percentage is not a percentage of the whole document.
- **Display states, exactly as Turnitin's post-July-2024 rules:**
  `0%` shows "0%" with no highlights; **1–19% shows only `*%`** — no
  number and no highlights anywhere in the report, because false
  positives are more likely in that band (the suppression happens in
  the analyzer itself: the payload for that state contains no number
  and no flags to leak); **20–100%** shows the number with flagged
  sentences highlighted **blue**.
- **Intake gates:** under 300 words of prose → no report (the `- -`
  state with the reason, mirroring Turnitin's 300-word minimum);
  a 30,000-word ceiling is enforced and stated.
- **Submission Breakdown bar:** one segment per qualifying sentence,
  sized by sentence length, blue for flagged; clicking a segment
  scrolls to that sentence and flashes it.
- **Integrity Flags panel:** hidden characters (U+200B, U+200C,
  U+200D, U+FEFF) and replaced characters (Cyrillic/Greek lookalikes
  inside Latin words) are genuinely detected and located, with
  Turnitin's wording that "a flag is not necessarily an indicator of
  a problem".
- **Document Details:** total words, qualifying sentences, excluded
  non-prose segments, average sentence length, flagged count (≥20%
  state only) and a US/UK spelling-mix count.
- **Download / Print Report** produces a clean printout in the shape
  of Turnitin's PDF: cover header (title, date) → score overview →
  breakdown → the highlighted submission → details → honesty note.
- **Interpretation posture, copied in spirit from Turnitin's own
  guidance:** the honesty block is always visible — an AI score is a
  single data point, it may misidentify human and AI text, and it
  must never be the sole basis for adverse action against a student.

**The heuristic (this is the honest part).** Turnitin's scores come
from a proprietary transformer model trained on its in-house academic
corpus; this demo has no such model. Each qualifying sentence gets a
transparent 0–1 AI-pattern score from surface signals only, and is
flagged at **≥ 0.40**; the document score is the rounded percentage
of flagged qualifying sentences. This is **Detector v2** (31 Oct
2026). v1 weighted stock phrases so heavily (0.45, threshold 0.65)
that a sentence containing no stock phrase could reach at most 0.55 —
and modern LLM prose, which avoids the classic stock phrases, scored
0% end-to-end (one simple human sentence, at 0.30, outscored every
modern-AI sentence, max 0.20). v2 rebalances seven documented
signals (weights sum to 1.00): AI-marker/stock phrases (0.26); a
formulaic starter or a starter repeated from the previous sentence
(0.08); sentence length close to the document mean with no
"specifics" such as numbers, quotes, contractions or names (0.18);
**burstiness** — a document-level signal, the coefficient of
variation of sentence lengths (0.22); **word-rank predictability**
in the GLTR style (0.10), from an embedded ~2,225-word Google Books
frequency list (common-word density in the top 1,000 plus scarcity
of words outside the list) — kept deliberately small, because simple
non-native English also uses common words, which is the known GLTR
false-positive trap; average word length (0.12); and cross-sentence
bigram repetition (0.04). The v1 within-sentence lexical-variety
signal was removed: measured on human and AI texts alike it is ~0
everywhere (neither repeats words inside a sentence), so it carried
no signal. The analyzer is `analyzeText()` in
`server/humanizer.js`, exposed as `POST /api/analyze`, and ported
byte-identically to the browser (`analyzeLocal` in
`client/src/humanizerClient.js`, parity-verified JSON-deep-equal
against the server on the whole validation battery below). A
dependency-free Python 3 port of the same detector,
`ai_detector.py`, is distributed with the project (outside the
repo); its percentages and flagged lines match the JS implementation
exactly on the battery texts.

**Validation battery (31 Oct 2026, Detector v2; fictional texts
written for testing, ≥ 300 words each):**

| Text | v2 result | v1 result |
| --- | --- | --- |
| Classic AI-style sample (built-in demo, saturated with stock phrases) | **100%** (16/16 flagged) | 63% |
| Modern AI-style sample (current ChatGPT-style prose, zero stock phrases) | **80%** (12/15 flagged) | 0% |
| Formal academic AI-style text (no stock phrases) | **43%** (6/14 flagged) | 0% |
| Human-style sample (built-in demo; personal, varied, contractions) | **0%** | 0% |
| Formal human academic text (named researchers, exact figures, quotations) | **0%** | 0% |
| Simple-English non-native-style human text (short sentences, common words — the known false-positive risk group) | **0%** | 0% |
| The modern AI sample after this app's own humanizer | **0%** (down from 80%) | — |
| Human sample with two classic-AI sentences mixed in | **\*%** band (number suppressed, as designed) | \*% |

**Measured demo results (built-in samples):** the deliberately
robotic AI-style sample (326 words) scores **100%** with all 16
sentences highlighted; the human-style sample (328 words, varied,
personal, contractions) scores **0%**; a planted zero-width character
pair plus a Cyrillic homoglyph in the AI sample are both listed in
the Flags panel.

**Document upload (PDF / Word / TXT).** Above the paste box, the
**📄 Upload a document** area takes the same files Turnitin accepts —
**PDF, Word (.docx) and TXT** — by drag & drop or file picker, and the
report is generated as soon as the file is read. Extraction happens
**entirely in the browser** (pdf.js for PDF, mammoth for DOCX, the
File API for TXT): the file is never uploaded anywhere and never
reaches a server, which is also what makes the feature work on the
static GitHub Pages build. `pdfjs-dist` and `mammoth` are recorded in
`client/package.json` and loaded lazily, only when a document is
opened. Two extraction details matter: PDF text is rebuilt from item
geometry (wrapped lines are re-joined with a space; only a line gap
far larger than the page's typical gap counts as a paragraph break),
so an uploaded document analyses **identically to the same text
pasted in** — verified headlessly on 31 Oct 2026 (Detector v2): the
AI-style sample scores **100% with the same 16 flagged sentences**
via paste and PDF alike (and via DOCX and TXT under v1); the
human-style sample scores **0%** via PDF. One honest caveat: text
that is part of the file itself — e.g. a browser print header with
a date stamp saved into the PDF — is analysed as part of the
document, exactly as a real detector would read the file. The
report header carries the **document name** (and it prints, via
Download / Print Report). Edge cases, all with honest messages and no
fake report: a **scanned / image-only PDF** (no text layer) is
recognised and refused with an explanation; a **corrupt, encrypted or
password-protected** file gets a could-not-be-read message; a wrong
file type lists the accepted formats; a document **over 30,000
words** is analysed on its first 30,000 words only (Turnitin's
ceiling) and both the upload area and the report header say so; and
anything under 300 words lands in the existing `- -` too-short state.

**Honest limits.** The percentages are *unvalidated estimates* — no
false-positive rate is claimed, and none of Turnitin's published
accuracy figures apply to this tool. There is **no plagiarism /
similarity checking**: comparing text against a database of sources
is out of scope and is not claimed anywhere. Heavily edited or
paraphrased AI text can score low; plain, repetitive human text can
score high. It is a teaching demo of how such reports are presented,
not evidence about any real student.

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
    "lengthRatio": 0.9,
    "meaningScore": 99,
    "coverage": 100,
    "newConceptRatio": 0,
    "readabilityIn": 41,
    "readabilityOut": 51.2,
    "repetitionIn": 3,
    "repetitionOut": 3,
    "doubleVerified": true,
    "naturalnessScore": 98,
    "naturalnessIn": 56,
    "candidatesTried": 4,
    "candidatesPassed": 4
  },
  "status": "Accepted"
}
```

On gate failure the same call returns `"status": "Returned original"`,
`"output"` set to the untouched original paragraph, the checks that
failed (with `missingConcepts` / `newConcepts` lists when those checks
fail), and the flawed candidate under `"rejectedOutput"`.

`POST /api/analyze` with `{ "text": "…" }` powers the Professor View
(see its section above): it returns the report `state`
(`scored` / `zero` / `low` / `tooShort` / `tooLong`), the
`displayScore` (`"100%"` / `"0%"` / `"*%"` / `null`), per-segment
sentences with flags (suppressed in the `low` state), document
`details`, and integrity `flags`. Short or over-long texts return a
report state rather than an error, mirroring Turnitin's indicators.

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
