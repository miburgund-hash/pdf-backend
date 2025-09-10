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
  afterH1: 20,         // H1 → erste SHL
  afterH2: 8,          // SHL → Absatz
  afterPara: 20,       // (leicht vergrößert, überall gleich)
  afterListBlock: 14,  // „Typische …“ Sub-Headline
  afterLi: 4,
  afterLiGroup: 10,    // Luft nach Beispielgruppe (Punkt 1: …)
  blockGap: 22,        // Ängste → Ziele → Vorbehalte
  bigGap: 30
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

function needNewPage(y) {
  return y < 70;
}
function newPage(doc) {
  return doc.addPage([A4.w, A4.h]);
}

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
  page.drawText(String(text), {
    x: MARGIN, y, size: SIZES.h2, font: fonts.bold, color: rgb(0,0,0)
  });
  return y - (SIZES.h2 + GAPS.afterH2);
}

function drawH3(page, fonts, y, text) {
  page.drawText(String(text), {
    x: MARGIN, y, size: SIZES.h3, font: fonts.bold, color: rgb(0,0,0)
  });
  return y - (SIZES.h3 + GAPS.afterListBlock);
}

// ----- Nummerierte Liste über Seiten fortsetzen -----
function drawNumberedListPaged(page, fonts, y, items, startIdx, getNewPage) {
  let cursor = y;
  let i = startIdx;

  while (i < items.length) {
    const text = `${i + 1}. ${items[i]}`;
    const lines = wrapLines(text, fonts.regular, SIZES.li, MAX_W);

    for (const ln of lines) {
      if (needNewPage(cursor)) {
        page = getNewPage();
        cursor = A4.h - MARGIN;
      }
      page.drawText(ln, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
    }
    cursor -= GAPS.afterLi;
    i++;
  }
  return { page, y: cursor };
}

// Entfernt (optional) doppelte Titel-Prefixe aus Beispielzeilen
function normalizeExample(ex, title) {
  let s = String(ex || "").replace(/^[-–]\s+/, ""); // führenden Bullet entfernen
  s = s.replace(/^["„”]/, "").replace(/["“”]$/, ""); // Quotes weg
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s*[–-]\\s*`, "i");
  s = s.replace(re, "");
  return s.trim();
}

// Für Vorteile: "Typische Ängste\n1. Titel\n- Bsp\n- Bsp\n2. Titel ..."
function parseNestedListBlock(block) {
  const lines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const header = lines[0] && /^Typische\s+/i.test(lines[0]) ? lines[0] : "";
  const startIndex = header ? 1 : 0;

  const items = [];
  let current = null;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      if (current) items.push(current);
      current = { title: m[2].trim(), examples: [] };
      continue;
    }

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

/**
 * Draw Nested List (5 Punkte + Bullets) mit automatischem Seitenumbruch.
 */
function drawNestedList(page, fonts, y, data, getNewPage) {
  let cursor = y;

  if (data.header) {
    let header = data.header
      .replace(/Vorurteile/gi, "Vorbehalte")
      .replace(/\s*–\s*Beispiele:?/i, "");
    if (needNewPage(cursor)) {
      page = getNewPage();
      cursor = A4.h - MARGIN;
    }
    cursor = drawH3(page, fonts, cursor, header);
  }

  for (let idx = 0; idx < data.items.length; idx++) {
    const it = data.items[idx];

    // Nummerierte Zeile (mit hängendem Umbruch)
    const titleLine = `${idx + 1}. ${it.title}`;
    const titleLines = wrapLines(titleLine, fonts.regular, SIZES.li, MAX_W);
    for (const ln of titleLines) {
      if (needNewPage(cursor)) {
        page = getNewPage();
        cursor = A4.h - MARGIN;
      }
      page.drawText(ln, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
    }
    cursor -= 2;

    // Bullets (mit hängendem Umbruch)
    for (let j = 0; j < it.examples.length; j++) {
      const ex = `• ${it.examples[j]}`;
      const exLines = wrapLines(ex, fonts.regular, SIZES.liSub, MAX_W - 16);
      for (let li = 0; li < exLines.length; li++) {
        if (needNewPage(cursor)) {
          page = getNewPage();
          cursor = A4.h - MARGIN;
        }
        const x = MARGIN + (li === 0 ? 12 : 16);
        page.drawText(exLines[li], { x, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
        cursor -= SIZES.liSub + 2;
      }
    }

    cursor -= GAPS.afterLiGroup;
  }

  return { page, y: cursor };
}

// -------- Robuster Trigger-Parser (Zeilenbasiert) --------
function parseTriggers(rawText) {
  const lines = String(rawText || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim());

  const blocks = { aengste: [], ziele: [], vorbehalte: [] };
  let current = null; // "aengste" | "ziele" | "vorbehalte"

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
    if (m && current) {
      blocks[current].push(m[2].trim());
    }
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
              "Typische Ängste",
              "1. Cyberangriff",
              "- 24/7-Monitoring mit schneller Reaktion",
              "- Klinik bleibt handlungsfähig",
              "",
              "Typische Ziele",
              "1. Mehr Zeit",
              "- 30 % weniger Doku-Aufwand",
              "- Entlastung im Team",
              "",
              "Typische Vorbehalte",
              "1. Zu teuer",
              "- Fixpreis",
              "- Transparente Kosten",
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

    const regFont = regBytes
      ? await contentPdf.embedFont(regBytes)
      : await contentPdf.embedFont(StandardFonts.Helvetica);

    const boldFont = boldBytes
      ? await contentPdf.embedFont(boldBytes)
      : await contentPdf.embedFont(StandardFonts.HelveticaBold);

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

      // Ängste
      if (blocks.aengste.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Ängste");
        const res = drawNumberedListPaged(
          page, fonts, y, blocks.aengste, 0,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y;
        y -= GAPS.blockGap;
      }

      // Ziele
      if (blocks.ziele.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Ziele");
        const res = drawNumberedListPaged(
          page, fonts, y, blocks.ziele, 0,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y;
        y -= GAPS.blockGap;
      }

      // Vorbehalte
      if (blocks.vorbehalte.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Vorbehalte");
        const res = drawNumberedListPaged(
          page, fonts, y, blocks.vorbehalte, 0,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y;
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

        parsed.header = parsed.header
          .replace(/Vorurteile/gi, "Vorbehalte")
          .replace(/\s*–\s*Beispiele:?/i, "");

        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }

        const res = drawNestedList(
          page,
          fonts,
          y,
          parsed,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page;
        y = res.y;

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

      // Vorteile -> Seite 2 Start
      if (/^Vorteile deines Angebots/i.test(heading)) {
        page = newPage(contentPdf);
        y = A4.h - MARGIN;
        y = drawH2(page, fonts, y, "Vorteile deines Angebots");
        y -= 2;
        drawBenefits(text);
        continue;
      }

      // alles andere normal (z.B. Positionierungsvorschlag – kein Seitenanfang erzwingen)
      drawParagraph(heading, text);
    }

    // -------- 4) Content-PDF bytes --------
    const contentBytes = await contentPdf.save();

    // -------- 5) Statische + Content mergen --------
    const merged = await PDFDocument.create();

    async function addPdfIfExists(filename) {
      try {
        const bytes = await fs.readFile(path.join(STATIC_DIR, filename));
        const src = await PDFDocument.load(bytes, { updateMetadata: false });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      } catch {}
    }

    await addPdfIfExists("deckblatt.pdf"); // Seite 1
    {
      const src = await PDFDocument.load(contentBytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    await addPdfIfExists("angebot1.pdf"); // 4
    await addPdfIfExists("angebot2.pdf"); // 5

    const finalBytes = await merged.save();

    // -------- 6) Response --------
    if (asUrl) {
      if (!finalBytes || finalBytes.length < 1000) {
        throw new Error("PDF appears too small – aborting upload.");
      }
      const filenameBase = (title || "Ergebnis")
        .replace(/[^\p{L}\p{N}\s\-_\.]/gu, "")
        .replace(/\s+/g, "-");
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
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err),
    });
  }
}



