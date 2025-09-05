// /api/index.js  — Minimaltest
export default function handler(req, res) {
  if (req.method === 'GET') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send('PDF-API läuft ✔');
  } else if (req.method === 'OPTIONS') {
    res.status(200).end();
  } else {
    res.status(405).send('Method Not Allowed');
  }
}
