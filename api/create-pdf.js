// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

const STATIC_DIR = path.join(process.cwd(), "static");

/* ------------------------------------------------------------
   Layout & Typo
------------------------------------------------------------ */
const A4 = { w: 595, h: 842 };
const MARGIN = 56;
const MAX_W = A4.w - MARGIN * 2;

// Schriftgrößen
const SIZE = {
  h1: 26,            // Titel
  h2: 16,            // Abschnitts-Headline
  h3: 13,            // Unter-Headline (z.B. „Typische Ängste“)
  p: 12,             // Fließtext
  li: 12,            // Listenzeilen
  sub: 11            // Sub-Bullets
};

// Zeilenabstände
const LEADING = {
  h1: 6,
  h2: 4,
  h3: 3,
  p: 2,
  li: 2,
  sub: 1
};

// Abstände (nach Blöcken)
const GAP = {
  afterTitle: 18 * 2,        // Titel → erste SHL: doppelt
  afterH2: 8,                // nach jeder SHL: kompakt
  afterParagraph: 10 * 3,    // nach Absätzen bis zur nächsten SHL: 3×
  betweenItems: 6            // zwischen Listenelementen
};

/* ------------------------------------------------------------
   Helfer
------------------------------------------------------------ */
function lineHeight(size, add = 0) {
  return size + add;
}

function wrapLines(text, font, size, maxWidth) {
  const words = String(text || "").split(/\s+/);
  const out = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(t, size) > maxWidth && line) {
      out.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) out.push(line);
  return out;
}

function nextPage(pdf, fonts) {
  const page = pdf.addPage([A4.w, A4.h]);
  return { page, x: MARGIN, y: A4.h - MARGIN, fonts };
}

function ensureSpace(ctx, needed) {
  if (ctx.y - needed < MARGIN) {
    const np = nextPage(ctx.pdf, ctx.fonts);
    ctx.page = np.page;
    ctx.x = np.x;
    ctx.y = np.y;
  }
}

function drawTextLine(ctx, text, size, font, color = rgb(0, 0, 0)) {
  ensureSpace(ctx, size + 2);
  ctx.page.drawText(text, { x: ctx.x, y: ctx.y, size, font, color });
  ctx.y -= lineHeight(size, LEADING.p);
}

function drawWrapped(ctx, text, size, font) {
  const lines = wrapLines(text, font, size, MAX_W);
  for (const ln of lines) {
    drawTextLine(ctx, ln, size, font);
  }
}

/* ------------------------------------------------------------
   Parser für „Trigger“ & „Vorteile“ – erkennt Unter-SHL und Listen
------------------------------------------------------------ */

// z.B. „Typische Ängste:\n1. ...\n2. ...\n\nTypische Ziele:\n...“
function parseTriggerText(text) {
  const blocks = [];
  const parts = String(text || "").split(/\n{2,}/); // leere Zeilen trennen Gruppen
  for (const part of parts) {
    const m = part.match(/^\s*(Typische\s+(Ängste|Ziele|Vorurteile))\s*:?\s*/i);
    if (!m) continue;
    const subHeading = m[1].trim();
    const body = part.replace(m[0], "");
    const items = body
      .split(/\n+/)
      .map(s => s.trim())
      .filter(Boolean)
      .filter(s => /^\d+\./.test(s)); // nur nummerierte Zeilen
    blocks.push({ subHeading, items });
  }
  return blocks;
}

