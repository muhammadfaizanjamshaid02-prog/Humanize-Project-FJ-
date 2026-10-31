import { Fragment, useEffect, useRef, useState } from 'react';
import {
  humanizeLocal, verifyEdit, synonymAlternatives, analyzeLocal,
  PURPOSES, PURPOSE_DEFAULTS, DEPTHS,
} from './humanizerClient.js';
import { AVATAR_DATA_URI } from './avatarData.js';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/* ------------------------------------------------------------------ */
/* Login gate (personal/show gate for the demo — NOT real security).  */
/* Only the SHA-256 hex digest of the gate password lives in code.    */
/* The check runs through crypto.subtle where available (https /      */
/* localhost); a small synchronous SHA-256 below is the fallback for  */
/* non-secure contexts, so the SAME digest constant is used either    */
/* way and no second constant ever has to be derived or stored.       */
/* ------------------------------------------------------------------ */
const GATE_HASH =
  '9d2ab51950ca9cd3cc0f1dd02a88ff405e01dfc00c455e78886d193f9445d64e';
const GATE_KEY = 'humanize-unlocked';

function sha256HexSync(text) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const bytes = Array.from(new TextEncoder().encode(text));
  const bitLen = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  bytes.push(0, 0, 0, 0,
    (bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff,
    (bitLen >>> 8) & 0xff, bitLen & 0xff);
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Array(64);
  for (let block = 0; block < bytes.length; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      const i = block + t * 4;
      w[t] = (bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3];
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + b) | 0, (H[2] + c) | 0, (H[3] + d) | 0,
      (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  return H.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
}

async function checkGatePassword(typed) {
  try {
    if (window.crypto && crypto.subtle) {
      const digest = await crypto.subtle.digest(
        'SHA-256', new TextEncoder().encode(typed),
      );
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0')).join('');
      return hex === GATE_HASH;
    }
  } catch {
    /* fall through to the synchronous implementation */
  }
  return sha256HexSync(typed) === GATE_HASH;
}

function gateWasUnlocked() {
  try {
    return sessionStorage.getItem(GATE_KEY) === 'yes';
  } catch {
    return false;
  }
}

const API_BASE = import.meta.env.VITE_API_URL || '';
const MODES = ['Natural', 'Simple', 'Academic', 'Casual', 'Professional'];
const INTENSITIES = ['Light', 'Medium', 'Strong'];
const HISTORY_KEY = 'humanizeai-history';
const VOICE_KEY = 'humanizeai-voice-sample';

const SAMPLE_PARAGRAPH =
  'Furthermore, it is important to note that online education has become very popular in recent years. In addition, students do not have to travel to a campus, and they can study at any time that is convenient for them. However, many students find it difficult to stay motivated when they study alone at home. Therefore, teachers should provide regular feedback and create opportunities for students to participate in group discussions. In conclusion, online education can be highly effective when it is planned carefully and when students receive sufficient support from their teachers.';

function countWords(text) {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

/* ------------------------------------------------------------------ */
/* Professor View demo texts — FICTIONAL samples, written for this    */
/* demo. The AI-style one is deliberately robotic (stock phrases,     */
/* stock openers, near-identical sentence lengths); the human-style   */
/* one is a personal anecdote with varied lengths, contractions and   */
/* specific details. Both are over 300 words so they produce a full   */
/* report instead of the too-short state.                             */
/* ------------------------------------------------------------------ */
const PROF_AI_SAMPLE =
  'Furthermore, it is important to note that technology plays a crucial role in the modern world of education today. Moreover, in today\'s fast-paced world, students can access a wide range of resources in an efficient and effective manner. Additionally, online learning platforms provide students with the opportunity to learn at their own pace and in their own time. In addition, teachers can utilize various digital tools in order to enhance the overall learning experience for their students. It is worth mentioning that communication has become significantly easier due to the rapid advancement of modern technology in recent years. Consequently, students are able to collaborate with their classmates and share their ideas in a more effective way than before. Furthermore, technology has the potential to make education more accessible for students who live in remote and rural areas. In conclusion, it can be clearly seen that technology plays a vital role in shaping the future of modern education. Moreover, the use of technology in the classroom can significantly improve the overall quality of teaching and learning for everyone. Additionally, it is important to note that digital resources are constantly evolving in the ever-evolving landscape of modern education. When it comes to examinations, technology provides a wide range of tools that can help students prepare in an effective manner. Therefore, schools should embrace technology and integrate it into their daily teaching practices in order to achieve better outcomes for students. Furthermore, parents can monitor the progress of their children through various online platforms and applications in a convenient and timely manner. In addition, the availability of online courses means that students can pursue their interests beyond the boundaries of the traditional classroom setting. Overall, technology continues to transform the field of education in numerous ways and it will continue to do so in the future. To sum up, it is clear that the benefits of technology in education are numerous and its importance cannot be ignored or denied.';

const PROF_HUMAN_SAMPLE =
  'My grandfather kept a small notebook in his shirt pocket for almost forty years, and he wrote everything in it with a stub of pencil. Train times. Prices of onions. The name of a man who owed him two hundred rupees in 1987 and never paid. When he died last spring, the notebook came to me in a biscuit tin, along with his watch and an old photograph. I did not open it for weeks. It sat on my desk while I revised for my finals, and some nights in Lahore I would read one page instead of sleeping. What surprised me most was how ordinary the entries were. He had recorded the day the electricity meter was installed and the winter my aunt was born. Once, between a list of seed prices and a note about repairing the roof, he had written a single line about my grandmother: "She laughed today at breakfast. A good day." That line undid me, honestly. I keep thinking about why it hit so hard, and I suppose it is because the rest of us store our lives in photographs that vanish when a phone breaks, while he trusted paper and a short pencil. So I have started keeping a notebook of my own, which feels slightly ridiculous for a software student, and my handwriting is terrible besides. Still, I write in it most evenings — what I studied, what confused me, which bug took three hours to find. Some entries are one line long. Others run for a page and end mid-thought, because the power went out or someone called me downstairs for chai. What matters, I think, is the habit of noticing: the way my mother tests mangoes at the stall, the exact green of the fields after the first rain in July. My grandfather noticed things for forty years with a pencil stub, and because he did, a whole vanished world fits inside a biscuit tin on my desk.';

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY)) || [];
  } catch {
    return [];
  }
}

function loadVoice() {
  try {
    return localStorage.getItem(VOICE_KEY) || '';
  } catch {
    return '';
  }
}

