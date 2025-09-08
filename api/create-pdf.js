// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";

const STATIC_DIR = path.join(process.cwd(), "static");

// -------------------- Layout & Typografie --------------------
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const CONTENT_W = A4.w - MARGIN * 2;

const SIZE = {
  HL: 28,
  SHL: 18,
  MINI: 14,
  TEXT: 12,
};

const GAP = {
  HL_to_SHL1: 22,         // halbiert ggü. vorher
  SHL_to_TEXT_small: 8,   // etwas kleiner
  PARA_to_next_SHL: 36,   // 3x so groß
  BETWEEN_LINES: 2,       // Zeilenabstand Text
  MINI_AFTER: 10,         // etwas größerer Abstand nach "Typische Ängste/Ziele/Vorurteile"
  BLOCK_AFTER: 16,        // normaler Blockabstand
  BIG_AFTER: 28,          // 3x für große Trenner
  ADV_POINT_AFTER: 10,    // Abstand zwischen Zahlpunkt und den Bullets
  ADV_BULLET_AFTER: 6,    // Zeilenabstand Bullets
  ADV_POINT_BLOCK: 14,    // größerer Abstand nach dem zweiten Bullet bis zum nächsten Punkt
};

const COLOR = {
  BLACK: rgb(0,0,0)
};

// -------------------- Text-Wrapping --------------------
function wrapLines(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(t, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// -------------------- Low-level draw helpers --------------------
function drawTextBlock(page, font, text, x, y, size, color, maxWidth, lineGap = GAP.BETWEEN_LINES) {
  const lines = wrapLines(text, font, size, maxWidth);
  let cy = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: cy, size, font, color });
    cy -= size + lineGap;
  }
  return cy;
}

function ensureSpace(doc, page, y, needed) {
  if (y - needed < MARGIN) {
    page = doc.addPage([A4.w, A4.h]);
    return { page, y: A4.h - MARGIN };
  }
  return { page, y };
}

// -------------------- Block renderers --------------------
function drawHeadline(doc, page, fonts, title, y) {
  const { bold } = fonts;
  ({ page, y } = ensureSpace(doc, page, y, SIZE.HL + GAP.HL_to_SHL1));
  page.drawText(title, { x: MARGIN, y, size: SIZE.HL, font: bold, color: COLOR.BLACK });
  y -= SIZE.HL + GAP.HL_to_SHL1;
  return { page, y };
}

function drawSubHeadline(doc, page, fonts, text, y) {
  const { bold } = fonts;
  ({ page, y } = ensureSpace(doc, page, y, SIZE.SHL + GAP.SHL_to_TEXT_small));
  page.drawText(text, { x: MARGIN, y, size: SIZE.SHL, font: bold, color: COLOR.BLACK });
  y -= SIZE.SHL + GAP.SHL_to_TEXT_small;
  return { page, y };
}

function drawMiniHeadline(doc, page, fonts, text, y) {
  const { bold } = fonts;
  ({ page, y } = ensureSpace(doc, page, y, SIZE.MINI + GAP.MINI_AFTER));
  page.drawText(text, { x: MARGIN, y, size: SIZE.MINI, font: bold, color: COLOR.BLACK });
  y -= SIZE.MINI + GAP.MINI_AFTER; // etwas größerer Abstand nach "Typische …"
  return { page, y };
}

function drawParagraph(doc, page, fonts, text, y) {
  const { regular } = fonts;
  ({ page, y } = ensureSpace(doc, page, y, SIZE.TEXT * 3));
  y = drawTextBlock(page, regular, text, MARGIN, y, SIZE.TEXT, COLOR.BLACK, CONTENT_W);
  y -= GAP.PARA_to_next_SHL; // großer Abstand bis zur nächsten SHL
  return { page, y };
}

function drawNumberedList(doc, page, fonts, items, y) {
  const { regular } = fonts;
  for (let i = 0; i < items.length; i++) {
    ({ page, y } = ensureSpace(doc, page, y, SIZE.TEXT * 2));
    const prefix = `${i+1}. `;
    const preWidth = regular.widthOfTextAtSize(prefix, SIZE.TEXT);
    page.drawText(prefix, { x: MARGIN, y, size: SIZE.TEXT, font: regular, color: COLOR.BLACK });
    y = drawTextBlock(page, regular, items[i], MARGIN + preWidth, y, SIZE.TEXT, COLOR.BLACK, CONTENT_W - preWidth);
    y -= GAP.BLOCK_AFTER;
  }
  // etwas mehr Luft nach ganzer Liste:
  y -= GAP.BLOCK_AFTER;
  return { page, y };
}

