'use strict';

const express = require('express');
const cors = require('cors');
const { humanize, llmConfig, MODES, INTENSITIES, PURPOSES, DEPTHS } = require('./humanizer');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json({ limit: '100kb' }));

app.get('/api/health', (req, res) => {
  const cfg = llmConfig();
  res.json({
    ok: true,
    service: 'HumanizeAI',
    engine: cfg ? 'llm' : 'demo',
    model: cfg ? cfg.model : null,
  });
});

app.post('/api/humanize', async (req, res) => {
  try {
    const {
      text, mode = 'Natural', intensity = 'Medium',
      purpose = 'General', depth = 'Advanced', voiceSample,
    } = req.body || {};

    if (typeof text !== 'string' || !text.trim()) {
      return res.status(400).json({ error: 'Please paste a paragraph first.' });
    }
    if (!MODES.includes(mode)) {
      return res.status(400).json({ error: `Unknown mode. Choose one of: ${MODES.join(', ')}.` });
    }
    if (!INTENSITIES.includes(intensity)) {
      return res.status(400).json({ error: `Unknown intensity. Choose one of: ${INTENSITIES.join(', ')}.` });
    }
    // v3 fields — all optional; validated only when supplied.
    if (!PURPOSES.includes(purpose)) {
      return res.status(400).json({ error: `Unknown purpose. Choose one of: ${PURPOSES.join(', ')}.` });
    }
    if (!DEPTHS.includes(depth)) {
      return res.status(400).json({ error: `Unknown depth. Choose one of: ${DEPTHS.join(', ')}.` });
    }
    if (voiceSample !== undefined && voiceSample !== null && typeof voiceSample !== 'string') {
      return res.status(400).json({ error: 'Voice sample must be text.' });
    }

    const words = text.trim().split(/\s+/).filter(Boolean).length;
    if (words < 10) {
      return res.status(400).json({ error: 'Paragraph is too short — please give at least 10 words.' });
    }
    if (words > 1000) {
      return res.status(400).json({ error: 'Paragraph is too long — the limit is 1000 words.' });
    }

    const result = await humanize(text.trim(), mode, intensity, {
      purpose, depth, voiceSample: voiceSample || null,
    });
    return res.json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Something went wrong while humanizing. Please try again.' });
  }
});

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

// Clean JSON errors for malformed request bodies.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body was not valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request is too large.' });
  }
  return next(err);
});

app.listen(PORT, () => {
  const cfg = llmConfig();
  console.log(`HumanizeAI server running on http://localhost:${PORT}`);
  console.log(cfg ? `Engine: LLM (${cfg.model})` : 'Engine: demo (rule-based, no API key configured)');
});
