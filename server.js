// server.js — Pinecone v2 + Drive PDF ingest (guarded) + diagnostics
// Fixes: import pdf-parse from internal path to avoid demo file fallback

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// ---------- Env + App ----------
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath, override: true });

const PORT = process.env.PORT || 3000;

// 🔧 REQUIRED ENV
const AUTH_TOKEN = (process.env.AUTH_TOKEN || "").trim();
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

// Index config
const PINECONE_INDEX = process.env.PINECONE_INDEX || "mr-index";
const PINECONE_CLOUD = process.env.PINECONE_CLOUD || "aws";
const PINECONE_REGION = process.env.PINECONE_REGION || "us-east-1";
const LIVE_DRIVE_FILTER = String(process.env.LIVE_DRIVE_FILTER || "true").toLowerCase() === "true";

// Embedding model (1536 dims)
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors());
app.use(express.static("public"));

// ---------- Google Drive ----------
if (!GOOGLE_APPLICATION_CREDENTIALS || !fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)) {
  console.warn("[warn] GOOGLE_APPLICATION_CREDENTIALS missing or not found:", GOOGLE_APPLICATION_CREDENTIALS);
}
const gauth = new google.auth.GoogleAuth({
  keyFile: GOOGLE_APPLICATION_CREDENTIALS,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth: gauth });

// ---------- OpenAI + Pinecone ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

// Ensure index exists (serverless) — Pinecone v2
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
    const ready = d?.status?.ready;
    console.log(`[pinecone] status: ${ready ? "Ready" : "NotReady"}`);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let index; // v2 handle: pinecone.index(name)

// ---------- Debug (no auth) ----------
app.get("/debug/drive-env", (req, res) => {
  res.json({
    DRIVE_ROOT_FOLDER_ID,
    GOOGLE_APPLICATION_CREDENTIALS,
    credsFileExists: !!(GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS)),
  });
});