// -------------------- "Wichtige Trigger …" parser (kleine SHLs + Listen) --------------------
function drawTriggersSection(doc, page, fonts, bodyText, y) {
  // Erwartet Blöcke "Typische Ängste:", "Typische Ziele:", "Typische Vorurteile:"
  const blocks = bodyText.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean);

  for (const block of blocks) {
    let m = block.match(/^Typische\s+(Ängste|Ziele|Vorurteile)\s*:\s*/i);
    if (m) {
      const label = `Typische ${m[1]}`;
      const rest = block.replace(/^Typische\s+(Ängste|Ziele|Vorurteile)\s*:\s*/i, "");

      ({ page, y } = drawMiniHeadline(doc, page, fonts, label, y));

      // nummerierte Einträge extrahieren: "1. …" pro Zeile
      const items = rest
        .split(/\n/)
        .map(s => s.replace(/^\d+\.\s*/, "").trim())
        .filter(Boolean);

      ({ page, y } = drawNumberedList(doc, page, fonts, items, y));
    } else {
      // Fallback: als Paragraph darstellen
      ({ page, y } = drawParagraph(doc, page, fonts, block, y));
    }
  }
  return { page, y };
}

// -------------------- "Vorteile deines Angebots" (NEU: verschachtelte Struktur) -------------
function parseAdvantages(text) {
  // Robuster Parser: erkennt beide Formate
  //  A) Mehrzeilig:
  //     1. Cyberangriff
  //        - Beispiel 1
  //        - Beispiel 2
  //  B) Kompakt:
  //     1. Cyberangriff – Beispiel 1 – Beispiel 2
  const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);

  const groups = [];        // [{ title: 'Cyberangriff', bullets:['Bsp1','Bsp2'] }, ...]
  let current = null;

  for (const ln of lines) {
    if (/^\d+\.\s*/.test(ln)) {
      // Neuer Punkt
      if (current) groups.push(current);
      const after = ln.replace(/^\d+\.\s*/, "");
      // kompakt mit " – "?
      const parts = after.split(/\s+–\s+/);
      if (parts.length >= 3) {
        current = {
          title: parts[0],
          bullets: parts.slice(1, 3) // max 2 Beispiele
        };
      } else {
        current = { title: after, bullets: [] };
      }
    } else if (/^\-\s+/.test(ln)) {
      // Bullet-Zeile
      if (!current) current = { title: "", bullets: [] };
      current.bullets.push(ln.replace(/^\-\s+/, ""));
    } else if (/^Typische\s+(Ängste|Ziele|Vorurteile)/i.test(ln)) {
      // Mini-Headline ignorieren – Behandlung außerhalb
      continue;
    } else {
      // lose Zeile: falls kompakt Format mit " – " ohne Nummer
      const parts = ln.split(/\s+–\s+/);
      if (parts.length >= 3) {
        if (current) groups.push(current);
        current = { title: parts[0], bullets: parts.slice(1, 3) };
      }
    }
  }
  if (current) groups.push(current);
  return groups;
}

function drawAdvantagesGroup(doc, page, fonts, title, bullets, y) {
  const { regular } = fonts;

  // Titelzeile (nicht fett)
  ({ page, y } = ensureSpace(doc, page, y, SIZE.TEXT * 2));
  // "1. " Nummerierung erzeugen? Das übernimmt der Aufrufer.
  y = drawTextBlock(page, regular, title, MARGIN, y, SIZE.TEXT, COLOR.BLACK, CONTENT_W);
  y -= GAP.ADV_POINT_AFTER;

  // zwei Bullets, jeweils neue Zeile, eingerückt, NICHT fett
  for (let i = 0; i < bullets.length; i++) {
    ({ page, y } = ensureSpace(doc, page, y, SIZE.TEXT * 2));
    const bullet = `• ${bullets[i]}`;
    y = drawTextBlock(page, regular, bullet, MARGIN + 18, y, SIZE.TEXT, COLOR.BLACK, CONTENT_W - 18);
    y -= GAP.ADV_BULLET_AFTER;
  }

  // größerer Abstand nach dem Block
  y -= GAP.ADV_POINT_BLOCK;
  return { page, y };
}

