// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

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

function drawSection(page, fonts, x, y, maxWidth, heading, body, size = 12, gap = 6) {
  let cursorY = y;

  if (heading) {
    const hSize = 16;
    page.drawText(String(heading), {
      x, y: cursorY, size: hSize, font: fonts.bold, color: rgb(0, 0, 0)
    });

    // Abstand nach Headline (1,5x Zeilenhöhe)
    cursorY -= hSize * 1.5;
  }

  if (body) {
    const lines = wrapLines(String(body), fonts.regular, size, maxWidth);
    for (const ln of lines) {
      page.drawText(ln, { x, y: cursorY, size, font: fonts.regular, color: rgb(0,0,0) });
      cursorY -= size + 2;
      if (cursorY < 70) break;
    }

    // Abstand nach Body (3x Zeilenhöhe)
    cursorY -= size * 3;
  }

  return cursorY - gap;
}

// --- Handler ---------------------------------------------------------
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    // 1) Daten
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "Beschreibung deines Angebots." },
          { heading: "Deine Zielgruppe", text: "Beschreibung deiner Zielgruppe." },
          { heading: "Wichtige Trigger für deine Entscheider", text: "Typische Ängste:\n1. Angst vor Kosten\n2. Angst vor Verzögerungen\n\nTypische Ziele:\n1. Schnelle Umsetzung\n2. Hohe Wirkung\n\nTypische Vorurteile:\n1. Schon probiert\n2. Funktioniert nicht" },
          { heading: "Vorteile deines Angebots", text: "Typische Ängste:\n1. Werden genommen\n\nTypische Ziele:\n1. Werden erfüllt\n\nTypische Vorurteile:\n1. Werden aufgelöst" },
          { heading: "Dein Positionierungs-Vorschlag", text: "Hier steht der Vorschlag." }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // 2) Content-PDF erzeugen
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

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

    let page = contentPdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: margin, y, size: 20, font: fonts.bold, color: rgb(0,0,0) });
    y -= 32;

    for (const sec of sections) {
      const nextY = drawSection(page, fonts, margin, y, maxWidth, sec.heading, sec.text, 12, 8);
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

    // 4) Blob speichern statt direkt senden
    const filename = `reports/${Date.now()}-Ergebnis.pdf`;
    const { url } = await put(filename, Buffer.from(finalBytes), {
      access: "public",
      contentType: "application/pdf"
    });

    // 5) URL zurückgeben
    res.status(200).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err)
    });
  }
}
