// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";   // <--- wichtig

const STATIC_DIR = path.join(process.cwd(), "static");

// --- Helfer: Zeilen umbrechen -------------------------------------
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
    // mehr Abstand nach Überschrift
    cursorY -= hSize + gap * 3;
  }

  if (body) {
    const lines = wrapLines(String(body), fonts.regular, size, maxWidth);
    for (const ln of lines) {
      page.drawText(ln, { x, y: cursorY, size, font: fonts.regular, color: rgb(0,0,0) });
      cursorY -= size + 2;
      if (cursorY < 70) break;
    }
  }

  return cursorY - gap;
}

// --- API-Handler ---------------------------------------------------
export default async function handler(req, res) {
  // CORS locker für Tests
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    // 1) Daten holen (oder Demo)
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

    // 2) PDF erstellen
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    // Poppins laden (fallback Helvetica)
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regFont = regBytes
      ? await doc.embedFont(regBytes)
      : await doc.embedFont(StandardFonts.Helvetica);

    const boldFont = boldBytes
      ? await doc.embedFont(boldBytes)
      : await doc.embedFont(StandardFonts.HelveticaBold);

    const fonts = { regular: regFont, bold: boldFont };

    const W = 595, H = 842, M = 56;
    const maxWidth = W - 2 * M;
    let page = doc.addPage([W, H]);
    let y = H - M;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: M, y, size: 20, font: fonts.bold, color: rgb(0,0,0) });
    y -= 28;

    for (const sec of sections) {
      const nextY = drawSection(page, fonts, M, y, maxWidth, sec.heading, sec.text, 12, 8);
      if (nextY < M + 60) {
        page = doc.addPage([W, H]);
        y = H - M;
      } else {
        y = nextY;
      }
    }

    const pdfBytes = await doc.save();

    // 3) In den Vercel Blob hochladen und URL zurückgeben
    const filename = `reports/${Date.now()}-Ergebnis.pdf`;
    const { url } = await put(filename, Buffer.from(pdfBytes), {
      access: "public",
      contentType: "application/pdf"
    });

    // WICHTIG: Nur diese Blob-URL zurückgeben
    res.status(200).json({ url, filename });

  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err)
    });
  }
}

