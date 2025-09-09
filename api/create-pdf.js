// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// ---------------------------------------------
// Layout-Konstanten (Abstände, Schriftgrößen)
// ---------------------------------------------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

const SIZES = {
  h1: 28,         // Dokument-Hauptheadline
  h2: 18,         // Sektion-Headline (z.B. SHL)
  h3: 14,         // Unter-Headline (z.B. Typische Ängste)
  p: 12,          // Fließtext
  li: 12,         // Listentext
  liSub: 12       // Beispiel-Text (Unterpunkt)
};

const GAPS = {
  // vertikale Abstände – fein justiert nach deinen Wünschen
  afterH1: 20,           // Abstand H1 → erste SHL halbiert ggü. früher
  afterH2: 8,            // Abstand SHL → Absatz leicht reduziert
  afterPara: 16,         // Abstand Fließtext → nächste Headline
  afterListBlock: 14,    // Abstand zwischen "Typische Ängste" und der ersten Liste etc. minimal größer
  afterLi: 4,            // Abstand zwischen Listenzeilen
  afterLiGroup: 10,      // zusätzlicher Abstand nach 2. Beispiel je Gruppe (Vorteile)
  blockGap: 22,          // Abstand zwischen Blöcken (z.B. Ängste→Ziele→Vorurteile)
  bigGap: 30             // großer Abstand (z.B. vor "Vorteile deines Angebots" o.ä.)
};

// ---------------------------------------------
// Utilities
// ---------------------------------------------
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

function ensurePageSafeY(page, y) {
  // kleine Reserve am Seitenende
  if (y < 70) return true;
  return false;
}

function addNewPage(doc) {
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

// parse "Zahlenlisten" 1…5 aus Textblock ("Typische Ängste:\n1. ...\n2. ...")
function parseNumberedList(block) {
  // Entferne "Typische XYZ:" falls vorhanden
  let t = String(block || "").trim();
  t = t.replace(/^Typische\s+[^\n:]+:\s*/i, "");
  const out = [];
  const re = /^\s*(\d+)\.\s+(.+)$/gm;
  let m;
  while ((m = re.exec(t))) {
    out.push(m[2].trim());
  }
  return out;
}

// Für "Vorteile deines Angebots" – wir erwarten Sektions-Header + 1..N + je 0..M Unterzeilen
// Format:
// Typische Ängste
// 1. Titel
// - Beispiel 1
// - Beispiel 2
// 2. Titel
// - ...
function parseNestedList(block) {
  const lines = String(block || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Header "Typische Ängste" o.ä. herausfiltern – den Wert geben wir zurück
  const header = lines[0] && /^Typische\s+/i.test(lines[0]) ? lines[0] : "";
  const startIndex = header ? 1 : 0;

  const items = [];
  let current = null;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) {
      // neuer Hauptpunkt
      if (current) items.push(current);
      current = { title: m[2].trim(), examples: [] };
      continue;
    }

    if (/^[-–]\s+/.test(line)) {
      const ex = line.replace(/^[-–]\s+/, "").trim();
      if (!current) current = { title: "", examples: [] };
      current.examples.push(ex);
      continue;
    }
  }
  if (current) items.push(current);

  return { header: header || "", items };
}

function drawH2(page, fonts, y, text) {
  page.drawText(String(text), {
    x: MARGIN,
    y,
    size: SIZES.h2,
    font: fonts.bold,
    color: rgb(0,0,0),
  });
  return y - (SIZES.h2 + GAPS.afterH2);
}

function drawH3(page, fonts, y, text) {
  page.drawText(String(text), {
    x: MARGIN,
    y,
    size: SIZES.h3,
    font: fonts.bold,
    color: rgb(0,0,0),
  });
  return y - (SIZES.h3 + GAPS.afterListBlock);
}

function drawNumberedList(page, fonts, y, items) {
  let cursor = y;
  for (let i = 0; i < items.length; i++) {
    const prefix = `${i + 1}. `;
    const text = `${prefix}${items[i]}`;
    const lines = wrapLines(text, fonts.regular, SIZES.li, MAX_W);
    for (let j = 0; j < lines.length; j++) {
      page.drawText(lines[j], {
        x: MARGIN,
        y: cursor,
        size: SIZES.li,
        font: fonts.regular,
        color: rgb(0,0,0),
      });
      cursor -= SIZES.li + 2;
      if (cursor < 70) {
        return { y: cursor, overflow: true };
      }
    }
    cursor -= GAPS.afterLi;
  }
  return { y: cursor, overflow: false };
}

