// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// -------- Layout-Konstanten --------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

const SIZES = {
  h1: 28,
  h2: 18,
  h3: 14,
  p: 12,
  li: 12,
  liSub: 12,
};

const GAPS = {
  afterH1: 20,
  afterH2: 8,
  afterPara: 16,
  afterListBlock: 14,
  afterLi: 4,
  afterLiGroup: 10,
  beforeBullets: 4,   // kleiner Zusatzabstand vor dem ersten Bullet
  blockGap: 22,
  bigGap: 30,
};

// -------- Utilities --------
function wrapLines(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
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

function needNewPage(y) { return y < 70; }
function newPage(doc) { return doc.addPage([A4.w, A4.h]); }

function drawTextWrapped(page, font, text, x, y, size, color = rgb(0,0,0)) {
  const lines = wrapLines(text, font, size, MAX_W);
  let yy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: yy, size, font, color });
    yy -= size + 2;
  }
  return yy;
}

function drawH2(page, fonts, y, text) {
  page.drawText(String(text), { x: MARGIN, y, size: SIZES.h2, font: fonts.bold, color: rgb(0,0,0) });
  return y - (SIZES.h2 + GAPS.afterH2);
}

function drawH3(page, fonts, y, text) {
  page.drawText(String(text), { x: MARGIN, y, size: SIZES.h3, font: fonts.bold, color: rgb(0,0,0) });
  return y - (SIZES.h3 + GAPS.afterListBlock);
}

