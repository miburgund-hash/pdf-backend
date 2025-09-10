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
  afterH1: 20,         // H1 → erste SHL (halbiert ggü. früher)
  afterH2: 8,          // SHL → Absatz leicht reduziert
  afterPara: 22,       // << etwas vergrößert: Paragraph → nächste Headline
  afterListBlock: 14,  // etwas größer für „Typische …“ Sub-Headline
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
  // Suffixe wie „– Beispiele:“ entfernen & Vorurteile→Vorbehalte
  let t = String(text).replace(/–\s*Beispiele:?$/i, "").trim();
  t = t.replace(/Vorurteile/gi, "Vorbehalte");
  page.drawText(t, {
    x: MARGIN, y, size: SIZES.h3, font: fonts.bold, color: rgb(0,0,0)
  });
  return y - (SIZES.h3 + GAPS.afterListBlock);
}

function drawNumberedList(page, fonts, y, items) {
  let cursor = y;
  for (let i = 0; i < items.length; i++) {
    const prefix = `${i + 1}. `;
    const text = `${prefix}${items[i]}`;
    const lines = wrapLines(text, fonts.regular, SIZES.li, MAX_W);
    for (const ln of lines) {
      page.drawText(ln, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (needNewPage(cursor)) {
        return { y: cursor, overflow: true };
      }
    }
    cursor -= GAPS.afterLi;
  }
  return { y: cursor, overflow: false };
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

/**
 * Für Vorteile:
 * - Normalfall: "Typische Ängste\n1. Titel\n• Bsp\n• Bsp\n2. Titel ..."
 * - Flat-10-Fall (Problemfall): "Typische Ängste\n1. TitelA – BspA1\n2. TitelA – BspA2\n3. TitelB – BspB1\n4. TitelB – BspB2 ... 10."
 *   => Paare bilden: (1,2), (3,4), (5,6), (7,8), (9,10)
 */
function parseNestedListBlock(block) {
  const rawLines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const header = rawLines[0] && /^Typische\s+/i.test(rawLines[0]) ? rawLines[0] : "";
  const startIndex = header ? 1 : 0;

  // Erst Versuch: "echte" Struktur (1. Titel + Bullets)
  let items = [];
  let current = null;

  for (let i = startIndex; i < rawLines.length; i++) {
    const line = rawLines[i];

    // 1. Titelzeilen?
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      if (current) items.push(current);
      current = { title: m[2].trim(), examples: [] };
      continue;
    }

    // 2. Beispielzeilen (• / - / – am Zeilenanfang)
    if (/^[-–•]\s+/.test(line)) {
      const raw = line.replace(/^[-–•]\s+/, "");
      const ex = normalizeExample(raw, current?.title || "");
      if (!current) current = { title: "", examples: [] };
      current.examples.push(ex);
      continue;
    }
  }
  if (current) items.push(current);

  // --- Heuristik: Flat-10-Fall erkennen & in 5×(Titel+2 Bullets) umbauen ---
  // Kriterien:
  //  - mind. 6 Zeilen als "Titel" erkannt
  //  - KEINE Beispiele vorhanden
  if (items.length >= 6 && items.every(it => (it.examples || []).length === 0)) {
    const numbered = rawLines
      .slice(startIndex)
      .map(l => l.match(/^(\d+)\.\s+(.*)$/))
      .filter(Boolean)
      .map(m => m[2].trim());

    if (numbered.length >= 6) {
      const paired = [];
      for (let i = 0; i < Math.min(10, numbered.length); i += 2) {
        const l1 = numbered[i] || "";
        const l2 = numbered[i + 1] || "";

        // Split an " – " oder "-" (mit Umgebungs-Whitespace)
        const [t1, e1] = l1.split(/\s[–-]\s/);
        const [, e2] = l2.split(/\s[–-]\s/);

        const title = (t1 || l1).trim();
        const examples = [e1, e2].filter(Boolean).map(s => s.trim());

        paired.push({ title, examples });
        if (paired.length === 5) break; // genau 5 Punkte
      }
      if (paired.length) items = paired;
    }
  }

  return { header: header || "", items };
}

function drawNestedList(page, fonts, y, data) {
  let cursor = y;

  // Sub-Headline "Typische Ängste/Ziele/Vorbehalte" (Anzeige mit „Vorbehalte“)
  if (data.header) {
    let header = data.header
      .replace(/–\s*Beispiele:?$/i, "")    // "- Beispiele" entfernen
      .replace(/Vorurteile/gi, "Vorbehalte");
    cursor = drawH3(page, fonts, cursor, header);
  }

  for (let idx = 0; idx < data.items.length; idx++) {
    const it = data.items[idx];

    // 1. Zeile: "1. Titel" (normal, nicht fett)
    const titleLine = `${idx + 1}. ${it.title}`;
    const titleLines = wrapLines(titleLine, fonts.regular, SIZES.li, MAX_W);
    for (const ln of titleLines) {
      page.drawText(ln, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (needNewPage(cursor)) return { y: cursor, overflow: true };
    }

    // Beispiele als Bulletpoints (•), nicht als Spiegelstrich
    for (let j = 0; j < (it.examples || []).length; j++) {
      const ex = `• ${it.examples[j]}`;
      const exLines = wrapLines(ex, fonts.regular, SIZES.liSub, MAX_W - 12);
      for (const exLn of exLines) {
        page.drawText(exLn, { x: MARGIN + 12, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
        cursor -= SIZES.liSub + 2;
        if (needNewPage(cursor)) return { y: cursor, overflow: true };
      }
    }

    cursor -= GAPS.afterLiGroup;
    if (needNewPage(cursor)) return { y: cursor, overflow: true };
  }
  return { y: cursor, overflow: false };
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
      else current = "vorbehalte"; // Vorbehalte/Vorurteile
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
              "1. Betrieb steht still bei Ausfall – 99,9% Netzverfügbarkeit durch Redundanz",
              "2. Betrieb steht still bei Ausfall – Netzwerk läuft stabil – auch bei Ausfällen",
              "",
              "Typische Ziele",
              "1. Mehr Zeit für Patienten – 30 % weniger Dokumentationszeit",
              "2. Mehr Zeit für Patienten – Entlastung im Pflegealltag",
              "",
              "Typische Vorbehalte",
              "1. Am Ende wird es teurer – Fixpreis-Garantie",
              "2. Am Ende wird es teurer – Transparente Kostenstruktur",
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

    // Trigger-Titel puffern für Vorteile
    let triggerTitles = { aengste: [], ziele: [], vorbehalte: [] };

    const drawParagraph = (heading, text) => {
      if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH2(page, fonts, y, heading);
      if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
      y = drawTextWrapped(page, fonts.regular, text, MARGIN, y, SIZES.p);
      y -= GAPS.afterPara;
    };

    const drawTrigger = (rawText) => {
      const blocks = parseTriggers(rawText);
      triggerTitles = {
        aengste: blocks.aengste.slice(0, 5),
        ziele: blocks.ziele.slice(0, 5),
        vorbehalte: blocks.vorbehalte.slice(0, 5),
      };

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

        parsed.header = parsed.header
          .replace(/–\s*Beispiele:?$/i, "")
          .replace(/Vorurteile/gi, "Vorbehalte");

        // Titel aus Triggern übernehmen (1–5), falls vorhanden
        let sourceTitles = [];
        if (/Ängste/i.test(parsed.header)) sourceTitles = triggerTitles.aengste;
        else if (/Ziele/i.test(parsed.header)) sourceTitles = triggerTitles.ziele;
        else if (/Vorbehalte/i.test(parsed.header)) sourceTitles = triggerTitles.vorbehalte;

        parsed.items.forEach((it, idx) => {
          if (sourceTitles[idx]) it.title = sourceTitles[idx];
        });

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

      if (/^Vorteile deines Angebots/i.test(heading)) {
        page = newPage(contentPdf); // Seite 2 sicherstellen
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

    // -------- 5) Alles mergen (statische PDFs + Inhalt) --------
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

    // -------- 6) Antwort --------
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

