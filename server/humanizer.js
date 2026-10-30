'use strict';

/**
 * HumanizeAI — multi-pass humanizing pipeline.
 *
 * Pass 1  PROTECT : lock entities / numbers / dates / % / URLs / emails /
 *                   quotes / acronyms behind placeholders, restore after.
 * Pass 2  REWRITE : LLM (if a key is configured) or a deterministic
 *                   offline rule-based engine (demo mode, default).
 * Pass 3  CHECK   : entities & numbers preserved? length ratio? meaning
 *                   score (content-word cosine overlap, 0-100)?
 * Pass 4  GATE    : "Accepted" only if everything above passes.
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

function demoRewrite(protectedText, mode, intensity) {
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

  // 4) Sentence rhythm: split heavy sentences on Strong (and for Simple mode)
  if (intensity === 'Strong' || (mode === 'Simple' && intensity === 'Medium')) {
    out = splitLongSentences(out);
  }

  return tidy(out);
}

/* ------------------------------------------------------------------ */
/* Pass 2b — REWRITE (LLM, only when a key is configured)              */
/* ------------------------------------------------------------------ */

function llmConfig() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || '';
  if (!apiKey) return null;
  const usingGemini = !process.env.OPENAI_API_KEY && !!process.env.GEMINI_API_KEY;
  const baseUrl =
    process.env.LLM_BASE_URL ||
    (usingGemini
      ? 'https://generativelanguage.googleapis.com/v1beta/openai/'
      : 'https://api.openai.com/v1');
  const model =
    process.env.LLM_MODEL || (usingGemini ? 'gemini-2.0-flash' : 'gpt-4o-mini');
  return { apiKey, baseUrl: baseUrl.replace(/\/$/, ''), model };
}

const MODE_GUIDANCE = {
  Natural: 'Sound like a real person wrote it on a normal day. Friendly, plain, smooth.',
  Simple: 'Use very easy words and short sentences, like explaining to a classmate.',
  Academic: 'Keep a formal academic tone, but write clearly. No slang, no contractions.',
  Casual: 'Relaxed and conversational, like a message to a friend. Contractions are welcome.',
  Professional: 'Polished workplace tone: clear, direct, no slang, no contractions.',
};

function buildSystemPrompt(mode, intensity, stricter) {
  return [
    `You rewrite a student's paragraph so it reads like natural human writing. Mode: ${mode}. Intensity: ${intensity}.`,
    MODE_GUIDANCE[mode] || MODE_GUIDANCE.Natural,
    'Hard rules:',
    '1. Keep the meaning 100% the same. Add NO new facts. Remove NO facts.',
    '2. Tokens like ⟦E1⟧ are protected placeholders. Copy every one of them exactly, unchanged, in the same place in the meaning.',
    '3. Vary sentence length — mix short and long sentences.',
    '4. Prefer common everyday words over stiff formal words.',
    "5. Remove robotic filler: 'furthermore', 'moreover', 'in conclusion', 'it is important to note', 'in today's fast-paced world'.",
    '6. Return ONLY the rewritten paragraph, no explanation, no quotes around it.',
    stricter
      ? '7. A previous attempt changed or dropped protected content or facts. Be extra careful: every placeholder and every fact from the original must survive word-for-word in meaning.'
      : '',
  ].filter(Boolean).join('\n');
}

async function llmRewrite(protectedText, mode, intensity, stricter) {
  const cfg = llmConfig();
  if (!cfg) return null;
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.7,
      messages: [
        { role: 'system', content: buildSystemPrompt(mode, intensity, stricter) },
        { role: 'user', content: protectedText },
      ],
    }),
  });
  if (!res.ok) throw new Error(`LLM request failed (${res.status})`);
  const data = await res.json();
  const text = data && data.choices && data.choices[0] &&
    data.choices[0].message && data.choices[0].message.content;
  if (!text) throw new Error('LLM returned no text');
  return tidy(String(text).trim());
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

function contentWordFreq(text) {
  const tokens = text.toLowerCase().match(/[a-z][a-z'-]*|\d[\d,]*(?:\.\d+)?%?/g) || [];
  const freq = new Map();
  for (const raw of tokens) {
    const w = raw.replace(/['-]/g, '');
    if (!w || STOPWORDS.has(w)) continue;
    const key = stem(w);
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  return freq;
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

function runChecks(original, output, store) {
  const protectedValues = store.map((s) => s.value);
  // Every protected value must survive with at least the same occurrence
  // count it had in the original text.
  const countIn = (haystack, needle) => haystack.split(needle).length - 1;
  const entitiesPreserved = protectedValues.every(
    (v) => countIn(output, v) >= 1 && output.includes(v),
  );
  const numbersPreserved = sameMultiset(extractNumbers(original), extractNumbers(output));
  const ratio = wordCount(output) / Math.max(1, wordCount(original));
  const lengthRatio = Math.round(ratio * 100) / 100;
  const score = meaningScore(original, output);
  const lengthOk = lengthRatio >= 0.6 && lengthRatio <= 1.5;
  const accepted = entitiesPreserved && numbersPreserved && lengthOk && score >= 70;
  return {
    checks: {
      entitiesPreserved,
      numbersPreserved,
      lengthRatio,
      meaningScore: score,
    },
    accepted,
  };
}

/* ------------------------------------------------------------------ */
/* Pass 4 — GATE + main entry                                          */
/* ------------------------------------------------------------------ */

async function humanize(text, mode = 'Natural', intensity = 'Medium') {
  const safeMode = MODES.includes(mode) ? mode : 'Natural';
  const safeIntensity = INTENSITIES.includes(intensity) ? intensity : 'Medium';

  const { protectedText, store } = protectEntities(text);
  const cfg = llmConfig();

  let engine = 'demo';
  let output = null;

  if (cfg) {
    try {
      const first = await llmRewrite(protectedText, safeMode, safeIntensity, false);
      if (first) {
        engine = 'llm';
        const restored = restoreEntities(first, store);
        const firstCheck = runChecks(text, restored, store);
        if (firstCheck.accepted) {
          output = restored;
          return buildResult(output, safeMode, safeIntensity, engine, firstCheck);
        }
        // Gate failed -> one stricter retry, keep the better attempt.
        try {
          const second = await llmRewrite(protectedText, safeMode, safeIntensity, true);
          if (second) {
            const restored2 = restoreEntities(second, store);
            const secondCheck = runChecks(text, restored2, store);
            if (secondCheck.checks.meaningScore >= firstCheck.checks.meaningScore) {
              return buildResult(restored2, safeMode, safeIntensity, engine, secondCheck);
            }
          }
        } catch (_) { /* keep first attempt */ }
        return buildResult(restored, safeMode, safeIntensity, engine, firstCheck);
      }
    } catch (_) {
      // LLM unreachable -> fall through to the offline demo engine so the
      // product still works; the response honestly reports engine: 'demo'.
      engine = 'demo';
    }
  }

  const rewritten = demoRewrite(protectedText, safeMode, safeIntensity);
  output = restoreEntities(rewritten, store);
  const check = runChecks(text, output, store);
  return buildResult(output, safeMode, safeIntensity, engine, check);
}

function buildResult(output, mode, intensity, engine, { checks, accepted }) {
  return {
    output,
    mode,
    intensity,
    engine,
    checks,
    status: accepted ? 'Accepted' : 'Check manually',
  };
}

module.exports = {
  humanize,
  llmConfig,
  MODES,
  INTENSITIES,
  // exported for testing
  _internal: { protectEntities, restoreEntities, demoRewrite, meaningScore, runChecks },
};
