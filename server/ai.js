import fs from 'node:fs';
import OpenAI from 'openai';
import { db } from './db.js';
import { cosineSimilarity } from './files.js';

const serverOpenAi = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const chatModel = process.env.CHAT_MODEL || 'gpt-4o-mini';
const transcriptionModel = process.env.TRANSCRIPTION_MODEL || 'gpt-4o-mini-transcribe';
const embeddingModel = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';

function clientFromKey(apiKey) {
  const trimmed = String(apiKey || '').trim();
  return trimmed ? new OpenAI({ apiKey: trimmed }) : serverOpenAi;
}

export function hasOpenAi(apiKey = '') {
  return Boolean(clientFromKey(apiKey));
}

function requireOpenAi(apiKey = '') {
  const client = clientFromKey(apiKey);
  if (!client) {
    throw new Error('OpenAI API key is not configured. Add a key in the app or configure OPENAI_API_KEY on the server.');
  }
  return client;
}

export function describeAiError(error) {
  const status = error?.status ? `${error.status} ` : '';
  const code = error?.code ? ` (${error.code})` : '';
  const cause = error?.cause?.message ? ` Cause: ${error.cause.message}` : '';
  return `${status}${error?.message || 'OpenAI request failed'}${code}.${cause}`.trim();
}

export async function transcribeAudio(filePath, apiKey = '') {
  const client = requireOpenAi(apiKey);
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await client.audio.transcriptions.create({
        file: fs.createReadStream(filePath),
        model: transcriptionModel,
        response_format: 'json'
      });
      return result.text || '';
    } catch (error) {
      lastError = error;
      if (error.status && error.status < 500) break;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1200));
    }
  }
  throw new Error(describeAiError(lastError));
}

export async function embedText(text, apiKey = '') {
  const client = requireOpenAi(apiKey);
  const input = String(text || '').slice(0, 8000);
  if (!input.trim()) return null;
  const response = await client.embeddings.create({
    model: embeddingModel,
    input
  });
  return response.data[0]?.embedding || null;
}

