import fs from "fs";
import path from "path";
import PDFDocument from "pdfkit";

export default async function handler(req, res) {
  try {
    // Font-Pfade (immer relativ zu __dirname auf Vercel)
    const regularFont = path.join(process.cwd(), "static", "Poppins-Regular.ttf");
    const boldFont = path.join(process.cwd(), "static", "Poppins-SemiBold.ttf");

    // PDF-Dokument starten
    const doc = new PDFDocument();

    // Output in Buffer sammeln
    let buffers = [];
    doc.on("data", buffers.push.bind(buffers));
    doc.on("end", () => {
      let pdfData = Buffer.concat(buffers);
      res.writeHead(200, {
        "Content-Length": Buffer.byteLength(pdfData),
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=output.pdf",
      }).end(pdfData);
    });

    // Fonts registrieren
    doc.font(regularFont).fontSize(20).text("Hallo aus deiner PDF mit Poppins Regular!");
    doc.moveDown();
    doc.font(boldFont).fontSize(20).text("Und hier mit Poppins SemiBold 🚀");

    doc.end();

  } catch (err) {
    console.error("PDF-Fehler:", err);
    res.status(500).json({ error: "PDF konnte nicht erstellt werden." });
  }
}
