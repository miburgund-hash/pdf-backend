import express from "express";
import { v4 as uuidv4 } from "uuid";
import { PDFDocument } from "pdf-lib";
import fs from "fs/promises";
import path from "path";
import puppeteer from "puppeteer";

const app = express();
app.use(express.json({ limit: "2mb" }));

// CORS: erlaube Aufrufe von deiner Domain
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://burgundmerz.de");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

const STATIC_DIR = path.join(process.cwd(), "static");
const OUT_DIR = path.join(process.cwd(), "out");
await fs.mkdir(OUT_DIR, { recursive: true });

app.get("/", (req, res) => {
  res.send("PDF-API läuft ✔");
});

function renderHtmlFromGpt(gpt) {
  const esc = (s = "") => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  const blocks = (gpt.sections || []).map(sec => {
    const h = sec.heading ? `<h2>${esc(sec.heading)}</h2>` : "";
    const p = sec.text ? `<p>${esc(sec.text)}</p>` : "";
    const bullets = Array.isArray(sec.bullets) && sec.bullets.length
      ? `<ul>${sec.bullets.map(b=>`<li>${esc(b)}</li>`).join("")}</ul>` : "";
    return `${h}${p}${bullets}`;
  }).join("");

  return `<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8" />
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&display=swap" rel="stylesheet">
  <style>
    @page { size: A4; margin: 20mm; }
    body { font-family: 'Poppins', sans-serif; line-height: 1.5; font-size: 11pt; color:#111; }
    h1 { font-size: 22pt; font-weight: 600; margin: 0 0 12pt; }
    h2 { font-size: 14pt; font-weight: 600; margin: 18pt 0 8pt; }
    p  { margin: 0 0 8pt; }
    ul { padding-left: 18pt; margin: 0 0 8pt; }
    li { margin: 4pt 0; }
    .footer { position: fixed; bottom: 10mm; left: 20mm; right: 20mm; font-size: 9pt; color:#666; text-align:right; }
    .wrap { max-width: 155mm; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${esc(gpt.title || "Ergebnis")}</h1>
    ${blocks}
  </div>
  <div class="footer">© ${new Date().getFullYear()} Burgund & Merz</div>
</body>
</html>`;
}

async function buildContentPdf(html, outPath) {
  const browser = await puppeteer.launch({ args: ["--no-sandbox","--disable-setuid-sandbox"] });
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle0" });
  await page.waitForTimeout(300);
  await page.pdf({
    path: outPath, format: "A4", printBackground: true,
    margin: { top: "20mm", right: "20mm", bottom: "20mm", left: "20mm" }
  });
  await browser.close();
}

async function mergePdfs(paths, outPath) {
  const mergedPdf = await PDFDocument.create();
  for (const p of paths) {
    const bytes = await fs.readFile(p);
    const pdf = await PDFDocument.load(bytes, { updateMetadata: false });
    const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
    copiedPages.forEach(pg => mergedPdf.addPage(pg));
  }
  const outBytes = await mergedPdf.save();
  await fs.writeFile(outPath, outBytes);
}

app.post("/create-pdf", async (req, res) => {
  try {
    const { gpt } = req.body;
    if (!gpt || !gpt.sections) return res.status(400).json({ error: "Ungültige Daten (gpt.sections fehlt)" });

    const id = uuidv4().replace(/-/g,"");
    const tmpContent = path.join(OUT_DIR, `${id}-content.pdf`);
    const finalOut   = path.join(OUT_DIR, `${id}.pdf`);

    const html = renderHtmlFromGpt(gpt);
    await buildContentPdf(html, tmpContent);

    const deckblatt = path.join(STATIC_DIR, "deckblatt.pdf");
    const angebot1  = path.join(STATIC_DIR, "angebot1.pdf");
    const angebot2  = path.join(STATIC_DIR, "angebot2.pdf");

    await mergePdfs([deckblatt, tmpContent, angebot1, angebot2], finalOut);

    const host = req.headers["x-forwarded-host"] || req.headers.host;
    const proto = req.headers["x-forwarded-proto"] || "https";
    const downloadUrl = `${proto}://${host}/dl/${id}.pdf`;
    res.json({ downloadUrl });

    fs.unlink(tmpContent).catch(()=>{});
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erstellung fehlgeschlagen" });
  }
});

app.get("/dl/:file", async (req, res) => {
  const filePath = path.join(OUT_DIR, req.params.file);
  try {
    await fs.access(filePath);
    res.download(filePath, "Ergebnis.pdf");
  } catch {
    res.status(404).send("Nicht gefunden");
  }
});

// *** WICHTIG: keinen app.listen()!
// Vercel erwartet eine Funktion. Wir "reichen" Express an Vercel weiter:
export default function handler(req, res) {
  return app(req, res);
}


