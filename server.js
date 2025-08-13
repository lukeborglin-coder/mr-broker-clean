// server.js — Pinecone v2 + Google Drive + exact-slide PNG previews + narrative answers + SSE ingest

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// ---------- Env + App ----------
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });
const PORT = process.env.PORT || 3000;

const AUTH_TOKEN = (process.env.AUTH_TOKEN || "").trim();
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

const PINECONE_INDEX = process.env.PINECONE_INDEX || "mr-index";
const PINECONE_CLOUD = process.env.PINECONE_CLOUD || "aws";
const PINECONE_REGION = process.env.PINECONE_REGION || "us-east-1";
const LIVE_DRIVE_FILTER = String(process.env.LIVE_DRIVE_FILTER || "true").toLowerCase() === "true";

// Embeddings (1536 dims)
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors());
app.use(express.static("public"));

// ---------- Google Drive ----------
function getCredsPath() {
  const p =
    (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim() ||
    (process.env.GOOGLE_CREDENTIALS_JSON || "").trim();
  return p;
}
const CREDS_PATH = getCredsPath();
if (!CREDS_PATH || !fs.existsSync(CREDS_PATH)) {
  console.warn("[warn] Google credentials file not found:", CREDS_PATH || "(empty)");
}
const gauth = new google.auth.GoogleAuth({
  keyFile: CREDS_PATH,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth: gauth });

// ---------- OpenAI + Pinecone ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

async function ensurePineconeIndex() {
  if (!PINECONE_API_KEY) throw new Error("PINECONE_API_KEY missing");
  const list = await pinecone.listIndexes();
  const exists = list.indexes?.some((i) => i.name === PINECONE_INDEX);
  if (exists) return;

  console.log(`[pinecone] creating index "${PINECONE_INDEX}" (dims=${EMBEDDING_DIMS}, region=${PINECONE_REGION})...`);
  await pinecone.createIndex({
    name: PINECONE_INDEX,
    dimension: EMBEDDING_DIMS,
    metric: "cosine",
    spec: { serverless: { cloud: PINECONE_CLOUD, region: PINECONE_REGION } },
  });
  for (let i = 0; i < 30; i++) {
    const d = await pinecone.describeIndex(PINECONE_INDEX).catch(() => null);
    if (d?.status?.ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
}
let index;

// ---------- Public debug ----------
app.get("/debug/pinecone", async (req, res) => {
  try {
    const desc = await pinecone.describeIndex(PINECONE_INDEX).catch(() => null);
    let stats = null;
    try {
      stats = await pinecone.index(PINECONE_INDEX).describeIndexStats();
    } catch (e) {
      stats = { error: e.message };
    }
    res.json({ ok: true, index: PINECONE_INDEX, desc, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get("/debug/drive-env", (req, res) => {
  res.json({
    DRIVE_ROOT_FOLDER_ID,
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS || null,
    GOOGLE_CREDENTIALS_JSON: process.env.GOOGLE_CREDENTIALS_JSON || null,
    credsFilePath: CREDS_PATH || null,
    credsFileExists: !!(CREDS_PATH && fs.existsSync(CREDS_PATH)),
  });
});

// ---------- Auth guard ----------
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if ((req.get("x-auth-token") || "").trim() !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      auth: Boolean(AUTH_TOKEN),
      driveRoot: Boolean(DRIVE_ROOT_FOLDER_ID),
      googleCreds: Boolean(CREDS_PATH),
      openai: Boolean(OPENAI_API_KEY),
      pinecone: Boolean(PINECONE_API_KEY),
      index: PINECONE_INDEX,
      cloud: PINECONE_CLOUD,
      region: PINECONE_REGION,
    },
  });
});

// ---------- Drive diagnostics ----------
app.get("/drive/debug", (req, res) => {
  res.json({
    driveRootId: DRIVE_ROOT_FOLDER_ID || null,
    credsPath: CREDS_PATH || null,
    credsExists: !!(CREDS_PATH && fs.existsSync(CREDS_PATH)),
    authTokenConfigured: Boolean(AUTH_TOKEN),
  });
});

app.get("/drive/files/flat", async (req, res) => {
  try {
    const folderId = DRIVE_ROOT_FOLDER_ID;
    if (!folderId) return res.status(400).json({ error: "DRIVE_ROOT_FOLDER_ID not set" });
    const files = [];
    const q = `'${folderId}' in parents and trashed = false`;
    let pageToken;
    do {
      const r = await drive.files.list({
        q,
        fields: "nextPageToken, files(id,name,mimeType,size,modifiedTime,webViewLink,iconLink)",
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        corpora: "allDrives",
        pageSize: 1000,
        pageToken,
      });
      (r.data.files || []).forEach((f) =>
        files.push({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : null,
          modifiedTime: f.modifiedTime,
          webViewLink: f.webViewLink,
          iconLink: f.iconLink,
        })
      );
      pageToken = r.data.nextPageToken || undefined;
    } while (pageToken);
    res.json({ folderId, count: files.length, files });
  } catch (e) {
    res.status(500).json({ error: "Failed to list Drive files", detail: e?.response?.data || e?.message });
  }
});

// ---------- Helpers ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return data[0].embedding;
}

// Conversational answer template
async function answerWithContext(question, contexts) {
  const contextText = contexts
    .map((m, i) => `# Source ${i + 1}
File: ${m?.metadata?.fileName || "Untitled"}  |  Page: ${m?.metadata?.page ?? "?"}
---
${m?.metadata?.text || ""}`)
    .join("\n\n");

  const prompt = `You are a pharma market-research analyst writing client-ready insights.
Answer the question USING ONLY the context. Be conversational and concise.

Write in this structure:
1) One-sentence headline answer (narrative), e.g., "Evrysdi's latest NPS is 43% (2024 SMA Evrysdi HCP Patient ATU W6 Report)."
2) Then bullets for trend and supporting insight, e.g.:
   - Prior NPS readings in order (with % and source file names)
   - Notable directional changes (e.g., "up from 20% to 43%")
   - Any relevant comparator

Rules:
- Do NOT invent numbers or sources—only use the context.
- If the latest value or sources aren’t present, say you don’t have enough information.
- Keep to 3–5 bullets maximum.

Question:
${question}

Context:
${contextText}`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });
  return r.choices?.[0]?.message?.content?.trim() || "";
}

// --- Drive helpers
async function downloadDriveFileMeta(fileId) {
  const { data } = await drive.files.get({
    fileId,
    fields: "id,name,mimeType,size",
    supportsAllDrives: true,
  });
  return data;
}
async function downloadDriveFileBuffer(fileId) {
  const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  if (!resp || !resp.data) throw new Error(`No data for fileId=${fileId}`);
  const buf = Buffer.from(resp.data);
  if (!buf.length) throw new Error(`Empty buffer for fileId=${fileId}`);
  return buf;
}
async function parsePdfPages(buffer) {
  if (!buffer?.length) throw new Error("parsePdfPages: missing buffer");
  let fn = null;
  try {
    const m = await import("pdf-parse/lib/pdf-parse.js");
    fn = m.default || m;
  } catch {}
  if (!fn) {
    const m2 = await import("pdf-parse");
    fn = m2.default || m2;
  }
  if (!fn) throw new Error("Unable to load pdf-parse");
  const parsed = await fn(buffer);
  const pages = (parsed.text || "").split("\f").map((p) => p.trim()).filter(Boolean);
  return pages;
}
function chunkText(str, chunkSize = 2000, overlap = 200) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    out.push(str.slice(i, i + chunkSize));
    i += Math.max(1, chunkSize - overlap);
  }
  return out;
}
async function upsertChunks({ clientId, fileId, fileName, chunks, page }) {
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const text = chunks[i];
    const values = await embedText(text);
    vectors.push({
      id: `${fileId}_${page ?? 0}_${i}_${Date.now()}`,
      values,
      metadata: { clientId, fileId, fileName, page, text },
    });
  }
  if (vectors.length) await index.namespace(clientId).upsert(vectors);
}
async function ingestSingleDrivePdf({ clientId, fileId, fileName, maxPages = Infinity }) {
  const buf = await downloadDriveFileBuffer(fileId);
  const pages = await parsePdfPages(buf);
  const limit = Math.min(pages.length, Number.isFinite(maxPages) ? maxPages : pages.length);
  for (let p = 0; p < limit; p++) {
    const pageText = pages[p];
    if (!pageText) continue;
    const chunks = chunkText(pageText, 2000, 200);
    await upsertChunks({ clientId, fileId, fileName, chunks, page: p + 1 });
  }
}

