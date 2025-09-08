// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// ------- Layout-Konstanten -------------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

const FONT_SIZE = {
  title: 28,    // H1
  shl: 18,      // Abschnitt-Headline (SHL)
  sub: 14,      // Sub-Headline (Typische Ängste/Ziele/Vorurteile)
  body: 12,
};

const GAP = {
  // Titel -> erste SHL (halb so groß wie vorher)
  afterTitle: 16,
  // SHL -> Absatz kompakter
  afterSHL: 8,
  // Absatz -> nächste SHL (groß, ≈ 3x)
  afterParagraph: 30,
  // Zwischen Listen-Items
  line: 4,
  // Zwischen Gruppen (Ängste → Ziele → Vorurteile)
  betweenGroups: 16,
  // Nach Trigger-"Typische Vorurteile" → nächste SHL „Vorteile...“
  afterTriggerBlock: 30,
  // Einrückung für Unterpunkte (Beispiele)
  indent: 16,
};

// ---------- Text-Helfer ---------------
function wrap(text = "", font, size, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Trigger-Text in Gruppen parsen („Typische Ängste:“, …)
function parseTriggerGroups(raw = "") {
  const blocks = [];
  let current = null;
  const lines = raw.replace(/\r/g, "").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    const groupMatch = /^Typische\s+(Ängste|Ziele|Vorurteile)\s*:?\s*$/i.exec(line);
    if (groupMatch) {
      if (current) blocks.push(current);
      current = { title: `Typische ${groupMatch[1]}`, items: [] };
      continue;
    }
    if (/^\d+\.\s+/.test(line)) {
      current?.items.push(line.replace(/^\d+\.\s+/, "")); // reiner Text ohne Nummer
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// Vorteile-Text in Gruppen mit Beispielen parsen
// Erwartete Zeile (alles in EINER Zeile pro Punkt):
// 1. Aufträge gehen verloren – Beispiel 1: … – Beispiel 2: …
function parseBenefitsGroups(raw = "") {
  const blocks = [];
  let current = null;
  const lines = raw.replace(/\r/g, "").split("\n");

  const isGroupHeader = (s) =>
    /^Typische\s+(Ängste|Ziele|Vorurteile)/i.test(s.trim());

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (isGroupHeader(line)) {
      if (current) blocks.push(current);
      const hdr = line.replace(/\s*[-–]\s*Beispiele:?$/i, "").trim();
      current = { title: hdr, items: [] };
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      // Nummer abtrennen
      let content = line.replace(/^\d+\.\s+/, "");

      // Beispiele separieren
      // Splitten an "– Beispiel 1:" und "– Beispiel 2:"
      let title = content;
      let ex1 = null;
      let ex2 = null;

      // Robust splitten: „– Beispiel 1:“ kann auch „- Beispiel 1:“ sein
      const regexEx1 = /\s[–-]\s*Beispiel\s*1\s*:\s*/i;
      const regexEx2 = /\s[–-]\s*Beispiel\s*2\s*:\s*/i;

      if (regexEx1.test(content)) {
        const [t, rest1] = content.split(regexEx1);
        title = t.trim();
        if (regexEx2.test(rest1)) {
          const [p1, p2] = rest1.split(regexEx2);
          ex1 = p1.trim();
          ex2 = p2.trim();
        } else {
          ex1 = rest1.trim();
        }
      }

      current?.items.push({ title, examples: [ex1, ex2].filter(Boolean) });
      continue;
    }
  }
  if (current) blocks.push(current);
  return blocks;
}

// ---------- Drawing-Helfer ------------
function ensureSpace(doc, fonts, page, y, need, addPageCb) {
  if (y - need < MARGIN) {
    const [p, newY] = addPageCb();
    return [p, newY];
  }
  return [page, y];
}

function drawTextBlock(doc, page, fonts, text, x, y, size, color = rgb(0, 0, 0)) {
  const lines = wrap(text, fonts.regular, size, MAX_W);
  for (const ln of lines) {
    [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
      const np = doc.addPage([A4.w, A4.h]);
      return [np, A4.h - MARGIN];
    });
    page.drawText(ln, { x, y, size, font: fonts.regular, color });
    y -= size + GAP.line;
  }
  return y;
}

function drawSHL(doc, page, fonts, text, x, y) {
  [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.shl + GAP.afterSHL, () => {
    const np = doc.addPage([A4.w, A4.h]);
    return [np, A4.h - MARGIN];
  });
  page.drawText(text, {
    x,
    y,
    size: FONT_SIZE.shl,
    font: fonts.bold,
    color: rgb(0, 0, 0),
  });
  return y - (FONT_SIZE.shl + GAP.afterSHL);
}

function drawSubSHL(doc, page, fonts, text, x, y) {
  [page, y] = ensureSpace(doc, fonts, page, y, FONT_SIZE.sub + GAP.line, () => {
    const np = doc.addPage([A4.w, A4.h]);
    return [np, A4.h - MARGIN];
  });
  page.drawText(text, {
    x,
    y,
    size: FONT_SIZE.sub,
    font: fonts.bold,
    color: rgb(0, 0, 0),
  });
  return y - (FONT_SIZE.sub + GAP.line);
}

function drawNumberedList(doc, page, fonts, items, x, y) {
  const size = FONT_SIZE.body;
  let idx = 1;
  for (const it of items) {
    const prefix = `${idx}. `;
    const prefixW = fonts.regular.widthOfTextAtSize(prefix, size);
    const textLines = wrap(it, fonts.regular, size, MAX_W - prefixW);

    [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
      const np = doc.addPage([A4.w, A4.h]);
      return [np, A4.h - MARGIN];
    });

    // Erste Zeile mit Präfix
    page.drawText(prefix, { x, y, size, font: fonts.regular, color: rgb(0, 0, 0) });
    page.drawText(textLines[0], {
      x: x + prefixW,
      y,
      size,
      font: fonts.regular,
      color: rgb(0, 0, 0),
    });
    y -= size + GAP.line;

    // Weitere Zeilen (falls Wrap)
    for (let i = 1; i < textLines.length; i++) {
      [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
        const np = doc.addPage([A4.w, A4.h]);
        return [np, A4.h - MARGIN];
      });
      page.drawText(textLines[i], {
        x: x + prefixW,
        y,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      y -= size + GAP.line;
    }

    idx++;
  }
  return y;
}

function drawNumberedListWithExamples(doc, page, fonts, items, x, y) {
  // items: [{ title, examples: ['..','..'] }]
  const size = FONT_SIZE.body;
  let idx = 1;

  for (const it of items) {
    // Titelzeile: "1. Aufträge …"
    const prefix = `${idx}. `;
    const prefixW = fonts.regular.widthOfTextAtSize(prefix, size);
    const titleLines = wrap(it.title || "", fonts.regular, size, MAX_W - prefixW);

    [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
      const np = doc.addPage([A4.w, A4.h]);
      return [np, A4.h - MARGIN];
    });

    page.drawText(prefix, { x, y, size, font: fonts.regular, color: rgb(0, 0, 0) });
    page.drawText(titleLines[0], {
      x: x + prefixW,
      y,
      size,
      font: fonts.regular,
      color: rgb(0, 0, 0),
    });
    y -= size + GAP.line;

    for (let j = 1; j < titleLines.length; j++) {
      [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
        const np = doc.addPage([A4.w, A4.h]);
        return [np, A4.h - MARGIN];
      });
      page.drawText(titleLines[j], {
        x: x + prefixW,
        y,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      y -= size + GAP.line;
    }

    // Beispiele (nicht fett), jeweils eigene Zeile:
    for (let e = 0; e < (it.examples?.length || 0); e++) {
      const label = `- Bsp. ${e + 1}: `;
      const labelW = fonts.regular.widthOfTextAtSize(label, size);
      const exLines = wrap(it.examples[e], fonts.regular, size, MAX_W - GAP.indent - labelW);

      [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
        const np = doc.addPage([A4.w, A4.h]);
        return [np, A4.h - MARGIN];
      });
      page.drawText(label, {
        x: x + GAP.indent,
        y,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      page.drawText(exLines[0], {
        x: x + GAP.indent + labelW,
        y,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      y -= size + GAP.line;

      for (let k = 1; k < exLines.length; k++) {
        [page, y] = ensureSpace(doc, fonts, page, y, size + GAP.line, () => {
          const np = doc.addPage([A4.w, A4.h]);
          return [np, A4.h - MARGIN];
        });
        page.drawText(exLines[k], {
          x: x + GAP.indent + labelW,
          y,
          size,
          font: fonts.regular,
          color: rgb(0, 0, 0),
        });
        y -= size + GAP.line;
      }
    }

    y -= GAP.line; // kleiner Puffer zwischen Items
    idx++;
  }

  return y;
}

// ---------- HTTP-Handler --------------
export default async function handler(req, res) {
  // CORS für deine Domain
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // -------- 1) Daten laden ----------
    const body = !isDemo
      ? (req.body || {})
      : {
          gpt: {
            title: "Deine persönliche Positionierung",
            sections: [
              { heading: "Dein Angebot", text: "Demo-Fließtext …" },
              { heading: "Deine Zielgruppe", text: "Demo-Fließtext …" },
              {
                heading: "Wichtige Trigger für deine Entscheider",
                text:
                  "Typische Ängste:\n1. Punkt A\n2. Punkt B\n3. Punkt C\n4. Punkt D\n5. Punkt E\n\n" +
                  "Typische Ziele:\n1. Ziel A\n2. Ziel B\n3. Ziel C\n4. Ziel D\n5. Ziel E\n\n" +
                  "Typische Vorurteile:\n1. Vorurteil A\n2. Vorurteil B\n3. Vorurteil C\n4. Vorurteil D\n5. Vorurteil E",
              },
              {
                heading: "Vorteile deines Angebots",
                text:
                  "Typische Ängste – Beispiele:\n" +
                  "1. Aufträge gehen verloren – Beispiel 1: Demo-A – Beispiel 2: Demo-B\n" +
                  "2. Zettelwirtschaft frisst Zeit – Beispiel 1: Demo-A – Beispiel 2: Demo-B\n\n" +
                  "Typische Ziele – Beispiele:\n" +
                  "1. Mehr Aufträge – Beispiel 1: Demo-A – Beispiel 2: Demo-B\n\n" +
                  "Typische Vorurteile – Beispiele:\n" +
                  "1. Einführung dauert ewig – Beispiel 1: Demo-A – Beispiel 2: Demo-B",
              },
              { heading: "Dein Positionierungs-Vorschlag", text: "Demo-Claim …" },
            ],
          },
        };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // -------- 2) Content-PDF ----------
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Fonts (Poppins), Fallback Helvetica
    let regBytes = null,
      boldBytes = null;
    try {
      regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf"));
    } catch {}
    try {
      boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf"));
    } catch {}

    const regFont = regBytes
      ? await contentPdf.embedFont(regBytes)
      : await contentPdf.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes
      ? await contentPdf.embedFont(boldBytes)
      : await contentPdf.embedFont(StandardFonts.HelveticaBold);

    const fonts = { regular: regFont, bold: boldFont };

    let page = contentPdf.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;

    // H1
    page.drawText(String(gpt.title || "Ergebnis"), {
      x: MARGIN,
      y,
      size: FONT_SIZE.title,
      font: fonts.bold,
      color: rgb(0, 0, 0),
    });
    y -= FONT_SIZE.title + GAP.afterTitle;

    // Schleife über Abschnitte
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      y = drawSHL(contentPdf, page, fonts, heading, MARGIN, y);

      if (/^Wichtige Trigger/i.test(heading)) {
        // Trigger-Gruppen mit nummerierten Listen
        const groups = parseTriggerGroups(String(sec.text || ""));
        for (let i = 0; i < groups.length; i++) {
          y = drawSubSHL(contentPdf, page, fonts, groups[i].title, MARGIN, y);
          y = drawNumberedList(contentPdf, page, fonts, groups[i].items, MARGIN, y);
          y -= GAP.betweenGroups;
        }
        y += GAP.betweenGroups; // letzte Sub-Reduktion rücknehmen
        y -= GAP.afterTriggerBlock; // großer Abstand zur nächsten SHL
        continue;
      }

      if (/^Vorteile\s+deines\s+Angebots/i.test(heading)) {
        const groups = parseBenefitsGroups(String(sec.text || ""));
        for (let i = 0; i < groups.length; i++) {
          y = drawSubSHL(contentPdf, page, fonts, groups[i].title, MARGIN, y);
          y = drawNumberedListWithExamples(
            contentPdf,
            page,
            fonts,
            groups[i].items,
            MARGIN,
            y
          );
          y -= GAP.betweenGroups;
        }
        y += GAP.betweenGroups;
        y -= GAP.afterParagraph;
        continue;
      }

      // Default: Fließtext
      y = drawTextBlock(contentPdf, page, fonts, String(sec.text || ""), MARGIN, y, FONT_SIZE.body);
      y -= GAP.afterParagraph;
    }

    const contentBytes = await contentPdf.save();

    // -------- 3) Merge mit statischen PDFs (Seite 1, 4, 5) ------
    const merged = await PDFDocument.create();

    async function addPdf(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    }

    // Deckblatt (Seite 1)
    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
    await addPdf(deckblattBytes);

    // Content (Seite 2/3)
    const contentSrc = await PDFDocument.load(contentBytes);
    const contentPages = await merged.copyPages(contentSrc, contentSrc.getPageIndices());
    contentPages.forEach((p) => merged.addPage(p));

    // Angebot1 (Seite 4)
    const angebot1Bytes = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
    await addPdf(angebot1Bytes);

    // Angebot2 (Seite 5)
    const angebot2Bytes = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));
    await addPdf(angebot2Bytes);

    const finalBytes = await merged.save();

    // -------- 4) Upload in Vercel Blob ------------
    const fileNameSafe =
      String(gpt.title || "Ergebnis")
        .replace(/[^\p{L}\p{N}\-_]+/gu, "-")
        .slice(0, 80) || "Ergebnis";
    const blobName = `reports/${Date.now()}-${fileNameSafe}.pdf`;

    const { url } = await put(blobName, Buffer.from(finalBytes), {
      access: "public",
      contentType: "application/pdf",
    });

    // -------- 5) Response -------------------------
    if (req.query.as === "url") {
      return res.status(200).json({ url });
    }
    // sonst PDF direkt streamen
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${fileNameSafe}.pdf"`);
    return res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err),
    });
  }
}