/** Nummerierte Liste mit hängendem Einzug (Trigger-Blöcke). */
function drawNumberedList(page, fonts, y, items) {
  let cursor = y;
  for (let i = 0; i < items.length; i++) {
    const prefix = `${i + 1}. `;
    const prefixW = fonts.regular.widthOfTextAtSize(prefix, SIZES.li);
    const content = String(items[i] || "");
    const lines = wrapLines(content, fonts.regular, SIZES.li, MAX_W - prefixW);

    if (lines.length > 0) {
      page.drawText(prefix, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      page.drawText(lines[0], { x: MARGIN + prefixW, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (needNewPage(cursor)) return { y: cursor, overflow: true };
    }
    for (let k = 1; k < lines.length; k++) {
      page.drawText(lines[k], { x: MARGIN + prefixW, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (needNewPage(cursor)) return { y: cursor, overflow: true };
    }
    cursor -= GAPS.afterLi;
  }
  return { y: cursor, overflow: false };
}

// -------- Vorteile: Parser & Renderer --------

// Entfernt doppelte Titel-Prefixe in Beispielzeilen
function normalizeExample(ex, title) {
  let s = String(ex || "").replace(/^[-–]\s+/, "");
  s = s.replace(/^["„”]/, "").replace(/["“”]$/, "");
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s*[–-]\\s*`, "i");
  s = s.replace(re, "");
  return s.trim();
}

/**
 * Robust:
 *  - Standard-Format:
 *      Typische Ängste
 *      1. Titel
 *      - Beispiel
 *      - Beispiel
 *  - Alternativ-Format (kurzer Schreibstil):
 *      1. Titel – Beispiel A
 *      2. Titel – Beispiel B
 *    → wird automatisch zu „Titel“ mit zwei Beispielen gruppiert.
 */
function parseNestedListBlock(block) {
  const lines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let header = lines[0] && /^Typische\s+/i.test(lines[0]) ? lines[0] : "";
  const startIndex = header ? 1 : 0;

  // „– Beispiele“ am Header entfernen + „Vorbehalte“ normalisieren
  if (header) {
    header = header.replace(/\s*[–-]\s*Beispiele?/i, "");
    header = header.replace(/Vorurteile/gi, "Vorbehalte");
  }

  const items = [];
  let current = null;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    // 1) Normaler Punkt mit optionalem „– Beispiel“-Suffix
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) {
      const payload = m[2].trim();

      // Hat die Form "Titel – Beispiel"?
      const split = payload.split(/\s+[–-]\s+/);
      if (split.length >= 2) {
        const title = split[0].trim();
        const ex = split.slice(1).join(" – ").trim();

        // gleicher Titel wie vorher → Beispiel sammeln
        if (current && current.title.toLowerCase() === title.toLowerCase()) {
          current.examples.push(normalizeExample(ex, title));
        } else {
          if (current) items.push(current);
          current = { title, examples: [normalizeExample(ex, title)] };
        }
      } else {
        // reiner Titel ohne Beispiel, normaler Neustart
        if (current) items.push(current);
        current = { title: payload, examples: [] };
      }
      continue;
    }

    // 2) Spiegelstrich-Beispiel
    if (/^[-–]\s+/.test(line)) {
      const raw = line.replace(/^[-–]\s+/, "");
      const ex = normalizeExample(raw, current?.title || "");
      if (!current) current = { title: "", examples: [] };
      current.examples.push(ex);
      continue;
    }
  }
  if (current) items.push(current);

  return { header: header || "", items };
}

function drawNestedList(page, fonts, y, data) {
  let cursor = y;

  if (data.header) {
    cursor = drawH3(page, fonts, cursor, data.header);
  }

  for (let idx = 0; idx < data.items.length; idx++) {
    const it = data.items[idx];

    // "1. Titel" mit hängendem Einzug (Nummer getrennt)
    const prefix = `${idx + 1}. `;
    const prefixW = fonts.regular.widthOfTextAtSize(prefix, SIZES.li);
    const titleLines = wrapLines(it.title, fonts.regular, SIZES.li, MAX_W - prefixW);

    if (titleLines.length > 0) {
      page.drawText(prefix, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      page.drawText(titleLines[0], { x: MARGIN + prefixW, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (needNewPage(cursor)) return { y: cursor, overflow: true };
      for (let k = 1; k < titleLines.length; k++) {
        page.drawText(titleLines[k], { x: MARGIN + prefixW, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
        cursor -= SIZES.li + 2;
        if (needNewPage(cursor)) return { y: cursor, overflow: true };
      }
    }

    // kleiner Zusatzabstand vor Bullets
    cursor -= GAPS.beforeBullets;
    if (needNewPage(cursor)) return { y: cursor, overflow: true };

    // Bullets mit hängendem Einzug auf „• “
    const bullet = "• ";
    const bulletW = fonts.regular.widthOfTextAtSize(bullet, SIZES.liSub);
    const baseX = MARGIN + 12;

    for (let j = 0; j < it.examples.length; j++) {
      const exLines = wrapLines(String(it.examples[j] || ""), fonts.regular, SIZES.liSub, MAX_W - 12 - bulletW);
      if (exLines.length > 0) {
        page.drawText(bullet, { x: baseX, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
        page.drawText(exLines[0], { x: baseX + bulletW, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
        cursor -= SIZES.liSub + 2;
        if (needNewPage(cursor)) return { y: cursor, overflow: true };
        for (let m = 1; m < exLines.length; m++) {
          page.drawText(exLines[m], { x: baseX + bulletW, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
          cursor -= SIZES.liSub + 2;
          if (needNewPage(cursor)) return { y: cursor, overflow: true };
        }
      }
    }

    cursor -= GAPS.afterLiGroup;
    if (needNewPage(cursor)) return { y: cursor, overflow: true };
  }
  return { y: cursor, overflow: false };
}

// -------- Trigger-Parser --------
function parseTriggers(rawText) {
  const lines = String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());

  const blocks = { aengste: [], ziele: [], vorbehalte: [] };
  let current = null;

  const isHeader = (l) => /^Typische\s+(Ängste|Ziele|Vorbehalte|Vorurteile)\s*:?\s*$/i.test(l);

  for (const line of lines) {
    if (!line) continue;
    if (isHeader(line)) {
      if (/Ängste/i.test(line)) current = "aengste";
      else if (/Ziele/i.test(line)) current = "ziele";
      else current = "vorbehalte";
      continue;
    }
    const m = line.match(/^\s*(\d+)\.\s+(.+)$/);
    if (m && current) blocks[current].push(m[2].trim());
  }
  return blocks;
}

// -------- API Handler --------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    const asUrl = String(req.query.as || "").toLowerCase() === "url";

    // -------- 1) Daten --------
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "Demo-Angebot ..." },
          { heading: "Deine Zielgruppe", text: "Demo-Zielgruppe ..." },
          {
            heading: "Wichtige Trigger für deine Entscheider",
            text: [
              "Typische Ängste:",
              "1. Angst A",
              "2. Angst B",
              "3. Angst C",
              "4. Angst D",
              "5. Angst E",
              "Typische Vorbehalte:",
              "1. Vorbehalt A",
              "2. Vorbehalt B",
              "3. Vorbehalt C",
              "4. Vorbehalt D",
              "5. Vorbehalt E",
              "Typische Ziele:",
              "1. Ziel A",
              "2. Ziel B",
              "3. Ziel C",
              "4. Ziel D",
              "5. Ziel E",
            ].join("\n")
          },
          {
            heading: "Vorteile deines Angebots",
            text: [
              "Typische Ängste – Beispiele:",
              "1. Cyberangriff – 24/7-Monitoring",
              "2. Cyberangriff – Klinik bleibt handlungsfähig",
              "Typische Ziele – Beispiele:",
              "1. Mehr Zeit – 30% weniger Schreibaufwand",
              "2. Mehr Zeit – Team-Entlastung",
              "Typische Vorbehalte – Beispiele:",
              "1. Zu teuer – Fixpreis",
              "2. Zu teuer – transparente Kosten",
            ].join("\n")
          },
          { heading: "Dein Positionierungs-Vorschlag", text: "In 6 Wochen zur digitalen Klinik …" }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];
    const title = String(gpt.title || "Deine persönliche Positionierung");

    // -------- 2) Content-PDF --------
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Fonts
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regFont = regBytes ? await contentPdf.embedFont(regBytes) : await contentPdf.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes ? await contentPdf.embedFont(boldBytes) : await contentPdf.embedFont(StandardFonts.HelveticaBold);
    const fonts = { regular: regFont, bold: boldFont };

    let page = newPage(contentPdf);
    let y = A4.h - MARGIN;

    // H1
    page.drawText(title, { x: MARGIN, y, size: SIZES.h1, font: fonts.bold, color: rgb(0,0,0) });
    y -= SIZES.h1 + GAPS.afterH1;

    const drawParagraph = (heading, text) => {
      if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH2(page, fonts, y, heading);
      if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
      y = drawTextWrapped(page, fonts.regular, text, MARGIN, y, SIZES.p);
      y -= GAPS.afterPara;
    };

    const drawTrigger = (rawText) => {
      const blocks = parseTriggers(rawText);

      if (blocks.aengste.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Ängste");
        let res = drawNumberedList(page, fonts, y, blocks.aengste);
        y = res.y; if (res.overflow) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y -= GAPS.blockGap;
      }
      if (blocks.ziele.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Ziele");
        let res = drawNumberedList(page, fonts, y, blocks.ziele);
        y = res.y; if (res.overflow) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y -= GAPS.blockGap;
      }
      if (blocks.vorbehalte.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Vorbehalte");
        let res = drawNumberedList(page, fonts, y, blocks.vorbehalte);
        y = res.y; if (res.overflow) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y -= GAPS.bigGap;
      }
    };

    const drawBenefits = (rawText) => {
      const text = String(rawText || "").replace(/\r/g, "");
      const blocks = text.split(/\n(?=Typische\s+)/i);

      for (const block of blocks) {
        if (!block.trim()) continue;

        const parsed = parseNestedListBlock(block);
        if (!parsed.items.length && !parsed.header) continue;

        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        const res = drawNestedList(page, fonts, y, parsed);
        y = res.y; if (res.overflow) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y -= GAPS.blockGap;
      }
    };

    // -------- 3) Sektionen rendern --------
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      const text = String(sec.text || "").trim();

      if (/^Dein Angebot$/i.test(heading) || /^Deine Zielgruppe$/i.test(heading)) {
        drawParagraph(heading, text);
        continue;
      }

      if (/^Wichtige Trigger/i.test(heading)) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH2(page, fonts, y, "Wichtige Trigger für deine Entscheider");
        y -= 4;
        drawTrigger(text);
        continue;
      }

      // Vorteile immer neue Seite (oben)
      if (/^Vorteile deines Angebots/i.test(heading)) {
        page = newPage(contentPdf);
        y = A4.h - MARGIN;
        y = drawH2(page, fonts, y, "Vorteile deines Angebots");
        y -= 2;
        drawBenefits(text);
        continue;
      }

      drawParagraph(heading, text);
    }

    // -------- 4) Content-PDF bytes --------
    const contentBytes = await contentPdf.save();

    // -------- 5) Mergen (statisch + Inhalt) --------
    const merged = await PDFDocument.create();

    async function addPdfIfExists(filename) {
      try {
        const bytes = await fs.readFile(path.join(STATIC_DIR, filename));
        const src = await PDFDocument.load(bytes, { updateMetadata: false });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach((p) => merged.addPage(p));
      } catch {}
    }

    await addPdfIfExists("deckblatt.pdf"); // Seite 1
    {
      const src = await PDFDocument.load(contentBytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }
    await addPdfIfExists("angebot1.pdf"); // 4
    await addPdfIfExists("angebot2.pdf"); // 5

    const finalBytes = await merged.save();

    // -------- 6) Antwort --------
    if (asUrl) {
      if (!finalBytes || finalBytes.length < 1000) throw new Error("PDF appears too small – aborting upload.");
      const filenameBase = (title || "Ergebnis").replace(/[^\p{L}\p{N}\s\-_\.]/gu, "").replace(/\s+/g, "-");
      const safeName = `reports/${Date.now()}-${filenameBase}.pdf`;

      const { url } = await put(safeName, Buffer.from(finalBytes), {
        access: "public",
        contentType: "application/pdf",
        cacheControl: "public, max-age=31536000, immutable",
      });
      return res.status(200).json({ url });
    } else {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", 'inline; filename="Ergebnis.pdf"');
      return res.status(200).send(Buffer.from(finalBytes));
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(err?.message || err) });
  }
}



