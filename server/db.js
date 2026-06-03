import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
fs.mkdirSync(dataDir, { recursive: true });

export const db = new Database(path.join(dataDir, 'audit-assistant.sqlite'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    auditee_name TEXT,
    business_process TEXT,
    audit_area TEXT,
    objective TEXT,
    scope TEXT,
    auditor_notes TEXT,
    follow_up_interval_sec INTEGER NOT NULL DEFAULT 15,
    interview_date TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS transcript_segments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    speaker TEXT NOT NULL DEFAULT 'Unknown',
    text TEXT NOT NULL,
    started_at TEXT,
    ended_at TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS uploaded_files (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    file_path TEXT NOT NULL,
    extracted_text TEXT,
    status TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS file_embeddings (
    id TEXT PRIMARY KEY,
    file_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    chunk_text TEXT NOT NULL,
    embedding TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (file_id) REFERENCES uploaded_files(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS assistant_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    type TEXT NOT NULL,
    title TEXT,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    evidence_refs TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS audio_chunks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    mime_type TEXT,
    status TEXT NOT NULL,
    transcript_segment_id TEXT,
    error TEXT,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
`);

const sessionColumns = db.prepare('PRAGMA table_info(sessions)').all().map((column) => column.name);
if (!sessionColumns.includes('follow_up_interval_sec')) {
  db.exec('ALTER TABLE sessions ADD COLUMN follow_up_interval_sec INTEGER NOT NULL DEFAULT 15');
}

export function nowIso() {
  return new Date().toISOString();
}

export function getSessionBundle(sessionId) {
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;

  const transcript = db
    .prepare('SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId);
  const files = db
    .prepare('SELECT id, original_name, mime_type, status, error, created_at FROM uploaded_files WHERE session_id = ? ORDER BY created_at DESC')
    .all(sessionId);
  const events = db
    .prepare('SELECT * FROM assistant_events WHERE session_id = ? ORDER BY created_at DESC LIMIT 80')
    .all(sessionId)
    .map((event) => ({
      ...event,
      evidence_refs: event.evidence_refs ? JSON.parse(event.evidence_refs) : []
    }));

  return { session, transcript, files, events };
}

export function updateSessionTimestamp(sessionId) {
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(nowIso(), sessionId);
}