app.get("/debug/drive-list", async (req, res) => {
  try {
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: "files(id,name,mimeType),nextPageToken",
      pageSize: 10,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    res.json({ count: (r.data.files || []).length, sample: r.data.files || [] });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

app.get("/debug/pinecone", async (req, res) => {
  try {
    const desc = await pinecone.describeIndex(PINECONE_INDEX).catch(() => null);
    let stats = null;
    try {
      const idx = pinecone.index(PINECONE_INDEX);
      stats = await idx.describeIndexStats();
    } catch (e) {
      stats = { error: e.message };
    }
    res.json({ ok: true, index: PINECONE_INDEX, desc, stats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
});

app.get("/debug/embed-dim", async (req, res) => {
  try {
    const r = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: "hello" });
    res.json({ ok: true, model: EMBEDDING_MODEL, dim: r.data[0].embedding.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stack: e.stack });
  }
});

app.get("/debug/whoami", (req, res) => {
  try {
    const cwd = process.cwd();
    const files = fs.readdirSync(cwd).slice(0, 50);
    res.json({ cwd, files });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// ---------- Auth middleware ----------
app.use((req, res, next) => {
  const expected = AUTH_TOKEN;
  if (!expected) return next();
  const got = (req.get("x-auth-token") || "").trim();
  if (got !== expected) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------- Diagnostics ----------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    env: {
      auth: Boolean(AUTH_TOKEN),
      driveRoot: Boolean(DRIVE_ROOT_FOLDER_ID),
      googleCreds: Boolean(GOOGLE_APPLICATION_CREDENTIALS),
      openai: Boolean(OPENAI_API_KEY),
      pinecone: Boolean(PINECONE_API_KEY),
      index: PINECONE_INDEX,
      cloud: PINECONE_CLOUD,
      region: PINECONE_REGION,
    },
  });
});

app.get("/env", (req, res) => {
  const redact = (v) => (v ? v.slice(0, 6) + "…" : "");
  res.json({
    hasAuthToken: Boolean(AUTH_TOKEN),
    openaiKey: redact(OPENAI_API_KEY),
    pineconeKey: redact(PINECONE_API_KEY),
    pineconeIndex: PINECONE_INDEX,
  });
});

// ---------- Helpers ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return data[0].embedding;
}

async function answerWithContext(question, contexts) {
  const contextText = contexts
    .map(
      (m, i) => `# Source ${i + 1}
File: ${m?.metadata?.fileName || m?.metadata?.title || "Untitled"}
Page: ${m?.metadata?.page ?? m?.metadata?.slide ?? "?"}
---
${m?.metadata?.text || m?.metadata?.chunk || m?.metadata?.content || m?.values?.text || ""}`
    )
    .join("\n\n");

  const prompt = `You are a market research analyst. Answer the user's question using ONLY the context below.
If the context doesn't contain the answer, say you don't have enough information.
Be concise and factual. Return a short paragraph followed by a few bullets if helpful.

Question: ${question}

Context:
${contextText}`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// ===== Drive → PDF → text → chunks → embeddings =====

// Download a Drive file as a Buffer (STRICT: throw if empty)
async function downloadDriveFileBuffer(fileId) {
  const resp = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  if (!resp || !resp.data) {
    throw new Error(`Drive returned no data for fileId=${fileId}`);
  }
  const buf = Buffer.from(resp.data);
  if (!buf.length) {
    throw new Error(`Downloaded empty buffer from Drive for fileId=${fileId}`);
  }
  return buf;
}

// PDF → pages using internal pdf-parse path to avoid demo fallback
async function parsePdfPages(buffer) {
  if (!buffer || !buffer.length) {
    throw new Error("parsePdfPages called without a PDF buffer");
  }

  // IMPORTANT: load the actual parser function, not the package entry
  const mod = await import("pdf-parse/lib/pdf-parse.js");
  const pdfParse = mod.default || mod; // support both ESM/CJS default shapes

  const parsed = await pdfParse(buffer);
  const raw = parsed.text || "";
  const pages = raw.split("\f");
  return pages.map((p) => p.trim()).filter(Boolean);
}

// Simple text chunker with overlap
function chunkText(str, chunkSize = 2000, overlap = 200) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    out.push(str.slice(i, i + chunkSize));
    i += Math.max(1, chunkSize - overlap);
  }
  return out;
}

// Upsert a set of chunks for one file (stores page + filename)
// Pinecone v2 — use namespace chaining
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
  if (vectors.length) {
    await index.namespace(clientId).upsert(vectors);
  }
}

// Ingest ONE Drive PDF (with strict checks + logs)
async function ingestSingleDrivePdf({ clientId, fileId, fileName }) {
  console.log(`[ingest] downloading "${fileName}" (${fileId})`);
  const buf = await downloadDriveFileBuffer(fileId);
  console.log(`[ingest] ${fileName}: downloaded ${buf.length.toLocaleString()} bytes`);
  const pages = await parsePdfPages(buf);
  console.log(`[ingest] parsed ${pages.length} pages from "${fileName}"`);
  for (let p = 0; p < pages.length; p++) {
    const pageText = pages[p];
    if (!pageText) continue;
    const chunks = chunkText(pageText, 2000, 200);
    await upsertChunks({ clientId, fileId, fileName, chunks, page: p + 1 });
  }
}

// ---------- Live Drive filter (cache 60s) ----------
let _driveCache = { ids: new Set(), ts: 0 };
async function listDriveFileIds() {
  const now = Date.now();
  if (now - _driveCache.ts < 60_000 && _driveCache.ids.size > 0) return _driveCache.ids;

  if (!DRIVE_ROOT_FOLDER_ID) return new Set();
  const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
  const fields = "files(id,name,mimeType),nextPageToken";
  let pageToken = null;
  const ids = new Set();

  do {
    const resp = await drive.files.list({
      q,
      fields,
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageToken,
    });
    (resp.data.files || []).forEach((f) => {
      const mt = (f.mimeType || "").toLowerCase();
      if (mt.includes("pdf")) ids.add(f.id);
    });
    pageToken = resp.data.nextPageToken || null;
  } while (pageToken);

  _driveCache = { ids, ts: now };
  return ids;
}

// ---------- SEARCH ----------
app.post("/search", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });

    const { clientId = "demo", userQuery, topK = 6 } = req.body || {};
    if (!userQuery) return res.status(400).json({ error: "userQuery required" });

    const vector = await embedText(userQuery);

    // live Drive filter
    let pineconeFilter = undefined;
    if (LIVE_DRIVE_FILTER) {
      try {
        const liveIds = await listDriveFileIds();
        const allowList = [...liveIds];
        pineconeFilter = allowList.length
          ? { fileId: { $in: allowList } }
          : { fileId: { $in: ["__none__"] } };
      } catch (e) {
        console.error("[search] listDriveFileIds failed:", e);
        return res.status(503).json({
          error: "Drive check failed. Verify credentials and folder ID.",
          detail: e.message,
          stack: e.stack,
        });
      }
    }

    // Pinecone v2 query — namespace chaining; only { vector, topK, includeMetadata, filter }
    const query = await index.namespace(clientId).query({
      vector,
      topK: Number(topK) || 6,
      includeMetadata: true,
      filter: pineconeFilter,
    });

    const matches = query.matches || [];
    const answer = await answerWithContext(userQuery, matches);

    const references = matches.map((m) => ({
      fileId: m.metadata?.fileId,
      fileName: m.metadata?.fileName || m.metadata?.title || "Untitled",
      page: m.metadata?.page ?? m.metadata?.slide,
    }));

    res.json({ answer, references, visuals: [] });
  } catch (e) {
    console.error("[/search] error", e);
    res.status(500).json({ error: e?.message || String(e), stack: e?.stack });
  }
});

