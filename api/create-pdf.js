// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// ---------- Layout ----------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

const FONT_SIZE = {
  title: 28,   // H1
  shl: 18,     // Abschnitts-Headline
  sub: 14,     // Sub-Headline (Typische Ängste/Ziele/Vorurteile)
  body: 12,
};

const GAP = {
  afterTitle: 16,        // H1 -> erste SHL (kompakt)
  afterSHL: 8,           // SHL -> Absatz (kleiner)
  afterParagraph: 30,    // Absatz -> nächste SHL (groß ~3×)
  betweenGroups: 18,     // Ängste -> Ziele -> Vorurteile
  afterTriggerBlock: 30, // nach Trigger -> Vorteile (3×)
  line: 4,               // Abstand zwischen Zeilen
  indent: 16,            // Einrückung Beispiele
};

// ---------- Helpers ----------
function newPage(doc) {
  const page = doc.addPage([A4.w, A4.h]);
  return [page, A4.h - MARGIN];
}
function ensureSpace(doc, fonts, page, y, needed) {
  if (y - needed < MARGIN) return newPage(doc);
  return [page, y];
}
function wrap(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) out.push(line);
  return out;
}
function drawLines(doc, page, fonts, x, y, lines, size, font) {
  for (const ln of lines) {
    [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line);
    page.drawText(ln, { x, y, size, font, color: rgb(0, 0, 0) });
    y -= size + GAP.line;
  }
  return [page, y];
}
function drawParagraph(doc, page, fonts, text, x, y) {
  // trennt harte Zeilenumbrüche
  const parts = String(text || "").split(/\n{2,}/); // Absätze
  for (const p of parts) {
    const lines = p.split(/\n/).flatMap(line =>
      wrap(line, fonts.regular, FONT_SIZE.body, MAX_W)
    );
    [page, y] = drawLines(doc, page, fonts, x, y, lines, FONT_SIZE.body, fonts.regular);
    y -= GAP.line; // kleiner Puffer zwischen Zeilengruppen
  }
  return y;
}
function drawSHL(doc, page, fonts, text, x, y) {
  [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.shl + GAP.afterSHL);
  page.drawText(text, { x, y, size: FONT_SIZE.shl, font: fonts.bold, color: rgb(0, 0, 0) });
  return [page, y - (FONT_SIZE.shl + GAP.afterSHL)];
}
function drawSubHL(doc, page, fonts, text, x, y) {
  [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.sub + GAP.line);
  page.drawText(text, { x, y, size: FONT_SIZE.sub, font: fonts.bold, color: rgb(0, 0, 0) });
  return [page, y - (FONT_SIZE.sub + GAP.line)];
}
function drawNumberedList(doc, page, fonts, items, x, y) {
  let idx = 1;
  for (const raw of items) {
    const item = String(raw || "");
    const prefix = `${idx}. `;
    const pw = fonts.regular.widthOfTextAtSize(prefix, FONT_SIZE.body);
    const lines = wrap(item, fonts.regular, FONT_SIZE.body, MAX_W - pw);

    [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
    page.drawText(prefix, { x, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
    page.drawText(lines[0] || "", { x: x + pw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
    y -= FONT_SIZE.body + GAP.line;

    for (let i = 1; i < lines.length; i++) {
      [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
      page.drawText(lines[i], { x: x + pw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
      y -= FONT_SIZE.body + GAP.line;
    }
    idx++;
  }
  return [page, y];
}
function drawNumberedListWithExamples(doc, page, fonts, items, x, y) {
  let idx = 1;
  for (const it of items) {
    const title = String(it?.title || "");
    const prefix = `${idx}. `;
    const pw = fonts.regular.widthOfTextAtSize(prefix, FONT_SIZE.body);
    const titleLines = wrap(title, fonts.regular, FONT_SIZE.body, MAX_W - pw);

    // Titelzeile
    [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
    page.drawText(prefix, { x, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
    page.drawText(titleLines[0] || "", { x: x + pw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
    y -= FONT_SIZE.body + GAP.line;

    // evtl.weitere Titelzeilen
    for (let i = 1; i < titleLines.length; i++) {
      [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
      page.drawText(titleLines[i], { x: x + pw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
      y -= FONT_SIZE.body + GAP.line;
    }

    // Beispiele (nicht fett, eigene Zeilen, eingerückt)
    for (const [bIdx, ex] of (it.examples || []).entries()) {
      if (!ex) continue;
      const bullet = `- Bsp. ${bIdx + 1}: `;
      const bw = fonts.regular.widthOfTextAtSize(bullet, FONT_SIZE.body);
      const exLines = wrap(ex, fonts.regular, FONT_SIZE.body, MAX_W - pw - GAP.indent - bw);

      [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
      page.drawText(bullet, { x: x + pw + GAP.indent, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
      page.drawText(exLines[0] || "", { x: x + pw + GAP.indent + bw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
      y -= FONT_SIZE.body + GAP.line;

      for (let i = 1; i < exLines.length; i++) {
        [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.body + GAP.line);
        page.drawText(exLines[i], { x: x + pw + GAP.indent + bw, y, size: FONT_SIZE.body, font: fonts.regular, color: rgb(0, 0, 0) });
        y -= FONT_SIZE.body + GAP.line;
      }
    }

    y -= GAP.line; // kleiner Abstand zum nächsten Listeneintrag
    idx++;
  }
  return [page, y];
}

// ---------- Parser (robust) ----------
function isListLine(line) {
  return /^\d+[\.\)]\s+/.test(line) || /^[•\-]\s+/.test(line) || (!!line && !/^Typische\s+/i.test(line));
}
function stripListPrefix(line) {
  return line.replace(/^\d+[\.\)]\s+/, "").replace(/^[•\-]\s+/, "");
}

function parseTriggerText(raw = "") {
  const out = [];
  let current = null;
  const lines = raw.replace(/\r/g, "").split("\n");

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    const m = /^Typische\s+(Ängste|Ziele|Vorurteile)\s*:?\s*$/i.exec(line);
    if (m) {
      if (current) out.push(current);
      current = { title: `Typische ${m[1]}`, items: [] };
      continue;
    }
    if (current && isListLine(line)) current.items.push(stripListPrefix(line));
  }
  if (current) out.push(current);
  return out;
}

function parseBenefitsText(raw = "") {
  const out = [];
  let current = null;
  const lines = raw.replace(/\r/g, "").split("\n");

  const isHeader = (s) => /^Typische\s+(Ängste|Ziele|Vorurteile)/i.test((s || "").trim());
  const exInline1 = /\s[–—-]\s*(Beispiel|Bsp\.?)\s*1\s*:\s*/i;
  const exInline2 = /\s[–—-]\s*(Beispiel|Bsp\.?)\s*2\s*:\s*/i;
  const exLine = /^(?:[•\-]\s*)?(?:Beispiel|Bsp\.?)\s*([12])\s*:\s*(.+)$/i;

  for (let i = 0; i < lines.length; i++) {
    let line = (lines[i] || "").trim();
    if (!line) continue;

    if (isHeader(line)) {
      if (current) out.push(current);
      current = { title: line.replace(/\s*[-–—]\s*Beispiele:?$/i, "").trim(), items: [] };
      continue;
    }
    if (!current) continue;
    if (!isListLine(line)) continue;

    // Grundtitel
    let title = stripListPrefix(line);
    let ex1 = null, ex2 = null;

    // Inline "– Beispiel 1: … – Beispiel 2: …"
    if (exInline1.test(title)) {
      const [t, rest] = title.split(exInline1);
      title = t.trim();
      if (exInline2.test(rest)) {
        const [p1, p2] = rest.split(exInline2);
        ex1 = (p1 || "").trim();
        ex2 = (p2 || "").trim();
      } else {
        ex1 = rest.trim();
      }
    } else {
      // Beispiele in Folgezeilen
      let j = i + 1;
      while (j < lines.length) {
        const m = exLine.exec((lines[j] || "").trim());
        if (!m) break;
        (m[1] === "1" ? (ex1 = m[2].trim()) : (ex2 = m[2].trim()));
        j++;
      }
      i = j - 1;
    }
    current.items.push({ title: title.trim(), examples: [ex1, ex2].filter(Boolean) });
  }
  if (current) out.push(current);
  return out;
}

// ---------- Handler ----------
export default async function handler(req, res) {
  // CORS (falls Domain-übergreifend)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const as = (req.query?.as || "json").toLowerCase();
  const isDemo = req.method === "GET";

  try {
    // 1) Daten
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "…" },
          { heading: "Deine Zielgruppe", text: "…" },
          { heading: "Wichtige Trigger für deine Entscheider", text: "Typische Ängste:\n1. …\n…\n\nTypische Ziele:\n1. …\n…\n\nTypische Vorurteile:\n1. …" },
          { heading: "Vorteile deines Angebots", text: "Typische Ängste\n1. Titel – Beispiel 1: … – Beispiel 2: …\n\nTypische Ziele\n…" },
          { heading: "Dein Positionierungs-Vorschlag", text: "…" }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // 2) Content-PDF (Seite 2ff.)
    const content = await PDFDocument.create();
    content.registerFontkit(fontkit);

    // Fonts laden
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regular = regBytes ? await content.embedFont(regBytes) : await content.embedFont(StandardFonts.Helvetica);
    const bold    = boldBytes ? await content.embedFont(boldBytes) : await content.embedFont(StandardFonts.HelveticaBold);
    const fonts   = { regular, bold };

    // erste Content-Seite
    let [page, y] = newPage(content);

    // H1
    page.drawText(String(gpt.title || "Ergebnis"), {
      x: MARGIN, y, size: FONT_SIZE.title, font: bold, color: rgb(0, 0, 0)
    });
    y -= FONT_SIZE.title + GAP.afterTitle;

    // Sektionen
    for (const sec of sections) {
      const heading = String(sec.heading || "");
      const txt     = String(sec.text || "");

      // Überschrift
      [page, y] = drawSHL(content, page, fonts, heading, MARGIN, y);

      if (/^Wichtige Trigger/i.test(heading)) {
        const groups = parseTriggerText(txt);

        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          [page, y] = drawSubHL(content, page, fonts, g.title, MARGIN, y);
          [page, y] = drawNumberedList(content, page, fonts, g.items, MARGIN, y);

          if (i < groups.length - 1) y -= GAP.betweenGroups; // Abstand Ängste -> Ziele -> Vorurteile
        }
        y -= GAP.afterTriggerBlock; // großer Abstand zu „Vorteile …“

      } else if (/^Vorteile.*Angebots/i.test(heading)) {
        const groups = parseBenefitsText(txt);

        for (let i = 0; i < groups.length; i++) {
          const g = groups[i];
          [page, y] = drawSubHL(content, page, fonts, g.title, MARGIN, y);
          [page, y] = drawNumberedListWithExamples(content, page, fonts, g.items, MARGIN, y);

          if (i < groups.length - 1) y -= GAP.betweenGroups;
        }
        y -= GAP.afterParagraph; // Abstand zur nächsten SHL

      } else {
        // normaler Fließtext
        y = drawParagraph(content, page, fonts, txt, MARGIN, y);
        y -= GAP.afterParagraph;
      }
    }

    const contentBytes = await content.save();

    // 3) Statische PDFs + Content mergen
    const merged = await PDFDocument.create();

    async function addPdf(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const cp = await merged.copyPages(src, src.getPageIndices());
      cp.forEach(p => merged.addPage(p));
    }

    // Seite 1 (Deckblatt), dann Content, dann Angebot 1 & 2
    try {
      await addPdf(await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf")));
    } catch {}
    await addPdf(contentBytes);
    try {
      await addPdf(await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf")));
    } catch {}
    try {
      await addPdf(await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf")));
    } catch {}

    const finalBytes = await merged.save();

    // 4) Auslieferung
    if (as === "url") {
      const filename = `reports/${Date.now()}-${(gpt.title || "Ergebnis").replace(/[^\p{L}\p{N}\-_ ]/gu, "").replace(/\s+/g, "-").slice(0, 80)}.pdf`;
      const { url } = await put(filename, Buffer.from(finalBytes), { access: "public", contentType: "application/pdf" });
      res.status(200).json({ url });
    } else {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'attachment; filename="Ergebnis.pdf"');
      res.status(200).send(Buffer.from(finalBytes));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(err?.message || err) });
  }
}


