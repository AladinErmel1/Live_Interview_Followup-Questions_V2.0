import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, getSessionBundle, nowIso, updateSessionTimestamp } from './db.js';
import { chunkText, extractTextFromFile } from './files.js';
import {
  answerAuditorQuestion,
  describeAiError,
  generateAuditReportContent,
  generateFinalSummary,
  generateProcessMapContent,
  generateProactiveSuggestions,
  hasOpenAi,
  indexFileChunks,
  transcribeAudio
} from './ai.js';
import {
  buildAuditReportDocx,
  buildProcessMapDocx,
  buildProcessMapPng,
  buildTranscriptDocx,
  documentFileName,
  imageFileName
} from './documents.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const isRailwayRuntime = Boolean(
  process.env.RAILWAY_PROJECT_ID ||
  process.env.RAILWAY_SERVICE_ID ||
  process.env.RAILWAY_ENVIRONMENT_ID
);
const host = process.env.HOST || (isRailwayRuntime ? '0.0.0.0' : '127.0.0.1');
const dataDir = path.resolve(process.env.DATA_DIR || './data');

fs.mkdirSync(dataDir, { recursive: true });

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use((req, _res, next) => {
  req.openAiApiKey = req.get('x-openai-api-key') || '';
  next();
});

function sessionDir(sessionId, kind) {
  const dir = path.join(dataDir, 'sessions', sessionId, kind);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function requireSession(req, res, next) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!session) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  req.session = session;
  next();
}

function normalizeFollowUpInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(120, Math.max(10, Math.round(parsed)));
}

const upload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      cb(null, sessionDir(req.params.id, 'files'));
    },
    filename(_req, file, cb) {
      const safeName = file.originalname.replace(/[^\w.\-() ]+/g, '_');
      cb(null, `${Date.now()}-${randomUUID()}-${safeName}`);
    }
  }),
  limits: { fileSize: 200 * 1024 * 1024 }
});

