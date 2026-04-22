const router = require('express').Router();
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const db = require('../db/schema');
const auth = require('../middleware/auth');
const { err } = require('../middleware/error');
const logger = require('../logger');

const AI_DISCLAIMER = 'AI-generated summary for clinical assistance only. Not a substitute for professional medical judgment.';

// Rate limit: 10 AI requests per clinic per minute
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  keyGenerator: (req) => `ai:${req.user?.id || req.ip}`,
  message: { success: false, message: 'AI rate limit exceeded. Max 10 requests per minute.', code: 'rate_limited' },
});

async function callGemini(prompt) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('Gemini API key not configured'), { code: 'no_api_key' });

  const start = Date.now();
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );

  const duration = Date.now() - start;
  logger.info('Gemini API call', { duration, status: response.status });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Empty response from Gemini');
  return text.trim();
}

// Strip PII — only keep clinical notes, not names/DOB/contact
function stripPii(text) {
  if (!text) return '';
  return text
    .replace(/\b[A-Z][a-z]+ [A-Z][a-z]+\b/g, '[PATIENT]')
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, '[DATE]')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[PHONE]')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g, '[EMAIL]');
}

// POST /api/ai/summarize
router.post('/summarize', auth, aiLimiter, async (req, res) => {
  const schema = z.object({
    encounterId: z.number().int().positive().optional(),
    text: z.string().min(1).optional(),
  }).refine((d) => d.encounterId || d.text, { message: 'encounterId or text is required' });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ success: false, message: 'AI service not configured: GEMINI_API_KEY is missing', code: 'ai_not_configured' });
  }

  const { encounterId, text } = parsed.data;
  let clinicalNotes = text || '';
  let encounter = null;

  if (encounterId) {
    const { rows } = await db.query(
      'SELECT * FROM encounters WHERE id = $1 AND clinic_id = $2',
      [encounterId, req.user.id]
    ).catch(() => ({ rows: [] }));

    if (!rows[0]) return err(res, 404, 'Encounter not found', 'not_found');
    encounter = rows[0];
    clinicalNotes = stripPii(`Chief complaint: ${encounter.chief_complaint || ''}. Notes: ${encounter.notes || ''}`);
  } else {
    clinicalNotes = stripPii(clinicalNotes);
  }

  const prompt = `Summarize the following clinical encounter in 2-3 sentences for a medical professional. Include chief complaint, key findings, and recommended follow-up: ${clinicalNotes}`;

  try {
    const summary = await callGemini(prompt);

    // Store summary on encounter if encounterId provided
    if (encounterId && encounter) {
      await db.query(
        'UPDATE encounters SET ai_summary = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
        [summary, encounterId]
      ).catch(() => {});
    }

    res.json({ success: true, summary, disclaimer: AI_DISCLAIMER });
  } catch (e) {
    if (e.code === 'no_api_key') {
      return res.status(503).json({ success: false, message: e.message, code: 'ai_not_configured' });
    }
    logger.error('Gemini summarize error', { error: e.message });
    res.json({
      success: true,
      summary: 'AI summary temporarily unavailable. Please review clinical notes manually.',
      disclaimer: AI_DISCLAIMER,
      fallback: true,
    });
  }
});

// POST /api/ai/insights
router.post('/insights', auth, aiLimiter, async (req, res) => {
  const schema = z.object({ patientId: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return err(res, 400, parsed.error.errors[0].message, 'validation_error');

  if (!process.env.GEMINI_API_KEY) {
    return res.status(503).json({ success: false, message: 'AI service not configured: GEMINI_API_KEY is missing', code: 'ai_not_configured' });
  }

  const { patientId } = parsed.data;

  const { rows: encounters } = await db.query(
    `SELECT chief_complaint, notes, status, created_at FROM encounters
     WHERE patient_id = $1 AND clinic_id = $2 AND status != 'cancelled'
     ORDER BY created_at DESC LIMIT 10`,
    [patientId, req.user.id]
  ).catch(() => ({ rows: [] }));

  if (!encounters.length) {
    return res.json({ success: true, insights: 'No encounter history found for this patient.', disclaimer: AI_DISCLAIMER });
  }

  const notesText = encounters
    .map((e, i) => `Visit ${i + 1} (${e.created_at?.slice(0, 10)}): ${stripPii(e.chief_complaint)} — ${stripPii(e.notes || '')}`)
    .join('\n');

  const prompt = `Analyze the following longitudinal clinical encounter history and provide a 3-5 sentence health trend summary for a medical professional. Identify recurring complaints, patterns, and any recommended follow-up actions:\n${notesText}`;

  try {
    const insights = await callGemini(prompt);
    res.json({ success: true, insights, disclaimer: AI_DISCLAIMER, encounterCount: encounters.length });
  } catch (e) {
    logger.error('Gemini insights error', { error: e.message });
    res.json({
      success: true,
      insights: 'AI insights temporarily unavailable. Please review encounter history manually.',
      disclaimer: AI_DISCLAIMER,
      fallback: true,
    });
  }
});

module.exports = router;