// Zeichnet "Vorteile …" im Schema:
// 1. Titel
//   - Beispiel 1
//   - Beispiel 2
function drawNestedList(page, fonts, y, data) {
  // optional Header (z.B. "Typische Ängste")
  let cursor = y;
  if (data.header) {
    cursor = drawH3(page, fonts, cursor, data.header);
  }
  for (const it of data.items) {
    // Titelzeile (nummerierte Punkte bereits aus parseNestedList entfernt – wir rendern ohne Nummer)
    const titleLines = wrapLines(it.title, fonts.regular, SIZES.li, MAX_W);
    for (const ln of titleLines) {
      page.drawText(ln, { x: MARGIN, y: cursor, size: SIZES.li, font: fonts.regular, color: rgb(0,0,0) });
      cursor -= SIZES.li + 2;
      if (cursor < 70) return { y: cursor, overflow: true };
    }

    // Beispiele (nicht fett, als Spiegelstrich)
    for (let i = 0; i < it.examples.length; i++) {
      const ex = `- ${it.examples[i]}`;
      const exLines = wrapLines(ex, fonts.regular, SIZES.liSub, MAX_W - 12);
      for (const exLn of exLines) {
        page.drawText(exLn, { x: MARGIN + 12, y: cursor, size: SIZES.liSub, font: fonts.regular, color: rgb(0,0,0) });
        cursor -= SIZES.liSub + 2;
        if (cursor < 70) return { y: cursor, overflow: true };
      }
    }
    // etwas mehr Luft nach der Gruppe
    cursor -= GAPS.afterLiGroup;
    if (cursor < 70) return { y: cursor, overflow: true };
  }
  return { y: cursor, overflow: false };
}

