import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

const emptySessionForm = {
  auditeeName: '',
  businessProcess: '',
  auditArea: '',
  objective: '',
  scope: '',
  auditorNotes: '',
  followUpIntervalSec: '15',
  interviewDate: new Date().toISOString().slice(0, 10)
};

const followUpIntervalOptions = [15, 30, 45, 60, 90, 120];
const openAiKeyStorageKey = 'auditAssistantOpenAiKey';

function normalizeInterval(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 15;
  return Math.min(120, Math.max(10, Math.round(parsed)));
}

async function api(path, options = {}, openAiKey = '') {
  const headers = new Headers(options.headers || {});
  if (openAiKey.trim()) {
    headers.set('X-OpenAI-API-Key', openAiKey.trim());
  }
  const response = await fetch(path, { ...options, headers });
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) {
    throw new Error(body?.error || body || `Request failed: ${response.status}`);
  }
  return body;
}

function Field({ label, name, value, onChange, multiline = false, placeholder = '' }) {
  return (
    <label className="field">
      <span>{label}</span>
      {multiline ? (
        <textarea name={name} value={value} onChange={onChange} placeholder={placeholder} rows={3} />
      ) : (
        <input name={name} value={value} onChange={onChange} placeholder={placeholder} />
      )}
    </label>
  );
}