// ---------- Page PNG preview (exact slide) ----------
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";

const PREVIEW_DIR = "/tmp/previews";
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });

async function renderPdfPagePng(fileId, pageNumber) {
  const safeId = String(fileId).replace(/[^a-zA-Z0-9_-]/g, "");
  const pageNum = Math.max(1, Number(pageNumber) || 1);
  const pngPath = path.join(PREVIEW_DIR, `${safeId}_p${pageNum}.png`);
  if (fs.existsSync(pngPath)) return pngPath;

  const data = await downloadDriveFileBuffer(fileId);
  const pdf = await getDocument({ data, useWorker: false }).promise;
  const page = await pdf.getPage(pageNum);

  const scale = 1.5; // image quality
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx, viewport }).promise;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(pngPath);
    canvas.createPNGStream().pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });

  return pngPath;
}

app.get("/preview/page.png", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "");
    const page = Number(req.query.page || 1);
    if (!fileId) return res.status(400).send("fileId required");
    const pngPath = await renderPdfPagePng(fileId, page);
    res.type("image/png");
    fs.createReadStream(pngPath).pipe(res);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Live Drive allowlist for search ----------
let _driveCache = { ids: new Set(), ts: 0 };
async function listDriveFileIds() {
  const now = Date.now();
  if (now - _driveCache.ts < 60_000 && _driveCache.ids.size > 0) return _driveCache.ids;
  const ids = new Set();
  if (!DRIVE_ROOT_FOLDER_ID) return ids;
  const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
  let pageToken = null;
  do {
    const r = await drive.files.list({
      q,
      fields: "files(id,name,mimeType),nextPageToken",
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });
    (r.data.files || []).forEach((f) => {
      const mt = (f.mimeType || "").toLowerCase();
      if (mt.includes("pdf")) ids.add(f.id);
    });
    pageToken = r.data.nextPageToken || null;
  } while (pageToken);
  _driveCache = { ids, ts: now };
  return ids;
}