// ---------------------------------------------
// Handler
// ---------------------------------------------
export default async function handler(req, res) {
  // CORS (wenn du aus anderer Domain rufst)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    const asUrl = String(req.query.as || "").toLowerCase() === "url";
    const debug = String(req.query.debug || "") === "1";

    // 1) Daten holen
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "Demo-Fließtext zu deinem Angebot ..." },
          { heading: "Deine Zielgruppe", text: "Demo-Fließtext zur Zielgruppe ..." },
          {
            heading: "Wichtige Trigger für deine Entscheider",
            text: [
              "Typische Ängste:",
              "1. Angst A",
              "2. Angst B",
              "3. Angst C",
              "4. Angst D",
              "5. Angst E",
              "",
              "Typische Ziele:",
              "1. Ziel A",
              "2. Ziel B",
              "3. Ziel C",
              "4. Ziel D",
              "5. Ziel E",
              "",
              "Typische Vorurteile:",
              "1. Vorurteil A",
              "2. Vorurteil B",
              "3. Vorurteil C",
              "4. Vorurteil D",
              "5. Vorurteil E",
            ].join("\n")
          },
          {
            heading: "Vorteile deines Angebots",
            text: [
              "Typische Ängste",
              "1. Cyberangriff",
              "- Penetrationstests & Updates …",
              "- „Ihre Klinik läuft auch im Ernstfall stabil …“",
              "2. Patientendaten",
              "- DSGVO- & KHZG-konform …",
              "- „Ihre Patientendaten sind so geschützt …“",
              "",
              "Typische Ziele",
              "1. Mehr Zeit",
              "- 30 % weniger Dokumentationszeit",
              "- Sichtbar mehr Zeit für Patienten",
              "",
              "Typische Vorurteile",
              "1. Am Ende wird es teurer",
              "- Fixpreis-Garantie",
              "- Transparente Kostenstruktur",
            ].join("\n")
          },
          { heading: "Dein Positionierungs-Vorschlag", text: "In 6 Wochen zur digitalen Klinik …" }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];
    const title = String(gpt.title || "Deine persönliche Positionierung");

    // 2) PDF-Dokumente erzeugen (Inhaltsseiten)
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Fonts laden
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

    let page = addNewPage(contentPdf);
    let y = A4.h - MARGIN;

    // H1 (Dokumenttitel)
    page.drawText(title, { x: MARGIN, y, size: SIZES.h1, font: fonts.bold, color: rgb(0,0,0) });
    y -= SIZES.h1 + GAPS.afterH1;

    // Renderer für "normale" Sektionen
    const drawParagraph = (heading, text) => {
      if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH2(page, fonts, y, heading);
      if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
      y = drawTextWrapped(page, fonts.regular, text, MARGIN, y, SIZES.p);
      y -= GAPS.afterPara;
    };

    // Renderer für Trigger
    const drawTrigger = (text) => {
      const parts = String(text || "").split(/\n\s*\n/); // Abschnitte getrennt durch Leerzeilen
      const findBlock = (label) => parts.find(p => new RegExp(`^\\s*${label}\\s*:`, "i").test(p)) || "";

      const blockA = findBlock("Typische Ängste");
      const blockZ = findBlock("Typische Ziele");
      const blockV = findBlock("Typische Vorurteile");

      // Ängste
      if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH3(page, fonts, y, "Typische Ängste");
      let items = parseNumberedList(blockA);
      let res = drawNumberedList(page, fonts, y, items);
      y = res.y;
      if (res.overflow) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }

      y -= GAPS.blockGap;

      // Ziele
      if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH3(page, fonts, y, "Typische Ziele");
      items = parseNumberedList(blockZ);
      res = drawNumberedList(page, fonts, y, items);
      y = res.y;
      if (res.overflow) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }

      y -= GAPS.blockGap;

      // Vorurteile
      if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
      y = drawH3(page, fonts, y, "Typische Vorurteile");
      items = parseNumberedList(blockV);
      res = drawNumberedList(page, fonts, y, items);
      y = res.y;
      if (res.overflow) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }

      y -= GAPS.bigGap;
    };

    // Renderer für Vorteile (mit Unterpunkten/Beispielen)
    const drawBenefits = (text) => {
      // Text in drei Blöcke trennen über Zeilen mit "Typische XYZ"
      const all = String(text || "").replace(/\r/g, "").split(/\n(?=Typische\s+)/i);

      for (const block of all) {
        const parsed = parseNestedList(block);
        if (!parsed.items.length && !parsed.header) continue;

        if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
        const res = drawNestedList(page, fonts, y, parsed);
        y = res.y;
        if (res.overflow) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
        y -= GAPS.blockGap;
      }
    };

    // 3) Sektionen durchlaufen
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      const text = String(sec.text || "").trim();

      if (/^Dein Angebot$/i.test(heading) || /^Deine Zielgruppe$/i.test(heading)) {
        drawParagraph(heading, text);
        continue;
      }

      if (/^Wichtige Trigger/i.test(heading)) {
        if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH2(page, fonts, y, "Wichtige Trigger für deine Entscheider");
        y -= 4;
        drawTrigger(text);
        continue;
      }

      if (/^Vorteile deines Angebots/i.test(heading)) {
        if (ensurePageSafeY(page, y)) { page = addNewPage(contentPdf); y = A4.h - MARGIN; }
        y = drawH2(page, fonts, y, "Vorteile deines Angebots");
        y -= 2;
        drawBenefits(text);
        continue;
      }

      // Fallback – normaler Abschnitt
      drawParagraph(heading, text);
    }

    // 4) Inhalt-PDF Bytes
    const contentBytes = await contentPdf.save();

    // 5) Statische PDFs laden und alles mergen
    const merged = await PDFDocument.create();

    async function addPdfIfExists(filename) {
      try {
        const bytes = await fs.readFile(path.join(STATIC_DIR, filename));
        const src = await PDFDocument.load(bytes, { updateMetadata: false });
        const pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(p => merged.addPage(p));
        if (debug) console.log("Merged:", filename, "pages:", pages.length);
      } catch {
        if (debug) console.log("Static not found:", filename);
      }
    }

    await addPdfIfExists("deckblatt.pdf"); // Seite 1
    // Inhalt (Seite 2–n)
    {
      const src = await PDFDocument.load(contentBytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      if (debug) console.log("Merged content pages:", pages.length);
    }
    await addPdfIfExists("angebot1.pdf"); // nächste Seiten
    await addPdfIfExists("angebot2.pdf");

    const finalBytes = await merged.save();

    if (debug) {
      console.log("Final PDF bytes length:", finalBytes?.length);
    }

    // 6) Antwort
    if (asUrl) {
      // → in Blob hochladen und URL zurückgeben
      if (!finalBytes || finalBytes.length < 1000) {
        throw new Error("PDF appears too small – aborting upload.");
      }

      const filenameBase = (title || "Ergebnis")
        .replace(/[^\p{L}\p{N}\s\-_\.]/gu, "")
        .replace(/\s+/g, "-");

      const safeName = `reports/${Date.now()}-${filenameBase}.pdf`;

      // *** WICHTIG: Rohbytes direkt hochladen ***
      const { url } = await put(safeName, Buffer.from(finalBytes), {
        access: "public",
        contentType: "application/pdf",
        cacheControl: "public, max-age=31536000, immutable",
      });

      return res.status(200).json({ url });
    } else {
      // → direkt an den Browser streamen (Download)
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

