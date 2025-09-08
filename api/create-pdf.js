// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs/promises';
import path from 'path';
import { put } from '@vercel/blob';

// --- Vercel API Config ---
export const config = {
  api: { bodyParser: { sizeLimit: '4mb' } },
};

// --- Constants / Paths ---
const STATIC_DIR = path.join(process.cwd(), 'static');
const PAGE = { width: 595, height: 842 }; // A4
const MARGIN = 56;

// ----------------- Layout Helpers -----------------
function ensureSpace(doc, page, y, needed) {
  if (y - needed < MARGIN) {
    page = doc.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  }
  return { page, y };
}

function wrapLines(text, font, size, maxWidth) {
  const words = String(text || '').split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    const width = font.widthOfTextAtSize(test, size);
    if (width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawHeading({ doc, page, y, text, fonts, size = 28, after = 20 }) {
  ({ page, y } = ensureSpace(doc, page, y, size));
  page.drawText(String(text || ''), { x: MARGIN, y, size, font: fonts.bold, color: rgb(0, 0, 0) });
  y -= size + after;
  return { page, y };
}

function drawSubHeading({ doc, page, y, text, fonts, size = 18, after = 6 }) {
  ({ page, y } = ensureSpace(doc, page, y, size));
  page.drawText(String(text || ''), { x: MARGIN, y, size, font: fonts.bold, color: rgb(0, 0, 0) });
  y -= size + after; // halbierter Abstand SHL → Absatz
  return { page, y };
}

function drawLabel({ doc, page, y, text, fonts, size = 14, after = 6 }) {
  ({ page, y } = ensureSpace(doc, page, y, size));
  page.drawText(String(text || ''), { x: MARGIN, y, size, font: fonts.bold, color: rgb(0, 0, 0) });
  y -= size + after;
  return { page, y };
}

function drawParagraph({ doc, page, y, text, fonts, size = 12, lineGap = 2, after = 14, maxWidth }) {
  const lines = wrapLines(String(text || ''), fonts.regular, size, maxWidth);
  const lineHeight = size + lineGap;
  for (const ln of lines) {
    ({ page, y } = ensureSpace(doc, page, y, lineHeight));
    page.drawText(ln, { x: MARGIN, y, size, font: fonts.regular, color: rgb(0, 0, 0) });
    y -= lineHeight;
  }
  y -= after;
  return { page, y };
}

function drawNumberedList({
  doc, page, y, items = [], fonts, size = 12, lineGap = 2, after = 16, maxWidth,
  numberIndent = 18,
}) {
  const lineHeight = size + lineGap;
  let idx = 0;
  for (const raw of items) {
    idx += 1;
    const prefix = `${idx}. `;
    const lines = wrapLines(String(raw || ''), fonts.regular, size, maxWidth - numberIndent);

    ({ page, y } = ensureSpace(doc, page, y, lineHeight));
    page.drawText(prefix, { x: MARGIN, y, size, font: fonts.bold, color: rgb(0, 0, 0) });
    page.drawText(lines[0] || '', {
      x: MARGIN + numberIndent, y, size, font: fonts.regular, color: rgb(0, 0, 0),
    });
    y -= lineHeight;

    for (let i = 1; i < lines.length; i++) {
      ({ page, y } = ensureSpace(doc, page, y, lineHeight));
      page.drawText(lines[i], {
        x: MARGIN + numberIndent, y, size, font: fonts.regular, color: rgb(0, 0, 0),
      });
      y -= lineHeight;
    }
  }
  y -= after;
  return { page, y };
}

function drawBullets({
  doc, page, y, bullets = [], fonts, size = 12, lineGap = 2, after = 10, bulletIndent = 18,
}) {
  const lineHeight = size + lineGap;
  for (const b of bullets) {
    const txt = `– ${String(b || '')}`; // Spiegelstrich, NICHT fett
    ({ page, y } = ensureSpace(doc, page, y, lineHeight));
    page.drawText(txt, {
      x: MARGIN + bulletIndent, y, size, font: fonts.regular, color: rgb(0, 0, 0),
    });
    y -= lineHeight;
  }
  y -= after; // kleiner Blockabstand
  return { page, y };
}

// ----------------- Robust Parsing -----------------

// Block "Label:" bis vor nächstes "Label:" (ohne Annahmen zu Leerzeilen)
function getLabeledBlock(fullText, label, nextLabels = []) {
  const reStart = new RegExp(`^\\s*${label}\\s*:`, 'mi');
  const mStart = fullText.match(reStart);
  if (!mStart) return '';

  const startIdx = mStart.index + mStart[0].length;

  // suche erstes nächstes Label
  let endIdx = fullText.length;
  for (const nxt of nextLabels) {
    const reNext = new RegExp(`^\\s*${nxt}\\s*:`, 'mi');
    const mNext = fullText.slice(startIdx).match(reNext);
    if (mNext) {
      endIdx = Math.min(endIdx, startIdx + mNext.index);
    }
  }
  return fullText.slice(startIdx, endIdx).trim();
}

// Zeilen, die mit "1. ", "2. ", ... anfangen (sehr robust)
function parseNumberedItems(block) {
  const out = [];
  const re = /^\s*\d+\.\s+(.*)$/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    const line = (m[1] || '').trim();
    if (line) out.push(line);
  }
  return out;
}

// Titel + Beispiele (Bullets akzeptieren "-", "–", "•")
function parseTitleWithBullets(block) {
  const groups = [];
  // Titel: ^\d+\.  ... ; Beispiele danach als Bullet-Zeilen
  const lines = block.split(/\r?\n/).map(s => s.trim());
  let current = null;

  for (const line of lines) {
    if (/^\d+\.\s+/.test(line)) {
      if (current) groups.push(current);
      current = { title: line.replace(/^\d+\.\s+/, '').trim(), bullets: [] };
    } else if (/^(?:-|\u2013|\u2022)\s+/.test(line)) {
      // -  or – (EN DASH)  or • (bullet)
      if (!current) current = { title: '', bullets: [] };
      current.bullets.push(line.replace(/^(?:-|\u2013|\u2022)\s+/, '').trim());
    } else if (line) {
      // Zusatzzeile → an Titel anhängen
      if (!current) current = { title: '', bullets: [] };
      current.title = (current.title ? `${current.title} ` : '') + line;
    }
  }
  if (current) groups.push(current);
  return groups;
}

// ----------------- Render GPT content -----------------
function renderGptContent({ doc, fonts, gpt }) {
  const maxWidth = PAGE.width - MARGIN * 2;
  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  ({ page, y } = drawHeading({ doc, page, y, text: gpt.title || 'Ergebnis', fonts, size: 28, after: 20 }));

  const sections = Array.isArray(gpt.sections) ? gpt.sections : [];
  for (const sec of sections) {
    ({ page, y } = drawSubHeading({ doc, page, y, text: sec.heading || '', fonts, size: 18, after: 6 }));

    const txt = String(sec.text || '');

    if (/Typische Ängste:|Typische Ziele:|Typische Vorurteile:/m.test(txt)) {
      // ---- Wichtige Trigger-Block ----
      // Ängste
      const anxBlock = getLabeledBlock(txt, 'Typische Ängste', ['Typische Ziele', 'Typische Vorurteile']);
      if (anxBlock) {
        ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Ängste', fonts, size: 14, after: 6 }));
        const items = parseNumberedItems(anxBlock);
        ({ page, y } = drawNumberedList({ doc, page, y, items, fonts, size: 12, lineGap: 2, after: 16, maxWidth }));
      }

      // Ziele
      const goalsBlock = getLabeledBlock(txt, 'Typische Ziele', ['Typische Vorurteile']);
      if (goalsBlock) {
        ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Ziele', fonts, size: 14, after: 6 }));
        const items = parseNumberedItems(goalsBlock);
        ({ page, y } = drawNumberedList({ doc, page, y, items, fonts, size: 12, lineGap: 2, after: 16, maxWidth }));
      }

      // Vorurteile
      const prejBlock = getLabeledBlock(txt, 'Typische Vorurteile', []);
      if (prejBlock) {
        ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Vorurteile', fonts, size: 14, after: 6 }));
        const items = parseNumberedItems(prejBlock);
        ({ page, y } = drawNumberedList({ doc, page, y, items, fonts, size: 12, lineGap: 2, after: 28, maxWidth }));
      }
    } else if (sec.heading === 'Vorteile deines Angebots') {
      // ---- Vorteile strukturiert: Titel + Beispiele je Kategorie ----
      // Blocks extrahieren:
      const anxBlock = getLabeledBlock(txt, 'Typische Ängste', ['Typische Ziele', 'Typische Vorurteile']);
      const goalsBlock = getLabeledBlock(txt, 'Typische Ziele', ['Typische Vorurteile']);
      const prejBlock = getLabeledBlock(txt, 'Typische Vorurteile', []);

      // Ängste
      ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Ängste', fonts, size: 14, after: 8 }));
      for (const g of parseTitleWithBullets(anxBlock)) {
        ({ page, y } = drawNumberedList({ doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth }));
        ({ page, y } = drawBullets({ doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18 }));
      }

      // Ziele
      ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Ziele', fonts, size: 14, after: 8 }));
      for (const g of parseTitleWithBullets(goalsBlock)) {
        ({ page, y } = drawNumberedList({ doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth }));
        ({ page, y } = drawBullets({ doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18 }));
      }

      // Vorurteile
      ({ page, y } = drawLabel({ doc, page, y, text: 'Typische Vorurteile', fonts, size: 14, after: 8 }));
      for (const g of parseTitleWithBullets(prejBlock)) {
        ({ page, y } = drawNumberedList({ doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth }));
        ({ page, y } = drawBullets({ doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18 }));
      }

      y -= 10; // kleiner extra Blockabstand
    } else {
      // normaler Fließtext
      ({ page, y } = drawParagraph({ doc, page, y, text: txt, fonts, size: 12, lineGap: 2, after: 14, maxWidth }));
    }
  }

  return doc;
}

// ----------------- Merge with static PDFs -----------------
async function mergeWithStatics({ contentBytes }) {
  const merged = await PDFDocument.create();

  async function add(bytes) {
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  try { await add(await fs.readFile(path.join(STATIC_DIR, 'deckblatt.pdf'))); } catch {}
  const gptDoc = await PDFDocument.load(contentBytes, { updateMetadata: false });
  (await merged.copyPages(gptDoc, gptDoc.getPageIndices())).forEach(p => merged.addPage(p));
  try { await add(await fs.readFile(path.join(STATIC_DIR, 'angebot1.pdf'))); } catch {}
  try { await add(await fs.readFile(path.join(STATIC_DIR, 'angebot2.pdf'))); } catch {}

  return merged.save();
}

// ----------------- Handler -----------------
export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = String(req.query.debug || '') === '1';
  const onlyUrl = String(req.query.as || '') === 'url';

  if (debug) return res.status(200).json({ ok: true, echo: req.body });

  try {
    const body = req.body || {};
    const gpt = body.gpt || { title: 'Ergebnis', sections: [] };

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, 'Poppins-Regular.ttf')); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, 'Poppins-SemiBold.ttf')); } catch {}
    const regFont = regBytes ? await doc.embedFont(regBytes) : await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes ? await doc.embedFont(boldBytes) : await doc.embedFont(StandardFonts.HelveticaBold);
    const fonts = { regular: regFont, bold: boldFont };

    const workDoc = renderGptContent({ doc, fonts, gpt });
    const contentBytes = await workDoc.save();
    const finalBytes = await mergeWithStatics({ contentBytes });

    if (onlyUrl) {
      const safeName = (gpt.title || 'Ergebnis')
        .replace(/[^\p{L}\p{N}\-_.\s]/gu, '')
        .replace(/\s+/g, '-')
        .slice(0, 80);
      const filename = `reports/${Date.now()}-${safeName}.pdf`;
      try {
        const { url } = await put(filename, Buffer.from(finalBytes), {
          access: 'public',
          contentType: 'application/pdf',
        });
        return res.status(200).json({ url });
      } catch (e) {
        // Fallback: Direkt ausliefern
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeName}.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));
      }
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(gpt.title || 'Ergebnis')}.pdf"`);
    return res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error('[create-pdf] Error:', err);
    return res.status(500).json({ error: 'PDF-Erzeugung fehlgeschlagen', detail: String(err?.message || err) });
  }
}
