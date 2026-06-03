import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';

const textExtensions = new Set(['.txt', '.md', '.csv', '.json', '.log']);

export async function extractTextFromFile(filePath, originalName, mimeType = '') {
  const ext = path.extname(originalName).toLowerCase();

  if (mimeType.includes('pdf') || ext === '.pdf') {
    const buffer = await fs.readFile(filePath);
    const parsed = await pdf(buffer);
    return parsed.text || '';
  }

  if (
    mimeType.includes('wordprocessingml') ||
    mimeType.includes('msword') ||
    ext === '.docx'
  ) {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value || '';
  }

  if (['.xlsx', '.xls', '.ods'].includes(ext) || mimeType.includes('spreadsheet')) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const sheets = [];
    workbook.eachSheet((worksheet) => {
      const rows = [];
      worksheet.eachRow((row) => {
        rows.push(row.values.slice(1).map((value) => {
          if (value == null) return '';
          if (typeof value === 'object') return value.text || value.result || JSON.stringify(value);
          return String(value);
        }).join(', '));
      });
      sheets.push(`Sheet: ${worksheet.name}\n${rows.join('\n')}`);
    });
    return sheets.join('\n\n');
  }

  if (textExtensions.has(ext) || mimeType.startsWith('text/')) {
    return fs.readFile(filePath, 'utf8');
  }

  if (mimeType.startsWith('image/')) {
    return `Image file uploaded: ${originalName}. OCR is not enabled in this v1, so treat it as supporting evidence that may need manual review.`;
  }

  if (mimeType.startsWith('audio/') || mimeType.startsWith('video/')) {
    return `Media file uploaded: ${originalName}. Use the live recording transcription workflow for interview audio.`;
  }

  return `Unsupported file type for text extraction: ${originalName}. The file is stored locally but was not indexed.`;
}

export function chunkText(text, maxChars = 2200) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const chunks = [];
  for (let i = 0; i < clean.length; i += maxChars) {
    chunks.push(clean.slice(i, i + maxChars));
  }
  return chunks;
}

export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}