const audioUpload = multer({
  storage: multer.diskStorage({
    destination(req, _file, cb) {
      cb(null, sessionDir(req.params.id, 'audio'));
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname) || '.webm';
      cb(null, `${Date.now()}-${randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 80 * 1024 * 1024 }
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, openAiConfigured: hasOpenAi(_req.openAiApiKey) });
});

app.get('/api/sessions', (_req, res) => {
  const sessions = db
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC LIMIT 40')
    .all();
  res.json({ sessions });
});

app.post('/api/sessions', (req, res) => {
  const id = randomUUID();
  const createdAt = nowIso();
  const payload = req.body || {};
  db.prepare(`
    INSERT INTO sessions (
      id, auditee_name, business_process, audit_area, objective, scope,
      auditor_notes, follow_up_interval_sec, interview_date, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    payload.auditeeName || '',
    payload.businessProcess || '',
    payload.auditArea || '',
    payload.objective || '',
    payload.scope || '',
    payload.auditorNotes || '',
    normalizeFollowUpInterval(payload.followUpIntervalSec),
    payload.interviewDate || new Date().toISOString().slice(0, 10),
    'active',
    createdAt,
    createdAt
  );

  res.status(201).json(getSessionBundle(id));
});

app.get('/api/sessions/:id', requireSession, (req, res) => {
  res.json(getSessionBundle(req.params.id));
});

app.patch('/api/sessions/:id', requireSession, (req, res) => {
  const payload = req.body || {};
  db.prepare(`
    UPDATE sessions SET
      auditee_name = COALESCE(?, auditee_name),
      business_process = COALESCE(?, business_process),
      audit_area = COALESCE(?, audit_area),
      objective = COALESCE(?, objective),
      scope = COALESCE(?, scope),
      auditor_notes = COALESCE(?, auditor_notes),
      follow_up_interval_sec = COALESCE(?, follow_up_interval_sec),
      status = COALESCE(?, status),
      updated_at = ?
    WHERE id = ?
  `).run(
    payload.auditeeName,
    payload.businessProcess,
    payload.auditArea,
    payload.objective,
    payload.scope,
    payload.auditorNotes,
    payload.followUpIntervalSec == null ? null : normalizeFollowUpInterval(payload.followUpIntervalSec),
    payload.status,
    nowIso(),
    req.params.id
  );
  res.json(getSessionBundle(req.params.id));
});

app.post('/api/sessions/:id/audio-chunk', requireSession, audioUpload.single('audio'), async (req, res) => {
  const audioId = randomUUID();
  const createdAt = nowIso();
  db.prepare(`
    INSERT INTO audio_chunks (id, session_id, file_path, mime_type, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(audioId, req.params.id, req.file.path, req.file.mimetype, 'transcribing', createdAt);

  try {
    const text = await transcribeAudio(req.file.path, req.openAiApiKey);
    const segmentId = randomUUID();
    if (text.trim()) {
      db.prepare(`
        INSERT INTO transcript_segments (id, session_id, speaker, text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(segmentId, req.params.id, 'Live audio', text.trim(), nowIso());
    }
    db.prepare(`
      UPDATE audio_chunks SET status = ?, transcript_segment_id = ? WHERE id = ?
    `).run('transcribed', text.trim() ? segmentId : null, audioId);
    updateSessionTimestamp(req.params.id);
    res.json({ audioId, segment: text.trim() ? { id: segmentId, text: text.trim(), speaker: 'Live audio' } : null });
  } catch (error) {
    const message = describeAiError(error);
    db.prepare('UPDATE audio_chunks SET status = ?, error = ? WHERE id = ?').run('failed', message, audioId);
    res.status(500).json({ error: message });
  }
});

app.post('/api/sessions/:id/transcript', requireSession, (req, res) => {
  const id = randomUUID();
  db.prepare(`
    INSERT INTO transcript_segments (id, session_id, speaker, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, req.params.id, req.body?.speaker || 'Manual note', req.body?.text || '', nowIso());
  updateSessionTimestamp(req.params.id);
  res.status(201).json(getSessionBundle(req.params.id));
});

app.post('/api/sessions/:id/audio-chunks/:audioId/retry', requireSession, async (req, res) => {
  const chunk = db
    .prepare('SELECT * FROM audio_chunks WHERE id = ? AND session_id = ?')
    .get(req.params.audioId, req.params.id);
  if (!chunk) {
    res.status(404).json({ error: 'Audio chunk not found' });
    return;
  }

  try {
    db.prepare('UPDATE audio_chunks SET status = ?, error = NULL WHERE id = ?').run('transcribing', chunk.id);
    const text = await transcribeAudio(chunk.file_path, req.openAiApiKey);
    const segmentId = randomUUID();
    if (text.trim()) {
      db.prepare(`
        INSERT INTO transcript_segments (id, session_id, speaker, text, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(segmentId, req.params.id, 'Live audio', text.trim(), nowIso());
    }
    db.prepare('UPDATE audio_chunks SET status = ?, transcript_segment_id = ? WHERE id = ?').run(
      'transcribed',
      text.trim() ? segmentId : null,
      chunk.id
    );
    updateSessionTimestamp(req.params.id);
    res.json(getSessionBundle(req.params.id));
  } catch (error) {
    const message = describeAiError(error);
    db.prepare('UPDATE audio_chunks SET status = ?, error = ? WHERE id = ?').run('failed', message, chunk.id);
    res.status(500).json({ error: message });
  }
});

app.post('/api/sessions/:id/files', requireSession, upload.array('files', 12), async (req, res) => {
  const results = [];

  for (const file of req.files || []) {
    const fileId = randomUUID();
    db.prepare(`
      INSERT INTO uploaded_files (id, session_id, original_name, mime_type, file_path, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fileId, req.params.id, file.originalname, file.mimetype, file.path, 'processing', nowIso());

    try {
      const extracted = await extractTextFromFile(file.path, file.originalname, file.mimetype);
      const chunks = chunkText(extracted);
      db.prepare('UPDATE uploaded_files SET extracted_text = ?, status = ? WHERE id = ?').run(extracted, 'indexed', fileId);
      await indexFileChunks(fileId, req.params.id, chunks, nowIso, randomUUID, req.openAiApiKey);
      results.push({ id: fileId, originalName: file.originalname, status: 'indexed', chunks: chunks.length });
    } catch (error) {
      db.prepare('UPDATE uploaded_files SET status = ?, error = ? WHERE id = ?').run('failed', error.message, fileId);
      results.push({ id: fileId, originalName: file.originalname, status: 'failed', error: error.message });
    }
  }

  updateSessionTimestamp(req.params.id);
  res.json({ files: results, bundle: getSessionBundle(req.params.id) });
});

app.post('/api/sessions/:id/ask', requireSession, async (req, res) => {
  try {
    const question = req.body?.question || '';
    const { content, evidence } = await answerAuditorQuestion({
      session: req.session,
      sessionId: req.params.id,
      question,
      apiKey: req.openAiApiKey
    });
    const eventId = randomUUID();
    db.prepare(`
      INSERT INTO assistant_events (id, session_id, type, title, content, evidence_refs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, req.params.id, 'answer', question.slice(0, 120), content, JSON.stringify(evidence), nowIso());
    updateSessionTimestamp(req.params.id);
    res.json({ event: db.prepare('SELECT * FROM assistant_events WHERE id = ?').get(eventId), bundle: getSessionBundle(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/suggestions', requireSession, (req, res) => {
  const events = db
    .prepare("SELECT * FROM assistant_events WHERE session_id = ? AND type NOT IN ('answer', 'summary') ORDER BY created_at DESC LIMIT 30")
    .all(req.params.id);
  res.json({ suggestions: events });
});

app.post('/api/sessions/:id/suggestions/generate', requireSession, async (req, res) => {
  try {
    const suggestions = await generateProactiveSuggestions({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    const inserted = [];
    for (const suggestion of suggestions.slice(0, 2)) {
      if (!suggestion?.content) continue;
      const id = randomUUID();
      db.prepare(`
        INSERT INTO assistant_events (id, session_id, type, title, content, evidence_refs, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        req.params.id,
        suggestion.type || 'follow_up',
        suggestion.title || 'Audit suggestion',
        suggestion.content,
        JSON.stringify({
          severity: suggestion.severity || 'medium',
          evidenceSources: suggestion.evidenceSources || []
        }),
        nowIso()
      );
      inserted.push(db.prepare('SELECT * FROM assistant_events WHERE id = ?').get(id));
    }
    updateSessionTimestamp(req.params.id);
    res.json({ suggestions: inserted, bundle: getSessionBundle(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/sessions/:id/events/:eventId', requireSession, (req, res) => {
  db.prepare('UPDATE assistant_events SET status = ? WHERE id = ? AND session_id = ?').run(
    req.body?.status || 'new',
    req.params.eventId,
    req.params.id
  );
  res.json(getSessionBundle(req.params.id));
});

app.post('/api/sessions/:id/final-summary', requireSession, async (req, res) => {
  try {
    const { content, evidence } = await generateFinalSummary({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    const eventId = randomUUID();
    db.prepare(`
      INSERT INTO assistant_events (id, session_id, type, title, content, evidence_refs, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, req.params.id, 'summary', 'Interview summary and audit notes', content, JSON.stringify(evidence), nowIso());
    db.prepare('UPDATE sessions SET status = ?, updated_at = ? WHERE id = ?').run('completed', nowIso(), req.params.id);
    res.json({ bundle: getSessionBundle(req.params.id) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/download/transcript.docx', requireSession, async (req, res) => {
  try {
    const bundle = getSessionBundle(req.params.id);
    const buffer = await buildTranscriptDocx(bundle);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${documentFileName(req.session, 'transcript')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/sessions/:id/download/audit-report.docx', requireSession, async (req, res) => {
  try {
    const report = await generateAuditReportContent({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    const processMap = await generateProcessMapContent({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    const buffer = await buildAuditReportDocx({ session: req.session, report, processMap });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${documentFileName(req.session, 'audit-report')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: describeAiError(error) });
  }
});

app.get('/api/sessions/:id/download/process-map.docx', requireSession, async (req, res) => {
  try {
    const processMap = await generateProcessMapContent({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    if (!processMap.available) {
      res.status(422).json({ error: processMap.reason || 'Not enough process sequence information was identified.' });
      return;
    }
    const buffer = await buildProcessMapDocx({ session: req.session, processMap });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${documentFileName(req.session, 'process-map')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: describeAiError(error) });
  }
});

app.get('/api/sessions/:id/download/process-map.png', requireSession, async (req, res) => {
  try {
    const processMap = await generateProcessMapContent({ session: req.session, sessionId: req.params.id, apiKey: req.openAiApiKey });
    if (!processMap.available) {
      res.status(422).json({ error: processMap.reason || 'Not enough process sequence information was identified.' });
      return;
    }
    const buffer = await buildProcessMapPng(processMap);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${imageFileName(req.session, 'process-map')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(buffer);
  } catch (error) {
    res.status(500).json({ error: describeAiError(error) });
  }
});

app.use(express.static(path.resolve('dist')));
app.get('*', (_req, res) => {
  const indexPath = path.resolve('dist/index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.status(404).send('Client build not found. Run npm run dev for development or npm run build before npm start.');
});

app.listen(port, host, () => {
  const browserHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`Internal Audit Interview Assistant API listening on ${host}:${port}`);
  console.log(`Local browser URL: http://${browserHost}:${port}`);
});
