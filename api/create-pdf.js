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
      x,
      y: cursorY,
      size: hSize,
      font: fonts.bold,
      color: rgb(0, 0, 0),
    });
    cursorY -= hSize + gap * 3;
  }

  if (body) {
    const lines = wrapLines(String(body), fonts.regular, size, maxWidth);
    for (const ln of lines) {
      page.drawText(ln, {
        x,
        y: cursorY,
        size,
        font: fonts.regular,
        color: rgb(0, 0, 0),
      });
      cursorY -= size + 2;
      if (cursorY < 70) break;
    }
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
  if (req.method !== "POST" && !isDemo)
    return res.status(405).send("Method Not Allowed");

  try {
    // 1) Daten
    const body = !isDemo
      ? req.body || {}
      : {
          gpt: {
            title: "Beispiel – Positionierung",
            sections: [
              {
                heading: "Ist-Situation",
                text: "Kurzer Überblick über Markt, Zielgruppe und aktuelle Angebote.",
              },
              {
                heading: "Zielbild",
                text: "Klare, spitze Positionierung mit messbarem Nutzen und eindeutiger Differenzierung.",
              },
              {
                heading: "Kernbotschaften",
                text: "Wir fokussieren uns auf XY. Schnell, verständlich, zuverlässig.",
              },
            ],
          },
        };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // 2) Content-PDF erzeugen
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Fonts laden (Poppins), sonst Fallback Helvetica
    let regBytes = null,
      boldBytes = null;
    try {
      regBytes = await fs.readFile(
        path.join(STATIC_DIR, "Poppins-Regular.ttf")
      );
    } catch {}
    try {
      boldBytes = await fs.readFile(
        path.join(STATIC_DIR, "Poppins-SemiBold.ttf")
      );
    } catch {}

    const regFont = regBytes
      ? await contentPdf.embedFont(regBytes)
      : await contentPdf.embedFont(StandardFonts.Helvetica);

    const boldFont = boldBytes
      ? await contentPdf.embedFont(boldBytes)
      : await contentPdf.embedFont(StandardFonts.HelveticaBold);

    const fonts = { regular: regFont, bold: boldFont };

    // A4 Seite
    const pageWidth = 595,
      pageHeight = 842;
    const margin = 56;
    const maxWidth = pageWidth - margin * 2;

    let page = contentPdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, {
      x: margin,
      y,
      size: 20,
      font: fonts.bold,
      color: rgb(0, 0, 0),
    });
    y -= 28;

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
        8
      );
      if (nextY < margin + 60) {
        page = contentPdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      } else {
        y = nextY;
      }
    }

    const finalBytes = await contentPdf.save();

    // 3) Datei im Blob Store speichern
    const filename = `reports/Ergebnis-${Date.now()}.pdf`;
    const { url } = await put(filename, Buffer.from(finalBytes), {
      access: "public",
      contentType: "application/pdf",
    });

    // 4) URL zurückgeben
    res.status(200).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err),
    });
  }
}

