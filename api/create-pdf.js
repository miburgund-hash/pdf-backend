// /api/create-pdf.js
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import fs from "fs/promises";
import path from "path";
import { put } from "@vercel/blob";

// -------------------- Konfiguration / Layout --------------------
const STATIC_DIR = path.join(process.cwd(), "static");

const A4 = { w: 595, h: 842 };
const MARGIN = 56;

const SIZES = {
  title: 28,
  shl: 18,      // Abschnitts-Headline (z. B. "Dein Angebot")
  shl2: 14,     // Unter-Headline (z. B. "Typische Ängste")
  p: 12,        // Fließtext + Nummernzeilen
  bullet: 12,
};

const GAPS = {
  title_to_shl1: 16,              // Abstand Titel -> erste Subheadline
  after_shl: 8,                   // SHL -> Absatzbeginn
  line: 2,                        // Zeilenabstand Fließtext
  after_para_to_next_shl: 24,     // größerer Abstand Absatzende -> nächste SHL
  list: 4,
  listGroup: 8,
  benefitsBetweenHeadAndBullets: 6, // SHL2 -> erste Bullet
  benefitsBetweenBullets: 2,        // Bullet -> Bullet
  benefitsBetweenItems: 8,          // nach 2. Bullet -> nächster Punkt
};

const COLORS = { text: rgb(0, 0, 0) };

// -------------------- Helfer --------------------
function wrapLines(text, font, size, maxWidth) {
  const words = String(text ?? "").split(/\s+/);
  const lines = [];
  let line = "";
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawWrappedText(page, font, text, x, y, size, maxWidth) {
  let cursor = y;
  const lines = wrapLines(text, font, size, maxWidth);
  for (const ln of lines) {
    page.drawText(ln, { x, y: cursor, size, font, color: COLORS.text });
    cursor -= size + GAPS.line;
  }
  return cursor;
}

function ensureSpace(pdf, page, cursor, need, newPageTopY = A4.h - MARGIN) {
  if (cursor - need < MARGIN) {
    page = pdf.addPage([A4.w, A4.h]);
    return { page, cursor: newPageTopY };
  }
  return { page, cursor };
}

/** Normt "Vorurteile" → "Vorbehalte" in Headings */
function normalizeHeading(s) {
  return String(s || "")
    .replace(/vorurteile/gi, "Vorbehalte")
    .replace(/ Vorteil(e)?\s*deines\s*Angebots\s*–\s*Beispiele/gi, "Vorteile deines Angebots");
}

// -------------------- Trigger-Parser + Renderer --------------------
/** Extrahiert nummerierte Listen (1.–5.) robust aus Freitext */
function extractNumberedList(block) {
  const txt = String(block || "")
    .replace(/\r/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // Splitte an "1. ", "2. ", ... aber behalte den Text dahinter
  // Wir fügen manuell wieder die Nummer hinzu
  const parts = txt.split(/\s(?=\d+\.\s)/g).filter(Boolean);

  const items = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)\.\s*(.*)$/);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    const text = m[2].trim();
    if (n >= 1 && n <= 5 && text) items.push({ n, text });
  }
  // sortiert & max. 5
  return items
    .sort((a, b) => a.n - b.n)
    .slice(0, 5)
    .map((x) => `${x.n}. ${x.text}`);
}

