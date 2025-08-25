
// secure_slide_server.cjs
// Standalone microservice to serve secure PDF slide images
// Run with: node secure_slide_server.cjs

const express = require('express');
const { google } = require('googleapis');
const fs = require('fs');

const app = express();
const PORT = 3030;

// Lazy auth client
let authClient;
async function initAuth() {
  if (authClient) return authClient;
  authClient = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return authClient;
}

app.get('/secure-slide/health', async (req, res) => {
  const out = { ok: true, pdfjs: false, canvas: false, variant: null };
  try { await import('pdfjs-dist/legacy/build/pdf.js'); out.pdfjs = true; } catch {}
  try {
    let m = null;
    try { m = require('canvas'); out.variant = 'canvas'; } catch {}
    if (!m) {
      try { m = require('@napi-rs/canvas'); out.variant = '@napi-rs/canvas'; } catch {}
    }
    if (m) out.canvas = true;
  } catch {}
  res.json(out);
});

app.get('/secure-slide/:fileId/:page', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    const pageNum = Math.max(1, parseInt(req.params.page, 10) || 1);
    if (!fileId) return res.status(400).json({ error: 'File ID is required' });

    const auth = await initAuth();
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    const pdfBuffer = Buffer.from(response.data);

    let pdfjsLib;
    try { pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.js'); } catch {}
    let canvasMod = null;
    try { canvasMod = require('canvas'); } catch {}
    if (!canvasMod) {
      try { canvasMod = require('@napi-rs/canvas'); } catch {}
    }

    if (!pdfjsLib || !canvasMod) {
      console.warn('secure-slide: missing pdfjs or canvas, returning 204');
      return res.status(204).end();
    }
    const createCanvas = canvasMod.createCanvas || (canvasMod.default && canvasMod.default.createCanvas);
    if (!createCanvas) return res.status(204).end();

    const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer, disableWorker: true, isEvalSupported: false });
    const pdf = await loadingTask.promise;
    const pageIndex = Math.min(pageNum, pdf.numPages);
    const page = await pdf.getPage(pageIndex);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;

    const buf = canvas.toBuffer('image/png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
    res.end(buf);
  } catch (err) {
    console.error('secure-slide error:', err.message || err);
    res.status(204).end();
  }
});

app.listen(PORT, () => {
  console.log(`✔ Secure slide service listening on http://localhost:${PORT}`);
});
