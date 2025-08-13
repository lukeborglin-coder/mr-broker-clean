// server.js — multi‑report synthesis + recency priority + exact-slide PNGs (static) + superscript refs

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

// ---------- Name/Date helpers ----------
function cleanReportName(name) {
  if (!name) return "Untitled";
  let n = String(name).replace(/\.pdf$/i, "");
  n = n.replace(/([_\-]\d{6,8})$/i, "");     // _111324, -20250115
  n = n.replace(/([_\-]Q[1-4]\d{4})$/i, ""); // _Q42024
  n = n.replace(/([_\-][WV]\d{1,2})$/i, ""); // _W6
  n = n.replace(/([_\-]v\d+)$/i, "");        // _v2
  return n.trim();
}

// Try to extract a date from filename; fallback to Drive modifiedTime later
function dateFromName(name) {
  const s = String(name || "");
  // Patterns: 2025-06, 202506, 2025, Q42024, 092723
  let m;
  m = s.match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])/); // YYYYMM or YYYY-MM
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, 1).getTime();
  m = s.match(/(20\d{2})/); // YYYY
  if (m) return new Date(Number(m[1]), 0, 1).getTime();
  m = s.match(/Q([1-4])\s?20(\d{2})/i); // Q42024
  if (m) return new Date(2000 + Number(m[2]), (Number(m[1]) - 1) * 3, 1).getTime();
  m = s.match(/(0[1-9]|1[0-2])([0-3]\d)(2\d)/); // e.g., 092723 => 2023-09-27
  if (m) return new Date(2000 + Number(m[3]), Number(m[1]) - 1, Number(m[2])).getTime();
  return 0;
}

// ---------- Page PNG preview (public) ----------
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";

const PREVIEW_DIR = "/tmp/previews";
if (!fs.existsSync(PREVIEW_DIR)) fs.mkdirSync(PREVIEW_DIR, { recursive: true });

async function downloadDriveFileBuffer(fileId) {
  const resp = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  if (!resp || !resp.data) throw new Error(`No data for fileId=${fileId}`);
  const buf = Buffer.from(resp.data);
  if (!buf.length) throw new Error(`Empty buffer for fileId=${fileId}`);
  return buf;
}