function parseTriggerGroups(raw) {
  // Erwarte Marker "Typische Ängste:", "Typische Ziele:", "Typische Vorbehalte:"
  const s = String(raw || "").replace(/Vorurteile/gi, "Vorbehalte");
  const reA = /typische\s+ängste\s*:/i;
  const reZ = /typische\s+ziele\s*:/i;
  const reV = /typische\s+vorbehalte\s*:/i;

  const getBlock = (labelRe, fromText) => {
    const start = fromText.search(labelRe);
    if (start < 0) return { block: "", rest: fromText };
    const after = fromText.slice(start).replace(/^[^\n]*\n?/, ""); // Zeile mit Marker weg
    return { block: after, rest: fromText.slice(0, start) + fromText.slice(start + after.length) };
  };

  let rest = s;
  let aBlock = "", zBlock = "", vBlock = "";

  // Reihenfolge egal: wir suchen nacheinander
  if (reA.test(rest)) {
    const m = rest.match(reA);
    const idx = rest.search(reA);
    const cut = rest.slice(idx).replace(/^[^\n]*\n?/, "");
    aBlock = cut.split(reZ)[0]?.split(reV)[0] ?? "";
    rest = s; // nicht weiter verändert, nur Blöcke schneiden
  }
  if (reZ.test(rest)) {
    const idx = rest.search(reZ);
    const cut = rest.slice(idx).replace(/^[^\n]*\n?/, "");
    zBlock = cut.split(reA)[0]?.split(reV)[0] ?? "";
  }
  if (reV.test(rest)) {
    const idx = rest.search(reV);
    const cut = rest.slice(idx).replace(/^[^\n]*\n?/, "");
    vBlock = cut.split(reA)[0]?.split(reZ)[0] ?? "";
  }

  return {
    a: extractNumberedList(aBlock),
    z: extractNumberedList(zBlock),
    v: extractNumberedList(vBlock),
  };
}

function renderTriggerSection(pdf, page, fonts, x, y, maxW, section) {
  // Headline (SHL) ist bereits gerendert vorher – hier nur Inhalt
  const groups = parseTriggerGroups(section.text);

  const drawGroup = (title, lines) => {
    if (!lines.length) return y;
    ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl2 + 5 * (SIZES.p + GAPS.list) + 20));
    page.drawText(title, { x, y, size: SIZES.shl2, font: fonts.bold, color: COLORS.text });
    y -= SIZES.shl2 + GAPS.after_shl;
    for (const ln of lines) {
      y = drawWrappedText(page, fonts.regular, ln, x, y, SIZES.p, maxW);
      y -= GAPS.list;
    }
    y -= GAPS.after_para_to_next_shl;
    return y;
  };

  // Gruppen in der gewünschten Reihenfolge
  y = drawGroup("Typische Ängste", groups.a);
  y = drawGroup("Typische Ziele", groups.z);
  y = drawGroup("Typische Vorbehalte", groups.v);

  return { page, y };
}

// -------------------- Vorteile-Parser + Renderer --------------------
/** Parst Vorteil-Textblöcke (10 Zeilen → 5 Punkte mit je 2 Bullets) */
function parseBenefitsBlock(raw) {
  let clean = String(raw || "").trim();

  // „– Beispiele:“ am Anfang entfernen
  clean = clean.replace(/^[-–]\s*Beispiele\s*:?/i, "").trim();

  // Jede Zeile erwartet: "1. Titel – Bullettext"
  const lines = clean
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  const items = [];
  for (let i = 0; i < lines.length; i += 2) {
    const l1 = lines[i] || "";
    const l2 = lines[i + 1] || "";

    const [t1, b1] = l1.split(/\s+–\s+/, 2);
    const [t2, b2] = l2.split(/\s+–\s+/, 2);

    const title = (t1 || "").replace(/^\d+\.\s*/, "").trim();
    const bullets = [];
    if (b1) bullets.push(b1.trim());
    if (b2) bullets.push(b2.trim());

    const cleanTitle = title || (t2 || "").replace(/^\d+\.\s*/, "").trim();
    if (cleanTitle) items.push({ title: cleanTitle, bullets });
  }
  return items.slice(0, 5);
}

/** Render: **nicht fett** nummeriert + 2 Bullets */
function drawNumberedItemWithBullets(page, fonts, x, y, idx, title, bullets, maxWidth) {
  let cursor = y;

  // Nummer + Titel (nicht fett, Größe wie Fließtext)
  const label = `${idx}. ${title}`;
  page.drawText(label, { x, y: cursor, size: SIZES.p, font: fonts.regular, color: COLORS.text });
  cursor -= SIZES.p + GAPS.benefitsBetweenHeadAndBullets;

  // Bullets
  const bulletIndent = 16;
  for (const b of bullets.slice(0, 2)) {
    const bulletLine = `• ${b}`;
    cursor = drawWrappedText(page, fonts.regular, bulletLine, x + bulletIndent, cursor, SIZES.bullet, maxWidth - bulletIndent);
    cursor -= GAPS.benefitsBetweenBullets;
  }
  cursor -= GAPS.benefitsBetweenItems;
  return cursor;
}

