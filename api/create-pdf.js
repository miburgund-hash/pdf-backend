// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";

const STATIC_DIR = path.join(process.cwd(), "static");

// --- Helfer ---------------------------------------------------------
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

/**
 * Zeichnet eine Section:
 * - Headline -> Text: 1× gap (normal)
 * - Abschnittsende -> nächste Headline: 3× gap
 */
function drawSection(
  page,
  fonts,
  x,
  y,
  maxWidth,
  heading,
  body,
  size = 12,
  gap = 8 // Basisabstand
) {
  const headlineGap = gap;      // nach Headline (Headline -> Body)
  const sectionGap  = gap * 3;  // nach Abschnitt (Body-Ende -> nächste Headline)

  let cursorY = y;

  if (heading) {
    const hSize = 16;
    page.drawText(String(heading), {
      x, y: cursorY, size: hSize, font: fonts.bold, color: rgb(0, 0, 0)
    });
    cursorY -= hSize + headlineGap; // Headline-Abstand
  }

  if (body) {
    const lines = wrapLines(String(body), fonts.regular, size, maxWidth);
    for (const ln of lines) {
      page.drawText(ln, { x, y: cursorY, size, font: fonts.regular, color: rgb(0,0,0) });
      cursorY -= size + 2; // Zeilenabstand im Fließtext
      if (cursorY < 70) break;
    }
  }

  // Abstand nach Abschnitt (bis zur nächsten Headline)
  return cursorY - sectionGap;
}

// --- Handler ---------------------------------------------------------
export default async function handler(req, res) {
  // CORS (falls später von deiner Domain aufgerufen)
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    // 1) Daten
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Beispiel – Positionierung",
        sections: [
          { heading: "Ist-Situation", text: "Kurzer Überblick über Markt, Zielgruppe und aktuelle Angebote." },
          { heading: "Zielbild", text: "Klare, spitze Positionierung mit messbarem Nutzen und eindeutiger Differenzierung." },
          { heading: "Kernbotschaften", text: "Wir fokussieren uns auf XY. Schnell, verständlich, zuverlässig." }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // 2) Content-PDF (Seite 2 & 3)
    const contentPdf = await PDFDocument.create();
    // Fontkit registrieren, damit TTF-Fonts funktionieren
    contentPdf.registerFontkit(fontkit);

    // Fonts laden (Poppins), sonst Fallback Helvetica
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

    // A4
    const pageWidth = 595, pageHeight = 842;
    const margin = 56;
    const maxWidth = pageWidth - margin * 2;
    const baseGap = 8; // Basisabstand, passend zum drawSection-Aufruf

    let page = contentPdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    // Titel
    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: margin, y, size: 20, font: fonts.bold, color: rgb(0,0,0) });
    // nach dem Titel: 1,5× Basisabstand zusätzlich
    y -= 28 + Math.round(baseGap * 1.5);

    // Sections
    for (const sec of sections) {
      const nextY = drawSection(
        page,
        fonts,
        margin,
        y,
        maxWidth,
        sec.heading,
        sec.text,
        12,
        baseGap // gap (headlineGap = 1×, sectionGap = 3×)
      );

      if (nextY < margin + 60) {
        page = contentPdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      } else {
        y = nextY;
      }
    }

    const contentBytes = await contentPdf.save();

    // 3) Statische PDFs + Inhalt mergen
    const merged = await PDFDocument.create();

    async function addPdfFromBytes(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
    const angebot1Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
    const angebot2Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));

    await addPdfFromBytes(deckblattBytes);  // Seite 1
    await addPdfFromBytes(contentBytes);    // Seite 2 & 3
    await addPdfFromBytes(angebot1Bytes);   // Seite 4
    await addPdfFromBytes(angebot2Bytes);   // Seite 5

    const finalBytes = await merged.save();

    // 4) Direkt als Download ausliefern
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Ergebnis.pdf"');
    res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err)
    });
  }
}