// ---------- SEARCH (returns page images + deduped refs + narrative) ----------
app.post("/search", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId = "demo", userQuery, topK = 6 } = req.body || {};
    if (!userQuery) return res.status(400).json({ error: "userQuery required" });

    const vector = await embedText(userQuery);

    let pineconeFilter = undefined;
    if (LIVE_DRIVE_FILTER) {
      const liveIds = await listDriveFileIds();
      pineconeFilter = liveIds.size ? { fileId: { $in: [...liveIds] } } : { fileId: { $in: ["__none__"] } };
    }

    const q = await index.namespace(clientId).query({
      vector,
      topK: Number(topK) || 6,
      includeMetadata: true,
      filter: pineconeFilter,
    });

    const matches = q.matches || [];
    const answer = await answerWithContext(userQuery, matches);

    // Dedup references by fileId; strip ".pdf" from names
    const seenRef = new Set();
    const references = [];
    for (const m of matches) {
      const fid = m.metadata?.fileId;
      if (!fid || seenRef.has(fid)) continue;
      seenRef.add(fid);
      const cleanName = (m.metadata?.fileName || "Untitled").replace(/\.pdf$/i, "");
      references.push({
        fileId: fid,
        fileName: cleanName,
        page: m.metadata?.page ?? m.metadata?.slide,
      });
    }

    // Visuals: concrete page PNGs (limit 4)
    const seenVis = new Set();
    const visuals = [];
    for (const m of matches) {
      const fid = m.metadata?.fileId;
      const page = m.metadata?.page ?? m.metadata?.slide;
      if (!fid || !page) continue;
      const key = `${fid}:${page}`;
      if (seenVis.has(key)) continue;
      seenVis.add(key);
      const imageUrl = `/preview/page.png?fileId=${encodeURIComponent(fid)}&page=${encodeURIComponent(page)}`;
      const cleanName = (m.metadata?.fileName || "Untitled").replace(/\.pdf$/i, "");
      visuals.push({ fileId: fid, fileName: cleanName, page, imageUrl });
      if (visuals.length >= 4) break;
    }

    res.json({ answer, references, visuals });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin: purge namespace ----------
