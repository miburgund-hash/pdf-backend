// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";
import { buffer } from "node:stream/consumers";

// --------------------------------------------------
// Pfade & Konstanten
// --------------------------------------------------
const STATIC_DIR = path.join(process.cwd(), "static");

// Layout
const PAGE = { w: 595, h: 842 }; // A4
const MARGIN = 56;
const MAX_W = PAGE.w - MARGIN * 2;

const SIZES = {
  title: 28,
  shl: 18,          // Sub-Headline (Abschnittstitel)
  label: 14,        // "Typische Ängste" etc.
  text: 12,
  list: 12,
  bullet: 12,
};

const GAPS = {
  title_to_shl: 12,            // HL -> SHL1 (du wolltest 0.5x, ist hier klein gehalten)
  shl_to_paragraph: 6,         // SHL -> Body
  paragraph_to_next_shl: 24,   // Body -> nächste SHL (3x so groß)
  label_after_section: 12,     // kleine Labels im Abschnitt
  list_item: 3,                // Zeilenabstand in Listen
  list_block_after_label: 8,   // kleiner Abstand Label -> Liste
  between_number_and_bullets: 2,
  after_number_block: 8,       // nach den Bullets extra Luft
};

// --------------------------------------------------
// Helfer: Text messen / umbrechen / zeichnen
// --------------------------------------------------
function wrapLines(text, font, size, maxWidth) {
  const words = String(text ?? "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const t = line ? line + " " + w : w;
    const width = font.widthOfTextAtSize(t, size);
    if (width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = t;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrapped(page, font, size, x, y, text, maxWidth, color = rgb(0,0,0)) {
  const lines = wrapLines(text, font, size, maxWidth);
  let cursor = y;
  for (const ln of lines) {
    page.drawText(ln, { x, y: cursor, size, font, color });
    cursor -= size + 2;
  }
  return cursor;
}

function newPageIfNeeded(pdf, page, y) {
  if (y < MARGIN + 40) {
    page = pdf.addPage([PAGE.w, PAGE.h]);
    return { page, y: PAGE.h - MARGIN };
  }
  return { page, y };
}

// --------------------------------------------------
// Parser-Helfer
// --------------------------------------------------
function getSection(gpt, heading) {
  if (!gpt?.sections) return null;
  const hit = gpt.sections.find(s => String(s.heading || "").toLowerCase().trim() === heading.toLowerCase());
  return hit?.text ?? null;
}

// TRIGGER: Drei nummerierte Blöcke unter „Typische Ängste / Ziele / Vorurteile“
function parseTriggerText(text) {
  const blocks = splitByLabels(text, ["Typische Ängste", "Typische Ziele", "Typische Vorurteile"]);
  const parseNum = (t) => parseNumberedItems(t);

  return {
    aengste: parseNum(blocks["Typische Ängste"] || ""),
    ziele: parseNum(blocks["Typische Ziele"] || ""),
    vorbehalte: parseNum(blocks["Typische Vorurteile"] || ""),
  };
}

// Vorteile: „1. Titel“ + darunter Bullet-Zeilen „- …“ oder „• …“ bis nächster Punkt
function parseAdvantages(text) {
  const blocks = splitByLabels(text, ["Typische Ängste", "Typische Ziele", "Typische Vorurteile"]);

  const parseGroup = (t) => {
    const lines = String(t || "").split(/\r?\n/);
    const items = [];
    let current = null;

    for (let raw of lines) {
      const line = raw.trim();
      if (!line) continue;

      const mNum = line.match(/^(\d+)\.\s+(.*)$/); // 1. Titel
      const mBul = line.match(/^[-–•]\s*(.*)$/);  // - oder – oder •

      if (mNum) {
        if (current) items.push(current);
        current = { title: mNum[2].trim(), bullets: [] };
        continue;
      }
      if (mBul && current) {
        current.bullets.push(mBul[1].trim());
        continue;
      }
      // Fallback: gehört zur aktuellen Bullet-Zeile -> anhängen
      if (current && current.bullets.length > 0) {
        current.bullets[current.bullets.length - 1] += " " + line;
      }
    }
    if (current) items.push(current);
    return items;
  };

  return {
    aengste: parseGroup(blocks["Typische Ängste"] || ""),
    ziele: parseGroup(blocks["Typische Ziele"] || ""),
    vorbehalte: parseGroup(blocks["Typische Vorurteile"] || ""),
  };
}

function splitByLabels(text, labels) {
  const out = {};
  let current = null;
  const lines = String(text || "").split(/\r?\n/);

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const label = labels.find(l => line.toLowerCase().startsWith(l.toLowerCase()));
    if (label) {
      current = label;
      out[current] = [];
      continue;
    }
    if (current) out[current].push(raw);
  }

  // join
  Object.keys(out).forEach(k => out[k] = out[k].join("\n"));
  return out;
}

function parseNumberedItems(text) {
  const lines = String(text || "").split(/\r?\n/);
  const items = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\.\s+(.*)$/);
    if (m) items.push(m[2].trim());
  }
  return items;
}