// -------------------- Haupt-Renderer --------------------
async function renderContentPdf(payload) {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  // Fonts
  let regBytes = null, boldBytes = null;
  try { regBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-Regular.ttf")); } catch {}
  try { boldBytes = await fs.readFile(path.join(STATIC_DIR, "Poppins-SemiBold.ttf")); } catch {}

  const regFont = regBytes ? await pdf.embedFont(regBytes) : await pdf.embedFont(StandardFonts.Helvetica);
  const boldFont = boldBytes ? await pdf.embedFont(boldBytes) : await pdf.embedFont(StandardFonts.HelveticaBold);
  const fonts = { regular: regFont, bold: boldFont };

  const maxW = A4.w - MARGIN * 2;

  // Seite 1 starten
  let page = pdf.addPage([A4.w, A4.h]);
  let y = A4.h - MARGIN;

  const title = String(payload.title || "Deine persönliche Positionierung");
  page.drawText(title, { x: MARGIN, y, size: SIZES.title, font: fonts.bold, color: COLORS.text });
  y -= SIZES.title + GAPS.title_to_shl1;

  const sections = Array.isArray(payload.sections) ? payload.sections : [];

  // Vorteile- & Positionierungs-Abschnitt herauslösen (werden später platziert)
  const benefitsSection = sections.find(s => normalizeHeading(s.heading).toLowerCase() === "vorteile deines angebots");
  const positionSection = sections.find(s => normalizeHeading(s.heading).toLowerCase() === "dein positionierungs-vorschlag");
  const normalSections = sections.filter(s => {
    const h = normalizeHeading(s.heading).toLowerCase();
    return h !== "vorteile deines angebots" && h !== "dein positionierungs-vorschlag";
  });

  // --- Normale Abschnitte in Reihenfolge, mit Spezialfall „Wichtige Trigger …“ ---
  for (const s of normalSections) {
    const heading = normalizeHeading(s.heading);

    // Überschrift SHL
    ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl + GAPS.after_shl + 60));
    page.drawText(heading, { x: MARGIN, y, size: SIZES.shl, font: fonts.bold, color: COLORS.text });
    y -= SIZES.shl + GAPS.after_shl;

    // Spezial-Renderer für „Wichtige Trigger …“
    if (/wichtige\s+trigger/i.test(heading)) {
      const out = renderTriggerSection(pdf, page, fonts, MARGIN, y, maxW, s);
      page = out.page;
      y = out.y;
      continue;
    }

    // Standard-Fließtext
    const body = String(s.text || "").replace(/typische\s+vorurteile/gi, "Typische Vorbehalte");
    y = drawWrappedText(page, fonts.regular, body, MARGIN, y, SIZES.p, maxW);
    y -= GAPS.after_para_to_next_shl;
  }

  // --- Seite 2 oben: Vorteile deines Angebots ---
  if (benefitsSection) {
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;

    page.drawText("Vorteile deines Angebots", {
      x: MARGIN, y, size: SIZES.shl, font: fonts.bold, color: COLORS.text
    });
    y -= SIZES.shl + GAPS.after_shl;

    const raw = String(benefitsSection.text || "").replace(/Vorurteile/gi, "Vorbehalte");
    const reA = /typische\s+ängste\s*:?/i;
    const reZ = /typische\s+ziele\s*:?/i;
    const reV = /typische\s+vorbehalte\s*:?/i;

    const sliceAfterHeader = (re, txt) => {
      const i = txt.search(re);
      if (i < 0) return "";
      return txt.slice(i).replace(/^[^\n]*\n?/, "").trim();
    };

    let aContent = sliceAfterHeader(reA, raw).split(reZ)[0]?.split(reV)[0] || "";
    let zContent = sliceAfterHeader(reZ, raw).split(reA)[0]?.split(reV)[0] || "";
    let vContent = sliceAfterHeader(reV, raw).split(reA)[0]?.split(reZ)[0] || "";

    // Rest „– Beispiele:“ am Abschnittsanfang entfernen
    aContent = aContent.replace(/^[-–]\