function StatusPill({ children, tone = 'neutral' }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

function eventMeta(event) {
  const refs = event?.evidence_refs;
  if (Array.isArray(refs)) return refs[0] || {};
  if (refs && typeof refs === 'object') return refs;
  return {};
}

function followUpPriority(event) {
  const severityRank = { critical: 5, high: 4, medium: 3, low: 2 };
  const typeRank = { risk: 4, control_gap: 4, evidence_gap: 3, follow_up: 2 };
  const statusRank = { new: 3, useful: 2, asked: 1, ignored: 0 };
  const meta = eventMeta(event);
  return (
    (severityRank[String(meta.severity || '').toLowerCase()] || 1) * 1000 +
    (typeRank[event.type] || 1) * 100 +
    (statusRank[event.status] ?? 1) * 10 +
    new Date(event.created_at || 0).getTime() / 10000000000000
  );
}

function compareFollowUps(a, b) {
  return followUpPriority(b) - followUpPriority(a);
}

function App() {
  const [health, setHealth] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [bundle, setBundle] = useState(null);
  const [form, setForm] = useState(emptySessionForm);
  const [question, setQuestion] = useState('');
  const [manualTranscript, setManualTranscript] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [openAiKey, setOpenAiKey] = useState(() => window.localStorage.getItem(openAiKeyStorageKey) || '');
  const [openAiKeyDraft, setOpenAiKeyDraft] = useState('');
  const [recording, setRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [assistantFullscreen, setAssistantFullscreen] = useState(false);
  const [recordingState, setRecordingState] = useState('idle');
  const [segmentCount, setSegmentCount] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [livePreview, setLivePreview] = useState('');
  const mediaRecorderRef = useRef(null);
  const streamRef = useRef(null);
  const audioContextRef = useRef(null);
  const animationFrameRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const recordingActiveRef = useRef(false);
  const pausedRef = useRef(false);
  const segmentTimerRef = useRef(null);
  const finalStopRef = useRef(false);
  const latestTranscriptRef = useRef('');
  const bundleRef = useRef(null);
  const lastFollowUpTranscriptRef = useRef('');

  const session = bundle?.session;
  const transcript = bundle?.transcript || [];
  const files = bundle?.files || [];
  const events = bundle?.events || [];
  const suggestions = events.filter((event) => event.type !== 'answer' && event.type !== 'summary');
  const answers = events.filter((event) => event.type === 'answer' || event.type === 'summary');
  const prioritizedSuggestions = [...suggestions].sort(compareFollowUps);
  const currentSuggestions = prioritizedSuggestions.slice(0, 2);
  const previousSuggestions = prioritizedSuggestions.slice(2, 7);
  const openPreviousCount = suggestions.filter((event) => !['asked', 'ignored'].includes(event.status)).length;
  const recentAnswers = answers.slice(0, 6);
  const followUpIntervalSec = normalizeInterval(session?.follow_up_interval_sec || form.followUpIntervalSec);
  const openAiReady = Boolean(health?.openAiConfigured || openAiKey);
  const apiRequest = (path, options = {}) => api(path, options, openAiKey);

  const latestTranscriptText = useMemo(
    () => transcript.map((segment) => segment.text).join(' '),
    [transcript]
  );

  async function refreshSessions() {
    const data = await apiRequest('/api/sessions');
    setSessions(data.sessions || []);
  }

  async function loadSession(id, options = {}) {
    if (!options.silent) setBusy('Loading session');
    setError('');
    try {
      const data = await apiRequest(`/api/sessions/${id}`);
      setBundle(data);
    } catch (err) {
      setError(err.message);
    } finally {
      if (!options.silent) setBusy('');
    }
  }

  useEffect(() => {
    api('/api/health', {}, openAiKey)
      .then(setHealth)
      .catch((err) => setError(err.message));
    refreshSessions().catch((err) => setError(err.message));
  }, [openAiKey]);

  useEffect(() => {
    if (!bundle && sessions.length) {
      loadSession(sessions[0].id).catch((err) => setError(err.message));
    }
  }, [sessions, bundle]);

  useEffect(() => {
    latestTranscriptRef.current = latestTranscriptText.trim();
    bundleRef.current = bundle;
  }, [latestTranscriptText, bundle]);

  useEffect(() => {
    lastFollowUpTranscriptRef.current = '';
  }, [session?.id]);

  useEffect(() => {
    if (!session?.id || !recording || isPaused) return undefined;

    const generateTimedFollowUps = async () => {
      const transcriptSnapshot = latestTranscriptRef.current;
      if (!transcriptSnapshot || transcriptSnapshot === lastFollowUpTranscriptRef.current) return;

      lastFollowUpTranscriptRef.current = transcriptSnapshot;
      setRecordingState(`Recording: preparing follow-up questions every ${followUpIntervalSec} seconds`);
      try {
        const data = await apiRequest(`/api/sessions/${session.id}/suggestions/generate`, { method: 'POST' });
        setBundle(data.bundle || bundleRef.current);
        setRecordingState('Recording: live audio detected');
      } catch (err) {
        setError(err.message);
        setRecordingState('Recording with follow-up generation error');
      }
    };

    const timer = window.setInterval(generateTimedFollowUps, followUpIntervalSec * 1000);
    return () => window.clearInterval(timer);
  }, [session?.id, recording, isPaused, followUpIntervalSec]);

  function updateForm(event) {
    setForm((current) => ({ ...current, [event.target.name]: event.target.value }));
  }

  async function updateActiveInterval(event) {
    if (!session?.id) return;
    const nextInterval = normalizeInterval(event.target.value);
    setError('');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ followUpIntervalSec: nextInterval })
      });
      setBundle(data);
    } catch (err) {
      setError(err.message);
    }
  }

  async function createSession(event) {
    event.preventDefault();
    setBusy('Creating session');
    setError('');
    try {
      const data = await apiRequest('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      setBundle(data);
      setForm(emptySessionForm);
      await refreshSessions();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function uploadAudioBlob(blob) {
    if (!session?.id || blob.size < 500) return;
    const formData = new FormData();
    formData.append('audio', blob, `interview-${Date.now()}.webm`);
    setRecordingState('Transcribing live segment');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}/audio-chunk`, {
        method: 'POST',
        body: formData
      });
      if (data.segment) {
        await loadSession(session.id, { silent: true });
      }
      setSegmentCount((count) => count + 1);
      if (recordingActiveRef.current) {
        setRecordingState('Recording: live audio detected');
      } else if (pausedRef.current) {
        setRecordingState('Paused');
      }
    } catch (err) {
      setError(err.message);
      setRecordingState('Recording with transcription error');
    }
  }

  async function startRecording() {
    if (!session?.id) {
      setError('Create or open an interview session before recording.');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setError('This browser does not support microphone recording with MediaRecorder. Try Chrome or Edge over a secure HTTPS connection.');
      return;
    }
    setError('');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      startAudioMeter(stream);
      startLiveSpeechPreview();
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      recordingActiveRef.current = true;
      pausedRef.current = false;
      lastFollowUpTranscriptRef.current = '';
      setRecording(true);
      setIsPaused(false);
      setSegmentCount(0);
      setRecordingState(`Recording: first transcript segment in about 12 seconds; follow-ups every ${followUpIntervalSec} seconds`);
      startSegmentRecorder(stream, mimeType);
    } catch (err) {
      setError(`Microphone unavailable: ${err.message}`);
    }
  }

  function startSegmentRecorder(stream, mimeType) {
    if (!recordingActiveRef.current) return;

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunks.push(event.data);
    };

    recorder.onerror = (event) => {
      setError(`Recording error: ${event.error?.message || 'Unknown recorder error'}`);
    };

    recorder.onstop = () => {
      if (segmentTimerRef.current) {
        window.clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }

      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (blob.size > 800) {
        uploadAudioBlob(blob);
      }

      if (recordingActiveRef.current && stream.getTracks().some((track) => track.readyState === 'live')) {
        startSegmentRecorder(stream, mimeType);
      } else if (finalStopRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        if (streamRef.current === stream) streamRef.current = null;
        finalStopRef.current = false;
      }
    };

    recorder.start();
    segmentTimerRef.current = window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, 12000);
  }

  function stopRecording() {
    recordingActiveRef.current = false;
    finalStopRef.current = true;
    if (segmentTimerRef.current) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      recorder.stop();
    } else if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      finalStopRef.current = false;
    }
    stopAudioMeter();
    stopLiveSpeechPreview();
    pausedRef.current = false;
    setRecordingState('Stopped');
    setRecording(false);
    setIsPaused(false);
  }

  function pauseRecording() {
    const recorder = mediaRecorderRef.current;
    if (!recording) return;

    if (!isPaused && recorder?.state === 'recording') {
      recordingActiveRef.current = false;
      pausedRef.current = true;
      finalStopRef.current = false;
      if (segmentTimerRef.current) {
        window.clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }
      recorder.stop();
      setRecordingState('Paused');
      setIsPaused(true);
      stopAudioMeter();
      stopLiveSpeechPreview();
    } else if (isPaused && streamRef.current) {
      recordingActiveRef.current = true;
      pausedRef.current = false;
      setIsPaused(false);
      if (streamRef.current) startAudioMeter(streamRef.current);
      startLiveSpeechPreview();
      setRecordingState('Recording: live audio detected');
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) =>
        MediaRecorder.isTypeSupported(type)
      );
      startSegmentRecorder(streamRef.current, mimeType);
    }
  }

  function startAudioMeter(stream) {
    stopAudioMeter();
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const audioContext = new AudioContext();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    analyser.fftSize = 256;
    source.connect(analyser);
    audioContextRef.current = audioContext;

    const samples = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) {
        const centered = sample - 128;
        sum += centered * centered;
      }
      const rms = Math.sqrt(sum / samples.length);
      setAudioLevel(Math.min(100, Math.round(rms * 4)));
      animationFrameRef.current = window.requestAnimationFrame(tick);
    };
    tick();
  }

  function stopAudioMeter() {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    setAudioLevel(0);
  }

  function startLiveSpeechPreview() {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setLivePreview('Live speech preview is not supported in this browser. Saved transcript will still update after each segment.');
      return;
    }

    stopLiveSpeechPreview();
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    recognition.onresult = (event) => {
      let text = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        text += event.results[i][0].transcript;
      }
      setLivePreview(text.trim());
    };
    recognition.onerror = () => {
      setLivePreview('Live speech preview unavailable. Saved transcript will continue through OpenAI segments.');
    };
    recognition.onend = () => {
      if (mediaRecorderRef.current?.state === 'recording') {
        try {
          recognition.start();
        } catch {
          // Browser recognition may already be restarting.
        }
      }
    };
    speechRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setLivePreview('Live speech preview unavailable. Saved transcript will continue through OpenAI segments.');
    }
  }

  function stopLiveSpeechPreview() {
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.onend = null;
      try {
        speechRecognitionRef.current.stop();
      } catch {
        // Some browsers throw if recognition was already stopped.
      }
      speechRecognitionRef.current = null;
    }
    setLivePreview('');
  }

  async function uploadFiles(event) {
    if (!session?.id) {
      setError('Create or open a session before uploading files.');
      return;
    }
    const selected = Array.from(event.target.files || []);
    if (!selected.length) return;
    const formData = new FormData();
    selected.forEach((file) => formData.append('files', file));
    setBusy('Indexing evidence');
    setError('');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}/files`, {
        method: 'POST',
        body: formData
      });
      setBundle(data.bundle);
      event.target.value = '';
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function askAssistant(event) {
    event.preventDefault();
    if (!session?.id || !question.trim()) return;
    setBusy('Asking auditor assistant');
    setError('');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });
      setBundle(data.bundle);
      setQuestion('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function addManualTranscript(event) {
    event.preventDefault();
    if (!session?.id || !manualTranscript.trim()) return;
    setBusy('Adding note');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}/transcript`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker: 'Manual note', text: manualTranscript })
      });
      setBundle(data);
      setManualTranscript('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function markEvent(eventId, status) {
    if (!session?.id) return;
    const data = await apiRequest(`/api/sessions/${session.id}/events/${eventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    setBundle(data);
  }

  async function generateSummary() {
    if (!session?.id) return;
    setBusy('Generating final audit notes');
    setError('');
    try {
      const data = await apiRequest(`/api/sessions/${session.id}/final-summary`, { method: 'POST' });
      setBundle(data.bundle);
      await refreshSessions();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  async function downloadSessionDocument(kind) {
    if (!session?.id) return;
    setBusy(`Preparing ${kind.replace(/-/g, ' ')}`);
    setError('');
    try {
      const extension = kind === 'process-map-image' ? 'png' : 'docx';
      const routeKind = kind === 'process-map-image' ? 'process-map' : kind;
      const headers = new Headers();
      if (openAiKey.trim()) {
        headers.set('X-OpenAI-API-Key', openAiKey.trim());
      }
      const response = await fetch(`/api/sessions/${session.id}/download/${routeKind}.${extension}`, { headers });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Download failed: ${response.status}`);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') || '';
      const match = contentDisposition.match(/filename="([^"]+)"/i);
      const filename = match?.[1] || `${routeKind}.${extension}`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy('');
    }
  }

  function saveOpenAiKey(event) {
    event.preventDefault();
    const nextKey = openAiKeyDraft.trim();
    if (!nextKey) {
      setError('Enter an OpenAI API key before saving.');
      return;
    }
    window.localStorage.setItem(openAiKeyStorageKey, nextKey);
    setOpenAiKey(nextKey);
    setOpenAiKeyDraft('');
    setError('');
  }

  function clearOpenAiKey() {
    window.localStorage.removeItem(openAiKeyStorageKey);
    setOpenAiKey('');
    setOpenAiKeyDraft('');
    setHealth((current) => current ? { ...current, openAiConfigured: false } : current);
  }

  return (
    <main className={`app-shell ${assistantFullscreen ? 'assistant-fullscreen-mode' : ''}`}>
      <header className="topbar">
        <div>
          <h1>Internal Audit Interview Assistant</h1>
          <p>Live transcription, evidence-aware follow-up questions, and audit notes for auditor-auditee interviews.</p>
        </div>
        <div className="topbar-status">
          <StatusPill tone={openAiReady ? 'good' : 'warn'}>
            {openAiReady ? 'OpenAI ready' : 'Add API key'}
          </StatusPill>
          {recording ? (
            <StatusPill tone={isPaused ? 'warn' : 'danger'}>{isPaused ? 'Paused' : 'Recording'}</StatusPill>
          ) : <StatusPill>Idle</StatusPill>}
        </div>
      </header>

      {error ? <div className="notice notice-error">{error}</div> : null}
      {busy ? <div className="notice">{busy}...</div> : null}

      <section className="workspace">
        <aside className="panel sidebar">
          <h2>Session</h2>
          <section className="api-key-card">
            <div className="api-key-heading">
              <strong>OpenAI API key</strong>
              <StatusPill tone={openAiReady ? 'good' : 'warn'}>{openAiReady ? 'Ready' : 'Required'}</StatusPill>
            </div>
            <form onSubmit={saveOpenAiKey} className="api-key-form">
              <input
                type="password"
                value={openAiKeyDraft}
                onChange={(event) => setOpenAiKeyDraft(event.target.value)}
                placeholder={openAiKey ? 'Key saved in this browser' : 'Enter API key'}
                autoComplete="off"
              />
              <div className="button-row">
                <button className="primary" type="submit">Save</button>
                <button type="button" onClick={clearOpenAiKey} disabled={!openAiKey}>Clear</button>
              </div>
            </form>
          </section>

          <details className="sidebar-section" open={!session}>
            <summary>New interview</summary>
            <form onSubmit={createSession} className="stack compact-form">
              <Field label="Auditee" name="auditeeName" value={form.auditeeName} onChange={updateForm} placeholder="Name or team" />
              <Field label="Process" name="businessProcess" value={form.businessProcess} onChange={updateForm} placeholder="Procurement, IT access..." />
              <Field label="Audit area" name="auditArea" value={form.auditArea} onChange={updateForm} placeholder="Controls, compliance..." />
              <Field label="Objective" name="objective" value={form.objective} onChange={updateForm} multiline />
              <label className="field">
                <span>Follow-up cadence</span>
                <select name="followUpIntervalSec" value={form.followUpIntervalSec} onChange={updateForm}>
                  {followUpIntervalOptions.map((seconds) => (
                    <option key={seconds} value={seconds}>Every {seconds} seconds</option>
                  ))}
                </select>
              </label>
              <button className="primary" type="submit">Create session</button>
            </form>
          </details>

          <details className="sidebar-section" open>
            <summary>Recent sessions</summary>
            {sessions.length ? sessions.map((item) => (
              <button key={item.id} className="session-button" onClick={() => loadSession(item.id)}>
                <strong>{item.business_process || item.audit_area || 'Untitled interview'}</strong>
                <span>{item.auditee_name || 'No auditee'} - {item.status}</span>
              </button>
            )) : <p className="muted">No saved sessions yet.</p>}
          </details>

          <details className="sidebar-section" open>
            <summary>Evidence</summary>
            <label className="file-picker full-width">
              Upload files
              <input type="file" multiple onChange={uploadFiles} />
            </label>
            {files.length ? files.map((file) => (
              <div className="file-row" key={file.id}>
                <span>{file.original_name}</span>
                <StatusPill tone={file.status === 'indexed' ? 'good' : file.status === 'failed' ? 'danger' : 'neutral'}>
                  {file.status}
                </StatusPill>
              </div>
            )) : <p className="muted">No files uploaded.</p>}
          </details>
        </aside>

        <section className="panel main-panel">
          <div className="section-header">
            <div>
              <h2>{session ? session.business_process || 'Active Interview' : 'No Session Open'}</h2>
              <p>{session ? `${session.audit_area || 'Audit area not set'} - ${session.auditee_name || 'Auditee not set'}` : 'Create a session to start listening.'}</p>
            </div>
            <div className="button-row">
              <button onClick={startRecording} disabled={!session || recording || !openAiReady}>Start</button>
              <button onClick={pauseRecording} disabled={!recording}>{isPaused ? 'Resume' : 'Pause'}</button>
              <button onClick={stopRecording} disabled={!recording}>Stop</button>
              <button onClick={generateSummary} disabled={!session || !openAiReady}>Final notes</button>
            </div>
          </div>
          <div className="recording-help">
            <label className="interval-control">
              <span>Follow-up cadence</span>
              <select value={followUpIntervalSec} onChange={updateActiveInterval} disabled={!session}>
                {followUpIntervalOptions.map((seconds) => (
                  <option key={seconds} value={seconds}>Every {seconds} seconds</option>
                ))}
              </select>
            </label>
            <div>
              <strong>Live audio:</strong> {recordingState}
              {recording ? ` - transcribed segments: ${segmentCount}` : ''}
            </div>
            <div className="audio-meter" aria-label="Live microphone level">
              <span style={{ width: `${audioLevel}%` }} />
            </div>
            {recording || livePreview ? (
              <div className="live-preview">
                {livePreview || 'Listening for speech...'}
              </div>
            ) : null}
          </div>

          <form onSubmit={addManualTranscript} className="manual-note">
            <input
              value={manualTranscript}
              onChange={(event) => setManualTranscript(event.target.value)}
              placeholder="Add manual transcript note or paste interview text..."
            />
            <button type="submit" disabled={!session}>Add</button>
          </form>

          <div className="download-row">
            <button onClick={() => downloadSessionDocument('transcript')} disabled={!session}>Download transcript</button>
            <button onClick={() => downloadSessionDocument('audit-report')} disabled={!session || !openAiReady}>Download audit report</button>
            <button onClick={() => downloadSessionDocument('process-map')} disabled={!session || !openAiReady}>Download process map</button>
            <button onClick={() => downloadSessionDocument('process-map-image')} disabled={!session || !openAiReady}>Download process map image</button>
          </div>

          <details className="transcript-panel">
            <summary>Live transcript</summary>
            <div className="transcript">
            {transcript.length ? transcript.map((segment) => (
              <article className="transcript-item" key={segment.id}>
                <span>{segment.speaker}</span>
                <p>{segment.text}</p>
              </article>
            )) : <p className="muted">Transcript segments will appear here while recording or after manual notes are added.</p>}
            </div>
          </details>
        </section>

        <aside className="panel assistant-panel">
          <div className="assistant-heading">
            <h2>Auditor Assistant</h2>
            <div className="assistant-heading-actions">
              <StatusPill>{recording && !isPaused ? `Every ${followUpIntervalSec}s` : 'Screen only'}</StatusPill>
              <button type="button" onClick={() => setAssistantFullscreen((current) => !current)}>
                {assistantFullscreen ? 'Exit full screen' : 'Full screen'}
              </button>
            </div>
          </div>

          <section className="priority-section">
            <h3>Next Questions</h3>
            {currentSuggestions.length ? currentSuggestions.map((event) => (
              <article className={`event-card status-${event.status}`} key={event.id}>
                <div className="event-title">
                  <strong>{event.title || event.type}</strong>
                  <StatusPill>{event.status}</StatusPill>
                </div>
                <p>{event.content}</p>
                <div className="mini-actions">
                  <button onClick={() => markEvent(event.id, 'useful')}>Useful</button>
                  <button onClick={() => markEvent(event.id, 'asked')}>Asked</button>
                  <button onClick={() => markEvent(event.id, 'ignored')}>Ignore</button>
                </div>
              </article>
            )) : <p className="muted">The next 1-2 questions will appear here at the selected cadence.</p>}
          </section>

          <details className="history-panel" open={previousSuggestions.length > 0}>
            <summary>Previous follow-up summary</summary>
            <div className="followup-summary">
              <strong>{suggestions.length}</strong> recommendations captured
              <span>{openPreviousCount} still open or useful</span>
              <span>Showing the highest-priority previous items first.</span>
            </div>
            {previousSuggestions.length ? previousSuggestions.map((event) => (
              <article className={`event-card event-card-compact status-${event.status}`} key={event.id}>
                <div className="event-title">
                  <strong>{event.title || event.type}</strong>
                  <StatusPill>{event.status}</StatusPill>
                </div>
                <p>{event.content}</p>
                <div className="mini-actions">
                  <button onClick={() => markEvent(event.id, 'useful')}>Useful</button>
                  <button onClick={() => markEvent(event.id, 'asked')}>Asked</button>
                  <button onClick={() => markEvent(event.id, 'ignored')}>Ignore</button>
                </div>
              </article>
            )) : <p className="muted">Older recommendations will appear here after new questions are generated.</p>}
          </details>

          <section className="chat-section">
            <h3>Live Auditor Chat</h3>
            <form onSubmit={askAssistant} className="ask-box chat-entry">
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder="Ask about the conversation or evidence..."
                rows={2}
              />
              <button className="primary" type="submit" disabled={!session || !openAiReady}>Ask</button>
            </form>
            <div className="chat-window">
              {recentAnswers.length ? recentAnswers.map((event) => (
                <article className="chat-exchange" key={event.id}>
                  <div className="chat-message chat-user">
                    <span>Auditor</span>
                    <p>{event.title}</p>
                  </div>
                  <div className="chat-message chat-assistant">
                    <span>Assistant</span>
                    <p>{event.content}</p>
                  </div>
                </article>
              )) : <p className="muted">Ask a question about the live conversation or uploaded evidence.</p>}
            </div>
          </section>
        </aside>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
