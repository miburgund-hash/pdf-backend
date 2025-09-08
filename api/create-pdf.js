// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import fs from 'fs/promises';
import path from 'path';

// Optional: Dateiupload in Vercel Blob (wenn ?as=url gesetzt ist)
import { put } from '@vercel/blob';

// ---------- Vercel API Config: Body-Limit erhöhen ----------
export const config = {
  api: {
    bodyParser: {
      sizeLimit: '4mb', // groß genug für längere Inhalte
    },
  },
};

// ---------- Pfade / Assets ----------
const STATIC_DIR = path.join(process.cwd(), 'static');
const PAGE = { width: 595, height: 842 }; // A4
const MARGIN = 56;

// ---------- Hilfsfunktionen Layout ----------
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

// Sorgt für Page-Break bevor wir auf/unter den Rand malen
function ensureSpace(doc, page, y, needed) {
  if (y - needed < MARGIN) {
    const newPage = doc.addPage([PAGE.width, PAGE.height]);
    return { page: newPage, y: PAGE.height - MARGIN };
  }
  return { page, y };
}

// Sichere Textausgabe mit automatischer Zeilenumbruch + Page-Break
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

function drawHeading({ doc, page, y, text, fonts, size = 20, after = 12 }) {
  let { page: p, y: yy } = ensureSpace(doc, page, y, size);
  p.drawText(String(text || ''), {
    x: MARGIN,
    y: yy,
    size,
    font: fonts.bold,
    color: rgb(0, 0, 0),
  });
  yy -= size + after;
  return { page: p, y: yy };
}

function drawSubHeading({ doc, page, y, text, fonts, size = 16, after = 8 }) {
  let { page: p, y: yy } = ensureSpace(doc, page, y, size);
  p.drawText(String(text || ''), {
    x: MARGIN,
    y: yy,
    size,
    font: fonts.bold,
    color: rgb(0, 0, 0),
  });
  yy -= size + after;
  return { page: p, y: yy };
}

function drawParagraph({ doc, page, y, text, fonts, size = 12, lineGap = 2, after = 10, maxWidth }) {
  const lines = wrapLines(text, fonts.regular, size, maxWidth);
  const lineHeight = size + lineGap;
  let p = page, yy = y;

  for (const ln of lines) {
    ({ page: p, y: yy } = ensureSpace(doc, p, yy, lineHeight));
    p.drawText(ln, { x: MARGIN, y: yy, size, font: fonts.regular, color: rgb(0, 0, 0) });
    yy -= lineHeight;
  }
  yy -= after;
  return { page: p, y: yy };
}

