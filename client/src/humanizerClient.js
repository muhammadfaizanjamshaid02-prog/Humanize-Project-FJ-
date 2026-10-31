/**
 * humanizerClient.js — BROWSER PORT of the demo-engine pipeline in
 * server/humanizer.js. This is the SAME algorithm as the server's
 * demo mode, now at v3: Pass 1 PROTECT (entities/numbers/dates locked
 * behind placeholders) -> Pass 2 demo REWRITE (Purpose-preset tuning,
 * Custom Voice statistics, 1 candidate at Depth Basic / up to 4 strategy
 * candidates (A/B/C + Fidelity+Flow D) at Depth Advanced) -> Pass 3 the six-check GATE (double
 * verification at Advanced) -> Naturalness Optimization Loop (gate
 * first, best selection score among the passers wins) -> FAIL-SAFE
 * (a rejected rewrite is never delivered; the original comes back
 * with status "Returned original").
 *
 * Differences from the server file, by design:
 *  - The LLM rewrite path is removed (no network calls, no API key in
 *    the browser), so `engine` in the result is always 'demo' here.
 *  - All server-only environment / module code is stripped; this is an
 *    ES module exporting humanizeLocal(text, mode, intensity, options),
 *    which is synchronous and returns exactly the API's response shape:
 *    { output, mode, intensity, purpose, depth, voice, engine,
 *      checks: {...}, candidates: [...], winnerIndex, status,
 *      rejectedOutput? } — and throws Errors with the same messages
 *    server.js returns for invalid input.
 *  - It also exports verifyEdit() (local re-verification of a
 *    user-edited output, for the word-click synonym swap) and
 *    synonymAlternatives() (the swap's option lists).
 *  - It also exports analyzeLocal / analyzeText — the Professor View
 *    analyzer, ported from the same block in server/humanizer.js and
 *    byte-for-byte identical in results (parity-tested); the server
 *    exposes it as POST /api/analyze.
 * It exists so the fully static GitHub Pages build works with no
 * server at all; when the Express API IS reachable the app uses it
 * first and only falls back to this module (see App.jsx).
 * GENERATED from server/humanizer.js by the documented port process —
 * do not edit the shared engine code here; edit the server file and
 * re-run the port.
 */

const MODES = ['Natural', 'Simple', 'Academic', 'Casual', 'Professional'];
const INTENSITIES = ['Light', 'Medium', 'Strong'];

/* v3 — PURPOSE PRESETS (DeepAI-style). Each preset names the Mode +
 * Intensity a user most likely wants for that job; the UI applies
 * these as defaults when the preset is picked (the user can still
 * override Mode/Intensity afterwards). The server ALSO applies the
 * preset's behaviour tuning in purposeTuning() below, so direct API
 * callers get the same behaviour as UI users. */
const PURPOSES = ['General', 'Essay', 'Assignment', 'Article', 'Email', 'Marketing', 'Story'];
const PURPOSE_DEFAULTS = {
  General: { mode: 'Natural', intensity: 'Medium' },
  Essay: { mode: 'Academic', intensity: 'Medium' },
  Assignment: { mode: 'Academic', intensity: 'Medium' },
  Article: { mode: 'Natural', intensity: 'Medium' },
  Email: { mode: 'Casual', intensity: 'Medium' },
  Marketing: { mode: 'Natural', intensity: 'Strong' },
  Story: { mode: 'Natural', intensity: 'Medium' },
};
const DEPTHS = ['Basic', 'Advanced'];

/* Behaviour tuning per purpose, consumed by demoRewrite():
 *  - splitMinBefore / splitMinAfter: clause-size thresholds for the
 *    ", and" sentence split (LOWER = shorter sentences, HIGHER =
 *    longer flowing sentences)
 *  - alwaysSplit: run the splitting pass even below Strong intensity
 *  - rotateFrom: repetition-rotation starts at this occurrence
 *  - contraction: 'on' forces contractions, 'off' forces expansions
 *    (formal writing), null = follow the Mode as in v2
 * Email wants short, easy-to-scan sentences; Marketing wants punchy
 * short lines + stronger word rotation; Story wants long flowing
 * sentences kept intact; Essay/Assignment are formal (no
 * contractions); Article and General keep the v2 behaviour. */
function purposeTuning(purpose) {
  switch (purpose) {
    case 'Email':
      return { splitMinBefore: 5, splitMinAfter: 4, alwaysSplit: true, contraction: 'on' };
    case 'Marketing':
      return { splitMinBefore: 4, splitMinAfter: 4, alwaysSplit: true, rotateFrom: 2, contraction: 'on' };
    case 'Story':
      return { splitMinBefore: 10, splitMinAfter: 8, alwaysSplit: false, contraction: 'on' };
    case 'Essay':
    case 'Assignment':
      return { contraction: 'off' };
    default: // General, Article
      return {};
  }
}

/* v3 — CUSTOM VOICE statistics (Grammarly-style). A writing sample is
 * NEVER used raw: it is reduced to three style statistics and only
 * those numbers travel onward (the LLM prompt receives the stats,
 * not the sample — privacy by design). Returns null unless the
 * sample has at least 40 words, so a stray sentence cannot pretend
 * to be a voice. */
function voiceStats(sample) {
  if (typeof sample !== 'string') return null;
  const words = sample.trim().split(/\s+/).filter(Boolean);
  if (words.length < 40) return null;
  const sentences = sample.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const sentenceCount = Math.max(1, sentences.length);
  const letters = words.reduce((n, w) => n + w.replace(/[^A-Za-z]/g, '').length, 0);
  const usesContractions = /(n't\b)|[A-Za-z]+'(s|re|ve|ll|d|m)\b/i.test(sample);
  return {
    avgSentenceWords: Math.round((words.length / sentenceCount) * 10) / 10,
    avgWordLength: Math.round((letters / words.length) * 100) / 100,
    usesContractions,
    sampleWords: words.length,
  };
}

/* Voice-match bonus for candidate selection: up to +12 selection
 * points, shrinking as the candidate's average sentence length moves
 * away from the sample's. It is a TIEBREAKER-grade bonus only — it is
 * added AFTER the meaning gate, so it can never rescue a candidate
 * that failed any check (the gate still outranks everything). */
function voiceBonus(candidate, stats) {
  if (!stats) return 0;
  const sentences = sentenceList(candidate);
  if (sentences.length === 0) return 0;
  const avg = candidate.trim().split(/\s+/).filter(Boolean).length / sentences.length;
  return Math.max(0, 12 - Math.abs(avg - stats.avgSentenceWords) * 1.2);
}

/* ------------------------------------------------------------------ */
/* Pass 1 — PROTECT                                                    */
/* ------------------------------------------------------------------ */

const MONTHS =
  'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';

// Ordered: longest / most specific first so nothing is double-claimed.
const PROTECT_PATTERNS = [
  /https?:\/\/[^\s)]+|www\.[^\s)]+/g, // URLs
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // emails
  /"[^"\n]+"|“[^”\n]+”|(?<=^|\s)'[^'\n]+'(?=\s|[.,!?;:]|$)/g, // quoted text (single quotes only at word edges, so contractions are safe)
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:${MONTHS})\\s+\\d{4}\\b`, 'g'), // 12 May 2024
  new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},?\\s+\\d{4}\\b`, 'g'), // May 12, 2024
  /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, // 12/05/2024
  /\b\d{4}-\d{2}-\d{2}\b/g, // 2024-05-12
  /\b\d[\d,]*(?:\.\d+)?\s?%/g, // percentages: 85% / 85.5 %
  /\$\s?\d[\d,]*(?:\.\d+)?/g, // money: $1,200
  /\b\d[\d,]*(?:\.\d+)?\b/g, // plain numbers incl. years
  /\b[A-Z]{2,}(?:-[A-Z0-9]+)?\b/g, // ALL-CAPS acronyms: AI, MERN, UNESCO
];

// Words that legitimately start sentences — never treat as proper nouns.
const SENTENCE_STARTERS = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'it', 'in', 'on', 'at',
  'as', 'but', 'and', 'so', 'if', 'when', 'while', 'many', 'some', 'most',
  'students', 'online', 'however', 'overall', 'today', 'there', 'he', 'she',
  'they', 'we', 'you', 'one', 'another', 'each', 'every', 'such', 'more',
  'also', 'first', 'second', 'finally', 'for', 'with', 'by', 'from', 'after',
  'before', 'during', 'because', 'although', 'research', 'education',
  'furthermore', 'moreover', 'therefore', 'additionally', 'consequently',
  'nevertheless', 'meanwhile', 'instead', 'recently', 'often', 'sometimes',
  'usually', 'clearly', 'importantly', 'still', 'yet', 'now', 'then', 'later',
]);