// ---------- Admin (purge namespace) ----------
app.post("/admin/rebuild-from-drive", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });

    await index.namespace(clientId).deleteAll();
    res.json({ ok: true, message: "Namespace purged. Re-ingest current Drive files to complete rebuild." });
  } catch (e) {
    console.error("[/admin/rebuild-from-drive] error", e);
    res.status(500).json({ error: e?.message || String(e), stack: e?.stack });
  }
});

// ---------- Admin (ingest all PDFs from Drive folder) ----------
app.post("/admin/ingest-drive", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId = "demo" } = req.body || {};
    const files = [];
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
        if (mt.includes("pdf")) files.push({ id: f.id, name: f.name });
      });
      pageToken = r.data.nextPageToken || null;
    } while (pageToken);

    let ingested = 0;
    for (const f of files) {
      await ingestSingleDrivePdf({ clientId, fileId: f.id, fileName: f.name });
      ingested++;
      console.log(`[ingest] ${ingested}/${files.length} ${f.name}`);
    }

    res.json({ ok: true, clientId, files: files.length, message: "Ingest complete." });
  } catch (e) {
    console.error("[/admin/ingest-drive] error", e);
    res.status(500).json({ error: e?.message || String(e), stack: e?.stack });
  }
});

// ---------- Extra: diagnose Drive quickly ----------
app.post("/admin/diagnose-drive", async (req, res) => {
  try {
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
    const r = await drive.files.list({
      q,
      fields: "files(id,name,mimeType)",
      pageSize: 5,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    const pdfs = (r.data.files || []).filter(f => (f.mimeType || "").toLowerCase().includes("pdf")).slice(0, 5);

    const sizes = [];
    for (const f of pdfs) {
      const buf = await downloadDriveFileBuffer(f.id);
      sizes.push({ id: f.id, name: f.name, bytes: buf.length });
    }
    res.json({ ok: true, sample: sizes });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e), stack: e?.stack });
  }
});

// ---------- Bootstrapping Pinecone then start server ----------
(async () => {
  try {
    await ensurePineconeIndex();
    index = pinecone.index(PINECONE_INDEX); // ✅ v2 handle
    console.log(`[pinecone] using index "${PINECONE_INDEX}"`);
  } catch (e) {
    console.error("[pinecone] failed to ensure index:", e);
  }

  app.listen(PORT, () => {
    console.log(`mr-broker running on :${PORT}`);
  });
})();

