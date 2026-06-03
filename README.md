# Internal Audit Interview Assistant

Local-first web app for live internal-audit interviews. It records interview audio, transcribes it with OpenAI, indexes supporting evidence, and displays timed follow-up questions for the auditor from the perspective of an experienced internal auditor.

## Local Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local `.env` file from `.env.example`:

   ```bash
   cp .env.example .env
   ```

3. Optional: put a valid, private OpenAI API key in `.env` if you want one shared server-side key:

   ```env
   OPENAI_API_KEY=your_new_private_key
   ```

Do not put real API keys in `.env.example`, source code, screenshots, or chat messages. If a key is exposed, revoke it and create a new one.

You can also leave `OPENAI_API_KEY` empty and enter an API key inside the app. The app stores that key in the auditor's browser local storage and sends it with AI requests.

## Run Locally

Use this while improving or running the app locally:

```bash
npm run dev
```

Open:

```text
http://127.0.0.1:5173
```

When the app is finished and you want a stable local run, build once with `npm run build` and start it with `npm start`. Then open `http://127.0.0.1:8787`.

## Use from GitHub

Run these commands in a terminal:

```bash
git clone https://github.com/AladinErmel1/Internal-Audit-Interview-Assistant-V2.0.git
cd Internal-Audit-Interview-Assistant-V2.0
npm install
cp .env.example .env
npm run dev
```

Then open:

```text
http://127.0.0.1:5173
```

You can either add `OPENAI_API_KEY` to `.env` or enter your OpenAI API key inside the app.

## Use on Railway

1. Open the Railway app URL in Chrome or Edge.
2. Enter your OpenAI API key in the `OpenAI API key` field and save it. If the Railway app owner configured a shared server key, this step is not needed.
3. Create an interview session with the auditee, process, audit area, objective, and follow-up cadence.
4. Upload relevant audit evidence before or during the interview.
5. Start recording. The app transcribes the interview and shows 1-2 prioritized follow-up questions at the selected cadence.
6. Use the live auditor chat to ask questions about the conversation and uploaded evidence.
7. Download the transcript, audit report, and process map when the interview is complete.

Use a trusted Railway app URL. Browser-entered keys are stored locally in the auditor's browser and sent to the app backend only for AI requests.


## What the Internal Audit Interview Assistant V2.0 Supports:

- Local interview sessions persisted in SQLite under `data/`.
- Continuous browser microphone recording in 30-second chunks.
- Audio chunk storage and OpenAI transcription.
- Live transcript display plus manual transcript notes.
- Upload and indexing for PDFs, Word documents, spreadsheets, text files, images, and media placeholders.
- Evidence-aware manual assistant questions.
- Auditor-selected follow-up cadence, for example every 15, 30, or 60 seconds during active interviews.
- Timed follow-up questions grounded in the live transcript and uploaded evidence.
- Follow-up status tracking: useful, asked, ignored.
- Live auditor chat for realtime questions about the interview and uploaded documents.
- Final audit-note generation grouped around risks, controls, findings, evidence gaps, and follow-up.
- Word downloads for the interview transcript and an internal-audit report with severity-ranked findings, root causes, potential risks, and recommendations.
- Process visualization downloads as Word and PNG when the interview describes ordered process steps.

## Notes

- Uploaded files, recordings, transcripts, and the SQLite database stay local in `data/`.
- Audio/transcript/evidence text is sent to OpenAI only when transcription, embeddings, follow-up questions, chat answers, or summaries are requested.
- Speaker diarization is best-effort in v1; transcript chunks are labeled as live audio or manual notes.
- On hosted environments, use persistent storage for `DATA_DIR`; otherwise the local SQLite database and uploaded files may be lost when the service restarts or redeploys.
