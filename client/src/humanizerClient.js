/**
 * humanizerClient.js — BROWSER PORT of the demo-engine pipeline in
 * server/humanizer.js. This is the SAME algorithm as the server's
 * demo mode: Pass 1 PROTECT (entities/numbers/dates locked behind
 * placeholders) -> Pass 2 demo REWRITE (3 strategy candidates) ->
 * Pass 3 the v2 six-check GATE, run twice (double verification) ->
 * Naturalness Optimization Loop (gate first, highest naturalness
 * among the passers wins) -> FAIL-SAFE (a rejected rewrite is never
 * delivered; the original comes back with status "Returned original").
 *
 * Differences from the server file, by design:
 *  - The LLM rewrite path is removed (no fetch, no API key in the
 *    browser), so `engine` in the result is always 'demo' here.
 *  - All server-only environment / module code is stripped; this is an ES
 *    module exporting humanizeLocal(text, mode, intensity), which is
 *    synchronous and returns exactly the API's response shape:
 *    { output, mode, intensity, engine, checks: {...}, status,
 *      rejectedOutput? } — and throws Errors with the same messages
 *    server.js returns for invalid input.
 * It exists so the fully static GitHub Pages build works with no
 * server at all; when the Express API IS reachable the app uses it
 * first and only falls back to this module (see App.jsx).
 */

/**
 * HumanizeAI — multi-pass humanizing pipeline.
 *
 * Pass 1  PROTECT : lock entities / numbers / dates / % / URLs / emails /
 *                   quotes / acronyms behind placeholders, restore after.
 * Pass 2  REWRITE : LLM (if a key is configured) or a deterministic
 *                   offline rule-based engine (demo mode, default).
 * Pass 3  CHECK   : SIX checks (v2) — entities & numbers preserved?
 *                   negations preserved exactly? meaning score
 *                   (content-word cosine overlap, 0-100)? fact coverage
 *                   (input concepts surviving)? no-new-facts ratio?
 *                   length ratio in band?
 * Pass 4  GATE    : the full check suite is run TWICE independently
 *                   (double verification, both runs must agree).
 *                   "Accepted" only if ALL six checks pass. FAIL-SAFE:
 *                   a rejected rewrite is NEVER delivered — the caller
 *                   gets the original paragraph back unchanged with
 *                   status "Returned original" and the flawed candidate
 *                   kept aside in `rejectedOutput` for transparency.
 */

const MODES = ['Natural', 'Simple', 'Academic', 'Casual', 'Professional'];
const INTENSITIES = ['Light', 'Medium', 'Strong'];

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

