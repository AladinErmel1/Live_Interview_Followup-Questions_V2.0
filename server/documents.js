import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  Packer,
  Paragraph,
  ShadingType,
  TextRun
} from 'docx';
import sharp from 'sharp';

function cleanText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function safeName(value, fallback = 'audit-interview') {
  return cleanText(value)
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '-')
    .slice(0, 80) || fallback;
}

function paragraph(text, options = {}) {
  return new Paragraph({
    spacing: { after: options.after ?? 160 },
    alignment: options.alignment,
    children: [
      new TextRun({
        text: cleanText(text) || 'Not documented.',
        bold: options.bold,
        italics: options.italics,
        size: options.size || 22,
        color: options.color || '17242F'
      })
    ]
  });
}

function heading(text, level = HeadingLevel.HEADING_1) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 360 : 240, after: 120 },
    children: [
      new TextRun({
        text: cleanText(text),
        bold: true,
        color: level === HeadingLevel.HEADING_1 ? '17443B' : '243746'
      })
    ]
  });
}

function bullet(text) {
  return new Paragraph({
    bullet: { level: 0 },
    spacing: { after: 100 },
    children: [new TextRun({ text: cleanText(text) || 'Not documented.', size: 22, color: '17242F' })]
  });
}

function addList(children, title, items) {
  children.push(heading(title, HeadingLevel.HEADING_3));
  const list = Array.isArray(items) ? items.filter((item) => cleanText(item)) : [];
  if (!list.length) {
    children.push(paragraph('Not documented.', { italics: true, color: '617080' }));
    return;
  }
  for (const item of list) children.push(bullet(item));
}

const severityStyles = {
  high: { label: 'HIGH', fill: 'FDEAEA', border: 'C7362F', text: '8F1D18', rank: 3 },
  medium: { label: 'MEDIUM', fill: 'FFF1DA', border: 'D9821F', text: '8A4B00', rank: 2 },
  low: { label: 'LOW', fill: 'FFF8CC', border: 'D4A900', text: '6C5A00', rank: 1 }
};

function normalizeSeverity(value) {
  const severity = String(value || '').toLowerCase();
  return severityStyles[severity] ? severity : 'low';
}

function sortedFindings(findings) {
  return (Array.isArray(findings) ? findings : [])
    .map((finding, index) => ({ ...finding, _index: index, severity: normalizeSeverity(finding.severity) }))
    .sort((a, b) => {
      const rankDiff = severityStyles[b.severity].rank - severityStyles[a.severity].rank;
      return rankDiff || a._index - b._index;
    });
}

function severityBadge(severity) {
  const style = severityStyles[normalizeSeverity(severity)];
  return new TextRun({
    text: ` ${style.label} RISK `,
    bold: true,
    size: 18,
    color: style.text
  });
}

function findingHeader(index, finding) {
  const severity = normalizeSeverity(finding.severity);
  const style = severityStyles[severity];
  return new Paragraph({
    spacing: { before: 280, after: 120 },
    border: {
      left: { style: BorderStyle.SINGLE, size: 18, color: style.border },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: style.border }
    },
    shading: { type: ShadingType.CLEAR, fill: style.fill },
    children: [
      new TextRun({
        text: `${index + 1}. ${cleanText(finding.title) || 'Finding'}  `,
        bold: true,
        size: 25,
        color: '17242F'
      }),
      severityBadge(severity)
    ]
  });
}

function findingSection(children, title, content) {
  children.push(new Paragraph({
    spacing: { before: 100, after: 60 },
    children: [new TextRun({ text: title, bold: true, size: 22, color: '17443B' })]
  }));

  if (Array.isArray(content)) {
    const items = content.filter((item) => cleanText(item));
    if (!items.length) {
      children.push(paragraph('Not documented.', { italics: true, color: '617080', after: 100 }));
      return;
    }
    for (const item of items) children.push(bullet(item));
    return;
  }

  children.push(paragraph(content || 'Not documented.', { after: 100 }));
}

function metadataRows(session) {
  return [
    ['Auditee', session.auditee_name],
    ['Business process', session.business_process],
    ['Audit area', session.audit_area],
    ['Interview date', session.interview_date],
    ['Objective', session.objective],
    ['Scope', session.scope]
  ].filter(([, value]) => cleanText(value));
}