// --------------------------------------------------
// Zeichnen: Titel / SHL / Label / Listen
// --------------------------------------------------
function drawTitle(page, fonts, y, text) {
  page.drawText(text, { x: MARGIN, y, size: SIZES.title, font: fonts.bold });
  return y - (SIZES.title + GAPS.title_to_shl);
}

function drawSHL(page, fonts, y, text) {
  page.drawText(text, { x: MARGIN, y, size: SIZES.shl, font: fonts.bold });
  return y - (SIZES.shl + GAPS.shl_to_paragraph);
}

function drawLabel(page, fonts, y, text) {
  page.drawText(text, { x: MARGIN, y, size: SIZES.label, font: fonts.bold });
  return y - (SIZES.label + GAPS.list_block_after_label);
}

function drawNumberList(page, fonts, y, items) {
  let cursor = y;
  for (let i = 0; i < items.length; i++) {
    const line = `${i + 1}. ${items[i]}`;
    cursor = drawWrapped(page, fonts.reg, SIZES.list, MARGIN, cursor, line, MAX_W);
    cursor -= GAPS.list_item;
    ({ page, y: cursor } = newPageIfNeeded(page.doc, page, cursor));
  }
  return cursor;
}

function drawNumberWithBullets(page, fonts, y, groups) {
  // groups: [{ title, bullets: [..] }, ...]
  let cursor = y;
  for (let i = 0; i < groups.length; i++) {
    const item = groups[i];

    // 1. Titelzeile (fett)
    const line = `${i + 1}. ${item.title}`;
    cursor = drawWrapped(page, fonts.bold, SIZES.list, MARGIN, cursor, line, MAX_W);

    // Bullets nicht fett
    for (const b of item.bullets || []) {
      cursor -= GAPS.between_number_and_bullets;
      const bulletLine = `- ${b}`;
      cursor = drawWrapped(page, fonts.reg, SIZES.bullet, MARGIN + 16, cursor, bulletLine, MAX_W - 16);
      ({ page, y: cursor } = newPageIfNeeded(page.doc, page, cursor));
    }

    // Extra-Luft nach jedem „Punkt + Bullets“
    cursor -= GAPS.after_number_block;
    ({ page, y: cursor } = newPageIfNeeded(page.doc, page, cursor));
  }
  return cursor;
}

