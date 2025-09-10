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
  shl: 18,          // Abschnitts-Headline (z. B. "Dein Angebot")
  shl2: 14,         // Unter-Headline (z. B. "Typische Ängste")
  p: 12,
  bullet: 12,
};

const GAPS = {
  title_to_shl1: 16,            // Abstand Titel -> erste Subheadline
  after_shl: 8,                 // SHL -> Absatzbeginn
  line: 2,                      // Zeilenabstand Fließtext
  after_para_to_next_shl: 24,   // **größerer** Abstand Absatzende -> nächste SHL
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

/** Parst Vorteil-Textblöcke (10 Zeilen → 5 Punkte mit je 2 Bullets) */
function parseBenefitsBlock(raw) {
  // Jede Zeile im Format: "1. Titel – Bullettext" bzw. "2. Titel – Bullettext" ...
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  // Gruppiere je 2 Zeilen → 1 Punkt mit 2 Bullets
  const items = [];
  for (let i = 0; i < lines.length; i += 2) {
    const l1 = lines[i] || "";
    const l2 = lines[i + 1] || "";
    // Titel extrahieren (Teil vor dem ersten " – "), Bullettexte nach dem " – "
    const [t1, b1] = l1.split(/\s+–\s+/, 2);
    const [t2, b2] = l2.split(/\s+–\s+/, 2);

    // Versuche, den Nummernpräfix "1. " etc. zu entfernen und den reinen Titel zu behalten
    const title = (t1 || "").replace(/^\d+\.\s*/, "").trim();
    const bullets = [];
    if (b1) bullets.push(b1.trim());
    if (b2) bullets.push(b2.trim());

    // Titel optional auch aus t2 abgleichen, falls t1 leer/unklar
    const cleanTitle = title || (t2 || "").replace(/^\d+\.\s*/, "").trim();

    if (cleanTitle) {
      items.push({ title: cleanTitle, bullets });
    }
  }

  // Max. 5 Punkte
  return items.slice(0, 5);
}

/** Render: nummerierter Punkt + 2 Bullets */
function drawNumberedItemWithBullets(page, fonts, x, y, idx, title, bullets, maxWidth) {
  let cursor = y;

  // Nummer + Titel (als SHL2)
  const label = `${idx}. ${title}`;
  page.drawText(label, { x, y: cursor, size: SIZES.shl2, font: fonts.bold, color: COLORS.text });
  cursor -= SIZES.shl2 + GAPS.benefitsBetweenHeadAndBullets;

  // 2 Bullets (nicht fett)
  const bulletIndent = 16;
  for (const b of bullets.slice(0, 2)) {
    const bulletLine = `• ${b}`;
    cursor = drawWrappedText(page, fonts.regular, bulletLine, x + bulletIndent, cursor, SIZES.bullet, maxWidth - bulletIndent);
    cursor -= GAPS.benefitsBetweenBullets;
  }

  // Extra Abstand zum nächsten Item
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

  // Durch Abschnitte iterieren
  const sections = Array.isArray(payload.sections) ? payload.sections : [];

  // Wir sammeln zunächst normalen Fließtext bis VORTEILE; VORTEILE kommt strikt auf Seite 2 oben.
  const benefitsSection = sections.find(s => normalizeHeading(s.heading).toLowerCase() === "vorteile deines angebots");
  const normalSections = sections.filter(s => normalizeHeading(s.heading).toLowerCase() !== "vorteile deines angebots");

  // --- Normale Abschnitte (Seite 1 usw.) ---
  for (const s of normalSections) {
    const heading = normalizeHeading(s.heading);
    // SHL
    ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl + GAPS.after_shl + 40));
    page.drawText(heading, { x: MARGIN, y, size: SIZES.shl, font: fonts.bold, color: COLORS.text });
    y -= SIZES.shl + GAPS.after_shl;

    // Body
    // „Vorurteile“ bereits als „Vorbehalte“ ersetzt
    const body = String(s.text || "").replace(/typische\s+vorurteile/gi, "Typische Vorbehalte");
    y = drawWrappedText(page, fonts.regular, body, MARGIN, y, SIZES.p, maxW);

    // Abstand zu nächster SHL vergrößert
    y -= GAPS.after_para_to_next_shl;
  }

  // --- Seite 2 oben: Vorteile deines Angebots ---
  if (benefitsSection) {
    // Neue Seite beginnen (Seite 2)
    page = pdf.addPage([A4.w, A4.h]);
    y = A4.h - MARGIN;

    // Haupt-Headline Seite 2
    page.drawText("Vorteile deines Angebots", {
      x: MARGIN, y, size: SIZES.shl, font: fonts.bold, color: COLORS.text
    });
    y -= SIZES.shl + GAPS.after_shl;

    // Unterblöcke "Typische Ängste", "Typische Ziele", "Typische Vorbehalte"
    // Wir splitten den Text in 3 logische Segmente anhand dieser Marker (unabhängig von Groß-/Kleinschreibung).
    const raw = String(benefitsSection.text || "").replace(/Vorurteile/gi, "Vorbehalte");
    const parts = {
      aengste: "",
      ziele: "",
      vorbehalte: "",
    };

    // Robust splitten
    // Erlaubt: "Typische Ängste", "Typische Ziele", "Typische Vorbehalte"
    const reA = /typische\s+ängste\s*:?/i;
    const reZ = /typische\s+ziele\s*:?/i;
    const reV = /typische\s+vorbehalte\s*:?/i;

    const startA = raw.search(reA);
    const startZ = raw.search(reZ);
    const startV = raw.search(reV);

    function segment(txt, start, nextStart) {
      if (start < 0) return "";
      const from = txt.slice(start).replace(/^[^\n]*\n?/, ""); // Zeile mit Marker weg
      return nextStart > start ? txt.slice(start, nextStart) : txt.slice(start);
    }

    // Schneide Bereiche
    const aBlock = startA >= 0 ? raw.slice(startA) : "";
    const zBlock = startZ >= 0 ? raw.slice(startZ) : "";
    const vBlock = startV >= 0 ? raw.slice(startV) : "";

    // Reine Inhalte (ohne Überschriftszeile) extrahieren
    const aContent = startA >= 0 ? raw.slice(startA).replace(reA, "").trim() : "";
    const zContent = startZ >= 0 ? raw.slice(startZ).replace(reZ, "").trim() : "";
    const vContent = startV >= 0 ? raw.slice(startV).replace(reV, "").trim() : "";

    // 1) Typische Ängste
    if (aContent) {
      // SHL2
      page.drawText("Typische Ängste", { x: MARGIN, y, size: SIZES.shl2, font: fonts.bold, color: COLORS.text });
      y -= SIZES.shl2 + GAPS.after_shl;

      const items = parseBenefitsBlock(aContent);
      for (let i = 0; i < items.length; i++) {
        ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl2 + 2 * (SIZES.bullet + GAPS.benefitsBetweenBullets) + 30));
        y = drawNumberedItemWithBullets(page, fonts, MARGIN, y, i + 1, items[i].title, items[i].bullets, maxW);
      }

      y -= GAPS.after_para_to_next_shl;
    }

    // 2) Typische Ziele
    if (zContent) {
      page.drawText("Typische Ziele", { x: MARGIN, y, size: SIZES.shl2, font: fonts.bold, color: COLORS.text });
      y -= SIZES.shl2 + GAPS.after_shl;

      const items = parseBenefitsBlock(zContent);
      for (let i = 0; i < items.length; i++) {
        ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl2 + 2 * (SIZES.bullet + GAPS.benefitsBetweenBullets) + 30));
        y = drawNumberedItemWithBullets(page, fonts, MARGIN, y, i + 1, items[i].title, items[i].bullets, maxW);
      }

      y -= GAPS.after_para_to_next_shl;
    }

    // 3) Typische Vorbehalte (statt Vorurteile)
    if (vContent) {
      page.drawText("Typische Vorbehalte", { x: MARGIN, y, size: SIZES.shl2, font: fonts.bold, color: COLORS.text });
      y -= SIZES.shl2 + GAPS.after_shl;

      const items = parseBenefitsBlock(vContent);
      for (let i = 0; i < items.length; i++) {
        ({ page, cursor: y } = ensureSpace(pdf, page, y, SIZES.shl2 + 2 * (SIZES.bullet + GAPS.benefitsBetweenBullets) + 30));
        y = drawNumberedItemWithBullets(page, fonts, MARGIN, y, i + 1, items[i].title, items[i].bullets, maxW);
      }

      y -= GAPS.after_para_to_next_shl;
    }
  }

  return pdf.save();
}