async function renderPdfPagePng(fileId, pageNumber) {
  const safeId = String(fileId).replace(/[^a-zA-Z0-9_-]/g, "");
  const pageNum = Math.max(1, Number(pageNumber) || 1);
  const pngPath = path.join(PREVIEW_DIR, `${safeId}_p${pageNum}.png`);
  if (fs.existsSync(pngPath)) return pngPath;

  const data = await downloadDriveFileBuffer(fileId);
  const pdf = await getDocument({ data, useWorker: false }).promise;
  const page = await pdf.getPage(pageNum);

  const scale = 1.5;
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

// ---------- Auth guard for API routes ----------
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if ((req.get("x-auth-token") || "").trim() !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// ---------- Helpers: embed/chunk/ingest ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return data[0].embedding;
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

// ---------- Diverse-context answering with recency priority + numeric tags ----------
async function buildDiverseSources(matches, maxSources = 8) {
  // Best hit per file
  const byFile = new Map();
  for (const m of matches) {
    const fid = m.metadata?.fileId;
    if (!fid) continue;
    if (!byFile.has(fid)) byFile.set(fid, m);
  }
  let diverse = [...byFile.values()];

  // Attach Drive modifiedTime + filename date; sort newest first
  const metas = await Promise.all(
    diverse.map(async (m) => {
      const fid = m.metadata.fileId;
      try {
        const info = await drive.files.get({
          fileId: fid,
          fields: "id,name,modifiedTime",
          supportsAllDrives: true
        }).then(r => r.data);
        const tName = dateFromName(info.name || m.metadata.fileName || "");
        const tMod = info.modifiedTime ? new Date(info.modifiedTime).getTime() : 0;
        const scoreTs = Math.max(tName, tMod);
        return { match: m, sortTs: scoreTs, name: info.name || m.metadata.fileName || "" };
      } catch {
        const tName = dateFromName(m.metadata.fileName || "");
        return { match: m, sortTs: tName, name: m.metadata.fileName || "" };
      }
    })
  );

  metas.sort((a, b) => (b.sortTs || 0) - (a.sortTs || 0));
  diverse = metas.map(x => {
    const m = x.match;
    return {
      ref: 0, // assign after slice
      fileId: m.metadata.fileId,
      fileName: cleanReportName(x.name || m.metadata.fileName || "Untitled"),
      page: m.metadata.page ?? m.metadata.slide ?? 1,
      text: m.metadata.text || ""
    };
  }).slice(0, maxSources);

  // Assign ref numbers 1..N
  diverse.forEach((d, i) => (d.ref = i + 1));
  return diverse;
}

async function answerStructuredWithRefs(question, sources) {
  const contextText = sources.map(s => `# Ref ${s.ref}
File: ${s.fileName}  |  Page: ${s.page}
---
${s.text}`).join("\n\n");

  const prompt = `You are a pharma market-research analyst.
Use ONLY the context refs below. Create a narrative headline + 1–5 supporting bullets.
Cite sources by their numeric tag with NO brackets and NO space before the superscript (e.g., 12 for ref 1).

Return STRICT JSON:
{
  "headline": "short narrative that synthesizes recency-weighted evidence; include superscript refs like ^1^2 (I'll convert)",
  "bullets": [
    { "text": "concise support with numbers if present and superscript refs like ^1^ or ^1^3" }
  ]
}

Rules:
- Do NOT invent numbers.
- Prefer trend and comparators.
- Keep bullets to 1–5, most decision-relevant.

Question:
${question}

CONTEXT (Refs):
${contextText}`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    response_format: { type: "json_object" }
  });

  let obj = {};
  try { obj = JSON.parse(r.choices?.[0]?.message?.content || "{}"); } catch {}
  const headline = String(obj.headline || "").trim();
  const bullets = Array.isArray(obj.bullets) ? obj.bullets.map(b => ({ text: String(b?.text || "").trim() })).filter(b => b.text) : [];
  return { headline, bullets };
}

// ---------- Live Drive allowlist ----------
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

// ---------- SEARCH ----------
app.post("/search", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId = "demo", userQuery, topK = 40 } = req.body || {};
    if (!userQuery) return res.status(400).json({ error: "userQuery required" });

    const vector = await embedText(userQuery);

    let pineconeFilter = undefined;
    if (LIVE_DRIVE_FILTER) {
      const liveIds = await listDriveFileIds();
      pineconeFilter = liveIds.size ? { fileId: { $in: [...liveIds] } } : { fileId: { $in: ["__none__"] } };
    }

    const q = await index.namespace(clientId).query({
      vector,
      topK: Number(topK) || 40,     // pull many, then diversify by recency
      includeMetadata: true,
      filter: pineconeFilter,
    });

    const matches = q.matches || [];
    const sources = await buildDiverseSources(matches, 8);
    const structured = await answerStructuredWithRefs(userQuery, sources);

    // Build references list & visuals from recency‑ordered sources
    const references = sources.map(s => ({
      ref: s.ref,
      fileId: s.fileId,
      fileName: cleanReportName(s.fileName),
      page: s.page || 1
    }));

    const visuals = sources.slice(0, 5).map(s => ({
      fileId: s.fileId,
      fileName: s.fileName,
      page: s.page || 1,
      imageUrl: `/preview/page.png?fileId=${encodeURIComponent(s.fileId)}&page=${encodeURIComponent(s.page || 1)}`
    }));

    res.json({ structured, references, visuals });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin mini endpoints ----------
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

app.post("/admin/ingest-one", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId = "demo", fileId, maxPages } = req.body || {};
    if (!fileId) return res.status(400).json({ error: "fileId required" });
    const meta = await drive.files.get({ fileId, fields: "id,name", supportsAllDrives: true }).then(r => r.data);
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
