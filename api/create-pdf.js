// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// -------- Layout --------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

const SIZES = {
  h1: 24,
  h2: 18,
  h3: 14,
  p: 12,
  li: 12,
  liSub: 12,
};

const GAPS = {
  afterH1: 18,
  afterH2: 8,
  afterPara: 20,      // etwas größer, einheitlich
  afterListBlock: 14,
  afterLi: 4,
  afterLiGroup: 10,
  blockGap: 22,
  bigGap: 30,
};

// -------- Helpers --------
function wrapLines(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    const wpx = font.widthOfTextAtSize(t, size);
    if (wpx > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}
const needNewPage = (y) => y < 70;
const newPage = (doc) => doc.addPage([A4.w, A4.h]);

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
    x: MARGIN, y, size: SIZES.h2, font: fonts.bold, color: rgb(0,0,0),
  });
  return y - (SIZES.h2 + GAPS.afterH2);
}
function drawH3(page, fonts, y, text) {
  page.drawText(String(text), {
    x: MARGIN, y, size: SIZES.h3, font: fonts.bold, color: rgb(0,0,0),
  });
  return y - (SIZES.h3 + GAPS.afterListBlock);
}

// ---- Nummerierte Liste mit hängender Einrückung (seitenübergreifend) ----
function drawNumberedListPagedHanging(page, fonts, y, items, getNewPage) {
  let cursor = y;
  const font = fonts.regular;

  for (let i = 0; i < items.length; i++) {
    const prefix = `${i + 1}. `;
    const prefixW = font.widthOfTextAtSize(prefix, SIZES.li);
    const content = String(items[i] || "");

    // Erste Zeile: prefix + erster Teil, danach hängende Einrückung
    // Wir splitten selbst: erste Linie bis MAX_W, Folgezeilen mit (MAX_W - prefixW)
    // 1) Ersten Inhalt in Zeilen rechnen (ohne Prefix) mit schmalerer Breite
    const lines = wrapLines(content, font, SIZES.li, MAX_W - prefixW);

    // erste Zeile: mit Prefix an x=MARGIN
    if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
    page.drawText(prefix + lines[0], {
      x: MARGIN, y: cursor, size: SIZES.li, font, color: rgb(0,0,0),
    });
    cursor -= SIZES.li + 2;

    // Folgezeilen: hängend eingerückt
    for (let l = 1; l < lines.length; l++) {
      if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
      page.drawText(lines[l], {
        x: MARGIN + prefixW, y: cursor, size: SIZES.li, font, color: rgb(0,0,0),
      });
      cursor -= SIZES.li + 2;
    }
    cursor -= GAPS.afterLi;
  }
  return { page, y: cursor };
}