// z.B. „Typische Ängste – Beispiele:\n1. Hauptpunkt …\n(Zeile) Beispiel\n(Zeile) Beispiel\n\nTypische Ziele – Beispiele: …“
function parseVorteileText(text) {
  const out = [];
  const groups = String(text || "")
    .split(/\n{2,}/)
    .map(g => g.trim())
    .filter(Boolean);

  let current = null;

  for (const g of groups) {
    const m = g.match(/^\s*(Typische\s+(Ängste|Ziele|Vorurteile))(?:\s*[-–]\s*Beispiele)?\s*:?\s*/i);
    if (m) {
      // neue Gruppe
      if (current) out.push(current);
      current = { subHeading: m[1], items: [] };
      const rest = g.replace(m[0], "").trim();
      if (!rest) continue;

      const lines = rest.split(/\n+/).map(s => s.trim()).filter(Boolean);
      let i = 0;
      while (i < lines.length) {
        const head = lines[i];
        if (/^\d+\./.test(head)) {
          const title = head.replace(/^\d+\.\s*/, "");
          const examples = [];
          let j = i + 1;
          // sammle 1–2 Folgezeilen, die **nicht** mit Zahl beginnen
          while (j < lines.length && !/^\d+\./.test(lines[j]) && examples.length < 4) {
            examples.push(lines[j]);
            j++;
          }
          current.items.push({ title, examples });
          i = j;
        } else {
          i++;
        }
      }
    } else if (current) {
      // fortlaufender Text ohne neue Überschrift – als zusätzliche lines behandeln
      const lines = g.split(/\n+/).map(s => s.trim()).filter(Boolean);
      let i = 0;
      while (i < lines.length) {
        const head = lines[i];
        if (/^\d+\./.test(head)) {
          const title = head.replace(/^\d+\.\s*/, "");
          const examples = [];
          let j = i + 1;
          while (j < lines.length && !/^\d+\./.test(lines[j]) && examples.length < 4) {
            examples.push(lines[j]);
            j++;
          }
          current.items.push({ title, examples });
          i = j;
        } else {
          i++;
        }
      }
    }
  }
  if (current) out.push(current);
  return out;
}

/* ------------------------------------------------------------
   Zeichnen: Titel, H2, H3, Absätze, Listen
------------------------------------------------------------ */
function drawH1(ctx, text) {
  ensureSpace(ctx, SIZE.h1 + GAP.afterTitle);
  ctx.page.drawText(text, {
    x: ctx.x,
    y: ctx.y,
    size: SIZE.h1,
    font: ctx.fonts.bold
  });
  ctx.y -= lineHeight(SIZE.h1, LEADING.h1) + GAP.afterTitle;
}

function drawH2(ctx, text, compact = false) {
  ensureSpace(ctx, SIZE.h2 + GAP.afterH2);
  ctx.page.drawText(text, {
    x: ctx.x,
    y: ctx.y,
    size: SIZE.h2,
    font: ctx.fonts.bold
  });
  ctx.y -= lineHeight(SIZE.h2, LEADING.h2) + (compact ? GAP.afterH2 : GAP.afterH2);
}

function drawH3(ctx, text) {
  ensureSpace(ctx, SIZE.h3 + GAP.afterH2);
  ctx.page.drawText(text, {
    x: ctx.x,
    y: ctx.y,
    size: SIZE.h3,
    font: ctx.fonts.bold
  });
  ctx.y -= lineHeight(SIZE.h3, LEADING.h3) + 4;
}

function drawParagraph(ctx, text) {
  drawWrapped(ctx, text, SIZE.p, ctx.fonts.regular);
  ctx.y -= GAP.afterParagraph;
}

function drawNumberList(ctx, items) {
  for (const it of items) {
    drawWrapped(ctx, it, SIZE.li, ctx.fonts.regular);
    ctx.y -= GAP.betweenItems;
  }
}

function drawExamples(ctx, examples) {
  for (const ex of examples) {
    // Spiegelstrich-Unterzeile
    const line = `– ${ex}`;
    drawWrapped(ctx, line, SIZE.sub, ctx.fonts.regular);
  }
  ctx.y -= GAP.betweenItems;
}

