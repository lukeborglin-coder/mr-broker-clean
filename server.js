// server.js — ES module, previews + search + secondary resources

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createCanvas } from "canvas";

// ---------- Env / App ----------
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const PORT = process.env.PORT || 3000;

// Optional server-side basic auth (off by default to avoid double prompts)
const ENABLE_BASIC_AUTH = String(process.env.ENABLE_BASIC_AUTH || "false").toLowerCase() === "true";
const SITE_PASSWORD = process.env.SITE_PASSWORD || "coggpt25";

const AUTH_TOKEN = (process.env.AUTH_TOKEN || "").trim();
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;

const PINECONE_INDEX = process.env.PINECONE_INDEX || "mr-index";
const PINECONE_CLOUD = process.env.PINECONE_CLOUD || "aws";
const PINECONE_REGION = process.env.PINECONE_REGION || "us-east-1";
const LIVE_DRIVE_FILTER = String(process.env.LIVE_DRIVE_FILTER || "true").toLowerCase() === "true";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

const app = express();

// Optional Basic Auth (username ignored; password only)
if (ENABLE_BASIC_AUTH) {
  app.use((req, res, next) => {
    const authHeader = req.headers.authorization || "";
    const [scheme, encoded] = authHeader.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="Secure Area"');
      return res.status(401).send("Authentication required");
    }
    const decoded = Buffer.from(encoded, "base64").toString();
    const idx = decoded.indexOf(":");
    const password = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (password !== SITE_PASSWORD) {
      res.set("WWW-Authenticate", 'Basic realm="Secure Area"');
      return res.status(401).send("Authentication required");
    }
    next();
  });
}

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
const gauth = new google.auth.GoogleAuth({
  keyFile: CREDS_PATH,
  scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});
const drive = google.drive({ version: "v3", auth: gauth });

// ---------- OpenAI + Pinecone ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pinecone = new Pinecone({ apiKey: PINECONE_API_KEY });

async function ensurePineconeIndex() {
  const list = await pinecone.listIndexes();
  const exists = list.indexes?.some((i) => i.name === PINECONE_INDEX);
  if (exists) return;
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

// ---------- Utility (names/dates) ----------
function cleanReportName(name) {
  if (!name) return "Report";
  let n = String(name).replace(/\.pdf$/i, "");
  n = n.replace(/([_\-]\d{6,8})$/i, "");
  n = n.replace(/([_\-]Q[1-4]\d{4})$/i, "");
  n = n.replace(/([_\-][WV]\d{1,2})$/i, "");
  n = n.replace(/([_\-]v\d+)$/i, "");
  return n.trim();
}
function dateFromName(name) {
  const s = String(name || "");
  let m;
  m = s.match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])/);
  if (m) return new Date(+m[1], +m[2] - 1, 1).getTime();
  m = s.match(/Q([1-4])\s?20(\d{2})/i);
  if (m) return new Date(2000 + +m[2], (+m[1] - 1) * 3, 1).getTime();
  m = s.match(/(20\d{2})/);
  if (m) return new Date(+m[1], 0, 1).getTime();
  m = s.match(/(0[1-9]|1[0-2])([0-3]\d)(2\d)/);
  if (m) return new Date(2000 + +m[3], +m[1] - 1, +m[2]).getTime();
  return 0;
}
function fmtYMD(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  return `${y}-${m}`;
}

