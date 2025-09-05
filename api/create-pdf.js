// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

// ------------------ Hilfsfunktionen ------------------
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
      if (cursorY < 70) break; // einfache Seitenbruch-Sicherung
    }
  }

  return cursorY - gap;
}

function slug(str, fallback = "Ergebnis") {
  const s = String(str || fallback).trim().replace(/[^\w\-]+/g, "-").replace(/-+/g, "-");
  return s || fallback;
}

// ------------------ Handler ------------------
export default async function handler(req, res) {
  // CORS locker, damit GPT/Web problemlos testen kann
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET"; // GET zeigt Demo-Inhalte
  if (req.method !== "POST" && !isDemo) {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // 1) Daten vorbereiten
    const body = !isDemo
      ? (req.body || {})
      : {
          gpt: {
            title: "Deine persönliche Positionierung",
            sections: [
              { heading: "Dein Angebot", text: "Wir bieten digitale Lösungen für den Mittelstand." },
              { heading: "Deine Zielgruppe", text: "Geschäftsführer und Entscheider in KMU." },
              { heading: "Wichtige Trigger für deine Entscheider", text:
                "Typische Ängste:\n1. Hohe Kosten\n2. Komplexität\n\nTypische Ziele:\n1. Effizienz\n2. Sicherheit\n\nTypische Vorurteile:\n1. Schon probiert\n2. Funktioniert nicht" },
              { heading: "Vorteile deines Angebots", text:
                "Typische Ängste:\n1. Wir nehmen sie ernst\n\nTypische Ziele:\n1. Wir erfüllen sie\n\nTypische Vorurteile:\n1. Wir widerlegen sie" },
              { heading: "Dein Positionierungs-Vorschlag", text:
                "Wir sind der Partner für sichere, effiziente IT-Lösungen im Mittelstand." }
            ]
          }
        };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // 2) Inhalts-PDF (Seite 2 & ggf. 3/4...) erstellen
    const contentPdf = await PDFDocument.create();
    contentPdf.registerFontkit(fontkit);

    // Poppins-Fonts laden (Fallback auf Helvetica, wenn nicht vorhanden)
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

    // A4 Maße
    const W = 595, H = 842, M = 56;
    const maxWidth = W - 2 * M;

    let page = contentPdf.addPage([W, H]);
    let y = H - M;

    const title = String(gpt.title || "Ergebnis");
    page.drawText(title, { x: M, y, size: 20, font: fonts.bold, color: rgb(0, 0, 0) });
    y -= 28;

    for (const sec of sections) {
      const nextY = drawSection(page, fonts, M, y, maxWidth, sec.heading, sec.text, 12, 8);
      if (nextY < M + 60) {
        page = contentPdf.addPage([W, H]);
        y = H - M;
      } else {
        y = nextY;
      }
    }

    const contentBytes = await contentPdf.save();

    // 3) Statische PDFs laden (Deckblatt, Angebot 1 & 2)
    // Hinweis: Falls eine Datei fehlt, wird sie einfach übersprungen.
    let deckblattBytes = null, angebot1Bytes = null, angebot2Bytes = null;
    try { deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf")); } catch {}
    try { angebot1Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf")); } catch {}
    try { angebot2Bytes  = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf")); } catch {}

    // 4) Alles mergen: Deckblatt → Inhalt → Angebot1 → Angebot2
    const merged = await PDFDocument.create();

    async function addFromBytes(bytes) {
      if (!bytes) return;
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const copiedPages = await merged.copyPages(src, src.getPageIndices());
      copiedPages.forEach(p => merged.addPage(p)); // vorhandene Links/Annotations bleiben erhalten
    }

    await addFromBytes(deckblattBytes);      // Seite 1
    await addFromBytes(contentBytes);        // Seite 2 (& 3/4 je nach Länge)
    await addFromBytes(angebot1Bytes);       // Seite 4
    await addFromBytes(angebot2Bytes);       // Seite 5

    const finalBytes = await merged.save();

    // 5) Upload ins Vercel Blob (öffentlicher Link)
    const safe = slug(title, "Ergebnis");
    const filename = `reports/${Date.now()}-${safe}.pdf`;

    const { url } = await put(filename, Buffer.from(finalBytes), {
      access: "public",
      contentType: "application/pdf"
    });

    // 6) JSON mit URL zurückgeben
    res.status(200).json({ url, filename });
  } catch (err) {
    console.error("[create-pdf] Fehler:", err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err),
    });
  }
}