// --- Normalisierung für Beispiele (Vorteile) ---
function normalizeExample(ex, title) {
  let s = String(ex || "").replace(/^[-–]\s+/, ""); // führenden Bullet entfernen
  s = s.replace(/^["„]/, "").replace(/["“”]$/, "");
  const esc = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*${esc}\\s*[–-]\\s*`, "i");
  s = s.replace(re, "");
  return s.trim();
}

/**
 * Parse „Vorteile“-Block robust:
 * - Header „Typische …“ (ohne „– Beispiele“)
 * - Nummerierte Titel 1..5
 * - Wenn Titel „Titel – Beispiel“ enthält, wird Beispiel automatisch übernommen
 * - Wenn gleiche Titel mehrfach auftauchen, werden Beispiele zusammengeführt
 * - Nur 5 Punkte, je max. 2 Beispiele
 */
function parseNestedListBlock(block) {
  const rawLines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  let header = "";
  if (rawLines[0] && /^Typische\s+/i.test(rawLines[0])) {
    header = rawLines[0]
      .replace(/\s*–\s*Beispiele:?/i, "")
      .replace(/Vorurteile/gi, "Vorbehalte");
    rawLines.shift();
  }

  // Sammeln (auch zusammenführen gleicher Titel)
  const map = new Map(); // title -> { title, examples: [] }

  for (const line of rawLines) {
    // 1) Nummern-Eintrag?
    const m = line.match(/^(\d+)\.\s+(.+)$/);
    if (m) {
      let titlePart = m[2].trim();
      let firstEx = "";

      // „Titel – Beispiel“ in der Nummernzeile?
      const split = titlePart.split(/\s+–\s+/);
      if (split.length >= 2) {
        titlePart = split[0].trim();
        firstEx = split.slice(1).join(" – ").trim();
      }

      const key = titlePart.toLowerCase();
      if (!map.has(key)) map.set(key, { title: titlePart, examples: [] });
      if (firstEx) {
        const ex = normalizeExample(firstEx, titlePart);
        if (ex) map.get(key).examples.push(ex);
      }
      continue;
    }

    // 2) Bullet-Zeile?
    if (/^[-–•]\s+/.test(line)) {
      const last = Array.from(map.values()).pop();
      if (last) {
        const ex = normalizeExample(line.replace(/^[-–•]\s+/, ""), last.title);
        if (ex) last.examples.push(ex);
      }
      continue;
    }
  }

  // Reihenfolge beibehalten, auf 5 begrenzen, pro Punkt 2 Beispiele
  const items = Array.from(map.values()).slice(0, 5).map(it => ({
    title: it.title,
    examples: (it.examples || []).slice(0, 2)
  }));

  return { header, items };
}

/** Zeichnet 5 Punkte mit Bullets (seitenfest, hängende Einrückung) */
function drawNestedList(page, fonts, y, data, getNewPage) {
  let cursor = y;

  if (data.header) {
    if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
    cursor = drawH3(page, fonts, cursor, data.header);
  }

  const font = fonts.regular;

  for (let i = 0; i < data.items.length; i++) {
    const title = data.items[i].title;
    const prefix = `${i + 1}. `;
    const prefixW = font.widthOfTextAtSize(prefix, SIZES.li);

    // Titel mit hängender Einrückung
    const tLines = wrapLines(title, font, SIZES.li, MAX_W - prefixW);
    if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
    page.drawText(prefix + tLines[0], {
      x: MARGIN, y: cursor, size: SIZES.li, font, color: rgb(0,0,0),
    });
    cursor -= SIZES.li + 2;

    for (let l = 1; l < tLines.length; l++) {
      if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
      page.drawText(tLines[l], {
        x: MARGIN + prefixW, y: cursor, size: SIZES.li, font, color: rgb(0,0,0),
      });
      cursor -= SIZES.li + 2;
    }
    cursor -= 2; // kleine Luft Titel → Bullets

    // Zwei Bullets (hängende Einrückung)
    const bullets = (data.items[i].examples || []).slice(0, 2);
    for (const b of bullets) {
      const blines = wrapLines(b, font, SIZES.liSub, MAX_W - 16);
      if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
      // erste Zeile mit Bullet
      page.drawText("• " + blines[0], {
        x: MARGIN + 12, y: cursor, size: SIZES.liSub, font, color: rgb(0,0,0),
      });
      cursor -= SIZES.liSub + 2;

      for (let l = 1; l < blines.length; l++) {
        if (needNewPage(cursor)) { page = getNewPage(); cursor = A4.h - MARGIN; }
        page.drawText(blines[l], {
          x: MARGIN + 16, y: cursor, size: SIZES.liSub, font, color: rgb(0,0,0),
        });
        cursor -= SIZES.liSub + 2;
      }
    }

    cursor -= GAPS.afterLiGroup;
  }
  return { page, y: cursor };
}

// ---- Trigger-Parser ----
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
              "1. Cyberangriff legt Klinikbetrieb lahm.",
              "2. Patientendaten gelangen in falsche Hände.",
              "3. Neue Software blockiert den Betrieb.",
              "4. Projekte laufen über Budget und Zeit.",
              "5. Fördergelder gehen verloren.",
              "Typische Vorbehalte:",
              "1. Umsetzung dauert zu lange.",
              "2. Anbieter versteht Klinikalltag nicht.",
              "3. Betrieb wird blockiert.",
              "4. Zu teuer am Ende.",
              "5. Standard-IT statt passgenau.",
              "Typische Ziele:",
              "1. Mehr Zeit für Patienten.",
              "2. Zukunftssichere IT.",
              "3. Moderne Arbeitgeberwahrnehmung.",
              "4. Planungssicherheit.",
              "5. Effizienzsteigerung.",
            ].join("\n")
          },
          {
            heading: "Vorteile deines Angebots",
            text: [
              "Typische Ängste – Beispiele:",
              "1. Cyberangriff – 24/7-Monitoring mit Reaktionszeit 15 Minuten",
              "2. Cyberangriff – Klinik bleibt handlungsfähig bei Angriffen",
              "3. Patientendaten – Verschlüsselung mit Audit-Protokoll",
              "4. Patientendaten – Daten jederzeit unter Kontrolle",
              "Typische Ziele – Beispiele:",
              "1. Mehr Zeit – 30% weniger Dokumentationsaufwand",
              "2. Mehr Zeit – Team-Entlastung",
              "Typische Vorbehalte – Beispiele:",
              "1. Zu teuer – Fixpreisgarantie",
              "2. Zu teuer – Transparente Kosten",
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
        let res = drawNumberedListPagedHanging(
          page, fonts, y, blocks.aengste,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y; y -= GAPS.blockGap;
      }

      // Ziele
      if (blocks.ziele.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Ziele");
        let res = drawNumberedListPagedHanging(
          page, fonts, y, blocks.ziele,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y; y -= GAPS.blockGap;
      }

      // Vorbehalte
      if (blocks.vorbehalte.length) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH3(page, fonts, y, "Typische Vorbehalte");
        let res = drawNumberedListPagedHanging(
          page, fonts, y, blocks.vorbehalte,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y; y -= GAPS.bigGap;
      }
    };

    const drawBenefits = (rawText) => {
      const text = String(rawText || "").replace(/\r/g, "");
      const blocks = text.split(/\n(?=Typische\s+)/i);

      for (const block of blocks) {
        if (!block.trim()) continue;

        const parsed = parseNestedListBlock(block);
        if (!parsed.items.length && !parsed.header) continue;

        // Header ist bereits normalisiert (ohne „– Beispiele“, mit „Vorbehalte“)
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }

        const res = drawNestedList(
          page, fonts, y, parsed,
          () => { page = newPage(contentPdf); return page; }
        );
        page = res.page; y = res.y;

        y -= GAPS.blockGap;
      }
    };

    // -------- 3) Sektionen rendern --------
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      const text = String(sec.text || "").trim();

      if (/^Dein Angebot$/i.test(heading) || /^Deine Zielgruppe$/i.test(heading)) {
        drawParagraph(heading, text); continue;
      }

      if (/^Wichtige Trigger/i.test(heading)) {
        if (needNewPage(y)) { page = newPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH2(page, fonts, y, "Wichtige Trigger für deine Entscheider");
        y -= 4;
        drawTrigger(text);
        continue;
      }

      // Vorteile immer Seite 2 Beginn
      if (/^Vorteile deines Angebots/i.test(heading)) {
        page = newPage(contentPdf);
        y = A4.h - MARGIN;
        y = drawH2(page, fonts, y, "Vorteile deines Angebots");
        y -= 2;
        drawBenefits(text);
        continue;
      }

      // Positionierungsvorschlag o.ä.: normal weiter (kein erzwungener Seitenanfang)
      drawParagraph(heading, text);
    }

    // -------- 4) content -> bytes --------
    const contentBytes = await contentPdf.save();

    // -------- 5) Statisch + Content mergen --------
    const merged = await PDFDocument.create();

    async function addPdfIfExists(filename) {
      try {
        const bytes = await fs.readFile(path.join(STATIC_DIR, filename));
        const src = await PDFDocument.load(bytes, { updateMetadata: false });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
      } catch {}
    }

    await addPdfIfExists("deckblatt.pdf");
    {
      const src = await PDFDocument.load(contentBytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    await addPdfIfExists("angebot1.pdf");
    await addPdfIfExists("angebot2.pdf");

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