app.post("/admin/rebuild-from-drive", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });
    await index.namespace(clientId).deleteAll();
    res.json({ ok: true, message: "Namespace purged. Re-ingest to rebuild." });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin: list PDFs ----------
app.post("/admin/ingest-list", async (req, res) => {
  try {
    const files = [];
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
    let pageToken = null;
    do {
      const r = await drive.files.list({
        q,
        fields: "files(id,name,mimeType,size),nextPageToken",
        pageSize: 1000,
        includeItemsFromAllDrives: true,
        supportsAllDrives: true,
        pageToken,
      });
      (r.data.files || []).forEach((f) => {
        const mt = (f.mimeType || "").toLowerCase();
        if (mt.includes("pdf")) files.push({ id: f.id, name: f.name, size: f.size ? Number(f.size) : null });
      });
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);
    res.json({ ok: true, count: files.length, files });
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ---------- Admin: ingest ONE PDF ----------
app.post("/admin/ingest-one", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId = "demo", fileId, maxPages } = req.body || {};
    if (!fileId) return res.status(400).json({ error: "fileId required" });
    const meta = await downloadDriveFileMeta(fileId);
    await ingestSingleDrivePdf({
      clientId,
      fileId,
      fileName: meta.name || "Untitled",
      maxPages: Number(maxPages) || Infinity,
    });
    res.json({ ok: true, clientId, fileId, fileName: meta.name || "Untitled" });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin: ingest ALL PDFs with live progress (SSE) ----------
app.post("/admin/ingest-drive", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const write = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {} };

  try {
    if (!index) { write({ level: "error", msg: "Pinecone index not ready yet" }); res.end(); return; }

    write({ level: "info", msg: "Listing PDFs in Drive folder…" });
    const files = [];
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
    let pageToken = null;
    do {
      const r = await drive.files.list({
        q,
        fields: "files(id,name,mimeType,size),nextPageToken",
        pageSize: 1000, includeItemsFromAllDrives: true, supportsAllDrives: true, pageToken,
      });
      (r.data.files || []).forEach((f) => {
        const mt = (f.mimeType || "").toLowerCase();
        if (mt.includes("pdf")) files.push({ id: f.id, name: f.name, size: f.size ? Number(f.size) : null });
      });
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    if (!files.length) { write({ level: "warn", msg: "No PDFs found." }); res.end(); return; }

    write({ level: "info", msg: `Found ${files.length} PDF(s). Starting ingest…` });
    let done = 0;
    const clientId = req.body?.clientId || "demo";
    for (const f of files) {
      try {
        write({ level: "info", fileId: f.id, fileName: f.name, msg: "Downloading…" });
        const meta = await downloadDriveFileMeta(f.id);
        write({ level: "info", fileId: f.id, fileName: f.name, size: meta.size ? Number(meta.size) : null, msg: "Parsing + embedding…" });
        await ingestSingleDrivePdf({ clientId, fileId: f.id, fileName: f.name });
        done++;
        write({ level: "success", fileId: f.id, fileName: f.name, done, total: files.length, msg: "Ingested" });
      } catch (e) {
        write({ level: "error", fileId: f.id, fileName: f.name, msg: e?.message || String(e) });
      }
    }
    write({ level: "info", msg: "All files processed." });
  } catch (e) {
    write({ level: "error", msg: e?.message || String(e) });
  } finally {
    setTimeout(() => { try { res.end(); } catch {} }, 250);
  }
});

// ---------- Boot ----------
(async () => {
  try {
    await ensurePineconeIndex();
    index = pinecone.index(PINECONE_INDEX);
    console.log(`[pinecone] using index "${PINECONE_INDEX}"`);
  } catch (e) {
    console.error("[pinecone] failed to ensure index:", e);
  }
  app.listen(PORT, () => console.log(`mr-broker running on :${PORT}`));
})();
