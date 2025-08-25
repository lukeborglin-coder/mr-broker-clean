
/**
 * Secure Slide Microservice (CommonJS)
 * Serves a single PNG image for a requested PDF page from Google Drive.
 * Auth via ADC (GOOGLE_APPLICATION_CREDENTIALS) or your default credentials.
 */
const express = require('express');
const cors = require('cors');
const { google } = require('googleapis');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

// Disable worker in Node
// (no require.resolve needed)
const app = express();
app.use(cors({
  origin: [/^http:\/\/localhost:\d+$/],
  credentials: false
}));

async function getAuthClient() {
  const auth = await google.auth.getClient({
    scopes: ['https://www.googleapis.com/auth/drive.readonly']
  });
  return auth;
}

app.get('/secure-slide/:fileId/:page', async (req, res) => {
  try {
    const rawFileId = req.params.fileId || '';
    const fileId = decodeURIComponent(rawFileId);
    const pageNumber = Math.max(1, parseInt(req.params.page, 10) || 1);

    const auth = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });

    // Download PDF bytes
    const arrayBuffer = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    ).then(r => r.data);
    const pdfBuffer = Buffer.from(arrayBuffer);

    const loadingTask = pdfjsLib.getDocument({
      data: pdfBuffer,
      disableWorker: true,
      isEvalSupported: false
    });
    const pdf = await loadingTask.promise;
    const pageIndex = Math.min(pageNumber, pdf.numPages);
    const page = await pdf.getPage(pageIndex);

    const scale = 1.5; // adjust for quality/perf
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const buf = canvas.toBuffer('image/png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
    res.end(buf);
  } catch (err) {
    console.error('secure-slide error:', err && err.message ? err.message : err);
    res.status(204).end();
  }
});

const PORT = process.env.PORT || 3030;
app.listen(PORT, () => {
  console.log(`Secure slide service listening on http://localhost:${PORT}`);
});