function splitLongSentences(text) {
  // Split on ';' always; split on ', and' only when both sides are real clauses.
  let out = text.replace(/\s*;\s*/g, '. ');
  out = out.replace(/, and /g, (m, offset, whole) => {
    const before = whole.slice(0, offset);
    const lastSentence = before.slice(Math.max(before.lastIndexOf('. '), 0));
    const afterWords = whole.slice(offset + m.length).split(/\s+/).length;
    if (lastSentence.trim().split(/\s+/).length >= 6 && afterWords >= 5) return '. And ';
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

/* The demo engine generates up to THREE candidate strategies for the
 * Naturalness Optimization Loop:
 *   A — standard pipeline for the chosen mode/intensity
 *   B — stronger restructuring: forced sentence splitting + merging
 *       of very short sentences (bigger sentence-length variation)
 *   C — rotation emphasis: synonyms rotate from the 2nd occurrence
 *       and transition de-duplication runs in its strictest form */
function demoRewrite(protectedText, mode, intensity, strategy = 'A') {
  let out = protectedText;

  // 1) Robotic filler & connectors
  for (const [from, to] of PHRASE_REPLACEMENTS) {
    out = replacePhrase(out, from, to, true);
  }

  // 2) Synonyms (Light is gentler than Medium/Strong)
  const simpleFirst = mode === 'Simple' ? 'Strong' : intensity;
  out = applySynonyms(out, simpleFirst);

  // 3) Voice: contractions for natural/casual voices, expansions for formal ones
  if (mode === 'Natural' || mode === 'Casual') {
    for (const [full, short] of CONTRACTIONS) {
      out = replacePhrase(out, full, short, true);
    }
  } else if (mode === 'Academic' || mode === 'Professional') {
    for (const [short, full] of EXPANSIONS) {
      out = out.replace(new RegExp(`\\b${short.replace("'", "['’]")}\\b`, 'gi'),
        (m) => matchCase(m, full));
    }
  }

  // 4) Technique 8: repetition reduction (C rotates from the 2nd use)
  out = reduceRepetition(out, strategy === 'C' ? 2 : 3);

  // 5) Sentence rhythm: split heavy sentences on Strong (and for
  //    Simple mode); strategy B always restructures, then merges shorts
  if (intensity === 'Strong' || (mode === 'Simple' && intensity === 'Medium')
    || strategy === 'B') {
    out = splitLongSentences(out);
  }
  if (strategy === 'B') out = mergeShortSentences(out);

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

function contentWordList(text) {
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]*|\d[\d,]*(?:\.\d+)?%?/g) || [];
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
 * words produced by the same machinery as the meaning score, with two
 * honest adjustments, applied identically to BOTH sides:
 *  - multi-word approved synonyms ("take part", "carry out", "look
 *    at"…) are collapsed to their head word first, so using the simple
 *    phrase counts as the same concept as the formal word, and the
 *    helper word ("part", "out") is not counted as a new fact;
 *  - GLUE_WORDS (discourse markers: furthermore, however, also…)
 *    carry no facts, so they are excluded from both concept sets.
 *    Meta-commentary filler the demo engine deletes outright ("it is
 *    important to note that") is excluded for the same reason: the
 *    words "important / note" there announce the sentence, they are
 *    not facts in it. Approved-synonym meanings of those words still
 *    canonicalise to the same concept on both sides via CANONICAL. */
const GLUE_WORDS = new Set([
  'furthermore', 'moreover', 'however', 'therefore', 'additionally',
  'consequently', 'nevertheless', 'meanwhile', 'instead', 'also',
  'addition', 'conclusion', 'overall', 'important', 'note', 'noted',
  'why', // only surfaces via the "That is why" transition variant
]);

function conceptSet(text) {
  let t = text.toLowerCase();
  for (const simple of Object.values(SYNONYMS)) {
    if (simple.includes(' ')) {
      const re = new RegExp(`\\b${simple.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
      t = t.replace(re, simple.split(' ')[0]);
    }
  }
  const freq = contentWordFreq(t);
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
  const checks = { ...first.checks, doubleVerified: agree };
  return { checks, accepted: first.accepted && second.accepted && agree };
}

/* ------------------------------------------------------------------ */
/* Pass 4 — GATE + main entry                                          */
/* ------------------------------------------------------------------ */

function humanizeLocal(text, mode = 'Natural', intensity = 'Medium') {
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

  const { protectedText, store } = protectEntities(trimmed);
  const naturalnessIn = naturalnessScore(trimmed);

  /* NATURALNESS OPTIMIZATION LOOP (demo engine): generate the 3
   * strategy candidates, run EVERY one through the full meaning gate
   * first, and only then — among the candidates that passed — pick
   * the highest naturalness. The gate always outranks naturalness. */
  const raw = [];
  for (const strategy of ['A', 'B', 'C']) {
    raw.push(restoreEntities(
      demoRewrite(protectedText, safeMode, safeIntensity, strategy), store,
    ));
  }

  // De-duplicate identical candidates, then gate-check each one.
  const candidates = [...new Set(raw)];
  const passed = [];
  let bestFailed = null;
  for (const candidate of candidates) {
    const verdict = verify(trimmed, candidate, store);
    const entry = { candidate, verdict, naturalness: naturalnessScore(candidate) };
    if (verdict.accepted) {
      passed.push(entry);
    } else if (!bestFailed
      || verdict.checks.meaningScore > bestFailed.verdict.checks.meaningScore) {
      bestFailed = entry;
    }
  }

  if (passed.length > 0) {
    passed.sort((a, b) => b.naturalness - a.naturalness);
    const winner = passed[0];
    return {
      output: winner.candidate,
      mode: safeMode,
      intensity: safeIntensity,
      engine: 'demo',
      checks: {
        ...winner.verdict.checks,
        naturalnessScore: winner.naturalness,
        naturalnessIn,
        candidatesTried: candidates.length,
        candidatesPassed: passed.length,
      },
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
    engine: 'demo',
    checks: {
      ...bestFailed.verdict.checks,
      naturalnessScore: naturalnessIn,
      naturalnessIn,
      candidatesTried: candidates.length,
      candidatesPassed: 0,
      rejectedNaturalness: bestFailed.naturalness,
    },
    status: 'Returned original',
    rejectedOutput: bestFailed.candidate,
  };
}

export { humanizeLocal, MODES, INTENSITIES };
export default humanizeLocal;
