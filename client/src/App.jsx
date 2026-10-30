import { useEffect, useState } from 'react';

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
    fetch(`${API_BASE}/api/health`)
      .then((r) => r.json())
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
      const res = await fetch(`${API_BASE}/api/humanize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: input, mode, intensity }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
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
      setError(
        e.message === 'Failed to fetch'
          ? 'Could not reach the server. Is it running on port 5000?'
          : e.message,
      );
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

  return (
    <div className="page">
      <header className="header">
        <div>
          <h1>Humanize<span className="accent">AI</span></h1>
          <p className="tagline">Paste a paragraph — get it back in natural human words, with the meaning untouched.</p>
        </div>
        {serverEngine === 'demo' && <span className="badge demo">Demo Mode</span>}
        {serverEngine === 'llm' && <span className="badge llm">AI Engine</span>}
        {serverEngine === 'offline' && <span className="badge offline">Server offline</span>}
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
            <h2>Humanized paragraph</h2>
            {result && <span className="word-count">{countWords(result.output)} words · {result.engine === 'llm' ? 'AI engine' : 'Demo engine'}</span>}
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
            <div className={`gate ${accepted ? 'gate-ok' : 'gate-warn'}`}>
              <div className="gate-status">
                {accepted ? '✓ Accepted' : '⚠ Check manually'}
              </div>
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
                  <span className="gate-value">{checks.lengthRatio}×</span>
                  <span className="gate-label">Length Ratio</span>
                </div>
              </div>
              <p className="gate-note">
                {accepted
                  ? 'This rewrite passed every check: names, numbers and meaning are all intact.'
                  : 'This rewrite did not pass every check. Read it side by side with your original before using it.'}
              </p>
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