function titleBlock(title, subtitle, session) {
  const children = [
    new Paragraph({
      alignment: AlignmentType.LEFT,
      spacing: { after: 80 },
      children: [new TextRun({ text: title, bold: true, size: 34, color: '17443B' })]
    }),
    paragraph(subtitle, { size: 22, color: '617080', after: 260 })
  ];

  for (const [label, value] of metadataRows(session)) {
    children.push(new Paragraph({
      spacing: { after: 80 },
      children: [
        new TextRun({ text: `${label}: `, bold: true, size: 21, color: '243746' }),
        new TextRun({ text: cleanText(value), size: 21, color: '17242F' })
      ]
    }));
  }
  return children;
}

export function documentFileName(session, suffix) {
  return `${safeName(session.business_process || session.audit_area || session.auditee_name)}-${suffix}.docx`;
}

export function imageFileName(session, suffix) {
  return `${safeName(session.business_process || session.audit_area || session.auditee_name)}-${suffix}.png`;
}

export async function buildTranscriptDocx({ session, transcript }) {
  const children = [
    ...titleBlock(
      'Internal Audit Interview Transcript',
      'Full transcript captured during the auditor-auditee interview.',
      session
    ),
    heading('Transcript', HeadingLevel.HEADING_1)
  ];

  if (!transcript.length) {
    children.push(paragraph('No transcript segments are available yet.', { italics: true, color: '617080' }));
  }

  for (const segment of transcript) {
    children.push(new Paragraph({
      spacing: { before: 120, after: 40 },
      children: [
        new TextRun({ text: segment.speaker || 'Unknown', bold: true, size: 21, color: '17443B' }),
        new TextRun({ text: `  ${segment.created_at || ''}`, size: 18, color: '617080' })
      ]
    }));
    children.push(paragraph(segment.text, { after: 140 }));
  }

  const doc = new Document({
    creator: 'Live_Interview_Followup Questions_V2.0',
    title: 'Internal Audit Interview Transcript',
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '17242F' },
          paragraph: { spacing: { line: 276 } }
        }
      }
    },
    sections: [{ properties: {}, children }]
  });

  return Packer.toBuffer(doc);
}

export async function buildAuditReportDocx({ session, report, processMap = null }) {
  const children = [
    ...titleBlock(
      'Internal Audit Interview Report',
      'Audit-oriented summary prepared from the full interview transcript and uploaded evidence.',
      session
    ),
    heading('Executive Summary', HeadingLevel.HEADING_1),
    paragraph(report.executiveSummary)
  ];

  const findings = sortedFindings(report.findings);
  children.push(heading('Findings', HeadingLevel.HEADING_1));
  if (!findings.length) {
    children.push(paragraph('No distinct findings were generated. Review the transcript and evidence gaps for further audit work.', { italics: true, color: '617080' }));
  }

  findings.forEach((finding, index) => {
    children.push(findingHeader(index, finding));
    findingSection(children, 'Findings', finding.finding || finding.observation);
    findingSection(children, 'Root Causes', finding.rootCauses || (finding.rootCause ? [finding.rootCause] : []));
    findingSection(children, 'Potential Risks', finding.potentialRisks);
    findingSection(children, 'Recommendations', finding.recommendations);
  });

  if (processMap?.available && Array.isArray(processMap.steps) && processMap.steps.length >= 3) {
    const processImage = await buildProcessMapPng(processMap);
    children.push(heading('Process Visualization', HeadingLevel.HEADING_1));
    children.push(paragraph(processMap.title || 'Process map'));
    children.push(new Paragraph({
      spacing: { after: 240 },
      children: [
        new ImageRun({
          data: processImage,
          type: 'png',
          transformation: { width: 680, height: 250 }
        })
      ]
    }));
  }

  const doc = new Document({
    creator: 'Live_Interview_Followup Questions_V2.0',
    title: 'Internal Audit Interview Report',
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '17242F' },
          paragraph: { spacing: { line: 276 } }
        }
      }
    },
    sections: [{ properties: {}, children }]
  });

  return Packer.toBuffer(doc);
}

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function wrapSvgText(text, maxChars = 28, maxLines = 3) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : ['Not documented'];
}