/* Sentence statistics for the stats rail (presentation only). */
function sentenceStats(text) {
  const sentences = (text || '').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const lengths = sentences.map((s) => countWords(s));
  const total = lengths.reduce((a, b) => a + b, 0);
  return {
    count: sentences.length,
    avg: sentences.length ? Math.round((total / sentences.length) * 10) / 10 : 0,
    lengths,
  };
}

/* Split text into word / separator tokens; word tokens carry a
 * running word index so a synonym swap can replace ONE occurrence. */
function tokenize(text) {
  const parts = text.split(/([A-Za-z][A-Za-z'-]*)/g);
  let wi = -1;
  return parts.filter((p) => p !== '').map((p) => {
    const isWord = /^[A-Za-z][A-Za-z'-]*$/.test(p);
    if (isWord) wi += 1;
    return { value: p, isWord, wordIndex: isWord ? wi : -1 };
  });
}

function matchCase(original, replacement) {
  if (!replacement) return replacement;
  if (original.charAt(0) === original.charAt(0).toUpperCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

/* ------------------------------------------------------------------ */
/* Professor View — a Turnitin-STYLE instructor AI-writing report.    */
/* The layout, display states and wording follow Turnitin's own       */
/* published report design (researched from Turnitin's official       */
/* guides, 31 Oct 2026): the score is the share of QUALIFYING         */
/* sentences (prose only — lists, headings and quoted blocks are      */
/* excluded) over a per-sentence threshold; a true zero shows as 0%,   */
/* scores of 20% and above show the number with blue highlights, and  */
/* the raw 1–19% band uses a "*%" headline with no sentence           */
/* highlights because false positives are more likely there. The      */
/* analysis itself  */
/* is a transparent heuristic (see analyzeText in humanizerClient.js) */
/* — NOT Turnitin's proprietary model, and the honesty block below    */
/* says so, always.                                                   */
/* ------------------------------------------------------------------ */
function ProfessorHonesty() {
  return (
    <section className="panel prof-honesty">
      <h3>⚖️ Read this before using any score</h3>
      <p>
        This Professor View is an <strong>educational heuristic demo</strong> built with
        HumanizeAI. It is <strong>not Turnitin</strong>: it uses no proprietary detection
        model and no plagiarism database, and its percentages are <strong>unvalidated
        estimates</strong> based on surface patterns only. Similarity / plagiarism checking
        is out of scope for this tool and is not claimed anywhere.
      </p>
      <p>
        Turnitin&apos;s own guidance for its AI score applies here in full: an AI score is
        a <strong>single data point, not a decision</strong>. A tool like this may
        misidentify human-written, AI-generated and AI-paraphrased text, so it must{' '}
        <strong>never be used as the sole basis for adverse action against a student</strong>.
        It takes further scrutiny and human judgement, together with your institution&apos;s
        academic policies, to decide whether anything is wrong at all. Low scores use a
        <strong>*%</strong> headline and no sentence highlights — precisely because false
        positives are more likely in that range. The exact aggregate count stays in
        Document Details so a real flag on a long document cannot be rounded away to 0%.
      </p>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Document upload for the Professor View — Turnitin-style intake:    */
/* PDF, Word (.docx) or TXT. Extraction happens ENTIRELY in the       */
/* browser (pdf.js for PDF, mammoth for DOCX, FileReader via          */
/* file.text() for TXT): the file is never uploaded anywhere and      */
/* never reaches a server. pdf.js and mammoth are loaded lazily,      */
/* only when a document is actually opened. The 30,000-word ceiling   */
/* matches Turnitin's intake cap; longer documents are truncated to   */
/* their first 30,000 words and the report says so.                   */
/* ------------------------------------------------------------------ */
const PROF_MAX_WORDS = 30000;
const PROF_FILE_EXTS = ['pdf', 'docx', 'txt'];

async function extractDocumentText(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'txt') {
    return file.text();
  }
  const buffer = await file.arrayBuffer();
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const out = await mammoth.extractRawText({ arrayBuffer: buffer });
    return out.value || '';
  }
  // PDF: rebuild the text from pdf.js item GEOMETRY. Items are grouped
  // into visual lines by baseline; a visual line break becomes a real
  // newline ONLY when its gap is much larger than the page's typical
  // line gap (a paragraph break). Ordinary wrapped lines are re-joined
  // with a space — otherwise a wrapped sentence would fracture into
  // fragments and analyse differently from the same text pasted in.
  const pdfjs = await import('pdfjs-dist');
  pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const pages = [];
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = [];
    for (const item of tc.items) {
      if (!('str' in item)) continue;
      const y = item.transform[5];
      let row = rows.find((r) => Math.abs(r.y - y) < 2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push(item);
    }
    rows.sort((a, b) => b.y - a.y); // PDF y grows upward: top line first
    const lines = rows.map((r) => {
      const items = r.items.sort((a, b) => a.transform[4] - b.transform[4]);
      let text = '';
      let prev = null;
      for (const item of items) {
        if (prev) {
          const gapX = item.transform[4] - (prev.transform[4] + prev.width);
          const fontSize = Math.abs(item.transform[3]) || item.height || 10;
          if (gapX > fontSize * 0.2) text += ' ';
        }
        text += item.str;
        prev = item;
      }
      return { y: r.y, text };
    }).filter((l) => l.text.trim());
    const gaps = [];
    for (let i = 1; i < lines.length; i += 1) gaps.push(lines[i - 1].y - lines[i].y);
    const sortedGaps = [...gaps].sort((a, b) => a - b);
    const medianGap = sortedGaps.length
      ? sortedGaps[Math.floor(sortedGaps.length / 2)]
      : 0;
    let out = '';
    lines.forEach((ln, i) => {
      if (i === 0) {
        out = ln.text;
        return;
      }
      const gap = lines[i - 1].y - ln.y;
      out += (medianGap > 0 && gap > medianGap * 1.4 ? '\n' : ' ') + ln.text;
    });
    pages.push(out);
  }
  return pages.join('\n');
}

/* Cut a text to its first `max` words, preserving the original
 * characters (including newlines) up to the end of the last kept word. */
function truncateToWords(text, max) {
  const re = /\S+/g;
  let m;
  let seen = 0;
  let end = text.length;
  while ((m = re.exec(text)) !== null) {
    seen += 1;
    if (seen === max) {
      end = re.lastIndex;
      break;
    }
  }
  return text.slice(0, end);
}

function ProfessorView() {
  const [text, setText] = useState('');
  const [report, setReport] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [flashIdx, setFlashIdx] = useState(null);
  const [docName, setDocName] = useState(null);
  const [docInfo, setDocInfo] = useState(null); // { totalWords, truncated }
  const [uploadError, setUploadError] = useState('');
  const [extracting, setExtracting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef(null);

  async function analyse(sourceText) {
    setError('');
    setReport(null);
    setFlashIdx(null);
    if (!sourceText || !sourceText.trim()) {
      setError('Please paste a text first — or load one of the samples.');
      return;
    }
    setLoading(true);
    try {
      // Server first (same pattern as the humanizer); on a static host
      // the identical analyzer runs in the browser instead.
      let data = null;
      let serverError = null;
      try {
        const res = await fetch(`${API_BASE}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: sourceText }),
        });
        let parsed = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }
        if (parsed && res.ok) data = parsed;
        else if (parsed && parsed.error) serverError = parsed.error;
      } catch {
        data = null;
      }
      if (serverError) throw new Error(serverError);
      if (!data) data = { ...analyzeLocal(sourceText), local: true };
      setReport(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  /* Upload flow: read the file in the browser, put its text into the
   * same box the paste flow uses, then analyse it straight away so
   * the professor lands directly on the report. */
  async function handleFile(file) {
    setUploadError('');
    if (!file) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!PROF_FILE_EXTS.includes(ext)) {
      setUploadError(
        `That file type is not accepted — sirf PDF, Word (.docx) ya TXT file dein. `
        + 'Accepted formats: PDF, Word (.docx), TXT.',
      );
      return;
    }
    setExtracting(true);
    setReport(null);
    setDocInfo(null);
    try {
      const raw = await extractDocumentText(file);
      const totalWords = countWords(raw);
      if (totalWords < 10) {
        // A text-based file of this type with essentially no words in
        // it is, in practice, a scanned / image-only document.
        if (ext === 'pdf') {
          setUploadError(
            'Is PDF mein parhne wala text nahi mila — ye scanned/image PDF lagti hai. '
            + 'Text wali PDF ya Word file try karein.',
          );
        } else {
          setUploadError('Is file mein parhne wala text nahi mila. Koi aur file try karein.');
        }
        return;
      }
      let usable = raw;
      let truncated = false;
      if (totalWords > PROF_MAX_WORDS) {
        usable = truncateToWords(raw, PROF_MAX_WORDS);
        truncated = true;
      }
      setText(usable);
      setDocName(file.name);
      setDocInfo({ totalWords, truncated });
      await analyse(usable);
    } catch {
      setUploadError(
        'This file could not be read — file corrupt, encrypted ya password-protected '
        + 'lagti hai. Koi aur file try karein.',
      );
    } finally {
      setExtracting(false);
    }
  }

  function jumpToSentence(i) {
    const el = document.getElementById(`prof-sent-${i}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashIdx(i);
    setTimeout(() => setFlashIdx((cur) => (cur === i ? null : cur)), 1600);
  }

  const words = countWords(text);
  const proseSentences = report ? report.sentences.filter((s) => s.kind === 'prose') : [];
  const showBar = report && report.state !== 'tooShort' && report.state !== 'tooLong';
  const sp = report ? report.details.spelling : { us: 0, uk: 0 };
  const topSections = report && Array.isArray(report.sections)
    ? report.sections
      .filter((section) => section.flaggedCount > 0)
      .slice()
      .sort((a, b) => (b.percentRaw - a.percentRaw)
        || (b.flaggedCount - a.flaggedCount) || (a.index - b.index))
      .slice(0, 5)
    : [];
  const barBins = proseSentences.length > 120
    ? Array.from({ length: 100 }, (_, i) => {
      const start = Math.floor((i * proseSentences.length) / 100);
      const end = Math.floor(((i + 1) * proseSentences.length) / 100);
      const group = proseSentences.slice(start, end);
      const flaggedCount = group.filter((s) => s.flagged).length;
      return {
        index: i,
        start,
        end: end - 1,
        group,
        flaggedCount,
        percentExact: group.length
          ? Math.round(((100 * flaggedCount) / group.length) * 10) / 10 : 0,
        first: group[0],
      };
    })
    : null;

  function jumpToSection(section) {
    if (!report || report.state !== 'scored') return;
    const target = proseSentences[section.sentenceStart];
    if (target) jumpToSentence(target.index);
  }

  return (
    <div className="prof">
      <section className="panel prof-intro prof-no-print">
        <h2>🎓 Professor View — AI Writing Report</h2>
        <p>
          Upload a student&apos;s document (PDF, Word or TXT) or paste the text, and get a
          Turnitin-style report: what share of the{' '}
          <strong>qualifying sentences</strong> (prose only — list items, headings and quoted
          blocks are excluded, just as Turnitin excludes non-prose) show AI-like patterns.
          A report needs <strong>at least 300 words</strong> of prose; the ceiling is 30,000
          words. Scores under the display threshold use a <strong>*%</strong> headline
          and no sentence highlights, because false positives are more likely there;
          the exact aggregate count is kept in Document Details for audit.
        </p>
      </section>

      <section className="panel prof-controls prof-no-print">
        <div className="panel-head">
          <h3>Submission text</h3>
          <span className="word-count">{words} words</span>
        </div>

        <div
          className={`prof-upload${dragOver ? ' drag' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files && e.dataTransfer.files[0]);
          }}
        >
          <p className="prof-upload-title">📄 Upload a document</p>
          <p className="prof-upload-hint">
            Drag &amp; drop the student&apos;s file here, or choose it — the report is
            generated as soon as the file is read.
          </p>
          <button
            type="button"
            className="btn primary"
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            disabled={extracting}
          >
            {extracting ? 'Reading file…' : 'Choose file'}
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.docx,.txt"
            hidden
            onChange={(e) => {
              handleFile(e.target.files && e.target.files[0]);
              e.target.value = '';
            }}
          />
          <p className="prof-upload-formats">
            Accepted: <strong>PDF</strong>, <strong>Word (.docx)</strong>,{' '}
            <strong>TXT</strong> — the same intake as Turnitin. Up to 30,000 words
            are analysed.
          </p>
          <p className="prof-upload-privacy">
            🔒 File sirf aap ke browser mein parhi jati hai — kahin upload nahi hoti,
            kisi server par nahi jati.
          </p>
          {uploadError && <p className="error">{uploadError}</p>}
          {docInfo && (
            <p className="prof-upload-loaded">
              📄 <strong>{docName}</strong> — {docInfo.totalWords.toLocaleString()} words
              read from the file.
              {docInfo.truncated && (
                <> Sirf pehle 30,000 words analyse hue — document us se lamba tha
                (30,000-word ceiling, bilkul Turnitin ki tarah).</>
              )}
            </p>
          )}
        </div>

        <textarea
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDocName(null);
            setDocInfo(null);
          }}
          placeholder="…or paste the student's text here (300+ words of prose for a full report)…"
          rows={12}
        />
        <div className="row">
          <button type="button" className="btn primary" onClick={() => analyse(text)} disabled={loading}>
            {loading ? 'Analysing…' : 'Analyse'}
          </button>
          <button
            type="button" className="btn ghost"
            onClick={() => { setText(PROF_AI_SAMPLE); setReport(null); setError(''); setUploadError(''); setDocName(null); setDocInfo(null); }}
          >
            Load AI-style sample
          </button>
          <button
            type="button" className="btn ghost"
            onClick={() => { setText(PROF_HUMAN_SAMPLE); setReport(null); setError(''); setUploadError(''); setDocName(null); setDocInfo(null); }}
          >
            Load human-style sample
          </button>
          <button
            type="button" className="btn ghost"
            onClick={() => { setText(''); setReport(null); setError(''); setUploadError(''); setDocName(null); setDocInfo(null); }}
          >
            Clear
          </button>
        </div>
        {error && <p className="error">{error}</p>}
      </section>

      {report && (
        <div className="prof-report" id="prof-report">
          <div className="prof-print-head">
            <h2>AI Writing Report — HumanizeAI Professor View</h2>
            <p className="prof-date">
              Generated {new Date().toLocaleString()} · Heuristic demo — not a Turnitin report
            </p>
            {docName && (
              <p className="prof-date">
                Document: <strong>{docName}</strong>
                {docInfo && docInfo.truncated && (
                  <> · First 30,000 of {docInfo.totalWords.toLocaleString()} words analysed
                  (30,000-word ceiling)</>
                )}
              </p>
            )}
          </div>

          {(report.state === 'tooShort' || report.state === 'tooLong') ? (
            <section className="panel prof-score prof-score-na">
              <span className="prof-big">- -</span>
              <span className="prof-score-label">no report generated</span>
              <p className="prof-interp">{report.interpretation}</p>
            </section>
          ) : (
            <section className="panel prof-score">
              <span className="prof-big">{report.displayScore}</span>
              <span className="prof-score-label">
                of qualifying text detected as AI-pattern
              </span>
              <p className="prof-interp">{report.interpretation}</p>
            </section>
          )}

          {showBar && (
            <section className="panel prof-breakdown">
              <h3>Submission Breakdown</h3>
              {barBins ? (
                <>
                  <div className="prof-bar binned" role="group" aria-label="Submission breakdown bar, grouped into 100 bins">
                    {barBins.map((bin) => (
                      <button
                        key={bin.index}
                        type="button"
                        className={`prof-seg binned${bin.flaggedCount ? ' flagged' : ''}`}
                        title={`Sentences ${bin.start + 1}–${bin.end + 1} — ${bin.flaggedCount} flagged (${bin.percentExact}%)`}
                        onClick={() => bin.first && jumpToSentence(bin.first.index)}
                      />
                    ))}
                  </div>
                  <p className="prof-legend">
                    Long document grouped into 100 bins; each bin covers about{' '}
                    {Math.ceil(proseSentences.length / 100)} qualifying sentences.{' '}
                    {report.state === 'scored'
                      ? 'Blue = the bin contains at least one flagged sentence. Click a bin to jump to its first sentence.'
                      : 'No sentence is highlighted in this score range. Click a bin to jump to its first sentence.'}
                  </p>
                </>
              ) : (
                <>
                  <div className="prof-bar" role="group" aria-label="Submission breakdown bar">
                    {proseSentences.map((s) => (
                      <button
                        key={s.index}
                        type="button"
                        className={`prof-seg${s.flagged ? ' flagged' : ''}`}
                        style={{ flexGrow: Math.max(1, countWords(s.text)) }}
                        title={`Sentence ${s.index + 1}${s.flagged ? ' — flagged as AI-pattern' : ''}`}
                        onClick={() => jumpToSentence(s.index)}
                      />
                    ))}
                  </div>
                  <p className="prof-legend">
                    One segment per qualifying sentence, sized by its length.{' '}
                    {report.state === 'scored'
                      ? 'Blue = flagged as AI-pattern. Click a segment to jump to that sentence.'
                      : 'No sentence is highlighted in this score range. Click a segment to jump to that sentence.'}
                  </p>
                </>
              )}
            </section>
          )}

          {report.sections && report.sections.length > 0 && (
            <section className="panel prof-sections">
              <h3>Most AI-pattern sections</h3>
              {topSections.length ? (
                <ol className="prof-section-list">
                  {topSections.map((section) => {
                    const content = (
                      <>
                        <span className="prof-section-meta">
                          Sentences {section.sentenceStart + 1}–{section.sentenceEnd + 1}
                          {' · '}{section.percentRaw}% · {section.flaggedCount} of {section.sentenceCount} flagged
                        </span>
                        <span className="prof-section-label">{section.label}</span>
                      </>
                    );
                    return (
                      <li key={section.index}>
                        {report.state === 'scored' ? (
                          <button
                            type="button"
                            className="prof-section-item"
                            onClick={() => jumpToSection(section)}
                            title="Jump to this section"
                          >
                            {content}
                          </button>
                        ) : (
                          <div className="prof-section-item static">{content}</div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p>No section contains a flagged sentence.</p>
              )}
              <p className="prof-legend">
                Sections are consecutive windows of about 25 qualifying sentences.
                {report.state !== 'scored'
                  && ' Section links are disabled in this score range, so no sentence is singled out.'}
              </p>
            </section>
          )}

          <div className="prof-cols">
            <section className="panel prof-text">
              <h3>Submission</h3>
              <p className="prof-doc">
                {report.sentences.map((s) => (
                  <Fragment key={s.index}>
                    {s.index === 0 ? null : s.newLine ? <br /> : ' '}
                    <span
                      id={`prof-sent-${s.index}`}
                      className={[
                        s.kind === 'excluded' ? 'prof-excl' : '',
                        s.flagged ? 'prof-hl' : '',
                        flashIdx === s.index ? 'prof-flash' : '',
                      ].join(' ')}
                      title={s.kind === 'excluded' ? `Not counted — ${s.sub}` : undefined}
                    >
                      {s.text}
                    </span>
                  </Fragment>
                ))}
              </p>
              {report.state === 'scored' && (
                <p className="prof-legend">
                  Blue highlights = sentences over the AI-pattern threshold. Grey text is
                  non-prose (list items, headings, quoted blocks) and is not counted.
                </p>
              )}
            </section>

            <div className="prof-side">
              <section className="panel prof-flags">
                <h3>🚩 Integrity Flags</h3>
                {report.flags.total === 0 ? (
                  <p>
                    No flags — no hidden characters and no replaced characters found.
                    A flag is not necessarily an indicator of a problem; it marks a place
                    worth a closer look.
                  </p>
                ) : (
                  <>
                    {report.flags.hidden.count > 0 && (
                      <div className="prof-flag-item">
                        <strong>Hidden characters:</strong>{' '}
                        {report.flags.hidden.count} found (
                        {report.flags.hidden.items
                          .map((i) => `${i.code} ×${i.count}`)
                          .join(', ')}
                        ).
                        {report.flags.hidden.items[0] && (
                          <> First in: “{report.flags.hidden.items[0].snippet}…”</>
                        )}
                      </div>
                    )}
                    {report.flags.homoglyphs.count > 0 && (
                      <div className="prof-flag-item">
                        <strong>Replaced characters:</strong>{' '}
                        {report.flags.homoglyphs.count} lookalike character(s) in{' '}
                        {report.flags.homoglyphs.words.length} word(s):{' '}
                        {report.flags.homoglyphs.words
                          .map((w) => `“${w.word}” (${w.chars
                            .map((c) => `${c.script} ${c.code}`)
                            .join(', ')})`)
                          .join('; ')}
                        .
                      </div>
                    )}
                    <p className="prof-flag-note">
                      A flag is not necessarily an indicator of a problem. However, we
                      recommend you focus your attention there for further review.
                    </p>
                  </>
                )}
              </section>

              <section className="panel prof-details">
                <h3>Document Details</h3>
                <dl>
                  <div><dt>Total words</dt><dd>{report.counts.totalWords}</dd></div>
                  <div><dt>Text segments</dt><dd>{report.counts.totalSentences}</dd></div>
                  <div>
                    <dt>Qualifying sentences</dt>
                    <dd>{report.counts.qualifyingSentences}</dd>
                  </div>
                  <div>
                    <dt>Non-prose segments excluded</dt>
                    <dd>{report.counts.excludedSegments}</dd>
                  </div>
                  <div>
                    <dt>Short fragments excluded</dt>
                    <dd>{report.details.excludedFragments ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Contents lines excluded</dt>
                    <dd>{report.details.excludedToc ?? 0}</dd>
                  </div>
                  <div>
                    <dt>Average sentence length</dt>
                    <dd>{report.details.avgSentenceLength} words</dd>
                  </div>
                  <div>
                    <dt>Flagged sentences</dt>
                    <dd>
                      {report.details.flaggedCount == null
                        ? '—'
                        : `${report.details.flaggedCount} (${report.details.percentExact}% exact)`}
                    </dd>
                  </div>
                  <div>
                    <dt>Spelling mix</dt>
                    <dd>
                      US ×{sp.us} · UK ×{sp.uk}
                      {sp.us > 0 && sp.uk > 0
                        ? ' — mixed US/UK spelling, worth a look'
                        : ''}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          </div>

          <div className="row prof-actions prof-no-print">
            <button type="button" className="btn primary" onClick={() => window.print()}>
              Download / Print Report
            </button>
          </div>
        </div>
      )}

      <ProfessorHonesty />
    </div>
  );
}

function MainApp({ onLock }) {
  const [view, setView] = useState('humanizer'); // 'humanizer' | 'professor'
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('Natural');
  const [intensity, setIntensity] = useState('Medium');
  const [purpose, setPurpose] = useState('General');
  const [depth, setDepth] = useState('Advanced');
  const [voiceSample, setVoiceSample] = useState(loadVoice);
  const [result, setResult] = useState(null);
  const [resultInput, setResultInput] = useState('');
  const [display, setDisplay] = useState(null); // { text, checks, candIdx }
  const [editInfo, setEditInfo] = useState(null); // { failed } after a synonym swap
  const [swap, setSwap] = useState(null); // { wordIndex, word, alternatives }
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [serverEngine, setServerEngine] = useState(null);
  const [history, setHistory] = useState(loadHistory);

  useEffect(() => {
    // On a fully static host (e.g. GitHub Pages) there is no API:
    // the health request 404s or returns HTML instead of JSON. That
    // is not an error state for the user — the demo algorithm also
    // runs entirely in the browser (see humanizerClient.js) — so any
    // failure here simply lands on 'offline', which the header badge
    // presents as Demo Mode.
    fetch(`${API_BASE}/api/health`)
      .then((r) => {
        if (!r.ok) throw new Error('no api');
        return r.json();
      })
      .then((d) => setServerEngine(d.engine))
      .catch(() => setServerEngine('offline'));
  }, []);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  }, [history]);

  useEffect(() => {
    // The Custom Voice sample is stored ONLY in this browser.
    localStorage.setItem(VOICE_KEY, voiceSample);
  }, [voiceSample]);

  const voiceWords = countWords(voiceSample);
  const voiceActive = voiceWords >= 40;

  function pickPurpose(p) {
    setPurpose(p);
    const d = PURPOSE_DEFAULTS[p];
    if (d) {
      setMode(d.mode);
      setIntensity(d.intensity);
    }
  }

  function showResult(data, forInput) {
    setResult(data);
    setResultInput(forInput);
    setDisplay({
      text: data.output,
      checks: data.checks,
      candIdx: data.winnerIndex != null && data.winnerIndex >= 0 ? data.winnerIndex : 0,
    });
    setEditInfo(null);
    setSwap(null);
  }

  async function humanize() {
    setError('');
    setResult(null);
    setDisplay(null);
    setEditInfo(null);
    setSwap(null);
    setCopied(false);
    const words = countWords(input);
    if (words < 10) {
      setError('Please paste a paragraph of at least 10 words first.');
      return;
    }
    if (words > 1000) {
      setError('That paragraph is too long — the limit is 1000 words.');
      return;
    }
    setLoading(true);
    try {
      // 1) Server first: when the Express API is reachable (local dev,
      //    or a deployed server via VITE_API_URL) its answer is used
      //    exactly as before — including its JSON validation errors,
      //    which are authoritative and shown as-is.
      let data = null;
      let serverError = null;
      try {
        const res = await fetch(`${API_BASE}/api/humanize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: input, mode, intensity, purpose, depth,
            voiceSample: voiceActive ? voiceSample : undefined,
          }),
        });
        let parsed = null;
        try {
          parsed = await res.json();
        } catch {
          parsed = null; // non-JSON answer (e.g. a static host's 404 page)
        }
        if (parsed && res.ok) data = parsed;
        else if (parsed && parsed.error) serverError = parsed.error;
        // A non-OK / non-JSON response means "no API here" — fall
        // through to the in-browser engine instead of failing.
      } catch {
        data = null; // network failure — fall through to local engine
      }
      if (serverError) throw new Error(serverError);

      // 2) Static-host fallback (GitHub Pages): run the SAME v3 demo
      //    algorithm in the browser. Its validation errors carry the
      //    same messages as the server's and surface the same way.
      if (!data) {
        data = {
          ...humanizeLocal(input, mode, intensity, {
            purpose, depth, voiceSample: voiceActive ? voiceSample : null,
          }),
          local: true,
        };
        setServerEngine('offline');
      }

      showResult(data, input);
      const entry = {
        id: Date.now(),
        input,
        mode: data.mode,
        intensity: data.intensity,
        purpose: data.purpose || 'General',
        depth: data.depth || 'Advanced',
        result: data,
      };
      setHistory((h) => [entry, ...h].slice(0, 10));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function selectCandidate(i) {
    if (!result || !result.candidates || !result.candidates[i]) return;
    const c = result.candidates[i];
    setDisplay({ text: c.text, checks: c.checks, candIdx: i });
    setEditInfo(null);
    setSwap(null);
    setCopied(false);
  }

  /* Word-click synonym swap: replace THAT occurrence only, then
   * re-verify the edited text locally. A gate-breaking edit is kept
   * and clearly flagged — never silently reverted. */
  function applySwap(alternative) {
    if (!swap || !display) return;
    const tokens = tokenize(display.text);
    const rebuilt = tokens.map((t) => (
      t.isWord && t.wordIndex === swap.wordIndex
        ? matchCase(t.value, alternative)
        : t.value
    )).join('');
    const recheck = verifyEdit(resultInput, rebuilt);
    setDisplay({ text: rebuilt, checks: recheck.checks, candIdx: display.candIdx });
    setEditInfo({ failed: !recheck.accepted });
    setSwap(null);
    setCopied(false);
  }

  function copyOutput() {
    if (!display) return;
    navigator.clipboard.writeText(display.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function downloadOutput() {
    if (!display) return;
    const blob = new Blob([display.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'humanized-paragraph.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  function reloadRun(entry) {
    setInput(entry.input);
    setMode(entry.mode);
    setIntensity(entry.intensity);
    setPurpose(entry.purpose || 'General');
    setDepth(entry.depth || 'Advanced');
    showResult(entry.result, entry.input);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const checks = display ? display.checks : null;
  const accepted = result && result.status === 'Accepted' && !(editInfo && editInfo.failed);
  const returnedOriginal = result && result.status === 'Returned original';
  const editFailed = !!(editInfo && editInfo.failed);
  const statsIn = result ? sentenceStats(resultInput) : null;
  const statsOut = display ? sentenceStats(display.text) : null;
  const maxBar = statsOut ? Math.max(1, ...statsOut.lengths) : 1;

  // Plain-language list of exactly which v2 checks failed.
  const failedChecks = [];
  if (checks && (returnedOriginal || editFailed)) {
    if (!checks.entitiesPreserved) failedChecks.push('a name or protected item changed');
    if (!checks.numbersPreserved) failedChecks.push('a number or date changed');
    if (!checks.negationPreserved) failedChecks.push('a "not / never / no" wording changed — that can flip the meaning');
    if (checks.meaningScore < 85) failedChecks.push(`meaning score was only ${checks.meaningScore}% (needs 85%)`);
    if (checks.coverage < 85) failedChecks.push(`only ${checks.coverage}% of the original facts survived (needs 85%)`);
    if (checks.newConceptRatio > 20) failedChecks.push(`${checks.newConceptRatio}% new facts appeared that were not in your paragraph (max 20%)`);
    if (checks.lengthRatio < 0.6 || checks.lengthRatio > 1.5) failedChecks.push(`the length changed too much (${checks.lengthRatio}×)`);
    if (checks.verificationRuns === 2 && !checks.doubleVerified) failedChecks.push('the two verification runs did not agree');
  }

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Humanize<span className="accent">AI</span></h1>
          <p className="tagline">Paste a paragraph — get it back in natural human words, with the meaning untouched.</p>
        </div>
        {serverEngine === 'demo' && <span className="badge demo">Demo Mode</span>}
        {serverEngine === 'llm' && <span className="badge llm">AI Engine</span>}
        {serverEngine === 'offline' && <span className="badge demo">Demo Mode</span>}
        {view === 'humanizer' ? (
          <button type="button" className="btn ghost small" onClick={() => setView('professor')}>
            🎓 Professor View
          </button>
        ) : (
          <button type="button" className="btn ghost small" onClick={() => setView('humanizer')}>
            ← Back to Humanizer
          </button>
        )}
        <button type="button" className="btn ghost small lock-btn" onClick={onLock}>
          🔒 Lock
        </button>
      </header>

      {view === 'professor' ? (
        <ProfessorView />
      ) : (
        <>
      <main className="layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Your paragraph</h2>
            <span className="word-count">{countWords(input)} / 1000 words</span>
          </div>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Paste the paragraph you want to humanize here…"
            rows={12}
          />
          <div className="row">
            <button type="button" className="btn ghost" onClick={() => setInput(SAMPLE_PARAGRAPH)}>
              Sample Paragraph
            </button>
            <button type="button" className="btn ghost" onClick={() => { setInput(''); setResult(null); setDisplay(null); setError(''); }}>
              Clear
            </button>
          </div>

          <div className="selector">
            <span className="selector-label">Purpose</span>
            <div className="pills">
              {PURPOSES.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`pill ${purpose === p ? 'active' : ''}`}
                  onClick={() => pickPurpose(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="selector">
            <span className="selector-label">Mode</span>
            <div className="pills">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`pill ${mode === m ? 'active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div className="selector">
            <span className="selector-label">Intensity</span>
            <div className="pills">
              {INTENSITIES.map((i) => (
                <button
                  key={i}
                  type="button"
                  className={`pill ${intensity === i ? 'active' : ''}`}
                  onClick={() => setIntensity(i)}
                >
                  {i}
                </button>
              ))}
            </div>
          </div>

          <div className="selector">
            <span className="selector-label">Depth</span>
            <div className="pills">
              {DEPTHS.map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`pill ${depth === d ? 'active' : ''}`}
                  onClick={() => setDepth(d)}
                >
                  {d}
                </button>
              ))}
            </div>
            <p className="selector-hint">
              {depth === 'Basic'
                ? 'Basic: one rewrite, still checked by the full meaning gate.'
                : 'Advanced: up to 4 rewrites compete; the safest, most natural one wins.'}
            </p>
          </div>

          <details className="voice-box">
            <summary>Your writing sample (optional — Custom Voice)</summary>
            <p className="selector-hint">
              Paste 40+ words of your own writing and the rewrite will lean toward your
              sentence length and contraction style. Only style statistics are measured —
              the sample itself is stored only in this browser and is never sent anywhere
              as text.
            </p>
            <textarea
              value={voiceSample}
              onChange={(e) => setVoiceSample(e.target.value)}
              placeholder="Paste a sample of your own writing here…"
              rows={5}
            />
            <p className="selector-hint">
              {voiceActive
                ? `Voice sample active — ${voiceWords} words. It will shape the next rewrite.`
                : `${voiceWords} / 40 words needed to activate your voice.`}
            </p>
          </details>

          <button type="button" className="btn primary" onClick={humanize} disabled={loading}>
            {loading ? 'Humanizing…' : 'Humanize'}
          </button>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{returnedOriginal ? 'Your paragraph (returned unchanged)' : 'Humanized paragraph'}</h2>
            {display && <span className="word-count">{countWords(display.text)} words · {result.engine === 'llm' ? 'AI engine' : result.local ? 'Demo engine · in browser' : 'Demo engine'}</span>}
          </div>
          <div className="output-box">
            {display ? (
              accepted || editInfo ? (
                tokenize(display.text).map((t, i) => {
                  if (!t.isWord) return <span key={i}>{t.value}</span>;
                  const alts = synonymAlternatives(t.value);
                  if (!alts.length) return <span key={i}>{t.value}</span>;
                  return (
                    <button
                      key={i}
                      type="button"
                      className="syn-word"
                      title="Click for a synonym"
                      onClick={() => setSwap({ wordIndex: t.wordIndex, word: t.value, alternatives: alts })}
                    >
                      {t.value}
                    </button>
                  );
                })
              ) : (
                display.text
              )
            ) : (
              <span className="placeholder">Your humanized paragraph will appear here.</span>
            )}
          </div>
          {display && accepted && (
            <p className="selector-hint">Words with a dotted underline have a safe synonym — click one to swap just that word.</p>
          )}
          {swap && (
            <div className="swap-box">
              <span>
                Replace <strong>{swap.word}</strong> with:
              </span>
              {swap.alternatives.map((alt) => (
                <button key={alt} type="button" className="btn ghost small" onClick={() => applySwap(alt)}>
                  {alt}
                </button>
              ))}
              <button type="button" className="btn ghost small" onClick={() => setSwap(null)}>
                Cancel
              </button>
            </div>
          )}
          <div className="row">
            <button type="button" className="btn ghost" onClick={copyOutput} disabled={!display}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" className="btn ghost" onClick={downloadOutput} disabled={!display}>
              Download .txt
            </button>
          </div>

          {result && result.voice && (
            <p className="voice-note">
              Voice: matched from your sample (average sentence ≈ {result.voice.avgSentenceWords} words ·{' '}
              {result.voice.usesContractions ? 'contractions on' : 'contractions off'} ·{' '}
              average word ≈ {result.voice.avgWordLength} letters)
            </p>
          )}

          {result && result.candidates && result.candidates.length > 1 && (
            <details className="compare-box">
              <summary>Compare rewrites ({result.candidates.length} passed the gate)</summary>
              <ul>
                {result.candidates.map((c, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      className={`compare-item ${display && display.candIdx === i ? 'active' : ''}`}
                      onClick={() => selectCandidate(i)}
                    >
                      <span className="compare-meta">
                        Rewrite {i + 1}{i === (result.winnerIndex ?? 0) ? ' · ★ winner' : ''} · Naturalness {c.naturalnessScore} · Meaning {c.checks.meaningScore}%
                      </span>
                      <span className="compare-text">{c.text.slice(0, 120)}…</span>
                    </button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {result && checks && (
            <div className={`gate ${editFailed ? 'gate-edited' : accepted ? 'gate-ok' : 'gate-fail'}`}>
              <div className="gate-status">
                {editFailed
                  ? '⚠ Edited — this version no longer passes all checks'
                  : accepted
                    ? '✓ Accepted'
                    : '⛔ Returned original — rewrite rejected'}
              </div>
              {editInfo && !editInfo.failed && (
                <p className="gate-note">Edited by you — re-checked locally just now (local re-check): this version still passes all checks.</p>
              )}
              {checks.naturalnessScore != null && (
                <div className="naturalness">
                  <span className="naturalness-label">Naturalness Score</span>
                  <span className="naturalness-value">
                    {checks.naturalnessIn} → {checks.naturalnessScore}
                  </span>
                  <p className="naturalness-note">
                    Naturalness = how human the writing patterns are. This is not any
                    detector's score — no tool can guarantee a detector result.
                  </p>
                </div>
              )}
              <div className="gate-grid">
                <div>
                  <span className="gate-value">{checks.meaningScore}%</span>
                  <span className="gate-label">Meaning Preserved</span>
                </div>
                <div>
                  <span className="gate-value">{checks.entitiesPreserved ? '✓' : '✗'}</span>
                  <span className="gate-label">Names &amp; Entities</span>
                </div>
                <div>
                  <span className="gate-value">{checks.numbersPreserved ? '✓' : '✗'}</span>
                  <span className="gate-label">Numbers &amp; Dates</span>
                </div>
                <div>
                  <span className="gate-value">{checks.negationPreserved ? '✓' : '✗'}</span>
                  <span className="gate-label">Negation Lock</span>
                </div>
                <div>
                  <span className="gate-value">{checks.coverage}%</span>
                  <span className="gate-label">Fact Coverage</span>
                </div>
                <div>
                  <span className="gate-value">{checks.newConceptRatio}%</span>
                  <span className="gate-label">New Facts</span>
                </div>
                <div>
                  <span className="gate-value">{checks.lengthRatio}×</span>
                  <span className="gate-label">Length Ratio</span>
                </div>
                <div>
                  <span className="gate-value">{checks.verificationRuns === 1 ? '1 run' : checks.doubleVerified ? '✓' : '✗'}</span>
                  <span className="gate-label">{checks.verificationRuns === 1 ? 'Verified (Basic)' : 'Double Verified'}</span>
                </div>
              </div>
              <p className="gate-note">
                {editFailed
                  ? 'Your edit changed something the gate protects (a fact, a number, a negation, or too much of the meaning). The edited text is kept above — nothing was reverted — but it is no longer an Accepted rewrite.'
                  : accepted
                    ? 'This rewrite passed all six safety checks: names, numbers, negations and meaning are all intact, every fact survived, and no new facts were added.'
                    : 'The rewrite was not safe, so it was rejected and your original paragraph is returned untouched. Nothing in it was changed.'}
              </p>
              {statsIn && statsOut && (
                <div className="sent-stats">
                  <p className="gate-stats">
                    Sentences: {statsIn.count} → {statsOut.count} · Average sentence length:{' '}
                    {statsIn.avg} → {statsOut.avg} words
                  </p>
                  <div className="sent-bars" aria-hidden="true">
                    {statsOut.lengths.map((len, i) => (
                      <span
                        key={i}
                        className="sent-bar"
                        style={{ height: `${Math.max(3, Math.round((len / maxBar) * 26))}px` }}
                        title={`Sentence ${i + 1}: ${len} words`}
                      />
                    ))}
                  </div>
                </div>
              )}
              {checks.readabilityIn != null && (
                <p className="gate-stats">
                  Readability (Flesch): {checks.readabilityIn} → {checks.readabilityOut}
                  {' · '}Repetition index: {checks.repetitionIn} → {checks.repetitionOut}
                  {checks.candidatesTried != null && (
                    <>{' · '}Candidates tried: {checks.candidatesTried}, passed the gate: {checks.candidatesPassed}</>
                  )}
                </p>
              )}
              {(returnedOriginal || editFailed) && (
                <details className="gate-details" open={editFailed}>
                  <summary>{editFailed ? 'Which checks did the edit break?' : 'Why was it rejected?'}</summary>
                  {failedChecks.length > 0 && (
                    <ul>
                      {failedChecks.map((f) => <li key={f}>{f}</li>)}
                    </ul>
                  )}
                  {checks.missingConcepts && checks.missingConcepts.length > 0 && (
                    <p>Missing facts: {checks.missingConcepts.join(', ')}</p>
                  )}
                  {checks.newConcepts && checks.newConcepts.length > 0 && (
                    <p>New facts that appeared: {checks.newConcepts.join(', ')}</p>
                  )}
                  {returnedOriginal && result.rejectedOutput && (
                    <>
                      <p className="gate-rejected-label">The rejected rewrite (not delivered):</p>
                      <p className="gate-rejected">{result.rejectedOutput}</p>
                    </>
                  )}
                </details>
              )}
            </div>
          )}
        </section>
      </main>

      {history.length > 0 && (
        <section className="history">
          <div className="panel-head">
            <h2>History (last {history.length})</h2>
            <button type="button" className="btn ghost small" onClick={() => setHistory([])}>
              Clear history
            </button>
          </div>
          <ul>
            {history.map((h) => (
              <li key={h.id}>
                <button type="button" className="history-item" onClick={() => reloadRun(h)}>
                  <span className="history-text">{h.result.output.slice(0, 110)}…</span>
                  <span className="history-meta">
                    {h.mode} · {h.intensity}
                    {h.purpose && h.purpose !== 'General' && <> · {h.purpose}</>}
                    {h.depth === 'Basic' && <> · Basic</>}
                    {' · '}{h.result.status} · Meaning {h.result.checks.meaningScore}%
                    {h.result.checks.naturalnessScore != null && (
                      <> · Naturalness {h.result.checks.naturalnessIn} → {h.result.checks.naturalnessScore}</>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
        </>
      )}

      <footer className="footer">
        AI Writing Assistant — always review the output yourself before using it.
      </footer>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cartoon login gate: animated glass card, Faizan's avatar with a    */
/* speech bubble, and a hash-only password check. While locked, ONLY  */
/* this screen renders — the main app is not mounted at all.          */
/* ------------------------------------------------------------------ */
function LoginGate({ onUnlock }) {
  const [pw, setPw] = useState('');
  const [error, setError] = useState(false);
  const [success, setSuccess] = useState(false);
  const [checking, setChecking] = useState(false);
  const [shaking, setShaking] = useState(false);
  const inputRef = useRef(null);

  async function submit(e) {
    e.preventDefault();
    if (success || checking) return;
    setChecking(true);
    const ok = await checkGatePassword(pw);
    setChecking(false);
    if (ok) {
      setError(false);
      setSuccess(true);
      setTimeout(() => {
        try {
          sessionStorage.setItem(GATE_KEY, 'yes');
        } catch {
          /* session storage unavailable — unlock for this view anyway */
        }
        onUnlock();
      }, 750);
    } else {
      setError(true);
      setShaking(true);
      setPw('');
      if (inputRef.current) inputRef.current.focus();
    }
  }

  return (
    <div className="login-screen">
      <div className="blob blob-1" />
      <div className="blob blob-2" />
      <div className="blob blob-3" />
      <div className="star star-1" />
      <div className="star star-2" />
      <div className="star star-3" />
      <div className="star star-4" />
      <div className="sunburst" aria-hidden="true" />
      <div className="orbit" aria-hidden="true">
        <span className="orbit-item orbit-item-1">⭐</span>
        <span className="orbit-item orbit-item-2">☁️</span>
        <span className="orbit-item orbit-item-3">🎈</span>
        <span className="orbit-item orbit-item-4">🌈</span>
      </div>
      <div className="sun-face" aria-hidden="true">🌞</div>
      <div
        className={`login-card${shaking ? ' shake' : ''}`}
        onAnimationEnd={(e) => {
          if (e.target === e.currentTarget) setShaking(false);
        }}
      >
        <div className="speech-bubble" key={success ? 'yay' : 'hello'}>
          {success
            ? 'Yahoo! Sahi password 🎉 Khul raha hai…'
            : 'Hello! 👋 Main Faizan — HumanizeAI mein khush aamdeed! Andar aane ke liye password likho.'}
        </div>
        <div className="avatar-wrap">
          <img
            className={`login-avatar${success ? ' jump' : ''}`}
            src={AVATAR_DATA_URI}
            alt="Muhammad Faizan Jamshaid"
          />
          <span className="wave-hand" aria-hidden="true">👋</span>
        </div>
        <h1 className="login-name">Muhammad Faizan Jamshaid</h1>
        <p className="login-sub">
          Humanize<span className="accent">AI</span> — pehle password, phir magic ✨
        </p>
        <form className="login-form" onSubmit={submit}>
          <input
            ref={inputRef}
            className="login-input"
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Password likho…"
            autoComplete="off"
            autoFocus
          />
          <button type="submit" className="login-btn" disabled={checking || success}>
            {success ? 'Khul gaya 🎉' : checking ? 'Check ho raha hai…' : 'Kholo 🔓'}
          </button>
        </form>
        {error && <p className="login-error">Ghalat password 😅 Dobara koshish karo.</p>}
      </div>
    </div>
  );
}

export default function App() {
  const [unlocked, setUnlocked] = useState(gateWasUnlocked);

  function lock() {
    try {
      sessionStorage.removeItem(GATE_KEY);
    } catch {
      /* ignore — state change below still re-locks the view */
    }
    setUnlocked(false);
  }

  if (!unlocked) {
    return <LoginGate onUnlock={() => setUnlocked(true)} />;
  }
  return <MainApp onLock={lock} />;
}