export async function indexFileChunks(fileId, sessionId, chunks, nowIso, idFactory, apiKey = '') {
  if (!hasOpenAi(apiKey)) {
    for (const chunk of chunks) {
      db.prepare(`
        INSERT INTO file_embeddings (id, file_id, session_id, chunk_text, embedding, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(idFactory(), fileId, sessionId, chunk, null, nowIso());
    }
    return;
  }

  for (const chunk of chunks) {
    const embedding = await embedText(chunk, apiKey);
    db.prepare(`
      INSERT INTO file_embeddings (id, file_id, session_id, chunk_text, embedding, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(idFactory(), fileId, sessionId, chunk, embedding ? JSON.stringify(embedding) : null, nowIso());
  }
}

export async function retrieveEvidence(sessionId, query, limit = 6, apiKey = '') {
  const rows = db
    .prepare(`
      SELECT fe.chunk_text, fe.embedding, uf.original_name
      FROM file_embeddings fe
      JOIN uploaded_files uf ON uf.id = fe.file_id
      WHERE fe.session_id = ?
    `)
    .all(sessionId);

  if (!rows.length) return [];

  if (!hasOpenAi(apiKey)) {
    return rows.slice(0, limit).map((row) => ({
      source: row.original_name,
      text: row.chunk_text,
      score: 0
    }));
  }

  const queryEmbedding = await embedText(query, apiKey);
  return rows
    .map((row) => ({
      source: row.original_name,
      text: row.chunk_text,
      score: row.embedding ? cosineSimilarity(queryEmbedding, JSON.parse(row.embedding)) : 0
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function transcriptContext(sessionId, maxSegments = 20) {
  return db
    .prepare('SELECT speaker, text, created_at FROM transcript_segments WHERE session_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(sessionId, maxSegments)
    .reverse()
    .map((segment) => `[${segment.created_at}] ${segment.speaker}: ${segment.text}`)
    .join('\n');
}

function previousFollowUps(sessionId, limit = 12) {
  return db
    .prepare(`
      SELECT title, content, status, created_at
      FROM assistant_events
      WHERE session_id = ? AND type IN ('follow_up', 'risk', 'control_gap', 'evidence_gap')
      ORDER BY created_at DESC
      LIMIT ?
    `)
    .all(sessionId, limit)
    .reverse()
    .map((event) => `[${event.created_at}] ${event.status}: ${event.title || ''} - ${event.content}`)
    .join('\n');
}

function allTranscriptContext(sessionId, maxSegments = 500) {
  return transcriptContext(sessionId, maxSegments);
}

const auditorSystemPrompt = `
You are a professional internal auditor with more than 20 years of experience across finance, operations, manufacturing, IT, procurement, sales, HR, compliance, and regulated sectors.
You are supporting a live interview between an auditor and an auditee.
Think like an internal auditor: focus on objectives, risks, controls, control design, control operation, evidence, root causes, exceptions, segregation of duties, compliance, fraud indicators, governance, and practical next steps.
Be concise and usable during a live interview. Do not invent facts. Separate transcript-based observations from document-based evidence. Ask follow-up questions the auditor can use immediately.
Do not speak to the auditee. Do not produce text for the app to read aloud. Your output is for the auditor's screen only.
The interview may be multilingual. Respond in the same language as the auditor question when clear; otherwise use English.
`;

export async function answerAuditorQuestion({ session, sessionId, question, apiKey = '' }) {
  const evidence = await retrieveEvidence(sessionId, question, 6, apiKey);
  const transcript = transcriptContext(sessionId, 30);
  const client = requireOpenAi(apiKey);

  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0.25,
    messages: [
      { role: 'system', content: auditorSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Answer the auditor question using the live transcript and uploaded evidence.',
          session,
          question,
          recentTranscript: transcript,
          evidence
        })
      }
    ]
  });

  return { content: response.choices[0]?.message?.content || '', evidence };
}

export async function generateProactiveSuggestions({ session, sessionId, apiKey = '' }) {
  const recentTranscript = transcriptContext(sessionId, 10);
  if (!recentTranscript.trim()) return [];

  const evidence = await retrieveEvidence(sessionId, recentTranscript, 3, apiKey);
  const previousQuestions = previousFollowUps(sessionId);
  const client = requireOpenAi(apiKey);
  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0.2,
    messages: [
      { role: 'system', content: auditorSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Generate 1 to 2 live follow-up questions for the auditor to ask next. Return strict JSON only.',
          requiredJsonShape: [
            {
              type: 'follow_up|risk|control_gap|evidence_gap',
              severity: 'low|medium|high|critical',
              title: 'very short title',
              content: 'one clear, specific question the auditor can ask now',
              evidenceSources: ['uploaded file names or transcript when relevant']
            }
          ],
          selectionRules: [
            'Every item must be directly relevant to the most recent discussion point in the transcript.',
            'Use uploaded evidence to challenge, clarify, or extend the discussion when the evidence is relevant.',
            'Prefer one excellent question over two average questions.',
            'Only return two questions when both are clearly necessary and address different audit angles.',
            'Each content field must be one question, not a paragraph and not a list.',
            'Prefer practical questions about risks, controls, control operation, exceptions, evidence, owners, timing, and gaps.',
            'Do not repeat previous follow-up questions unless the live transcript makes the repeated question newly necessary.',
            'If there is not enough new substance, return an empty suggestions array.'
          ],
          session,
          recentTranscript,
          evidence,
          previousQuestions
        })
      }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = response.choices[0]?.message?.content || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed : parsed.suggestions || parsed.items || [];
}

export async function generateFinalSummary({ session, sessionId, apiKey = '' }) {
  const transcript = transcriptContext(sessionId, 200);
  const evidence = await retrieveEvidence(sessionId, transcript, 8, apiKey);
  const client = requireOpenAi(apiKey);
  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0.2,
    messages: [
      { role: 'system', content: auditorSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Create internal audit interview notes grouped by process area, risk, control, finding candidate, evidence gap, and required follow-up.',
          session,
          transcript,
          evidence
        })
      }
    ]
  });

  return { content: response.choices[0]?.message?.content || '', evidence };
}

