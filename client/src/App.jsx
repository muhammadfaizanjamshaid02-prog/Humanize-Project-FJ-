import { useEffect, useState } from 'react';
import { humanizeLocal } from './humanizerClient.js';

const API_BASE = import.meta.env.VITE_API_URL || '';
const MODES = ['Natural', 'Simple', 'Academic', 'Casual', 'Professional'];
const INTENSITIES = ['Light', 'Medium', 'Strong'];
const HISTORY_KEY = 'humanizeai-history';

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

export default function App() {
  const [input, setInput] = useState('');
  const [mode, setMode] = useState('Natural');
  const [intensity, setIntensity] = useState('Medium');
  const [result, setResult] = useState(null);
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

  async function humanize() {
    setError('');
    setResult(null);
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
          body: JSON.stringify({ text: input, mode, intensity }),
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

      // 2) Static-host fallback (GitHub Pages): run the SAME v2 demo
      //    algorithm in the browser. Its validation errors carry the
      //    same messages as the server's and surface the same way.
      if (!data) {
        data = { ...humanizeLocal(input, mode, intensity), local: true };
        setServerEngine('offline');
      }

      setResult(data);
      const entry = {
        id: Date.now(),
        input,
        mode: data.mode,
        intensity: data.intensity,
        result: data,
      };
      setHistory((h) => [entry, ...h].slice(0, 10));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  function copyOutput() {
    if (!result) return;
    navigator.clipboard.writeText(result.output).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function downloadOutput() {
    if (!result) return;
    const blob = new Blob([result.output], { type: 'text/plain' });
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
    setResult(entry.result);
    setError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  const checks = result ? result.checks : null;
  const accepted = result && result.status === 'Accepted';
  const returnedOriginal = result && result.status === 'Returned original';

  // Plain-language list of exactly which v2 checks failed.
  const failedChecks = [];
  if (checks && returnedOriginal) {
    if (!checks.entitiesPreserved) failedChecks.push('a name or protected item changed');
    if (!checks.numbersPreserved) failedChecks.push('a number or date changed');
    if (!checks.negationPreserved) failedChecks.push('a "not / never / no" wording changed — that can flip the meaning');
    if (checks.meaningScore < 85) failedChecks.push(`meaning score was only ${checks.meaningScore}% (needs 85%)`);
    if (checks.coverage < 85) failedChecks.push(`only ${checks.coverage}% of the original facts survived (needs 85%)`);
    if (checks.newConceptRatio > 20) failedChecks.push(`${checks.newConceptRatio}% new facts appeared that were not in your paragraph (max 20%)`);
    if (checks.lengthRatio < 0.6 || checks.lengthRatio > 1.5) failedChecks.push(`the length changed too much (${checks.lengthRatio}×)`);
    if (!checks.doubleVerified) failedChecks.push('the two verification runs did not agree');
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
            <button type="button" className="btn ghost" onClick={() => { setInput(''); setResult(null); setError(''); }}>
              Clear
            </button>
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

          <button type="button" className="btn primary" onClick={humanize} disabled={loading}>
            {loading ? 'Humanizing…' : 'Humanize'}
          </button>
          {error && <p className="error">{error}</p>}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{returnedOriginal ? 'Your paragraph (returned unchanged)' : 'Humanized paragraph'}</h2>
            {result && <span className="word-count">{countWords(result.output)} words · {result.engine === 'llm' ? 'AI engine' : result.local ? 'Demo engine · in browser' : 'Demo engine'}</span>}
          </div>
          <div className="output-box">
            {result ? result.output : <span className="placeholder">Your humanized paragraph will appear here.</span>}
          </div>
          <div className="row">
            <button type="button" className="btn ghost" onClick={copyOutput} disabled={!result}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
            <button type="button" className="btn ghost" onClick={downloadOutput} disabled={!result}>
              Download .txt
            </button>
          </div>

          {result && checks && (
            <div className={`gate ${accepted ? 'gate-ok' : 'gate-fail'}`}>
              <div className="gate-status">
                {accepted ? '✓ Accepted' : '⛔ Returned original — rewrite rejected'}
              </div>
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
                  <span className="gate-value">{checks.doubleVerified ? '✓' : '✗'}</span>
                  <span className="gate-label">Double Verified</span>
                </div>
              </div>
              <p className="gate-note">
                {accepted
                  ? 'This rewrite passed all six safety checks, verified twice: names, numbers, negations and meaning are all intact, every fact survived, and no new facts were added.'
                  : 'The rewrite was not safe, so it was rejected and your original paragraph is returned untouched. Nothing in it was changed.'}
              </p>
              {checks.readabilityIn != null && (
                <p className="gate-stats">
                  Readability (Flesch): {checks.readabilityIn} → {checks.readabilityOut}
                  {' · '}Repetition index: {checks.repetitionIn} → {checks.repetitionOut}
                  {checks.candidatesTried != null && (
                    <>{' · '}Candidates tried: {checks.candidatesTried}, passed the gate: {checks.candidatesPassed}</>
                  )}
                </p>
              )}
              {returnedOriginal && result.rejectedOutput && (
                <details className="gate-details">
                  <summary>Why was it rejected?</summary>
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
                  <p className="gate-rejected-label">The rejected rewrite (not delivered):</p>
                  <p className="gate-rejected">{result.rejectedOutput}</p>
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
                    {h.mode} · {h.intensity} · {h.result.status} · Meaning {h.result.checks.meaningScore}%
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