// -------------------- Merge mit statischen PDFs + Upload --------------------
async function buildFinalPdf(payload) {
  const contentBytes = await renderContentPdf(payload);

  // Deckblatt + Angebotsseiten
  const merged = await PDFDocument.create();

  // Helper: PDF aus Bytes anhängen
  async function addPdf(bytes) {
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await merged.copyPages(src, src.getPageIndices());
    pages.forEach(p => merged.addPage(p));
  }

  // Seite 1 (Deckblatt)
  const deck = await fs.readFile(path.join(STATIC_DIR, "deckblatt.pdf"));
  await addPdf(deck);

  // Inhalt (Seite 2/3 …)
  const contentDoc = await PDFDocument.load(contentBytes);
  const pages = await merged.copyPages(contentDoc, contentDoc.getPageIndices());
  pages.forEach(p => merged.addPage(p));

  // Angebotsseiten 4 & 5
  const an1 = await fs.readFile(path.join(STATIC_DIR, "angebot1.pdf"));
  const an2 = await fs.readFile(path.join(STATIC_DIR, "angebot2.pdf"));
  await addPdf(an1);
  await addPdf(an2);

  return merged.save();
}

// -------------------- API-Handler --------------------
export default async function handler(req, res) {
  // CORS
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();

  const as = String(req.query.as || "").toLowerCase(); // "url" → nur URL ausgeben

  try {
    const isDemo = req.method === "GET";
    const body = !isDemo
      ? (req.body || {})
      : {
          gpt: {
            title: "Deine persönliche Positionierung",
            sections: [
              { heading: "Dein Angebot", text: "Demo-Fließtext …" },
              { heading: "Deine Zielgruppe", text: "Demo-Fließtext …" },
              {
                heading: "Wichtige Trigger für deine Entscheider",
                text:
                  "Typische Ängste:\n" +
                  "1. Punkt A\n2. Punkt B\n3. Punkt C\n4. Punkt D\n5. Punkt E\n\n" +
                  "Typische Ziele:\n" +
                  "1. Ziel A\n2. Ziel B\n3. Ziel C\n4. Ziel D\n5. Ziel E\n\n" +
                  "Typische Vorbehalte:\n" + // schon normiert
                  "1. Vorbehalt A\n2. Vorbehalt B\n3. Vorbehalt C\n4. Vorbehalt D\n5. Vorbehalt E",
              },
              {
                heading: "Vorteile deines Angebots",
                text:
                  "Typische Ängste:\n" +
                  "1. Ein Cyberangriff legt das Krankenhaus lahm – 99,9% Netzverfügbarkeit durch Redundanz\n" +
                  "1. Ein Cyberangriff legt das Krankenhaus lahm – Netzwerk läuft stabil, selbst bei Störungen\n" +
                  "2. Patientendaten gelangen in falsche Hände – DSGVO-/KHZG-konforme Lösung, revisionssicher\n" +
                  "2. Patientendaten gelangen in falsche Hände – Zugriffskontrollen & Verschlüsselung\n" +
                  "3. Fördergelder werden nicht genutzt – Audit-Vorbereitung, Anforderungen geprüft\n" +
                  "3. Fördergelder werden nicht genutzt – Strukturierter Compliance-Check\n" +
                  "4. Projekte werden teurer – Fixpreis-Angebote ohne Nachschläge\n" +
                  "4. Projekte werden teurer – Klare Vertragsmodelle & Budgettransparenz\n" +
                  "5. IT-Umstellung blockiert Betrieb – Migration in 30 Tagen bei laufendem Betrieb\n" +
                  "5. IT-Umstellung blockiert Betrieb – Projektplanung bindet Klinikpersonal ein\n\n" +
                  "Typische Ziele:\n" +
                  "1. Mehr Zeit für Patienten – Dokumentation -30 % Schreibzeit\n" +
                  "1. Mehr Zeit für Patienten – Automatisierte Prozesse entlasten Teams\n" +
                  "2. Zukunftssichere IT – Cloud-Architektur, 3x schneller erweiterbar\n" +
                  "2. Zukunftssichere IT – Systeme wachsen mit (Upgradefähigkeit)\n" +
                  "3. Arbeitgebermarke stärken – Digitale Services eingeführt in 6 Wochen\n" +
                  "3. Arbeitgebermarke stärken – Klinik als moderner Arbeitgeber wahrgenommen\n" +
                  "4. Effizienzgewinne – Digitale Prozesse ohne Zusatzaufwand\n" +
                  "4. Effizienzgewinne – Transparente Abläufe statt Papier\n" +
                  "5. Amortisation & Planbarkeit – Klare Budgets, feste Laufzeiten\n" +
                  "5. Amortisation & Planbarkeit – Kosten klar planbar\n\n" +
                  "Typische Vorbehalte:\n" +
                  "1. Umsetzung dauert zu lange – Schrittweise Einführung, keine Downtime\n" +
                  "1. Umsetzung dauert zu lange – Go-Live in 6 Wochen (Praxisbeispiel)\n" +
                  "2. Anbieter versteht Klinik-Alltag nicht – Referenzen, echte Klinik-Projekte\n" +
                  "2. Anbieter versteht Klinik-Alltag nicht – Nachweisbare Ergebnisse schaffen Vertrauen\n" +
                  "3. Betrieb wird blockiert – Einführung im Hintergrund (kein Ausfall)\n" +
                  "3. Betrieb wird blockiert – Reaktionszeit & Support vertraglich fixiert\n" +
                  "4. Am Ende teurer als kalkuliert – Fixpreis ohne Nachschläge\n" +
                  "4. Am Ende teurer als kalkuliert – Transparente Leistungsumfänge\n" +
                  "5. Nur Standard-Projekt – Individuelle Anpassungen möglich\n" +
                  "5. Nur Standard-Projekt – Module passgenau auswählbar",
              },
              { heading: "Dein Positionierungs-Vorschlag", text: "Demo-Claim …" },
            ],
          },
        };

    const gpt = body.gpt || {};
    const finalBytes = await buildFinalPdf(gpt);

    // Upload (öffentliche URL zurückgeben)
    const filename =
      `reports/${Date.now()}-Deine-persönliche-Positionierung-${Math.random().toString(36).slice(2)}.pdf`;

    const { url } = await put(filename, Buffer.from(finalBytes), {
      access: "public",
      contentType: "application/pdf",
    });

    if (as === "url") {
      return res.status(200).json({ url });
    }

    // sonst: PDF direkt ausliefern
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="Ergebnis.pdf"');
    res.status(200).send(Buffer.from(finalBytes));
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "PDF-Erzeugung fehlgeschlagen",
      detail: String(err?.message || err),
    });
  }
}