export function buildProcessMapSvg(processMap) {
  const steps = Array.isArray(processMap.steps) ? processMap.steps : [];
  const boxWidth = 260;
  const boxHeight = 132;
  const gap = 52;
  const margin = 34;
  const width = Math.max(900, margin * 2 + steps.length * boxWidth + (steps.length - 1) * gap);
  const height = 330;
  const title = escapeXml(processMap.title || 'Process Map');
  const boxes = steps.map((step, index) => {
    const x = margin + index * (boxWidth + gap);
    const y = 96;
    const nameLines = wrapSvgText(step.name, 25, 2);
    const descLines = wrapSvgText(step.description, 34, 2);
    const noteLines = step.controlOrRiskNote ? wrapSvgText(`Note: ${step.controlOrRiskNote}`, 34, 2) : [];
    const nameText = nameLines.map((line, lineIndex) => (
      `<tspan x="${x + 18}" y="${y + 30 + lineIndex * 17}">${escapeXml(line)}</tspan>`
    )).join('');
    const descStart = y + 70;
    const descText = descLines.map((line, lineIndex) => (
      `<tspan x="${x + 18}" y="${descStart + lineIndex * 15}">${escapeXml(line)}</tspan>`
    )).join('');
    const noteStart = y + 103;
    const noteText = noteLines.map((line, lineIndex) => (
      `<tspan x="${x + 18}" y="${noteStart + lineIndex * 14}">${escapeXml(line)}</tspan>`
    )).join('');
    const arrow = index < steps.length - 1
      ? `<line x1="${x + boxWidth + 10}" y1="${y + 66}" x2="${x + boxWidth + gap - 12}" y2="${y + 66}" stroke="#245B4F" stroke-width="3" marker-end="url(#arrow)" />`
      : '';
    return `
      <rect x="${x}" y="${y}" width="${boxWidth}" height="${boxHeight}" rx="12" fill="#FFFFFF" stroke="#BFD8CF" stroke-width="2"/>
      <circle cx="${x + 22}" cy="${y + 22}" r="14" fill="#245B4F"/>
      <text x="${x + 22}" y="${y + 27}" font-family="Arial" font-size="14" font-weight="700" text-anchor="middle" fill="#FFFFFF">${index + 1}</text>
      <text font-family="Arial" font-size="15" font-weight="700" fill="#17242F">${nameText}</text>
      <text font-family="Arial" font-size="13" fill="#3F4D5B">${descText}</text>
      <text font-family="Arial" font-size="12" fill="#8A4B00">${noteText}</text>
      ${step.actor ? `<text x="${x + 18}" y="${y + boxHeight + 22}" font-family="Arial" font-size="12" fill="#617080">Owner: ${escapeXml(step.actor)}</text>` : ''}
      ${arrow}
    `;
  }).join('');

  return `
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="#245B4F" />
    </marker>
  </defs>
  <rect width="100%" height="100%" fill="#F7F9FB"/>
  <text x="${margin}" y="46" font-family="Arial" font-size="26" font-weight="700" fill="#17443B">${title}</text>
  <text x="${margin}" y="72" font-family="Arial" font-size="14" fill="#617080">Ordered process visualization extracted from the interview.</text>
  ${boxes}
</svg>`;
}

export async function buildProcessMapPng(processMap) {
  const svg = buildProcessMapSvg(processMap);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

export async function buildProcessMapDocx({ session, processMap }) {
  const image = await buildProcessMapPng(processMap);
  const children = [
    ...titleBlock(
      'Internal Audit Process Visualization',
      'Ordered process steps extracted from the interview and supporting evidence.',
      session
    ),
    heading(processMap.title || 'Process Map', HeadingLevel.HEADING_1),
    new Paragraph({
      spacing: { after: 240 },
      children: [
        new ImageRun({
          data: image,
          type: 'png',
          transformation: { width: 680, height: Math.round(680 * 330 / 900) }
        })
      ]
    }),
    heading('Process Steps', HeadingLevel.HEADING_1)
  ];

  processMap.steps.forEach((step, index) => {
    children.push(heading(`${index + 1}. ${step.name || 'Process step'}`, HeadingLevel.HEADING_2));
    if (step.actor) children.push(paragraph(`Owner / actor: ${step.actor}`));
    children.push(paragraph(step.description));
    if (step.controlOrRiskNote) children.push(paragraph(`Control / risk note: ${step.controlOrRiskNote}`));
  });

  const doc = new Document({
    creator: 'Live_Interview_Followup Questions_V2.0',
    title: 'Internal Audit Process Visualization',
    styles: {
      default: {
        document: {
          run: { font: 'Arial', size: 22, color: '17242F' },
          paragraph: { spacing: { line: 276 } }
        }
      }
    },
    sections: [{ properties: {}, children }]
  });

  return Packer.toBuffer(doc);
}
