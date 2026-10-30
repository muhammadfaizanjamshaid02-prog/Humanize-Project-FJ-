import { useEffect, useState } from 'react';
import {
  humanizeLocal, verifyEdit, synonymAlternatives,
  PURPOSES, PURPOSE_DEFAULTS, DEPTHS,
} from './humanizerClient.js';

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

export default function App() {
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
      </header>

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
                : 'Advanced: up to 3 rewrites compete; the safest, most natural one wins.'}
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

      <footer className="footer">
        AI Writing Assistant — always review the output yourself before using it.
      </footer>
    </div>
  );
}