// --------------------------------------------------
// Haupt-Handler
// --------------------------------------------------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const isDemo = req.method === "GET";
  if (req.method !== "POST" && !isDemo) return res.status(405).send("Method Not Allowed");

  try {
    // ---------------- Body + Beispiel ----------------
    const body = !isDemo ? (req.body || {}) : {
      gpt: {
        title: "Deine persönliche Positionierung",
        sections: [
          { heading: "Dein Angebot", text: "Demo-Text für Angebot." },
          { heading: "Deine Zielgruppe", text: "Demo-Text für Zielgruppe." },
          {
            heading: "Wichtige Trigger für deine Entscheider",
            text:
`Typische Ängste:
1. Beispiel Angst A
2. Beispiel Angst B
3. Beispiel Angst C
4. Beispiel Angst D
5. Beispiel Angst E

Typische Ziele:
1. Ziel 1
2. Ziel 2
3. Ziel 3
4. Ziel 4
5. Ziel 5

Typische Vorurteile:
1. V1
2. V2
3. V3
4. V4
5. V5`
          },
          {
            heading: "Vorteile deines Angebots",
            text:
`Typische Ängste
1. Cyberangriff
- Penetrationstests & Updates — 0 Ausfälle im letzten Jahr
- „Ihre Klinik läuft auch im Ernstfall stabil – Notaufnahme bleibt offen.“

2. Patientendaten
- DSGVO- & KHZG-konforme Lösung, revisionssicher dokumentiert
- „Ihre Patientendaten sind so geschützt wie in einem Hochsicherheitsbereich.“

Typische Ziele
1. Mehr Zeit
- 30 % weniger Dokumentationsaufwand pro Patient
- Mehr Zeit für Patientenkontakt

Typische Vorurteile
1. Einführung dauert ewig
- Start in 2 Wochen möglich
- Schrittweise Einführung ohne Stillstand`
          },
          { heading: "Dein Positionierungs-Vorschlag", text: "Kurz, stark, klar." }
        ]
      }
    };

    const gpt = body.gpt || {};
    const title = String(gpt.title || "Ergebnis");

    // ---------------- PDF vorbereiten ----------------
    const pdf = await PDFDocument.create();
    pdf.registerFontkit(fontkit);

    // Fonts
    let regBytes = null, boldBytes = null;
    try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
    try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

    const regFont = regBytes ? await pdf.embedFont(regBytes) : await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = boldBytes ? await pdf.embedFont(boldBytes) : await pdf.embedFont(StandardFonts.HelveticaBold);
    const fonts = { reg: regFont, bold: boldFont };

    let page = pdf.addPage([PAGE.w, PAGE.h]);
    // kleine Hilfe, damit draw-Funktionen newPageIfNeeded nutzen können
    page.doc = pdf;

    let y = PAGE.h - MARGIN;

    // ---------------- Seite 1: Deckblatt (statisch) ----------------
    // wird später per Merge vorangestellt!

    // ---------------- Seite 2/3: Inhalte ----------------
    // Titel
    y = drawTitle(page, fonts, y, title);

    // „Dein Angebot“
    const txtAngebot = getSection(gpt, "Dein Angebot") || "";
    y = drawSHL(page, fonts, y, "Dein Angebot");
    y = drawWrapped(page, fonts.reg, SIZES.text, MARGIN, y, txtAngebot, MAX_W);
    y -= GAPS.paragraph_to_next_shl;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    // „Deine Zielgruppe“
    const txtZielgruppe = getSection(gpt, "Deine Zielgruppe") || "";
    y = drawSHL(page, fonts, y, "Deine Zielgruppe");
    y = drawWrapped(page, fonts.reg, SIZES.text, MARGIN, y, txtZielgruppe, MAX_W);
    y -= GAPS.paragraph_to_next_shl;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    // „Wichtige Trigger …“
    const txtTrigger = getSection(gpt, "Wichtige Trigger für deine Entscheider") || "";
    const trigger = parseTriggerText(txtTrigger);

    y = drawSHL(page, fonts, y, "Wichtige Trigger für deine Entscheider");
    y = drawLabel(page, fonts, y, "Typische Ängste");
    y = drawNumberList(page, fonts, y, trigger.aengste);
    y -= 8;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    y = drawLabel(page, fonts, y, "Typische Ziele");
    y = drawNumberList(page, fonts, y, trigger.ziele);
    y -= 8;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    y = drawLabel(page, fonts, y, "Typische Vorurteile");
    y = drawNumberList(page, fonts, y, trigger.vorbehalte);
    y -= GAPS.paragraph_to_next_shl;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    // „Vorteile deines Angebots“
    const txtVorteile = getSection(gpt, "Vorteile deines Angebots") || "";
    const adv = parseAdvantages(txtVorteile);

    y = drawSHL(page, fonts, y, "Vorteile deines Angebots");

    if (adv.aengste?.length) {
      y = drawLabel(page, fonts, y, "Typische Ängste");
      y = drawNumberWithBullets(page, fonts, y, adv.aengste);
      ({ page, y } = newPageIfNeeded(pdf, page, y));
    }

    if (adv.ziele?.length) {
      y = drawLabel(page, fonts, y, "Typische Ziele");
      y = drawNumberWithBullets(page, fonts, y, adv.ziele);
      ({ page, y } = newPageIfNeeded(pdf, page, y));
    }

    if (adv.vorbehalte?.length) {
      y = drawLabel(page, fonts, y, "Typische Vorurteile");
      y = drawNumberWithBullets(page, fonts, y, adv.vorbehalte);
      ({ page, y } = newPageIfNeeded(pdf, page, y));
    }

    y -= GAPS.paragraph_to_next_shl;
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    // „Dein Positionierungs-Vorschlag“
    const txtVorschlag = getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag");
    // Fallback key:
    const prop = getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag") || getSection(gpt, "Dein Positionierungs-Vorschlag");
    const finalProp = prop || txtVorschlag || getSection(gpt, "Dein Positionierungs-Vorschlag") || "";

    y = drawSHL(page, fonts, y, "Dein Positionierungs-Vorschlag");
    y = drawWrapped(page, fonts.bold, SIZES.text, MARGIN, y, finalProp, MAX_W);
    ({ page, y } = newPageIfNeeded(pdf, page, y));

    // ---------------- Speichern + Mergen ----------------
    const contentBytes = await pdf.save();

    // Merge: deckblatt + content + angebote
    const merged = await PDFDocument.create();
    async function addBytes(bytes) {
      const src = await PDFDocument.load(bytes, { updateMetadata: false });
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }

    try {
      const deck = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
      await addBytes(deck);
    } catch {}

    await addBytes(contentBytes);

    try {
      const a1 = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
      await addBytes(a1);
    } catch {}
    try {
      const a2 = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));
      await addBytes(a2);
    } catch {}

    const finalBytes = await merged.save();

    // ---------------- Auslieferung ----------------
    const asUrl = String(req.query.as || "").toLowerCase() === "url";
    const debug = String(req.query.debug || "") === "1";

    if (debug) {
      // nur Echo zurück (zum schnellen Testen)
      return res.status(200).json({ ok: true, echo: body?.gpt?.sections?.length || 0 });
    }

    if (asUrl) {
      const filenameBase = (title || "Ergebnis").replace(/[^\p{L}\p{N}\s\-_\.]/gu, "").replace(/\s+/g, "-");
      const safeName = `reports/${Date.now()}-${filenameBase}.pdf`;
      const { url } = await put(safeName, await buffer(finalBytes), {
        access: "public",
        contentType: "application/pdf",
      });
      return res.status(200).json({ url });
    }

    // Direkt-Download
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${(title || "Ergebnis").replace(/"/g, '')}.pdf"`);
    res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "PDF-Erzeugung fehlgeschlagen", detail: String(err?.message || err) });
  }
}

