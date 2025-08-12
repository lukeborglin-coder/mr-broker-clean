// server.js — auto-creates Pinecone index; live Drive filter; clear debug

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
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID; // Google folder ID
const GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS; // path to JSON
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
// Index config
const PINECONE_INDEX = process.env.PINECONE_INDEX || "mr-index";
const PINECONE_CLOUD = process.env.PINECONE_CLOUD || "aws";        // "aws" or "gcp"
const PINECONE_REGION = process.env.PINECONE_REGION || "us-east-1"; // ex: "us-east-1"
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
  scopes: ["https://www.googleapis.com/auth/drive.readonly"]
});
const drive = google.drive({ version: "v3", auth: gauth });

// ---------- OpenAI + Pinecone ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

// Ensure index exists (serverless)
async function ensurePineconeIndex() {
  // list indexes
  const indexes = await pinecone.listIndexes();
  const exists = indexes.indexes?.some(i => i.name === PINECONE_INDEX);
  if (exists) return;

  console.log(`[pinecone] creating index "${PINECONE_INDEX}" (dims=${EMBEDDING_DIMS}, region=${PINECONE_REGION})...`);
  await pinecone.createIndex({
    name: PINECONE_INDEX,
    dimension: EMBEDDING_DIMS,
    metric: "cosine",
    spec: {
      serverless: { cloud: PINECONE_CLOUD, region: PINECONE_REGION }
    }
  });

  // wait until Ready
  for (let i = 0; i < 30; i++) {
    const d = await pinecone.describeIndex(PINECONE_INDEX);
    const status = d.status?.ready ? "Ready" : "NotReady";
    console.log(`[pinecone] status: ${status}`);
    if (d.status?.ready) break;
    await new Promise(r => setTimeout(r, 2000));
  }
}

let index; // will be set after ensurePineconeIndex()

// ---------- Debug (no auth) ----------
app.get("/debug/drive-env", (req, res) => {
  res.json({
    DRIVE_ROOT_FOLDER_ID,
    GOOGLE_APPLICATION_CREDENTIALS,
    credsFileExists: !!(GOOGLE_APPLICATION_CREDENTIALS && fs.existsSync(GOOGLE_APPLICATION_CREDENTIALS))
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
      supportsAllDrives: true
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
      const idx = pinecone.Index(PINECONE_INDEX);
      stats = await idx.describeIndexStats(); // <-- correct place for describeIndexStats
    } catch (e) {
      stats = { error: e.message };
    }
    res.json({
      ok: true,
      index: PINECONE_INDEX,
      desc,                       // desc?.status?.ready === true means it's usable
      stats                       // high-level index stats or error if not created yet
    });
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
      region: PINECONE_REGION
    }
  });
});

// ---------- Helpers ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({
    model: EMBEDDING_MODEL, // 1536 dims
    input: text
  });
  return data[0].embedding;
}

async function answerWithContext(question, contexts) {
  const contextText = contexts
    .map((m, i) => `# Source ${i + 1}
File: ${m?.metadata?.fileName || m?.metadata?.title || "Untitled"}
Page: ${m?.metadata?.page ?? m?.metadata?.slide ?? "?"}
---
${m?.metadata?.text || m?.metadata?.chunk || m?.metadata?.content || m?.values?.text || ""}
`)
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
    temperature: 0.2
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

// Drive file allowlist (cache 60s)
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
      q, fields, pageToken,
      pageSize: 1000,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true
    });
    (resp.data.files || []).forEach(f => {
      const mt = (f.mimeType || "").toLowerCase();
      if (mt.includes("pdf") || mt.includes("presentation") || mt.includes("powerpoint")) {
        ids.add(f.id);
      }
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
        return res.status(503).json({ error: "Drive check failed. Verify credentials and folder ID.", detail: e.message });
      }
    }

    let query;
    try {
      query = await index.query({
        vector,
        topK,
        includeMetadata: true,
        namespace: clientId,
        filter: pineconeFilter
      });
    } catch (e) {
      console.error("[/search] pinecone.query failed:", e);
      return res.status(500).json({ error: "pinecone.query failed", detail: e.message });
    }

    const matches = query.matches || [];
    const answer = await answerWithContext(userQuery, matches);

    const references = matches.map(m => ({
      fileId: m.metadata?.fileId,
      fileName: m.metadata?.fileName || m.metadata?.title || "Untitled",
      page: m.metadata?.page ?? m.metadata?.slide
    }));

    res.json({ answer, references, visuals: [] });
  } catch (e) {
    console.error("[/search] error", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Admin (purge namespace) ----------
app.post("/admin/rebuild-from-drive", async (req, res) => {
  try {
    if (!index) return res.status(503).json({ error: "Pinecone index not ready yet" });
    const { clientId } = req.body || {};
    if (!clientId) return res.status(400).json({ error: "clientId required" });

    await index.delete({ deleteAll: true, namespace: clientId });
    res.json({ ok: true, message: "Namespace purged. Re-ingest current Drive files to complete rebuild." });
  } catch (e) {
    console.error("[/admin/rebuild-from-drive] error", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Bootstrapping Pinecone then start server ----------
(async () => {
  try {
    await ensurePineconeIndex();
    index = pinecone.Index(PINECONE_INDEX);
    console.log(`[pinecone] using index "${PINECONE_INDEX}"`);
  } catch (e) {
    console.error("[pinecone] failed to ensure index:", e);
  }

  app.listen(PORT, () => {
    console.log(`mr-broker running on :${PORT}`);
  });
})();

