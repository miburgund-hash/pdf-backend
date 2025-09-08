// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// ---------- Helpers --------------------------------------------------
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

function drawSection(page, fonts, x, y, maxWidth, heading, body, size = 12, gap = 8) {
  let cursorY = y;

  if (heading) {
    const hSize = 16;
    page.drawText(String(heading), { x, y: cursorY, size: hSize, font: fonts.bold, color: rgb(0,0,0) });
    cursorY -= hSize + gap * 3; // extra Abstand nach Headline
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

function validatePayload(gpt) {
  const problems = [];
  if (!gpt || typeof gpt !== "object") {
    problems.push("gpt fehlt oder ist kein Objekt.");
    return { valid: false, problems };
  }
  if (!gpt.title || String(gpt.title).trim().length < 3) {
    problems.push("title fehlt/zu kurz.");
  }
  if (!Array.isArray(gpt.sections) || gpt.sections.length < 3) {
    problems.push("sections fehlt oder hat zu wenig Einträge (>=3).");
  } else {
    gpt.sections.forEach((s, i) => {
      if (!s || typeof s !== "object") problems.push(`sections[${i}] ist kein Objekt.`);
      if (!s.heading || String(s.heading).trim().length < 3) problems.push(`sections[${i}].heading fehlt/zu kurz.`);
      if (!s.text || String(s.text).trim().length < 3) problems.push(`sections[${i}].text fehlt/zu kurz.`);
    });
  }
  return { valid: problems.length === 0, problems };
}

// ---------- Handler --------------------------------------------------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const wantUrlOnly = req.query.as === "url";
  const debugMode   = req.query.debug === "1";

  try {
    const isDemo = req.method === "GET"; // GET = Demo-Inhalte
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Beispiel – Positionierung (Demo)",
        sections: [
          { heading: "Dein Angebot", text: "Kurzer Überblick …" },
          { heading: "Deine Zielgruppe", text: "Die Zielgruppe sind …" },
          { heading: "Wichtige Trigger für deine Entscheider", text: "Typische Ängste:\n1. …\n2. …\n\nTypische Ziele:\n1. …\n2. …\n\nTypische Vorurteile:\n1. …\n2. …" },
          { heading: "Vorteile deines Angebots", text: "Typische Ängste – Beispiele:\n1. …\n2. …\n\nTypische Ziele – Beispiele:\n1. …\n2. …\n\nTypische Vorurteile – Beispiele:\n1. …\n2. …" },
          { heading: "Dein Positionierungs-Vorschlag", text: "Unser Vorschlag lautet …" }
        ]
      }
    };

    const gpt = body.gpt || {};
    const { valid, problems } = validatePayload(gpt);

    // ---- DEBUG: zeige, was ankam
    if (debugMode) {
      return res.status(valid ? 200 : 400).json({
        valid, problems,
        received: gpt
      });
    }

    if (!valid) {
      return res.status(400).json({ error: "Ungültiger Payload.", problems });
    }

    // 2) Content-PDF erzeugen
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Fonts
    let regBytes=null, boldBytes=null;
    try { regBytes  = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regFont  = regBytes  ? await contentPdf.embedFont(regBytes)  : await contentPdf.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes ? await contentPdf.embedFont(boldBytes) : await contentPdf.embedFont(StandardFonts.HelveticaBold);
    const fonts = { regular: regFont, bold: boldFont };

    // Seite(n)
    const pageWidth = 595, pageHeight = 842, margin = 56, maxWidth = pageWidth - margin*2;
    let page = contentPdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: margin, y, size: 20, font: fonts.bold, color: rgb(0,0,0) });
    y -= 28;

    for (const sec of gpt.sections || []) {
      const nextY = drawSection(page, fonts, margin, y, maxWidth, sec.heading, sec.text, 12, 8);
      if (nextY < margin + 80) {
        page = contentPdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      } else {
        y = nextY;
      }
    }

    const contentBytes = await contentPdf.save();

    // 3) Deckblatt + Angebots-PDFs mergen
    const merged = await PDFDocument.create();
    async function addPdfFromBytes(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
    const angebot1Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
    const angebot2Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));

    await addPdfFromBytes(deckblattBytes);  // S.1
    await addPdfFromBytes(contentBytes);    // S.2+
    await addPdfFromBytes(angebot1Bytes);
    await addPdfFromBytes(angebot2Bytes);

    const finalBytes = await merged.save();

    // 4) Blob speichern und URL zurückgeben
    const filenameSafe = (title || "Ergebnis").replace(/[^\p{L}\p{N}\-_. ]/gu, "").replace(/\s+/g, "-");
    const key = `reports/${Date.now()}-${filenameSafe}.pdf`;
    const blob = await put(key, Buffer.from(finalBytes), { access: "public", contentType: "application/pdf" });

    if (wantUrlOnly) {
      return res.status(200).json({ url: blob.url });
    }
    res.setHeader("Content-Type", "application/json");
    return res.status(200).json({ url: blob.url });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(err?.message || err) });
  }
}