// ---------- PDF: raw & preview ----------
async function downloadDriveFileBuffer(fileId) {
  const resp = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(resp.data || []);
  if (!buf.length) throw new Error("empty file");
  return buf;
}
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
  const viewport = page.getViewport({ scale: 1.5 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;

  await new Promise((res, rej) => {
    const out = fs.createWriteStream(pngPath);
    canvas.createPNGStream().pipe(out);
    out.on("finish", res);
    out.on("error", rej);
  });
  return pngPath;
}

app.get("/file/pdf", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "");
    if (!fileId) return res.status(400).send("fileId required");
    const buf = await downloadDriveFileBuffer(fileId);
    res.type("application/pdf").set("Cache-Control", "public, max-age=3600").end(buf);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/preview/page.png", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "");
    const page = Number(req.query.page || 1);
    if (!fileId) return res.status(400).send("fileId required");
    try {
      const png = await renderPdfPagePng(fileId, page);
      res.type("image/png");
      fs.createReadStream(png).pipe(res);
    } catch {
      // tiny transparent pixel fallback
      const blank = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=",
        "base64"
      );
      res.type("image/png").send(blank);
    }
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- API auth guard (for /search, /secondary, etc.) ----------
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if ((req.get("x-auth-token") || "").trim() !== AUTH_TOKEN)
    return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------- Embeddings & ingest ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return data[0].embedding;
}
async function parsePdfPages(buffer) {
  const mod = await import("pdf-parse/lib/pdf-parse.js").catch(() => null);
  const fn = mod?.default || mod || (await import("pdf-parse")).default;
  const parsed = await fn(buffer);
  return (parsed.text || "")
    .split("\f")
    .map((p) => p.trim())
    .filter(Boolean);
}
function chunkText(str, chunk = 2000, overlap = 200) {
  const out = [];
  let i = 0;
  while (i < str.length) {
    out.push(str.slice(i, i + chunk));
    i += Math.max(1, chunk - overlap);
  }
  return out;
}
async function upsertChunks({ clientId, fileId, fileName, chunks, page }) {
  const vectors = [];
  for (let i = 0; i < chunks.length; i++) {
    const values = await embedText(chunks[i]);
    vectors.push({
      id: `${fileId}_${page ?? 0}_${i}_${Date.now()}`,
      values,
      metadata: {
        clientId,
        fileId,
        fileName,
        page,
        text: chunks[i],
        sourceType: "report",
      },
    });
  }
  if (vectors.length) await index.namespace(clientId).upsert(vectors);
}

// ---------- Search helpers ----------
async function buildDiverseSources(matches, maxSources = 8) {
  const byFile = new Map();
  for (const m of matches) {
    const fid = m.metadata?.fileId;
    if (!fid) continue;
    if (!byFile.has(fid)) byFile.set(fid, m);
  }
  const diverse = [...byFile.values()];
  const metas = await Promise.all(
    diverse.map(async (m) => {
      try {
        const info = await drive.files
          .get({
            fileId: m.metadata.fileId,
            fields: "id,name,modifiedTime",
            supportsAllDrives: true,
          })
          .then((r) => r.data);
        const tName = dateFromName(info.name || m.metadata.fileName || "");
        const tMod = info.modifiedTime ? new Date(info.modifiedTime).getTime() : 0;
        const ts = Math.max(tName, tMod);
        return {
          match: m,
          name: info.name || m.metadata.fileName || "",
          ts,
        };
      } catch {
        const ts = dateFromName(m.metadata.fileName || "");
        return { match: m, name: m.metadata.fileName || "", ts };
      }
    })
  );
  metas.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return metas.slice(0, maxSources).map((x, i) => ({
    ref: i + 1,
    fileId: x.match.metadata.fileId,
    fileName: cleanReportName(x.name || x.match.metadata.fileName || "Report"),
    page: x.match.metadata.page ?? x.match.metadata.slide ?? 1,
    text: x.match.metadata.text || "",
    ts: x.ts || 0,
  }));
}

async function answerStructured(question, sources) {
  const ctx = sources
    .map(
      (s) => `# Ref ${s.ref}
File: ${s.fileName} | Page: ${s.page} | Date: ${fmtYMD(s.ts) || "unknown"}
---
${s.text}`
    )
    .join("\n\n");

  const prompt = `You are a pharma market-research analyst.

Use ONLY the refs to answer. Rules:
- Determine the current metric/value using the most recent relevant reference (latest Date).
- If older refs contain a prior value for the same metric, compute and state the trend succinctly (e.g., "now 60%, up +10% vs 2024").
- Prefer recent evidence; never average across waves unless explicitly stated in refs.
- Output concise "headline" (2–4 sentences) plus 1–3 short bullets.
- Then provide 3–7 Supporting Detail bullets close to ref wording/numbers.
- Use numeric citations via ^n^ placeholders; do not invent refs.

STRICT JSON:
{
  "headline": { "paragraph": "text with ^n^", "bullets": ["bullet ^n^"] },
  "supporting": [ { "text": "close-to-source bullet ^n^" } ],
  "quotes": ["\"short quote\" ^n^"]
}

Question:
${question}

CONTEXT:
${ctx}`;

  await openai.chat.aiCompletions?.create?.({}); // guard for older SDKs
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.2,
    response_format: { type: "json_object" },
  });

  let obj = { headline: { paragraph: "", bullets: [] }, supporting: [], quotes: [] };
  try {
    obj = JSON.parse(resp.choices?.[0]?.message?.content || "{}");
  } catch {}
  obj.headline = {
    paragraph: String(obj.headline?.paragraph || "").trim(),
    bullets: Array.isArray(obj.headline?.bullets)
      ? obj.headline.bullets.slice(0, 3).map((s) => String(s || "").trim()).filter(Boolean)
      : [],
  };
  obj.supporting = Array.isArray(obj.supporting)
    ? obj.supporting.slice(0, 7).map((b) => ({ text: String(b?.text || "").trim() })).filter((b) => b.text)
    : [];
  obj.quotes = Array.isArray(obj.quotes)
    ? obj.quotes.slice(0, 4).map((q) => String(q || "").trim()).filter(Boolean)
    : [];
  return obj;
}

