import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fs from "fs/promises";
import path from "path";

const STATIC_DIR = path.join(process.cwd(), "static");

// einfache Text-Umbruchhilfe
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

function drawSection(page, font, fontBold, x, y, maxWidth, heading, body, size = 12, gap = 6) {
  let cursorY = y;
  if (heading) {
    const hSize = 16;
    page.drawText(heading, { x, y: cursorY, size: hSize, font: fontBold, color: rgb(0,0,0) });
    cursorY -= hSize + gap;
  }
  if (body) {
    const lines = wrapLines(body, font, size, maxWidth);
    for (const ln of lines) {
      page.drawText(ln, { x, y: cursorY, size, font, color: rgb(0,0,0) });
      cursorY -= size + 2;
    }
  }
  return cursorY - gap;
}

export default async function handler(req, res) {
  // CORS – falls du später von deiner Seite aufrufst
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  // Testmodus: GET erzeugt ein Demo-PDF (hilft beim ersten Testen im Browser)
  const isDemo = req.method === "GET";

  try {
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

    // 1) neues PDF – Seiten 2 & 3 (Inhalt)
    const contentPdf = await PDFDocument.create();
    const poppinsRegular = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")).catch(() => null);
    const poppinsBold    = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")).catch(() => null);

    const font     = poppinsRegular ? await contentPdf.embedFont(poppinsRegular) : await contentPdf.embedFont(StandardFonts.Helvetica);
    const fontBold = poppinsBold    ? await contentPdf.embedFont(poppinsBold)    : await contentPdf.embedFont(StandardFonts.HelveticaBold);

    // A4: 595 x 842 pt, Ränder
    const pageWidth = 595, pageHeight = 842;
    const margin = 56;
    const maxWidth = pageWidth - margin*2;

    // Seite 2
    let page = contentPdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: margin, y, size: 20, font: fontBold });
    y -= 28;

    for (const sec of sections) {
      const nextY = drawSection(page, font, fontBold, margin, y, maxWidth, sec.heading, sec.text, 12, 8);
      // neue Seite falls kein Platz
      if (nextY < margin + 80) {
        page = contentPdf.addPage([pageWidth, pageHeight]); // Seite 3
        y = pageHeight - margin;
      } else {
        y = nextY;
      }
    }

    const contentBytes = await contentPdf.save();

    // 2) statische PDFs anhängen (Links bleiben erhalten)
    const merged = await PDFDocument.create();

    const addPdf = async (bytes) => {
      const doc = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    };

    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
    const angebot1Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
    const angebot2Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));

    await addPdf(deckblattBytes);   // Seite 1
    await addPdf(contentBytes);     // Seite 2 & 3
    await addPdf(angebot1Bytes);    // Seite 4
    await addPdf(angebot2Bytes);    // Seite 5

    const finalBytes = await merged.save();

    // 3) direkt zurückgeben (Download im Browser)
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Ergebnis.pdf"');
    res.status(200).send(Buffer.from(finalBytes));
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(e?.message || e) });
  }
}