function drawNumberedList({
  doc, page, y, items = [], fonts, size = 12, lineGap = 2, after = 10, maxWidth,
  numberIndent = 18
}) {
  const lineHeight = size + lineGap;
  let p = page, yy = y;
  let idx = 0;

  for (const raw of items) {
    idx += 1;
    const prefix = `${idx}. `;
    const prefixWidth = fonts.bold.widthOfTextAtSize(prefix, size);

    // wir berechnen den restlichen Platz und umbrechen dort
    const lines = wrapLines(String(raw || ''), fonts.regular, size, maxWidth - numberIndent);

    ({ page: p, y: yy } = ensureSpace(doc, p, yy, lineHeight));
    // Nummer
    p.drawText(prefix, { x: MARGIN, y: yy, size, font: fonts.bold, color: rgb(0, 0, 0) });
    // erste Zeile des Eintrags
    p.drawText(lines[0] || '', {
      x: MARGIN + numberIndent,
      y: yy,
      size,
      font: fonts.regular,
      color: rgb(0, 0, 0),
    });
    yy -= lineHeight;

    // ggf. weitere Zeilen (ohne Nummer)
    for (let i = 1; i < lines.length; i++) {
      ({ page: p, y: yy } = ensureSpace(doc, p, yy, lineHeight));
      p.drawText(lines[i], {
        x: MARGIN + numberIndent,
        y: yy,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      yy -= lineHeight;
    }
  }
  yy -= after;
  return { page: p, y: yy };
}

// Unterpunkte mit Spiegelstrich (Beispiele)
function drawBullets({
  doc, page, y, bullets = [], fonts, size = 12, lineGap = 2, after = 8, bulletIndent = 18, startWithDash = true
}) {
  const lineHeight = size + lineGap;
  let p = page, yy = y;

  for (const b of bullets) {
    const text = (startWithDash ? '– ' : '') + String(b || '');
    ({ page: p, y: yy } = ensureSpace(doc, p, yy, lineHeight));
    p.drawText(text, {
      x: MARGIN + bulletIndent,
      y: yy,
      size,
      font: fonts.regular,     // NICHT fett – wie gewünscht
      color: rgb(0, 0, 0),
    });
    yy -= lineHeight;
  }
  yy -= after;
  return { page: p, y: yy };
}

// ---------- Seiten mit GPT-Inhalten rendern ----------
function renderGptContent({ doc, fonts, gpt }) {
  const maxWidth = PAGE.width - MARGIN * 2;

  let page = doc.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  // HL
  ({ page, y } = drawHeading({
    doc, page, y, text: gpt.title || 'Ergebnis', fonts,
    size: 28, after: 20
  }));

  // Sektionen
  const sections = Array.isArray(gpt.sections) ? gpt.sections : [];
  for (const sec of sections) {
    // Sub-Headline (z. B. "Dein Angebot", "Deine Zielgruppe", ...)
    ({ page, y } = drawSubHeading({
      doc, page, y, text: sec.heading || '', fonts,
      size: 18,
      after: 6, // HALBIERT: kleiner Abstand zwischen SHL und Absatz
    }));

    // Text (Fließtext oder strukturierte Vorgaben)
    const txt = String(sec.text || '');

    // Wenn Strukturierungen gewünscht sind (z. B. die "Wichtige Trigger..."-Sektion),
    // interpretieren wir bekannte Marker:
    if (/^Typische Ängste:/m.test(txt) || /^Typische Ziele:/m.test(txt) || /^Typische Vorurteile:/m.test(txt)) {
      // 1) Ängste
      const anxMatch = txt.match(/Typische Ängste:\s*([\s\S]*?)(?=\n\nTypische Ziele:|\n\nTypische Vorurteile:|$)/m);
      if (anxMatch) {
        ({ page, y } = drawSubHeading({ doc, page, y, text: 'Typische Ängste', fonts, size: 14, after: 6 }));
        const list = anxMatch[1]
          .split(/\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.replace(/^\d+\.\s*/, ''));
        ({ page, y } = drawNumberedList({
          doc, page, y, items: list, fonts,
          size: 12, lineGap: 2, after: 16, maxWidth
        })); // etwas größerer Abstand nach dem Block
      }

      // 2) Ziele
      const goalsMatch = txt.match(/Typische Ziele:\s*([\s\S]*?)(?=\n\nTypische Vorurteile:|$)/m);
      if (goalsMatch) {
        ({ page, y } = drawSubHeading({ doc, page, y, text: 'Typische Ziele', fonts, size: 14, after: 6 }));
        const list = goalsMatch[1]
          .split(/\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.replace(/^\d+\.\s*/, ''));
        ({ page, y } = drawNumberedList({
          doc, page, y, items: list, fonts,
          size: 12, lineGap: 2, after: 16, maxWidth
        }));
      }

      // 3) Vorurteile
      const prejudicesMatch = txt.match(/Typische Vorurteile:\s*([\s\S]*)$/m);
      if (prejudicesMatch) {
        ({ page, y } = drawSubHeading({ doc, page, y, text: 'Typische Vorurteile', fonts, size: 14, after: 6 }));
        const list = prejudicesMatch[1]
          .split(/\n/)
          .map(s => s.trim())
          .filter(Boolean)
          .map(s => s.replace(/^\d+\.\s*/, ''));
        ({ page, y } = drawNumberedList({
          doc, page, y, items: list, fonts,
          size: 12, lineGap: 2, after: 28, maxWidth // nach Vorurteilen 3x Abstand zur nächsten SHL
        }));
      }
    } else if (/^Typische Ängste\s*–|^Typische Ziele\s*–|^Typische Vorurteile\s*–/m.test(sec.heading || '')) {
      // Diesen Zweig lassen wir frei für Sonderfälle – hier nicht benötigt
      ({ page, y } = drawParagraph({ doc, page, y, text: txt, fonts, size: 12, after: 14, maxWidth }));
    } else if (sec.heading === 'Vorteile deines Angebots') {
      // Struktur: 1. Titel, dann Untergruppen "Typische Ängste", "Typische Ziele", "Typische Vorurteile"
      // Erwartetes Format im Text:
      // "Typische Ängste:\n1. Titel\n- Beispiel 1\n- Beispiel 2\n\n2. ...\n- ...\n- ...\n\nTypische Ziele:\n..."
      ({ page, y } = drawSubHeading({
        doc, page, y, text: 'Typische Ängste', fonts, size: 14, after: 8
      }));

      const getBlock = (label) => {
        const m = txt.match(new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n\\nTypische Ziele:|\\n\\nTypische Vorurteile:|$)`, 'm'));
        return m ? m[1] : '';
      };

      const parseTitleWithBullets = (block) => {
        // Block besteht aus Zeilen wie:
        // "1. Cyberangriff"
        // "- Beispiel 1"
        // "- Beispiel 2"
        const lines = block.split(/\n/).map(s => s.trim()).filter(Boolean);
        const groups = [];
        let current = null;

        for (const line of lines) {
          if (/^\d+\.\s+/.test(line)) {
            // neuer Punkt
            if (current) groups.push(current);
            current = { title: line.replace(/^\d+\.\s+/, ''), bullets: [] };
          } else if (/^-{1,2}\s*/.test(line)) {
            if (!current) current = { title: '', bullets: [] };
            current.bullets.push(line.replace(/^-{1,2}\s*/, ''));
          } else {
            // normale Erweiterungszeile -> an Titel anhängen
            if (!current) current = { title: '', bullets: [] };
            current.title += (current.title ? ' ' : '') + line;
          }
        }
        if (current) groups.push(current);
        return groups;
      };

      // 1) Ängste
      const blockAnx = getBlock('Typische Ängste');
      const anxGroups = parseTitleWithBullets(blockAnx);
      for (const g of anxGroups) {
        // Titel (nummeriert) + danach Beispiele als Bullets in neuen Zeilen
        ({ page, y } = drawNumberedList({
          doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth
        }));
        ({ page, y } = drawBullets({
          doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18, startWithDash: true
        }));
      }

      // 2) Ziele
      ({ page, y } = drawSubHeading({ doc, page, y, text: 'Typische Ziele', fonts, size: 14, after: 8 }));
      const blockGoals = getBlock('Typische Ziele');
      const goalGroups = parseTitleWithBullets(blockGoals);
      for (const g of goalGroups) {
        ({ page, y } = drawNumberedList({
          doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth
        }));
        ({ page, y } = drawBullets({
          doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18, startWithDash: true
        }));
      }

      // 3) Vorurteile
      ({ page, y } = drawSubHeading({ doc, page, y, text: 'Typische Vorurteile', fonts, size: 14, after: 8 }));
      const blockPrej = getBlock('Typische Vorurteile');
      const prejGroups = parseTitleWithBullets(blockPrej);
      for (const g of prejGroups) {
        ({ page, y } = drawNumberedList({
          doc, page, y, items: [g.title], fonts, size: 12, lineGap: 2, after: 4, maxWidth
        }));
        ({ page, y } = drawBullets({
          doc, page, y, bullets: g.bullets, fonts, size: 12, lineGap: 2, after: 10, bulletIndent: 18, startWithDash: true
        }));
      }

      // Zusatzabstand am Ende des Abschnitts
      y -= 10;

    } else {
      // normaler Fließtext
      ({ page, y } = drawParagraph({
        doc, page, y, text: txt, fonts, size: 12, lineGap: 2, after: 14, maxWidth
      }));
    }
  }

  return doc;
}

// ---------- Mergen mit statischen PDFs ----------
async function mergeWithStatics({ contentBytes }) {
  const merged = await PDFDocument.create();

  async function addPdfFromBytes(bytes) {
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  // Lade statische PDFs (wenn vorhanden)
  try {
    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, 'deckblatt.pdf'));
    await addPdfFromBytes(deckblattBytes); // Seite 1
  } catch {}

  // GPT-Inhalt (2–n)
  const gptDoc = await PDFDocument.load(contentBytes, { updateMetadata: false });
  const gptPages = await merged.copyPages(gptDoc, gptDoc.getPageIndices());
  gptPages.forEach(p => merged.addPage(p));

  try {
    const an1 = await fs.readFile(path.join(STATIC_DIR, 'angebot1.pdf'));
    await addPdfFromBytes(an1);
  } catch {}

  try {
    const an2 = await fs.readFile(path.join(STATIC_DIR, 'angebot2.pdf'));
    await addPdfFromBytes(an2);
  } catch {}

  return merged.save();
}

// ---------- Main-Handler ----------
export default async function handler(req, res) {
  // CORS – ggf. anpassen/erweitern
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const debug = String(req.query.debug || '').trim() === '1';
  const onlyUrl = String(req.query.as || '').trim() === 'url';

  // Debug: gib Body (Echo) zurück – hilft, JSON-Fehler auszuschließen
  if (debug) {
    return res.status(200).json({ ok: true, echo: req.body });
  }

  try {
    // --- Daten holen ---
    const body = req.body || {};
    const gpt = body.gpt || {
      title: 'Ergebnis',
      sections: []
    };

    // --- Content-PDF erstellen ---
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    // Fonts laden
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, 'Poppins-Regular.ttf')); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, 'Poppins-SemiBold.ttf')); } catch {}

    const regFont = regBytes
      ? await doc.embedFont(regBytes)
      : await doc.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes
      ? await doc.embedFont(boldBytes)
      : await doc.embedFont(StandardFonts.HelveticaBold);

    const fonts = { regular: regFont, bold: boldFont };

    // Inhalt rendern
    const workDoc = renderGptContent({ doc, fonts, gpt });
    const contentBytes = await workDoc.save();

    // --- statische PDFs mergen (Deckblatt voran, ggf. weitere hinten) ---
    const finalBytes = await mergeWithStatics({ contentBytes });

    // --- Optional: Upload in Blob & URL zurückgeben ---
    if (onlyUrl) {
      const filename = `reports/${Date.now()}-${(gpt.title || 'Ergebnis')
        .replace(/[^\p{L}\p{N}\-_.\s]/gu, '')
        .replace(/\s+/g, '-')
        .slice(0, 80)}.pdf`;

      try {
        const { url } = await put(filename, Buffer.from(finalBytes), {
          access: 'public',
          contentType: 'application/pdf'
        });
        return res.status(200).json({ url });
      } catch (e) {
        // Fallback: direkt ausliefern, wenn Upload fehlschlägt
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${(gpt.title || 'Ergebnis')}.pdf"`);
        return res.status(200).send(Buffer.from(finalBytes));
      }
    }

    // --- Direkt als Download ausliefern ---
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${(gpt.title || 'Ergebnis')}.pdf"`);
    return res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error('[create-pdf] Error:', err);
    return res.status(500).json({
      error: 'PDF-Erzeugung fehlgeschlagen',
      detail: String(err?.message || err)
    });
  }
}