// ---------- Drive allowlist ----------
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
      if ((f.mimeType || "").toLowerCase().includes("pdf")) ids.add(f.id);
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

    // Build filter
    let filter = {};
    if (LIVE_DRIVE_FILTER) {
      const live = await listDriveFileIds();
      filter.fileId = { $in: live.size ? [...live] : ["__none__"] };
    }

    const q = await index.namespace(clientId).query({
      vector,
      topK: Number(topK) || 40,
      includeMetadata: true,
      filter,
    });

    const matches = q.matches || [];
    const sources = await buildDiverseSources(matches, 8);
    const structured = await answerStructured(userQuery, sources);

    const references = sources.map((s) => ({
      ref: s.ref,
      fileId: s.fileId,
      fileName: cleanReportName(s.fileName),
      page: s.page || 1,
    }));
    const visuals = sources.slice(0, 6).map((s) => ({
      fileId: s.fileId,
      fileName: s.fileName,
      page: s.page || 1,
      imageUrl: `/preview/page.png?fileId=${encodeURIComponent(s.fileId)}&page=${encodeURIComponent(s.page || 1)}`,
    }));

    res.json({ structured, references, visuals });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- SECONDARY (public web summaries: DuckDuckGo + Wikipedia) ----------
app.post("/secondary", async (req, res) => {
  try {
    const q = String(req.body?.userQuery || req.body?.query || "").trim();
    if (!q) return res.status(400).json({ error: "query required" });

    const items = [];

    // DuckDuckGo Instant Answer
    try {
      const r = await fetch(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(q)}&format=json&no_redirect=1&no_html=1`
      );
      const d = await r.json();
      if (d?.AbstractText && d?.AbstractURL) {
        items.push({
          title: d.Heading || "Summary",
          summary: d.AbstractText,
          url: d.AbstractURL,
        });
      }
      (d?.RelatedTopics || []).forEach((rt) => {
        if (items.length >= 3) return;
        if (rt?.Text && rt?.FirstURL) {
          items.push({
            title: (rt.Text.split(" - ")[0] || "").slice(0, 120),
            summary: rt.Text,
            url: rt.FirstURL,
          });
        }
      });
    } catch {}

    // Wikipedia fallback
    try {
      if (items.length < 3) {
        const w = await fetch(
          `https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=${3 - items.length}`
        ).then((r) => r.json());
        const pages = (w?.pages || []).slice(0, 3 - items.length);
        for (const p of pages) {
          const s = await fetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(p.title)}`
          )
            .then((r) => r.json())
            .catch(() => null);
          if (s?.extract && s?.content_urls?.desktop?.page) {
            items.push({ title: p.title, summary: s.extract, url: s.content_urls.desktop.page });
          }
          if (items.length >= 3) break;
        }
      }
    } catch {}

    res.json({ items: items.slice(0, 3) });
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Boot ----------
(async () => {
  try {
    await ensurePineconeIndex();
    index = pinecone.index(PINECONE_INDEX);
  } catch (e) {
    console.error("pinecone bootstrap failed", e);
  }
  app.listen(PORT, () => console.log(`mr-broker running on :${PORT}`));
})();