/* ------------------------------------------------------------
   Haupt-Handler
------------------------------------------------------------ */
export default async function handler(req, res) {
  // CORS (optional)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    // Eingabedaten
    const body = !isDemo
      ? (typeof req.body === "string" ? JSON.parse(req.body) : req.body || {})
      : {
          gpt: {
            title: "Deine persönliche Positionierung",
            sections: [
              { heading: "Dein Angebot", text: "Demo-Fließtext ..." },
              { heading: "Deine Zielgruppe", text: "Demo-Fließtext ..." },
              {
                heading: "Wichtige Trigger für deine Entscheider",
                text: "Typische Ängste:\n1. Sorge A\n2. Sorge B\n3. Sorge C\n4. Sorge D\n5. Sorge E\n\nTypische Ziele:\n1. Ziel A\n2. Ziel B\n3. Ziel C\n4. Ziel D\n5. Ziel E\n\nTypische Vorurteile:\n1. Vorurteil A\n2. Vorurteil B\n3. Vorurteil C\n4. Vorurteil D\n5. Vorurteil E"
              },
              {
                heading: "Vorteile deines Angebots",
                text: "Typische Ängste – Beispiele:\n1. Ungeplante Kosten\nBeispiel 1 zur Kostenkontrolle\nBeispiel 2 zur Kalkulation\n\nTypische Ziele – Beispiele:\n1. Schneller Abschluss\nBeispiel 1 zur Beschleunigung\nBeispiel 2 zu Prozessen"
              },
              { heading: "Dein Positionierungs-Vorschlag", text: "Demo Vorschlag ..." }
            ]
          }
        };

    const gpt = body?.gpt || {};
    const sections = Array.isArray(gpt.sections) ? gpt.sections : [];

    // PDF instanziieren
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);

    // Fonts laden (Poppins)
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regFont = regBytes
      ? await pdf.embedFont(regBytes)
      : await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes
      ? await pdf.embedFont(boldBytes)
      : await pdf.embedFont(StandardFonts.HelveticaBold);

    const ctx = {
      pdf,
      page: pdf.addPage([A4.w, A4.h]),
      x: MARGIN,
      y: A4.h - MARGIN,
      fonts: { regular: regFont, bold: boldFont }
    };

    // Titel
    const title = String(gpt.title || "Ergebnis");
    drawH1(ctx, title);

    // Abschnitte rendern
    for (const sec of sections) {
      const heading = String(sec.heading || "").trim();
      const text = String(sec.text || "").trim();

      // SHL (kompakt)
      drawH2(ctx, heading, true);

      if (/^wichtige trigger/i.test(heading)) {
        // „Wichtige Trigger …“ → Unter-SHL + nummerierte Listen
        const blocks = parseTriggerText(text);
        for (const b of blocks) {
          drawH3(ctx, b.subHeading);
          drawNumberList(ctx, b.items);
        }
        ctx.y -= 2; // leichter extra Puffer
      } else if (/^vorteile deines angebots/i.test(heading)) {
        // „Vorteile …“ → Unter-SHL, 1. Hauptpunkt + Spiegelstrich-Beispiele
        const blocks = parseVorteileText(text);
        for (const b of blocks) {
          drawH3(ctx, b.subHeading);
          for (const it of b.items) {
            // 1. Hauptpunkt (ohne Nummer)
            drawWrapped(ctx, `• ${it.title}`, SIZE.li, ctx.fonts.bold);
            if (it.examples && it.examples.length) {
              drawExamples(ctx, it.examples);
            } else {
              ctx.y -= GAP.betweenItems;
            }
          }
        }
      } else {
        // normaler Fließtext
        drawParagraph(ctx, text);
      }
    }

    // PDF speichern & in Blob schreiben
    const pdfBytes = await pdf.save();
    const filename = `reports/${Date.now()}-${encodeURIComponent(title)}.pdf`;
    const { url } = await put(filename, Buffer.from(pdfBytes), {
      access: "public",
      contentType: "application/pdf"
    });

    // Rückgabe
    const as = req.query?.as || req.query?.getAs || "json";
    if (as === "url") {
      return res.status(200).send(url);
    }
    res.status(200).json({ url });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err)
    });
  }
}