function protectEntities(text) {
  const store = []; // [{ placeholder, value, kind }]
  let out = text;

  const stash = (value, kind) => {
    const placeholder = `⟦E${store.length + 1}⟧`;
    store.push({ placeholder, value, kind });
    return placeholder;
  };

  for (const pattern of PROTECT_PATTERNS) {
    out = out.replace(pattern, (m) => stash(m, 'entity'));
  }

  // Proper nouns: capitalised word sequences. A single capitalised word is
  // only trusted mid-sentence (sentence starts are too ambiguous), unless
  // it is a multi-word phrase, where every part agrees.
  out = out.replace(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*/g, (match, offset) => {
    const before = out.slice(0, offset).trimEnd();
    const atSentenceStart = before === '' || /[.!?…]["'”)]?$/.test(before);
    const words = match.split(/\s+/);
    if (atSentenceStart && words.length === 1) {
      if (SENTENCE_STARTERS.has(words[0].toLowerCase())) return match;
      // A lone capitalised word opening a sentence could still be a name
      // (e.g. "Karachi is ..."). Protect it only if it is not a starter word.
      return stash(match, 'entity');
    }
    if (atSentenceStart && SENTENCE_STARTERS.has(words[0].toLowerCase())) {
      // e.g. "The University of ..." — protect from the second word on.
      const rest = words.slice(1).join(' ');
      if (!rest) return match;
      return `${words[0]} ${stash(rest, 'entity')}`;
    }
    return stash(match, 'entity');
  });

  return { protectedText: out, store };
}

function restoreEntities(text, store) {
  let out = text;
  for (const { placeholder, value } of store) {
    out = out.split(placeholder).join(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Pass 2a — REWRITE (demo / rule-based engine, fully offline)         */
/* ------------------------------------------------------------------ */

// Robotic filler & stiff connectors -> simple everyday wording.
const PHRASE_REPLACEMENTS = [
  ["it is important to note that", ''],
  ["it should be noted that", ''],
  ["it is worth mentioning that", ''],
  ["in today's fast-paced world", 'today'],
  ['in the modern world', 'today'],
  ['due to the fact that', 'because'],
  ['in spite of the fact that', 'even though'],
  ['a large number of', 'many'],
  ['a majority of', 'most'],
  ['in the event that', 'if'],
  ['in order to', 'to'],
  ['as a result', 'so'],
  ['in addition', 'also'],
  ['in conclusion', 'so'],
  ['to sum up', 'so'],
  ['prior to', 'before'],
  ['subsequent to', 'after'],
  ['nevertheless', 'still'],
  ['consequently', 'so'],
  ['furthermore', 'also'],
  ['moreover', 'also'],
  ['therefore', 'so'],
  ['however', 'but'],
  ['additionally', 'also'],
];

// Formal -> simple synonyms (40+ base pairs, plus inflected forms).
const SYNONYMS = {
  utilise: 'use', utilize: 'use', utilises: 'uses', utilizes: 'uses',
  utilised: 'used', utilized: 'used',
  demonstrate: 'show', demonstrates: 'shows', demonstrated: 'showed',
  approximately: 'about', purchase: 'buy', commence: 'begin',
  terminate: 'end', sufficient: 'enough', numerous: 'many',
  assist: 'help', assists: 'helps', assistance: 'help',
  obtain: 'get', obtains: 'gets', obtained: 'got',
  require: 'need', requires: 'needs', required: 'needed',
  attempt: 'try', attempts: 'tries', concerning: 'about', regarding: 'about',
  individuals: 'people', participate: 'take part', participates: 'takes part',
  implement: 'carry out', establish: 'set up', significant: 'important',
  considerable: 'big', objective: 'goal', methodology: 'method',
  currently: 'now', frequently: 'often', generally: 'usually',
  additional: 'extra', initial: 'first', previous: 'earlier',
  difficult: 'hard', complex: 'hard', retain: 'keep', maintain: 'keep',
  provide: 'give', provides: 'gives', provided: 'gave',
  receive: 'get', receives: 'gets', ensure: 'make sure',
  permit: 'allow', permits: 'allows', request: 'ask for',
  inform: 'tell', respond: 'reply', examine: 'look at',
  determine: 'find out', construct: 'build', select: 'choose',
  essential: 'important', crucial: 'important', vital: 'important',
  beneficial: 'helpful', enhance: 'improve', facilitate: 'help',
  comprehend: 'understand', emphasise: 'stress', emphasize: 'stress',
  nowadays: 'these days', children: 'kids',
};

// Canonical forms so the meaning check treats known synonyms as equal.
const CANONICAL = {};
for (const [formal, simple] of Object.entries(SYNONYMS)) {
  CANONICAL[formal] = simple.split(' ')[0];
  CANONICAL[simple.split(' ')[0]] = simple.split(' ')[0];
}
// One build-loop artefact: "nowadays" -> "these days" has a STOPWORD as
// its head word, so head-word canonicalisation would map the input word
// to a stopword the output side then drops — an unfair mismatch. The
// content word of the phrase is "day", so both directions use it.
CANONICAL.nowadays = 'day';

// Multi-word approved synonyms ("take part", "carry out", "look at"…)
// collapse to the SAME canonical token the formal word maps to, so the
// checker treats the simple phrase and the formal word as one concept
// in both directions (see normalizeForCheck).
const SIMPLE_PHRASE_CANON = {};
for (const [formal, simple] of Object.entries(SYNONYMS)) {
  if (simple.includes(' ')) SIMPLE_PHRASE_CANON[simple] = CANONICAL[formal];
}

// Safe alternatives used ONLY by repetition reduction (3rd+ occurrence).
// They are registered in CANONICAL too, so the meaning/coverage checks
// treat "students" and "learners" as the same concept — exactly like
// the approved synonyms above.
const REPETITION_ALTERNATIVES = {
  student: 'learner', students: 'learners',
  teacher: 'instructor', teachers: 'instructors',
};
for (const [word, alt] of Object.entries(REPETITION_ALTERNATIVES)) {
  CANONICAL[word] = alt.split(' ')[0];
  CANONICAL[alt.split(' ')[0]] = alt.split(' ')[0];
}

const CONTRACTIONS = [
  ['do not', "don't"], ['does not', "doesn't"], ['did not', "didn't"],
  ['is not', "isn't"], ['are not', "aren't"], ['was not', "wasn't"],
  ['were not', "weren't"], ['will not', "won't"], ['would not', "wouldn't"],
  ['could not', "couldn't"], ['should not', "shouldn't"],
  ['have not', "haven't"], ['has not', "hasn't"], ['cannot', "can't"],
  ['it is', "it's"], ['that is', "that's"], ['there is', "there's"],
  ['i am', "i'm"], ['we are', "we're"], ['they are', "they're"],
  ['you are', "you're"], ['let us', "let's"],
];
const EXPANSIONS = CONTRACTIONS.map(([full, short]) => [short, full]);

function matchCase(original, replacement) {
  if (!replacement) return replacement;
  if (original.charAt(0) === original.charAt(0).toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function replacePhrase(text, from, to, all) {
  const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  if (all) return text.replace(re, (m) => matchCase(m, to));
  return text.replace(re, (m) => matchCase(m, to)); // deterministic: phrases always go
}

function applySynonyms(text, intensity) {
  let out = text;
  const seen = new Set();
  for (const [formal, simple] of Object.entries(SYNONYMS)) {
    const re = new RegExp(`\\b${formal}\\b`, 'gi');
    if (intensity === 'Light') {
      out = out.replace(re, (m) => {
        const key = formal.toLowerCase();
        if (seen.has(key)) return m; // Light: first occurrence per word only
        seen.add(key);
        return matchCase(m, simple);
      });
    } else {
      out = out.replace(re, (m) => matchCase(m, simple));
    }
  }
  return out;
}

function splitLongSentences(text, minBefore = 6, minAfter = 5) {
  // Split on ';' always; split on ', and' only when both sides are real
  // clauses. The thresholds come from the purpose preset (v3): Email /
  // Marketing pass lower values (shorter sentences), Story passes
  // higher ones (long flowing sentences survive).
  let out = text.replace(/\s*;\s*/g, '. ');
  out = out.replace(/, and /g, (m, offset, whole) => {
    const before = whole.slice(0, offset);
    const lastSentence = before.slice(Math.max(before.lastIndexOf('. '), 0));
    const afterWords = whole.slice(offset + m.length).split(/\s+/).length;
    if (lastSentence.trim().split(/\s+/).length >= minBefore && afterWords >= minAfter) return '. And ';
    return m;
  });
  return out;
}

function tidy(text) {
  return text
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s{2,}/g, ' ')
    .replace(/(^\s*[a-z])|([.!?]\s+[a-z])/g, (m) => m.toUpperCase())
    .trim();
}

/* --- Technique 7: GRAMMAR CORRECTION (safe, deterministic) ---------
 * Conservative surface rules ONLY: doubled function words ("the the"),
 * standalone "i" -> "I", "a" -> "an" before a vowel sound (small
 * exception list for words like "university" / "one"), and a missing
 * space after sentence punctuation. This runs while entities are
 * still placeholders (⟦E1⟧…), so names/numbers/dates can never be
 * touched by it; spacing + capitalisation finish in tidy(). */
const A_AN_EXCEPTIONS = new Set([
  'one', 'once', 'university', 'unit', 'united', 'unique', 'user',
  'users', 'useful', 'european', 'eulogy',
]);

function grammarFix(text) {
  let out = text;
  // Doubled function word: "the the" -> "the" (content words untouched).
  out = out.replace(
    /\b(the|a|an|of|to|in|on|at|is|are|was|were|and|or|but)\s+\1\b/gi,
    '$1',
  );
  // Standalone lower-case "i" is always the pronoun.
  out = out.replace(/\bi\b/g, 'I');
  // "a online" -> "an online" (vowel letter, not an exception word).
  out = out.replace(/\b(a|A) (\w+)/g, (m, art, next) => {
    if (!/^[aeiou]/i.test(next) || A_AN_EXCEPTIONS.has(next.toLowerCase())) return m;
    return `${art === 'A' ? 'An' : 'an'} ${next}`;
  });
  // Missing space after punctuation: "end.Start" -> "end. Start".
  // Safe here: decimals/URLs/emails are digits or placeholders by now.
  out = out.replace(/([.,;:!?])([A-Za-z])/g, '$1 $2');
  return tidy(out);
}

/* --- Technique 6: TRANSITION OPTIMIZATION --------------------------
 * After the 1:1 connector swaps, polish sentence-initial transitions:
 * the same transition may not head two consecutive sentences, and a
 * transition used for the 2nd/3rd time is varied or dropped (these
 * words are glue, so varying/dropping them cannot change a fact).
 * This fixes the v1 cosmetic flaw "Also, … Also, … So, … So, …". */
const TRANSITION_VARIANTS = {
  also: ['And', null],
  so: ['That is why', null],
  but: ['Yet', null],
  still: ['Yet', null],
  yet: ['But', null],
  and: [null],
  then: [null],
};

function optimizeTransitions(text, strict = false) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const seen = new Map();
  const out = [];
  for (const sentence of sentences) {
    const m = sentence.match(/^(Also|But|So|Still|Yet|And|Then)(,)?\s+/i);
    if (!m) { out.push(sentence); continue; }
    const canon = m[1].toLowerCase();
    const n = (seen.get(canon) || 0) + 1;
    seen.set(canon, n);
    if (n === 1) { out.push(sentence); continue; }
    const variants = TRANSITION_VARIANTS[canon] || [null];
    const choice = strict ? null : variants[(n - 2) % variants.length];
    const rest = sentence.slice(m[0].length);
    if (choice) {
      // "And students…", "Yet many…", "That is why online…" (no comma).
      const decapped = /^[A-Z][a-z]/.test(rest)
        ? rest.charAt(0).toLowerCase() + rest.slice(1)
        : rest;
      out.push(`${choice} ${decapped}`);
    } else {
      out.push(rest.charAt(0).toUpperCase() + rest.slice(1)); // dropped
    }
  }
  return out.join(' ');
}

/* --- Technique 8 (rewrite side): REPETITION REDUCTION --------------
 * Count content words as the text is scanned; from the 3rd occurrence
 * of a word on, swap in a safe alternative where one exists (the
 * REPETITION_ALTERNATIVES map defined with the synonyms, else the
 * approved synonym map). Words without a safe alternative are left
 * exactly as they are. */
function reduceRepetition(text, fromOccurrence = 3) {
  const counts = new Map();
  return text.replace(/[A-Za-z][A-Za-z'-]*/g, (m) => {
    const lower = m.toLowerCase();
    if (STOPWORDS.has(lower) || lower.length < 2) return m;
    const key = stem(lower.replace(/['-]/g, ''));
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    if (n >= fromOccurrence) {
      const alt = REPETITION_ALTERNATIVES[lower] || SYNONYMS[lower];
      if (alt) return matchCase(m, alt);
    }
    return m;
  });
}

/* Strategy B helper: merge a very short sentence (<6 words) into the
 * next one with ", and" — only when the combined sentence stays a
 * reasonable length (<= 30 words), so nothing turns into a run-on. */
function mergeShortSentences(text) {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const out = [];
  for (let i = 0; i < sentences.length; i += 1) {
    const cur = sentences[i];
    const next = sentences[i + 1];
    const curWords = cur.split(/\s+/).filter(Boolean).length;
    if (next && curWords < 6 && /[.!?]$/.test(cur)) {
      const combined = curWords + next.split(/\s+/).filter(Boolean).length;
      if (combined <= 30) {
        const head = cur.replace(/[.!?]$/, '');
        const tail = /^[A-Z][a-z]/.test(next)
          ? next.charAt(0).toLowerCase() + next.slice(1)
          : next;
        out.push(`${head}, and ${tail}`);
        i += 1;
        continue;
      }
    }
    out.push(cur);
  }
  return out.join(' ');
}

/* Strategy D helper: split one sentence at a safe clause boundary —
 * ", and" / ", but" / ", so" / ";" — choosing the boundary nearest the
 * middle where BOTH sides keep at least 5 words (a real clause each).
 * Only the boundary punctuation and the tail's capitalisation change;
 * the word sequence is untouched, so meaning cannot move. */
function splitSentenceAtClause(sentence) {
  const boundaries = [', and ', ', but ', ', so ', '; '];
  const total = sentence.split(/\s+/).filter(Boolean).length;
  let best = null;
  for (const sep of boundaries) {
    let idx = sentence.indexOf(sep);
    while (idx !== -1) {
      const headWords = sentence.slice(0, idx).split(/\s+/).filter(Boolean).length;
      const tailWords = total - headWords;
      if (headWords >= 5 && tailWords >= 5) {
        const dist = Math.abs(headWords - total / 2);
        if (!best || dist < best.dist) best = { idx, sep, dist };
      }
      idx = sentence.indexOf(sep, idx + 1);
    }
  }
  if (!best) return null;
  const head = sentence.slice(0, best.idx).replace(/[\s;]+$/, '');
  let tail = sentence.slice(best.idx + best.sep.length);
  if (best.sep !== '; ') {
    const conj = best.sep.replace(/[, ]/g, '');
    tail = `${conj.charAt(0).toUpperCase() + conj.slice(1)} ${tail}`;
  } else {
    tail = tail.charAt(0).toUpperCase() + tail.slice(1);
  }
  return [`${head}.`, tail];
}

/* Strategy D helper: BURSTINESS PASS. Human writing mixes very short
 * and long sentences; machine text hovers at one length. This pass
 * only restructures at clause/sentence boundaries — it splits a
 * sentence at a safe clause boundary (", and" / ", but" / ", so" /
 * ";"), or merges two adjacent sentences with ", and". The search is
 * greedy: every round, ALL safe moves are scored by the sentence-
 * length spread (std-dev) they would produce, and only the single
 * best IMPROVING move is applied, until the spread reaches a human-
 * like level or no safe move improves it. Not one content word is
 * added, dropped or reordered inside a clause, so the meaning gate
 * sees exactly the same facts before and after. */
function varySentenceLengths(text) {
  const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
  const std = (xs) => {
    if (xs.length === 0) return 0;
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
  };
  const spread = (arr) => std(arr.map(wordCount));
  const mergePair = (a, b) => {
    const head = a.replace(/\.$/, '');
    const tail = /^[A-Z][a-z]/.test(b) ? b.charAt(0).toLowerCase() + b.slice(1) : b;
    return `${head}, and ${tail}`;
  };
  let sentences = sentenceList(text);
  for (let round = 0; round < 6 && sentences.length >= 2; round += 1) {
    const cur = spread(sentences);
    if (cur >= 7) break;
    let best = null;
    for (let i = 0; i < sentences.length; i += 1) {
      // Candidate move 1: split sentence i at a clause boundary.
      if (wordCount(sentences[i]) >= 16) {
        const parts = splitSentenceAtClause(sentences[i]);
        if (parts) {
          const next = [...sentences.slice(0, i), ...parts, ...sentences.slice(i + 1)];
          const s = spread(next);
          if (s > cur + 0.01 && (!best || s > best.s)) best = { next, s };
        }
      }
      // Candidate move 2: merge sentences i and i+1.
      if (i + 1 < sentences.length) {
        const a = sentences[i];
        const b = sentences[i + 1];
        const wa = wordCount(a);
        // Guards: combined length cap; head must be a plain statement
        // (never absorb a question/exclamation); never merge across
        // an abbreviation fragment (the PROTECT pass leaves "Dear
        // Mr." as "⟦E1⟧ ⟦E2⟧." — a two-word pseudo-sentence that
        // must round-trip untouched); never merge into a But/However-
        // led sentence (", and but …" / ", and however …" are wrong).
        if (wa + wordCount(b) <= 34 && /\.$/.test(a)
          && !(wa < 4 && /⟦E\d+⟧\.$/.test(a))
          && !/^(But|However)\b/i.test(b)) {
          const next = [...sentences.slice(0, i), mergePair(a, b), ...sentences.slice(i + 2)];
          const s = spread(next);
          if (s > cur + 0.01 && (!best || s > best.s)) best = { next, s };
        }
      }
    }
    if (!best) break;
    sentences = best.next;
  }
  return sentences.join(' ');
}

/* The demo engine generates up to FOUR candidate strategies for the
 * Naturalness Optimization Loop:
 *   A — standard pipeline for the chosen mode/intensity
 *   B — stronger restructuring: forced sentence splitting + merging
 *       of very short sentences (bigger sentence-length variation)
 *   C — rotation emphasis: synonyms rotate from the 2nd occurrence
 *       and transition de-duplication runs in its strictest form
 *   D — Fidelity+Flow (v3.1): light-touch rewrite (phrase fixes,
 *       contractions, grammar — synonym swaps kept minimal) plus the
 *       burstiness pass, for very high meaning with natural rhythm */
function demoRewrite(protectedText, mode, intensity, strategy = 'A', tune = {}) {
  let out = protectedText;

  // 1) Robotic filler & connectors
  for (const [from, to] of PHRASE_REPLACEMENTS) {
    out = replacePhrase(out, from, to, true);
  }

  // 2) Synonyms (Light is gentler than Medium/Strong). Strategy D is
  //    the fidelity path: synonym swaps stay minimal (Light = first
  //    occurrence of each formal word only).
  const simpleFirst = strategy === 'D'
    ? 'Light'
    : (mode === 'Simple' ? 'Strong' : intensity);
  out = applySynonyms(out, simpleFirst);

  // 3) Voice: contractions for natural/casual voices, expansions for
  //    formal ones. v3: a purpose preset or a Custom Voice sample can
  //    override the Mode default via tune.contraction ('on' | 'off'),
  //    resolved by the caller in humanize() (voice > purpose > mode).
  const contractionAction = tune.contraction
    || (mode === 'Natural' || mode === 'Casual' ? 'on'
      : (mode === 'Academic' || mode === 'Professional' ? 'off' : null));
  if (contractionAction === 'on') {
    for (const [full, short] of CONTRACTIONS) {
      out = replacePhrase(out, full, short, true);
    }
  } else if (contractionAction === 'off') {
    for (const [short, full] of EXPANSIONS) {
      out = out.replace(new RegExp(`\\b${short.replace("'", "['’]")}\\b`, 'gi'),
        (m) => matchCase(m, full));
    }
  }

  // 4) Technique 8: repetition reduction (C rotates from the 2nd use;
  //    a purpose preset such as Marketing can also lower the trigger).
  //    Strategy D skips rotation entirely — fidelity first.
  if (strategy !== 'D') {
    out = reduceRepetition(out, tune.rotateFrom ?? (strategy === 'C' ? 2 : 3));
  }

  // 5) Sentence rhythm: split heavy sentences on Strong (and for
  //    Simple mode); strategy B always restructures, then merges
  //    shorts. v3: purpose presets can force the pass (Email /
  //    Marketing) and set its clause-size thresholds. Strategy D does
  //    its rhythm work in the burstiness pass instead (step 5b).
  if (strategy !== 'D'
    && (intensity === 'Strong' || (mode === 'Simple' && intensity === 'Medium')
      || strategy === 'B' || tune.alwaysSplit)) {
    out = splitLongSentences(out, tune.splitMinBefore ?? 6, tune.splitMinAfter ?? 5);
  }
  if (strategy === 'B') out = mergeShortSentences(out);

  // 5b) Strategy D: burstiness pass — vary sentence lengths by safe
  //     clause-boundary splits and short-sentence merges only.
  if (strategy === 'D') out = varySentenceLengths(out);

  // 6) Technique 6: transition optimization (C = strictest form)
  out = optimizeTransitions(out, strategy === 'C');

  // 7) Technique 7: grammar correction + tidy (entities are still
  //    placeholders at this point, so this can never touch them)
  return grammarFix(out);
}

/* ------------------------------------------------------------------ */
/* Pass 3 — MEANING CHECK                                              */
/* ------------------------------------------------------------------ */

const STOPWORDS = new Set((
  'the a an and or but if then else when while of at by for with about against between into through during before after above below to from up down in out on off over under again further once here there all any both each few more most other some such no nor not only own same so than too very can will just is am are was were be been being have has had having do does did doing would should could ought i you he she it we they me him her us them my your his its our their mine yours ours theirs this that these those as because until per via etc'
).split(' '));

function stem(word) {
  let w = CANONICAL[word] || word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

/* Checker-side equivalence normalisation (v3.1). Applied to BOTH the
 * original and the rewrite before any meaning/coverage counting, and
 * containing ONLY rewrites the demo engine itself can perform, so the
 * two sides are compared in the engine's own vocabulary:
 *   1. multi-word approved synonyms collapse to their canonical token
 *      ("take part" -> the token "participate" canonicalises to);
 *   2. the engine's PHRASE_REPLACEMENTS map is applied verbatim
 *      (longest phrase first), including the empty-string deletions,
 *      plus the one multi-word transition variant the transition
 *      optimiser can emit ("that is why" is its variant of "so");
 *   3. contractions expand via EXPANSIONS — the exact map the
 *      negation lock already uses — plus the generic n't rule.
 * Nothing topic-related is equated here; a word the engine never
 * touches keeps its own identity on both sides. */
const PHRASE_EQUIVALENCES = [...PHRASE_REPLACEMENTS, ['that is why', 'so']]
  .sort((a, b) => b[0].length - a[0].length);

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeForCheck(text) {
  let t = text;
  for (const [phrase, canon] of Object.entries(SIMPLE_PHRASE_CANON)) {
    t = t.replace(new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi'), canon);
  }
  for (const [from, to] of PHRASE_EQUIVALENCES) {
    t = t.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, 'gi'), to);
  }
  for (const [short, full] of EXPANSIONS) {
    t = t.replace(new RegExp(`\\b${short.replace("'", "['’]")}\\b`, 'gi'), ` ${full} `);
  }
  t = t.replace(/(\w+)n['’]t\b/gi, '$1 not');
  return t;
}

function contentWordList(text) {
  const tokens = normalizeForCheck(text).toLowerCase()
    .match(/[a-z][a-z'-]*|\d[\d,]*(?:\.\d+)?%?/g) || [];
  const list = [];
  for (const raw of tokens) {
    const w = raw.replace(/['-]/g, '');
    if (!w || STOPWORDS.has(w)) continue;
    list.push(stem(w));
  }
  return list;
}

function contentWordFreq(text) {
  const freq = new Map();
  for (const key of contentWordList(text)) {
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  return freq;
}

/* --- Technique 9: READABILITY ANALYSIS (Flesch Reading Ease) -------
 * Standard formula: 206.835 - 1.015 x (words/sentences)
 *                            - 84.6  x (syllables/words).
 * Syllables use the usual heuristic (vowel groups, silent-e rule).
 * REPORT-ONLY: never a gate condition, so a hard-but-faithful rewrite
 * is never rejected just for being hard to read. */
function syllableCount(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const groups = w.match(/[aeiouy]+/g);
  let n = groups ? groups.length : 1;
  if (w.endsWith('e') && n > 1) n -= 1; // silent e
  return Math.max(1, n);
}

function fleschReadingEase(text) {
  const words = text.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (words.length === 0) return 0;
  const sentences = Math.max(
    1,
    text.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean).length,
  );
  const syllables = words.reduce((sum, w) => sum + syllableCount(w), 0);
  const score = 206.835
    - 1.015 * (words.length / sentences)
    - 84.6 * (syllables / words.length);
  return Math.round(score * 10) / 10;
}

/* --- Technique 8 (measurement side): REPETITION INDEX --------------
 * One combined index, identical formula for input and output:
 *   + (count - 2) for every content word occurring 3+ times
 *   + (count - 1) for every repeated content-word bigram
 * Words are compared by SURFACE stem (suffix rules only, no synonym
 * canonicalisation): repetition is something a reader sees on the
 * page, so "students … learners …" genuinely counts as reduced.
 * 0 means no noticeable repetition. REPORT-ONLY, not a gate rule. */
function stemSurface(word) {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('es')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  return w;
}

function surfaceContentList(text) {
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]*|\d[\d,]*(?:\.\d+)?%?/g) || [];
  const list = [];
  for (const raw of tokens) {
    const w = raw.replace(/['-]/g, '');
    if (!w || STOPWORDS.has(w)) continue;
    list.push(stemSurface(w));
  }
  return list;
}

function bigramExtras(list) {
  const bigrams = new Map();
  for (let i = 0; i + 1 < list.length; i += 1) {
    const bg = `${list[i]} ${list[i + 1]}`;
    bigrams.set(bg, (bigrams.get(bg) || 0) + 1);
  }
  let extras = 0;
  for (const v of bigrams.values()) if (v >= 2) extras += v - 1;
  return extras;
}

function repetitionIndex(text) {
  const list = surfaceContentList(text);
  const freq = new Map();
  for (const k of list) freq.set(k, (freq.get(k) || 0) + 1);
  let index = 0;
  for (const v of freq.values()) if (v >= 3) index += v - 2;
  return index + bigramExtras(list);
}

/* ================================================================== */
/* NATURALNESS SCORE + OPTIMIZATION LOOP (the proposal's headline)   */
/*                                                                    */
/* Engineering target: push AI-signal characteristics as close to    */
/* zero as honestly possible. This score measures WRITING PATTERNS   */
/* only — it is NOT any detector's score, and no detector result is  */
/* claimed or guaranteed anywhere in this project.                   */
/*                                                                    */
/*   25 pts  burstiness — std-dev of sentence lengths (uniform       */
/*           lengths are a machine trait; people mix short + long)   */
/*   20 pts  lexical diversity — type-token ratio, scaled            */
/*   25 pts  AI-marker phrases — hard penalty, target ZERO           */
/*   15 pts  starter variety — unique sentence-opening words ratio   */
/*    7 pts  repeated-bigram penalty                                 */
/*    8 pts  everyday-vocabulary ratio (compact common-words list)   */
/* ================================================================== */
const AI_MARKERS = [
  'furthermore', 'moreover', 'additionally', 'in conclusion', 'to sum up',
  'it is important to note', 'it should be noted', 'it is worth mentioning',
  "in today's fast-paced world", 'in todays fast-paced world',
  'in the modern world', 'delve', 'delves', 'delving', 'crucial',
  'pivotal', 'plays a vital role', 'plays an important role',
  'plays a crucial role', 'when it comes to', 'overall',
  'in addition', 'fast-paced', 'ever-evolving', 'landscape', 'tapestry',
];

const COMMON_WORDS = new Set((
  'the be to of and a in that it was for on are as with his they i at be this have from or one had by words but not what all were we when your can said there use an each which she do how their will up other about out many then them these so some her would make like him into time has look two more write go see number no way could people my than first water been call who oil its now find long down day did get come made may part over new sound take only little work know place year live me back give most very after thing our just name good sentence man think say great where help through much before line right too mean old any same boy follow came want show also around form three small set put end does another well large must big even such because turn here why ask went men read need land different home us move try kind hand picture again change off play spell air away animal house point page letter mother answer found study still learn should world high every near add food between own below country plant last school father keep tree never start city earth eye light thought head under story saw left few while along might close something seem next hard open example begin life always those both paper together got group often run dog horse cat bird fish room talk soon list song being leave family really love happy friend begin heard order red door sure become top ship across today during short better best however low hours black products happened whole measure remember early waves reached listen wind rock space covered fast several hold himself toward five step morning passed vowel true hundred against pattern numeral table north slowly money map busy pulled draw voice seen cold cried plan notice south sing war ground fall king town i\'ll unit figure certain field travel wood fire upon done english road half ten fly gave box finally wait correct oh quickly person produce given fact street ago mouth note fear week whom strong special ran mind behind clear tail produce fact wonder lost inches pound among sugar example phrase thin dry though training sleep village result brother join buy tomorrow whom skin grass cow compare sentence people students student learn learning school book read write watch video online class lesson teacher question answer problem work works home day days week time years year make makes made take takes took give gives gave get gets got go goes went come comes came see sees saw know knows knew think thinks thought feel feels felt want wants use uses used find finds found tell tells told ask asks asked seem seems leave leaves left put puts set sets end ends means meant keep keeps kept let lets begin began bring brings brought write writes ten ten'
).split(/\s+/));

function countAiMarkers(text) {
  const t = text.toLowerCase();
  let count = 0;
  for (const marker of AI_MARKERS) {
    const re = new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    const hits = t.match(re);
    if (hits) count += hits.length;
  }
  return count;
}

function sentenceList(text) {
  return text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
}

function naturalnessScore(text) {
  const clamp01 = (x) => Math.min(1, Math.max(0, x));
  const sentences = sentenceList(text);
  const words = text.toLowerCase().match(/[a-z][a-z'-]*/g) || [];
  if (words.length === 0 || sentences.length === 0) return 0;

  // (a) burstiness: std-dev of per-sentence word counts
  const lengths = sentences.map((s) => (s.match(/[a-z][a-z'-]*/gi) || []).length);
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const sd = Math.sqrt(lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length);
  const burst = clamp01(sd / 7);

  // (b) lexical diversity (surface stems)
  const stems = words.map((w) => stemSurface(w.replace(/['-]/g, '')));
  const ttr = new Set(stems).size / words.length;
  const diversity = clamp01((ttr - 0.30) / 0.40);

  // (c) AI markers: each occurrence wipes half of this component
  const markers = countAiMarkers(text);
  const markerScore = Math.max(0, 1 - 0.5 * markers);

  // (d) starter variety
  const starters = sentences.map((s) => {
    const w = s.match(/[A-Za-z][A-Za-z'-]*/);
    return w ? w[0].toLowerCase() : '';
  });
  const starterRatio = new Set(starters).size / sentences.length;

  // (e) repeated bigrams
  const extras = bigramExtras(surfaceContentList(text));
  const bigramScore = Math.max(0, 1 - 0.34 * extras);

  // (f) everyday vocabulary ratio
  const common = words.filter((w) => COMMON_WORDS.has(w)).length;
  const everyday = clamp01((common / words.length - 0.35) / 0.30);

  return Math.round(
    25 * burst + 20 * diversity + 25 * markerScore
    + 15 * starterRatio + 7 * bigramScore + 8 * everyday,
  );
}

function meaningScore(input, output) {
  const a = contentWordFreq(input);
  const b = contentWordFreq(output);
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const v of a.values()) normA += v * v;
  for (const v of b.values()) normB += v * v;
  for (const [k, v] of a.entries()) if (b.has(k)) dot += v * b.get(k);
  const cos = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.round(cos * 100);
}

function extractNumbers(text) {
  return text.match(/\d[\d,]*(?:\.\d+)?/g) || [];
}

function sameMultiset(a, b) {
  if (a.length !== b.length) return false;
  const count = new Map();
  for (const x of a) count.set(x, (count.get(x) || 0) + 1);
  for (const x of b) {
    if (!count.get(x)) return false;
    count.set(x, count.get(x) - 1);
  }
  return true;
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/* ---------------- v2 check: NEGATION LOCK ------------------------- */
/* The most dangerous rewrite error is a flipped negation ("do not
 * allow" -> "allow"). Both sides are normalised the same way —
 * contractions are expanded first (don't -> do not, can't -> cannot,
 * won't -> will not) — and the negation words must then match EXACTLY
 * as a multiset: same words, same counts. */
const NEGATION_WORDS = new Set([
  'not', 'no', 'never', 'none', 'cannot', 'without', 'neither', 'nor',
  'nobody', 'nothing', 'nowhere', 'hardly', 'scarcely',
]);

function extractNegations(text) {
  let t = ` ${text.toLowerCase()} `;
  // Expand known contractions (EXPANSIONS covers don't, can't, won't…).
  for (const [short, full] of EXPANSIONS) {
    const re = new RegExp(`\\b${short.replace("'", "['’]")}\\b`, 'g');
    t = t.replace(re, ` ${full} `);
  }
  // Any remaining n't form (e.g. an unusual contraction) -> " not".
  t = t.replace(/(\w+)n['’]t\b/g, '$1 not');
  const tokens = t.match(/[a-z]+/g) || [];
  return tokens.filter((w) => NEGATION_WORDS.has(w));
}

/* ---------------- v2 checks: FACT COVERAGE / NO NEW FACTS --------- */
/* Concepts = the distinct stemmed, synonym-canonicalised content
 * words produced by the same machinery as the meaning score. Before
 * any counting, BOTH sides pass through normalizeForCheck(), which
 * applies ONLY equivalences the engine itself can produce:
 *  - multi-word approved synonyms ("take part", "carry out", "look
 *    at"…) collapse to the formal word's canonical token, so using
 *    the simple phrase counts as the same concept as the formal word,
 *    and the helper word ("part", "out") is not counted as a new fact;
 *  - the demo engine's own PHRASE_REPLACEMENTS are applied to the
 *    text being checked, so a filler phrase the engine rewrites or
 *    deletes as a unit ("in order to" -> "to", "due to the fact
 *    that" -> "because", "it is important to note that" -> "")
 *    compares equal to its replacement on the other side;
 *  - contractions are expanded with the same map the negation lock
 *    uses, so "can't" and "cannot" (a swap the engine itself makes)
 *    are the same token, and "don't" leaves no phantom concept.
 * On top of that, GLUE_WORDS (discourse markers: furthermore,
 * however, also…) carry no facts, so they are excluded from both
 * concept sets. */
const GLUE_WORDS = new Set([
  'furthermore', 'moreover', 'however', 'therefore', 'additionally',
  'consequently', 'nevertheless', 'meanwhile', 'instead', 'also',
  'addition', 'conclusion', 'overall', 'important', 'note', 'noted',
  'why', // only surfaces via the "That is why" transition variant
  // "yet" / "still" only ever appear here as the transition variants
  // optimizeTransitions() itself emits for but/still — pure glue, the
  // engine varies or drops them exactly like the words above.
  'yet', 'still',
]);

function conceptSet(text) {
  // All equivalence normalisation (multi-word synonyms, the engine's
  // own phrase swaps, contraction expansion) happens inside
  // contentWordList — see normalizeForCheck — identically for both
  // sides, so this function only has to drop the glue words.
  const freq = contentWordFreq(text);
  const set = new Set();
  for (const key of freq.keys()) {
    if (!GLUE_WORDS.has(key)) set.add(key);
  }
  return set;
}

/* ---------------- v2 GATE thresholds ------------------------------ */
const GATE = {
  meaningMin: 85, // raised from 70 in v2 — no room for drift
  coverageMin: 85, // % of input concepts that must survive
  newConceptMax: 20, // % of output concepts allowed to be new
  lengthMin: 0.6,
  lengthMax: 1.5,
};

function runChecks(original, output, store) {
  const protectedValues = store.map((s) => s.value);
  // Every protected value must survive in the output.
  const entitiesPreserved = protectedValues.every((v) => output.includes(v));
  const numbersPreserved = sameMultiset(extractNumbers(original), extractNumbers(output));
  const negationPreserved = sameMultiset(extractNegations(original), extractNegations(output));
  const ratio = wordCount(output) / Math.max(1, wordCount(original));
  const lengthRatio = Math.round(ratio * 100) / 100;
  const score = meaningScore(original, output);

  const inConcepts = conceptSet(original);
  const outConcepts = conceptSet(output);
  const missing = [...inConcepts].filter((c) => !outConcepts.has(c));
  const coverage = inConcepts.size === 0
    ? 100
    : Math.round(((inConcepts.size - missing.length) / inConcepts.size) * 100);
  const newConcepts = [...outConcepts].filter((c) => !inConcepts.has(c));
  const newConceptRatio = outConcepts.size === 0
    ? 0
    : Math.round((newConcepts.length / outConcepts.size) * 100);

  const lengthOk = lengthRatio >= GATE.lengthMin && lengthRatio <= GATE.lengthMax;
  const accepted =
    entitiesPreserved &&
    numbersPreserved &&
    negationPreserved &&
    lengthOk &&
    score >= GATE.meaningMin &&
    coverage >= GATE.coverageMin &&
    newConceptRatio <= GATE.newConceptMax;

  const checks = {
    entitiesPreserved,
    numbersPreserved,
    negationPreserved,
    lengthRatio,
    meaningScore: score,
    coverage,
    newConceptRatio,
    // Report-only technique stats (never gate conditions):
    readabilityIn: fleschReadingEase(original),
    readabilityOut: fleschReadingEase(output),
    repetitionIn: repetitionIndex(original),
    repetitionOut: repetitionIndex(output),
  };
  // Only attach the detail lists when the related check fails, so a
  // rejection explains itself without bloating a clean Accepted result.
  if (coverage < GATE.coverageMin) checks.missingConcepts = missing.slice(0, 8);
  if (newConceptRatio > GATE.newConceptMax) checks.newConcepts = newConcepts.slice(0, 8);
  return { checks, accepted };
}

/* ---------------- v2: DOUBLE VERIFICATION ------------------------- */
/* The whole check suite runs twice, independently: run 2 re-protects
 * the candidate output from scratch (a fresh PROTECT pass) and checks
 * again. Both runs must pass AND produce identical check values —
 * otherwise the candidate is not trustworthy and is rejected. */
function verify(original, output, store) {
  const first = runChecks(original, output, store);
  const reprotected = protectEntities(output);
  const second = runChecks(original, output, reprotected.store);
  const agree =
    first.accepted === second.accepted &&
    JSON.stringify(first.checks) === JSON.stringify(second.checks);
  const checks = { ...first.checks, doubleVerified: agree, verificationRuns: 2 };
  return { checks, accepted: first.accepted && second.accepted && agree };
}

/* Depth-aware verifier (v3): Advanced uses the full double
 * verification above. Basic (the faster QuillBot-style path) applies
 * the SAME six gate conditions in a single run — checks.verification
 * Runs says honestly how many runs backed the verdict, and
 * doubleVerified is false because only one run happened. */
function verifyWithDepth(original, output, store, depth) {
  if (depth === 'Basic') {
    const single = runChecks(original, output, store);
    return {
      checks: { ...single.checks, doubleVerified: false, verificationRuns: 1 },
      accepted: single.accepted,
    };
  }
  return verify(original, output, store);
}

/* ------------------------------------------------------------------ */
/* Pass 4 — GATE + main entry (browser port)                           */
/* ------------------------------------------------------------------ */

function humanizeLocal(text, mode = 'Natural', intensity = 'Medium', options = {}) {
  // Validation mirrors server.js exactly, so a local (in-browser) run
  // surfaces the same error messages the API would have returned.
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Please paste a paragraph first.');
  }
  if (!MODES.includes(mode)) {
    throw new Error(`Unknown mode. Choose one of: ${MODES.join(', ')}.`);
  }
  if (!INTENSITIES.includes(intensity)) {
    throw new Error(`Unknown intensity. Choose one of: ${INTENSITIES.join(', ')}.`);
  }
  const purpose = options.purpose === undefined ? 'General' : options.purpose;
  if (!PURPOSES.includes(purpose)) {
    throw new Error(`Unknown purpose. Choose one of: ${PURPOSES.join(', ')}.`);
  }
  const depth = options.depth === undefined ? 'Advanced' : options.depth;
  if (!DEPTHS.includes(depth)) {
    throw new Error(`Unknown depth. Choose one of: ${DEPTHS.join(', ')}.`);
  }
  if (options.voiceSample !== undefined && options.voiceSample !== null
    && typeof options.voiceSample !== 'string') {
    throw new Error('Voice sample must be text.');
  }
  const trimmed = text.trim();
  const words = trimmed.split(/\s+/).filter(Boolean).length;
  if (words < 10) {
    throw new Error('Paragraph is too short — please give at least 10 words.');
  }
  if (words > 1000) {
    throw new Error('Paragraph is too long — the limit is 1000 words.');
  }

  const safeMode = mode;
  const safeIntensity = intensity;
  const safePurpose = purpose;
  const safeDepth = depth;
  const stats = voiceStats(options.voiceSample || null);

  const { protectedText, store } = protectEntities(trimmed);
  const naturalnessIn = naturalnessScore(trimmed);

  // Purpose tuning + Custom Voice override — identical to the server.
  const tune = { ...purposeTuning(safePurpose) };
  if (stats) {
    const formalGuard = safeMode === 'Academic'
      && (safePurpose === 'Essay' || safePurpose === 'Assignment');
    if (!formalGuard) tune.contraction = stats.usesContractions ? 'on' : 'off';
  }
  const strategies = safeDepth === 'Basic' ? ['A'] : ['A', 'B', 'C', 'D'];

  /* NATURALNESS OPTIMIZATION LOOP (demo engine): generate the
   * strategy candidates (1 for Depth Basic, up to 4 for Advanced),
   * run EVERY one through the meaning gate first, and only then —
   * among the candidates that passed — pick the best selection score:
   * naturalness + min(22.5, 1.5 x max(0, meaning - 85)) + voice-match
   * bonus, under the Pareto guard (a candidate beaten on BOTH meaning
   * and naturalness by another passer can never win). The gate always
   * outranks the score: a meaning-flawed candidate is never selected. */
  const raw = [];
  for (const strategy of strategies) {
    raw.push(restoreEntities(
      demoRewrite(protectedText, safeMode, safeIntensity, strategy, tune), store,
    ));
  }

  // De-duplicate identical candidates, then gate-check each one.
  const candidates = [...new Set(raw)];
  const passed = [];
  let bestFailed = null;
  for (const candidate of candidates) {
    const verdict = verifyWithDepth(trimmed, candidate, store, safeDepth);
    const nat = naturalnessScore(candidate);
    const entry = {
      candidate,
      verdict,
      naturalness: nat,
      // v3.1 selection score — same formula as the server loop:
      // naturalness + min(22.5, 1.5 x max(0, meaning - 85)) + voice bonus.
      selectionScore: nat
        + Math.min(22.5, 1.5 * Math.max(0, verdict.checks.meaningScore - 85))
        + voiceBonus(candidate, stats),
    };
    if (verdict.accepted) {
      passed.push(entry);
    } else if (!bestFailed
      || verdict.checks.meaningScore > bestFailed.verdict.checks.meaningScore) {
      bestFailed = entry;
    }
  }

  if (passed.length > 0) {
    passed.sort((a, b) => b.selectionScore - a.selectionScore);
    // Pareto guard (v3.1): a candidate beaten on BOTH meaning and
    // naturalness by another passer can never win.
    const winner = passed.find((p) => !passed.some((q) => q !== p
      && q.verdict.checks.meaningScore > p.verdict.checks.meaningScore
      && q.naturalness > p.naturalness)) || passed[0];
    const winnerChecks = {
      ...winner.verdict.checks,
      naturalnessScore: winner.naturalness,
      naturalnessIn,
      candidatesTried: candidates.length,
      candidatesPassed: passed.length,
    };
    if (stats) winnerChecks.voiceMatch = true;
    return {
      output: winner.candidate,
      mode: safeMode,
      intensity: safeIntensity,
      purpose: safePurpose,
      depth: safeDepth,
      voice: stats,
      engine: 'demo',
      checks: winnerChecks,
      // COMPARE CANDIDATES: every gate-passing rewrite with its OWN
      // full checks, best first — same shape as the server response.
      candidates: passed.map((p) => ({
        text: p.candidate,
        naturalnessScore: p.naturalness,
        passed: true,
        checks: {
          ...p.verdict.checks,
          naturalnessScore: p.naturalness,
          naturalnessIn,
          candidatesTried: candidates.length,
          candidatesPassed: passed.length,
          ...(stats ? { voiceMatch: true } : {}),
        },
      })),
      winnerIndex: passed.indexOf(winner),
      status: 'Accepted',
    };
  }

  /* FAIL-SAFE: NO candidate passed the gate, so the user gets the
   * ORIGINAL paragraph back untouched — a flawed rewrite is never
   * presented as the result. checks.naturalnessScore describes the
   * DELIVERED output (the original), matching the server behaviour. */
  return {
    output: trimmed,
    mode: safeMode,
    intensity: safeIntensity,
    purpose: safePurpose,
    depth: safeDepth,
    voice: stats,
    engine: 'demo',
    checks: {
      ...bestFailed.verdict.checks,
      naturalnessScore: naturalnessIn,
      naturalnessIn,
      candidatesTried: candidates.length,
      candidatesPassed: 0,
      rejectedNaturalness: bestFailed.naturalness,
    },
    candidates: [],
    winnerIndex: -1,
    status: 'Returned original',
    rejectedOutput: bestFailed.candidate,
  };
}

/* Re-verify a USER-EDITED output (word-click synonym swap): runs the
 * full gate (double verification) locally on the edited text against
 * the original paragraph. The UI uses this to warn — never to revert —
 * when an edit breaks a check. */
function verifyEdit(original, edited) {
  const orig = typeof original === 'string' ? original.trim() : '';
  const out = typeof edited === 'string' ? edited.trim() : '';
  const { store } = protectEntities(orig);
  const verdict = verify(orig, out, store);
  return {
    accepted: verdict.accepted,
    checks: {
      ...verdict.checks,
      naturalnessScore: naturalnessScore(out),
      naturalnessIn: naturalnessScore(orig),
    },
  };
}

/* Alternatives for the word-click synonym swap: the approved formal
 * -> simple map in BOTH directions, plus the repetition alternatives.
 * A word with no safe alternative simply is not clickable. */
function synonymAlternatives(word) {
  const lower = String(word || '').toLowerCase();
  if (!lower) return [];
  const out = new Set();
  if (SYNONYMS[lower]) out.add(SYNONYMS[lower]);
  for (const [formal, simple] of Object.entries(SYNONYMS)) {
    if (simple === lower || simple.split(' ')[0] === lower) out.add(formal);
  }
  if (REPETITION_ALTERNATIVES[lower]) out.add(REPETITION_ALTERNATIVES[lower]);
  for (const [w, alt] of Object.entries(REPETITION_ALTERNATIVES)) {
    if (alt === lower) out.add(w);
  }
  out.delete(lower);
  return [...out];
}

/* ================================================================== */
/* PROFESSOR VIEW — analyzeText(text)                                  */
/* A Turnitin-STYLE instructor AI-writing report, heuristic edition.   */
/* Design follows the Turnitin research report (§8 clone design + the  */
/* report-layout / indicator sections): the percentage is the share    */
/* of QUALIFYING sentences (prose sentences in long-form writing;      */
/* lists, headings and quoted blocks are excluded) whose per-sentence  */
/* AI-pattern score crosses a threshold. Display states mirror         */
/* Turnitin's post-July-2024 rules exactly:                            */
/*   0%        -> "0%", no highlights                                  */
/*   1–19%     -> "*%" ONLY — no number and no highlights anywhere,    */
/*                because false positives are more likely in that band */
/*   20–100%   -> numeric %, flagged sentences highlighted blue        */
/* Intake mirrors Turnitin's file rules: at least 300 words of prose   */
/* for a report at all, and a 30,000-word ceiling.                     */
/*                                                                     */
/* HONESTY: this is NOT Turnitin. There is no proprietary transformer  */
/* model and no plagiarism/similarity database behind it — the         */
/* per-sentence score is a transparent heuristic over surface signals  */
/* only, and its percentages are UNVALIDATED estimates. Turnitin's     */
/* own guidance applies verbatim in spirit: an AI score is a single    */
/* data point, it may misidentify human and AI text, and it must       */
/* never be the sole basis for adverse action against a student.       */
/*                                                                     */
/* Per-sentence AI-pattern score (0..1), documented weights:           */
/*   0.45  AI-marker / stock phrases in the sentence (AI_MARKERS list, */
/*         0.6 per occurrence, capped at 1)                            */
/*   0.20  formulaic starter: a stock transition/opener, or the same   */
/*         content-word starter as the previous sentence (0.6)         */
/*   0.20  uniform structure: sentence length close to the document    */
/*         mean, discounted to 25% when the sentence carries           */
/*         "specifics" (a number, a quote, a contraction, or a         */
/*         mid-sentence capitalised word)                              */
/*   0.15  low lexical variety inside the sentence (stem type/token    */
/*         ratio below 0.75, scaled)                                   */
/* A sentence is FLAGGED at score >= AN_FLAG_THRESHOLD (0.65).         */
/* ================================================================== */
const AN_FLAG_THRESHOLD = 0.65;
const AN_MIN_WORDS = 300;
const AN_MAX_WORDS = 30000;

const AN_STOCK_OPENERS = [
  'furthermore', 'moreover', 'additionally', 'in addition', 'in conclusion',
  'overall', 'therefore', 'consequently', 'nevertheless', 'in summary',
  'to sum up', 'it is important to note', 'it should be noted',
  'it is worth mentioning', 'when it comes to', "in today's",
  'in the modern world', 'in recent years', 'first and foremost',
  'needless to say', 'lastly', 'in essence', 'in this essay',
  'this essay will', 'with the advancement of', 'as mentioned earlier',
];
const AN_STARTER_STOP = new Set([
  'the', 'a', 'an', 'it', 'he', 'she', 'they', 'we', 'i', 'my', 'his',
  'her', 'their', 'this', 'that', 'in', 'on', 'at', 'as', 'but', 'and',
  'so', 'if', 'when', 'while',
]);

function anWordCount(s) {
  return s.trim() ? s.trim().split(/\s+/).filter(Boolean).length : 0;
}

function anStem(w) {
  let s = w.replace(/['-]/g, '');
  if (s.length > 5 && s.endsWith('ing')) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith('ed')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('es')) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith('s') && !s.endsWith('ss')) s = s.slice(0, -1);
  return s;
}

/* Split the raw text into ordered segments: prose sentences (the only
 * QUALIFYING text) plus excluded non-prose lines (list items, ALL-CAPS
 * short headings, quoted blocks), each with its character offset in the
 * original text so integrity flags can be located. */
function anSegments(text) {
  const segments = [];
  const lines = text.split('\n');
  let offset = 0;
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const lineStart = offset;
    offset += rawLine.length + 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fromThisLine = [];
    const wordLike = trimmed.match(/[A-Za-z][A-Za-z'-]*/g) || [];
    const isList = /^\s*(?:[-*•▪◦]|\d{1,3}[.)])\s+\S/.test(line);
    const isQuoteBlock = /^\s*>/.test(line)
      || (/^\s*["“]/.test(line) && /["”]\s*$/.test(line));
    const isHeading = wordLike.length > 0 && wordLike.length <= 10
      && !/[a-z]/.test(trimmed) && /[A-Z]/.test(trimmed);
    if (isList || isQuoteBlock || isHeading) {
      fromThisLine.push({
        kind: 'excluded',
        sub: isList ? 'list item' : isQuoteBlock ? 'quoted block' : 'heading',
        text: trimmed,
        start: lineStart + line.indexOf(trimmed),
        flagged: false, score: null,
      });
    } else {
      const re = /[^.!?]+(?:[.!?]+["'”’)]*)?/g;
      let m;
      while ((m = re.exec(line)) !== null) {
        const raw = m[0];
        const t = raw.trim();
        if (!/[A-Za-z0-9]/.test(t)) continue;
        const lead = raw.length - raw.trimStart().length;
        fromThisLine.push({
          kind: 'prose', sub: 'sentence', text: t,
          start: lineStart + m.index + lead,
          flagged: false, score: null,
        });
      }
    }
    if (fromThisLine.length && segments.length) fromThisLine[0].newLine = true;
    segments.push(...fromThisLine);
  }
  segments.forEach((s, i) => { s.index = i; });
  return segments;
}

function anSentenceScore(sentence, prevStarter, meanLen) {
  const lower = sentence.toLowerCase();
  const words = lower.match(/[a-z][a-z'-]*/g) || [];

  // (1) AI-marker / stock phrases
  const markerComp = Math.min(1, countAiMarkers(sentence) * 0.6);

  // (2) formulaic starter
  let starterComp = 0;
  const stockHit = AN_STOCK_OPENERS.some(
    (p) => lower === p || lower.startsWith(`${p} `) || lower.startsWith(`${p},`),
  ) || /^(first|second|third|finally),\s/.test(lower);
  const firstWord = words.length ? words[0] : '';
  if (stockHit) starterComp = 1;
  else if (firstWord && firstWord === prevStarter && !AN_STARTER_STOP.has(firstWord)) starterComp = 0.6;

  // (3) uniform structure, discounted by "specifics"
  let uniformComp = 0;
  if (meanLen > 0) {
    const uniformity = 1 - Math.min(1, Math.abs(words.length - meanLen) / Math.max(6, meanLen * 0.6));
    const tokens = sentence.split(/\s+/);
    const hasSpecifics = /\d/.test(sentence) || /["“”]/.test(sentence)
      || /[a-z]'[a-z]/i.test(sentence)
      || tokens.slice(1).some((t) => /^[A-Z][a-z]+/.test(t));
    uniformComp = uniformity * (hasSpecifics ? 0.25 : 1);
  }

  // (4) low lexical variety within the sentence
  let lexicalComp = 0;
  if (words.length >= 4) {
    const ttr = new Set(words.map(anStem)).size / words.length;
    lexicalComp = Math.min(1, Math.max(0, (0.75 - ttr) / 0.45));
  }

  const score = 0.45 * markerComp + 0.20 * starterComp
    + 0.20 * uniformComp + 0.15 * lexicalComp;
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

const AN_HIDDEN = {
  '\u200B': ['U+200B', 'ZERO WIDTH SPACE'],
  '\u200C': ['U+200C', 'ZERO WIDTH NON-JOINER'],
  '\u200D': ['U+200D', 'ZERO WIDTH JOINER'],
  '\uFEFF': ['U+FEFF', 'ZERO WIDTH NO-BREAK SPACE (BYTE ORDER MARK)'],
};

function anFlags(text, segments) {
  const locate = (pos) => {
    let found = null;
    for (const s of segments) { if (s.start <= pos) found = s; else break; }
    return found;
  };
  const snippet = (seg) => (seg ? seg.text.slice(0, 90) : '');

  // (a) hidden / zero-width characters
  const hiddenByCode = new Map();
  let hiddenCount = 0;
  for (let i = 0; i < text.length; i += 1) {
    const meta = AN_HIDDEN[text[i]];
    if (!meta) continue;
    hiddenCount += 1;
    if (!hiddenByCode.has(meta[0])) {
      const seg = locate(i);
      hiddenByCode.set(meta[0], {
        code: meta[0], name: meta[1], count: 0,
        segment: seg ? seg.index : null, snippet: snippet(seg),
      });
    }
    hiddenByCode.get(meta[0]).count += 1;
  }

  // (b) replaced characters: Cyrillic/Greek lookalikes inside Latin words
  const homoWords = [];
  let homoChars = 0;
  const wordRe = /[\p{L}\p{M}]+/gu;
  let m;
  while ((m = wordRe.exec(text)) !== null) {
    const w = m[0];
    if (!/[A-Za-z]/.test(w)) continue; // purely non-Latin words are not "replaced characters"
    const bad = [...w].filter((c) => /[\u0370-\u03FF\u0400-\u04FF]/.test(c));
    if (!bad.length) continue;
    homoChars += bad.length;
    const seg = locate(m.index);
    homoWords.push({
      word: w,
      chars: bad.map((c) => ({
        char: c,
        code: `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
        script: /[\u0400-\u04FF]/.test(c) ? 'Cyrillic' : 'Greek',
      })),
      segment: seg ? seg.index : null,
      snippet: snippet(seg),
    });
  }

  return {
    hidden: { count: hiddenCount, items: [...hiddenByCode.values()] },
    homoglyphs: { count: homoChars, words: homoWords },
    total: (hiddenCount > 0 ? 1 : 0) + (homoChars > 0 ? 1 : 0),
  };
}

const AN_US_WORDS = [
  'color', 'behavior', 'favorite', 'honor', 'labor', 'neighbor', 'center',
  'theater', 'organize', 'organized', 'organization', 'recognize',
  'analyze', 'defense', 'catalog', 'traveled', 'traveling', 'modeling',
];
const AN_UK_WORDS = [
  'colour', 'behaviour', 'favourite', 'honour', 'labour', 'neighbour',
  'centre', 'theatre', 'organise', 'organised', 'organisation',
  'recognise', 'analyse', 'defence', 'catalogue', 'travelled',
  'travelling', 'modelling',
];

function anSpelling(text) {
  const lower = text.toLowerCase();
  const count = (list) => list.reduce((acc, w) => {
    const hits = lower.match(new RegExp(`\\b${w}\\b`, 'g'));
    return acc + (hits ? hits.length : 0);
  }, 0);
  return { us: count(AN_US_WORDS), uk: count(AN_UK_WORDS) };
}

function analyzeText(text) {
  const raw = typeof text === 'string' ? text : '';
  const segments = anSegments(raw);
  const prose = segments.filter((s) => s.kind === 'prose');
  const totalWords = anWordCount(raw);
  const qualifyingWords = prose.reduce((a, s) => a + anWordCount(s.text), 0);
  const flags = anFlags(raw, segments);
  const base = {
    threshold: AN_FLAG_THRESHOLD,
    counts: {
      totalWords,
      qualifyingWords,
      totalSentences: segments.length,
      qualifyingSentences: prose.length,
      excludedSegments: segments.length - prose.length,
    },
    sentences: segments,
    details: {
      avgSentenceLength: prose.length
        ? Math.round((qualifyingWords / prose.length) * 10) / 10 : 0,
      flaggedCount: null,
      spelling: anSpelling(raw),
    },
    flags,
  };

  if (totalWords < AN_MIN_WORDS || prose.length === 0) {
    return {
      ...base, state: 'tooShort', displayScore: null, percent: null,
      interpretation: `Not enough prose to analyse — a Turnitin-style report needs at least ${AN_MIN_WORDS} words of long-form prose, because very short texts give unstable, all-or-nothing results. This text has ${totalWords} word${totalWords === 1 ? '' : 's'}${prose.length === 0 && totalWords >= AN_MIN_WORDS ? ' and no prose sentences at all' : ''}. Paste a longer piece of writing (reports cover up to ${AN_MAX_WORDS.toLocaleString('en-US')} words).`,
    };
  }
  if (totalWords > AN_MAX_WORDS) {
    return {
      ...base, state: 'tooLong', displayScore: null, percent: null,
      interpretation: `This text is over the ${AN_MAX_WORDS.toLocaleString('en-US')}-word ceiling for an AI-writing report. Please analyse a shorter extract.`,
    };
  }

  const meanLen = qualifyingWords / prose.length;
  let prevStarter = '';
  for (const s of prose) {
    s.score = anSentenceScore(s.text, prevStarter, meanLen);
    s.flagged = s.score >= AN_FLAG_THRESHOLD;
    const w = s.text.toLowerCase().match(/[a-z][a-z'-]*/);
    prevStarter = w ? w[0] : '';
  }
  const flaggedCount = prose.filter((s) => s.flagged).length;
  const percent = Math.round((100 * flaggedCount) / prose.length);

  if (percent === 0) {
    return {
      ...base, state: 'zero', displayScore: '0%', percent: 0,
      details: { ...base.details, flaggedCount: 0 },
      interpretation: 'No AI-pattern sentences found in the qualifying text.',
    };
  }
  if (percent < 20) {
    // Turnitin's suppression rule, applied at the source: in the 1–19%
    // band NO number and NO highlights are attributed, because false
    // positives are more likely there. Flag/score data is stripped from
    // the payload itself, so the UI cannot leak it.
    for (const s of prose) { s.flagged = false; s.score = null; }
    return {
      ...base, state: 'low', displayScore: '*%', percent: null,
      interpretation: 'A small share of qualifying sentences showed AI-like patterns. The score is shown as *% with no number and no highlights, because false positives are more likely in this range — treat it only as a prompt for a closer look, not as a finding.',
    };
  }
  return {
    ...base, state: 'scored', displayScore: `${percent}%`, percent,
    details: { ...base.details, flaggedCount },
    interpretation: `${percent}% of the qualifying sentences crossed the AI-pattern threshold — the highlighted sentences are the ones to review first.`,
  };
}

/* Professor View runs fully client-side on static hosts; the server
 * exposes the identical function as POST /api/analyze. */
const analyzeLocal = analyzeText;


export {
  humanizeLocal, analyzeLocal, analyzeText, verifyEdit, synonymAlternatives,
  MODES, INTENSITIES, PURPOSES, PURPOSE_DEFAULTS, DEPTHS,
};
export default humanizeLocal;