export async function generateAuditReportContent({ session, sessionId, apiKey = '' }) {
  const transcript = allTranscriptContext(sessionId, 1000);
  const evidence = await retrieveEvidence(sessionId, transcript, 16, apiKey);
  const client = requireOpenAi(apiKey);
  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0.2,
    messages: [
      { role: 'system', content: auditorSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Create a structured internal audit interview report with all relevant consolidated findings from the complete conversation. Return strict JSON only.',
          requiredJsonShape: {
            executiveSummary: 'concise audit-oriented summary based on the whole conversation and auditee insights',
            findings: [
              {
                title: 'short finding title',
                severity: 'high|medium|low',
                finding: 'summarized finding based on the whole conversation and auditee insights',
                rootCauses: ['specific and cross-cutting root causes integrated into this finding; use not determined if unclear'],
                potentialRisks: ['risk statements'],
                recommendations: ['practical internal audit recommendations'],
                evidenceGaps: ['missing evidence or points to verify']
              }
            ]
          },
          rules: [
            'Do not invent facts. If something is unclear, say not determined or requires verification.',
            'Separate interview observations from uploaded evidence where relevant.',
            'Base findings on the entire conversation and all auditee insights, not only isolated transcript fragments.',
            'Identify every relevant internal-audit finding supported by the conversation or uploaded evidence.',
            'Do not limit the report to two findings. Return as many findings as are relevant and non-duplicative.',
            'Combine similar or overlapping issues into one consolidated finding.',
            'Do not include live follow-up questions or assistant recommendations in the report.',
            'Integrate cross-cutting root causes into the rootCauses, potentialRisks, and recommendations of the corresponding findings.',
            'Do not create separate cross-cutting sections outside the findings.',
            'For each finding, preserve this order: finding, root causes, potential risks, recommendations.',
            'Prioritize from an internal audit perspective: control design, control operation, evidence, risk, root cause, and remediation.',
            'Assign severity high, medium, or low to every finding based on likely impact and urgency.',
            'Order findings from most important to least important.',
            'Keep the output professional and suitable for a Word report.'
          ],
          session,
          transcript,
          evidence
        })
      }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    return JSON.parse(raw);
  } catch {
    return {
      executiveSummary: response.choices[0]?.message?.content || 'No report content generated.',
      findings: []
    };
  }
}

export async function generateProcessMapContent({ session, sessionId, apiKey = '' }) {
  const transcript = allTranscriptContext(sessionId, 500);
  if (!transcript.trim()) {
    return {
      available: false,
      reason: 'No transcript is available for process visualization.',
      title: '',
      steps: []
    };
  }

  const evidence = await retrieveEvidence(sessionId, transcript, 8, apiKey);
  const client = requireOpenAi(apiKey);
  const response = await client.chat.completions.create({
    model: chatModel,
    temperature: 0.15,
    messages: [
      { role: 'system', content: auditorSystemPrompt },
      {
        role: 'user',
        content: JSON.stringify({
          task: 'Extract an ordered process visualization from the interview. Return strict JSON only.',
          requiredJsonShape: {
            available: true,
            reason: 'short explanation when unavailable',
            title: 'short process title',
            steps: [
              {
                order: 1,
                name: 'short step name',
                actor: 'owner, role, or team if available',
                description: 'what happens in this step',
                controlOrRiskNote: 'control, risk, handoff, or evidence note if relevant'
              }
            ]
          },
          rules: [
            'Set available=false and steps=[] when the conversation does not describe at least three ordered process steps.',
            'Only extract sequence that is supported by the transcript or evidence.',
            'Keep step names short and process-oriented.',
            'Preserve the actual order described by the auditee when clear.',
            'Do not invent process steps to make a map complete.'
          ],
          session,
          transcript,
          evidence
        })
      }
    ],
    response_format: { type: 'json_object' }
  });

  const raw = response.choices[0]?.message?.content || '{}';
  try {
    const parsed = JSON.parse(raw);
    const steps = Array.isArray(parsed.steps)
      ? parsed.steps
          .map((step, index) => ({
            order: Number.isFinite(Number(step.order)) ? Number(step.order) : index + 1,
            name: String(step.name || '').trim(),
            actor: String(step.actor || '').trim(),
            description: String(step.description || '').trim(),
            controlOrRiskNote: String(step.controlOrRiskNote || '').trim()
          }))
          .filter((step) => step.name || step.description)
          .sort((a, b) => a.order - b.order)
      : [];

    if (!parsed.available || steps.length < 3) {
      return {
        available: false,
        reason: parsed.reason || 'Not enough ordered process steps were identified in the interview.',
        title: parsed.title || '',
        steps: []
      };
    }

    return {
      available: true,
      reason: '',
      title: parsed.title || session.business_process || 'Interview process map',
      steps
    };
  } catch {
    return {
      available: false,
      reason: 'The process visualization response could not be parsed.',
      title: '',
      steps: []
    };
  }
}