function drawAdvantagesSection(doc, page, fonts, bodyText, y) {
  // Wir erwarten Teilblöcke "Typische Ängste", "Typische Ziele", "Typische Vorurteile"
  const chunks = bodyText
    .split(/\n(?=Typische\s+(Ängste|Ziele|Vorurteile))/i)
    .map(s => s.trim())
    .filter(Boolean);

  for (const chunk of chunks) {
    const m = chunk.match(/^Typische\s+(Ängste|Ziele|Vorurteile)\s*/i);
    if (!m) continue;
    const label = `Typische ${m[1]}`;
    const rest = chunk.replace(/^Typische\s+(Ängste|Ziele|Vorurteile)\s*/i, "").trim();

    // Mini-Headline
    ({ page, y } = drawMiniHeadline(doc, page, fonts, label, y));

    // Punkte + Bullets rendern
    const groups = parseAdvantages(rest);
    for (let i = 0; i < groups.length; i++) {
      const numTitle = `${i + 1}. ${groups[i].title}`;
      ({ page, y } = drawAdvantagesGroup(doc, page, fonts, numTitle, groups[i].bullets.slice(0,2), y));
    }

    // Nach jedem Block etwas mehr Luft
    y -= GAP.BLOCK_AFTER;
  }
  // am Ende noch extra Abstand
  y -= GAP.BLOCK_AFTER;
  return { page, y };
}

// -------------------- Handler --------------------
export default async function handler(req, res) {
  // CORS falls nötig
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    // ----- Payload -----
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "Demo-Fließtext …" },
          { heading: "Deine Zielgruppe", text: "Demo-Fließtext …" },
          { heading: "Wichtige Trigger für deine Entscheider", text:
`Typische Ängste:
1. Punkt A
2. Punkt B
3. Punkt C

Typische Ziele:
1. Ziel A
2. Ziel B

Typische Vorurteile:
1. Vorurteil A
2. Vorurteil B`
          },
          { heading: "Vorteile deines Angebots", text:
`Typische Ängste
1. Cyberangriff
   - Penetrationstests & Updates – 0 Ausfälle …
   - "Ihre Klinik läuft auch …"

Typische Ziele
1. Mehr Zeit
   - Dokumentationszeit reduziert …
   - Mehr Zeit am Patienten …

Typische Vorurteile
1. "Das dauert ewig"
   - Schrittweise Einführung …
   - Max. 2h Downtime …`
          },
          { heading: "Dein Positionierungs-Vorschlag", text: "In X Wochen zu …" }
        ]
      }
    };

    const gpt = body.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // ----- Content PDF -----
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);

    // Fonts
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}
    const regular = regBytes ? await doc.embedFont(regBytes) : await doc.embedFont(StandardFonts.Helvetica);
    const bold    = boldBytes ? await doc.embedFont(boldBytes) : await doc.embedFont(StandardFonts.HelveticaBold);
    const fonts   = { regular, bold };

    let page = doc.addPage([A4.w, A4.h]);
    let y = A4.h - MARGIN;

    // Title
    ({ page, y } = drawHeadline(doc, page, fonts, String(gpt.title || "Ergebnis"), y));

    // Sections
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      const text    = String(sec.text || "").trim();
      if (!heading) continue;

      ({ page, y } = drawSubHeadline(doc, page, fonts, heading, y));

      if (/^Wichtige Trigger/i.test(heading)) {
        ({ page, y } = drawTriggersSection(doc, page, fonts, text, y));
      } else if (/^Vorteile deines Angebots/i.test(heading)) {
        ({ page, y } = drawAdvantagesSection(doc, page, fonts, text, y));
      } else {
        ({ page, y } = drawParagraph(doc, page, fonts, text, y));
      }

      // Seitenumbruch falls knapp:
      if (y < MARGIN + 60) {
        page = doc.addPage([A4.w, A4.h]);
        y = A4.h - MARGIN;
      }
    }

    const contentBytes = await doc.save();

    // ----- Merge statische PDFs (1,4,5) -----
    const merged = await PDFDocument.create();

    async function addPdf(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      for (const p of pages) merged.addPage(p);
    }

    // Seite 1: Deckblatt
    const deckblattBytes = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
    await addPdf(deckblattBytes);

    // Seite 2..n: Content
    await addPdf(contentBytes);

    // Seite 4: Angebot 1
    const angebot1Bytes = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
    await addPdf(angebot1Bytes);

    // Seite 5: Angebot 2
    const angebot2Bytes = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));
    await addPdf(angebot2Bytes);

    const finalBytes = await merged.save();

    // ----- Response -----
    // Wenn ?as=url vom Actions-Test gesetzt → Blob / Storage machen (wird in deiner Actions-Implementierung erledigt)
    // Hier liefern wir das PDF direkt:
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Ergebnis.pdf"');
    res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(err?.message || err) });
  }
}
