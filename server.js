// server.js — auth + Drive crawl + RAG + auto-tagging + recency re-ranking
// Adds: "Secondary Information" web results in /search; maps 'internal' -> 'admin' in /me
// Adds: Role selection in /admin/users/create; /admin/library-stats; manifest write on ingest
// Fixes: defines chunkText() and uses it correctly; robust ingest + tags (month/year/report)
// NEW: /api/client-libraries — live-from-Drive dropdown (cached), so no manual updates on deploy
// UPDATES (Aug 2025):
// - Admin creation no longer requires a client folder; admins get access to all libraries ("*").
// - Session cookie security is controlled by SECURE_COOKIES env (false OK for local/dev).
// - Send Cache-Control: no-store for .html/.css/.js (and for "/" + "/admin") to avoid stale UI.
// - NEW: /api/drive-pdf (secure PDF proxy) for slide snapshots. (Aug 15 fix: supports Slides export + Shared Drives)
// - Ingest: store fileId for all vectors; for PDFs, also store page numbers in metadata.
// - /search: optional generateSupport -> returns supportingBullets [{text, recencyEpoch, refs[]}], recency-sorted.
// - Auto-ingest support:
//    (a) /admin/ingest/sync (token-protected; for cron)
//    (b) Drive push notifications (changes.watch) → /webhooks/drive triggers ingest automatically.
// - NEW (Aug 15): Data files pipeline (Final Frequencies & Raw Data) → cache to /data-cache and serve charts via /api/chart-query.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { google } from "googleapis";
import crypto from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import * as XLSX from "xlsx";
import { parse as csvParse } from "csv-parse/sync";

// -------------------- Environment --------------------
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-auth-token";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-small"; // 1536 dims
const ANSWER_MODEL = process.env.ANSWER_MODEL || "gpt-4o-mini";
const DEFAULT_TOPK = Number(process.env.DEFAULT_TOPK || 6);

const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST || "";

const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "";
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON || "";

const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "";
const DRIVE_WEBHOOK_VERIFY_TOKEN =
  process.env.DRIVE_WEBHOOK_VERIFY_TOKEN || "";

// Cache for client libraries (so UI always loads from Drive, no redeploys)
const CLIENT_LIB_TTL_MS = Number(process.env.CLIENT_LIB_TTL_MS || 60_000);

// Internal account
const INTERNAL_USERNAME = "cognitive_internal";
const INTERNAL_PASSWORD =
  process.env.INTERNAL_PASSWORD?.trim() || "coggpt25";
const INTERNAL_PASSWORD_HASH =
  process.env.INTERNAL_PASSWORD_HASH?.trim() || null;

// Secure cookies flag (override with SECURE_COOKIES=false for local/dev HTTP)
const SECURE_COOKIES =
  String(
    process.env.SECURE_COOKIES ??
      (process.env.NODE_ENV === "development" ? "false" : "true")
  )
    .toLowerCase()
    .trim() === "true";

// -------------------- Data pipeline envs --------------------
const DATA_CACHE_DIR =
  process.env.DATA_CACHE_DIR || path.resolve(process.cwd(), "data-cache");
const DATA_FILES_FOLDER = process.env.DATA_FILES_FOLDER || "Data Files";
const DATA_FINAL_FREQ_SUBFOLDER =
  process.env.DATA_FINAL_FREQ_SUBFOLDER || "Final Frequencies";
const DATA_RAW_SUBFOLDER =
  process.env.DATA_RAW_SUBFOLDER || "Raw Data";

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Static with no-store for dev iteration
app.use(
  express.static("public", {
    setHeaders(res, p) {
      if (/\.(html|css|js)$/i.test(p)) {
        res.setHeader("Cache-Control", "no-store");
      }
    },
  })
);

// Global no-store for direct HTML routes (/, /admin)
app.use((req, res, next) => {
  if (/\.(html|css|js)$/i.test(req.path)) {
    res.setHeader("Cache-Control", "no-store");
  }
  next();
});

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: SECURE_COOKIES,
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);

// Ensure data cache root exists
try { await fsp.mkdir(DATA_CACHE_DIR, { recursive: true }); } catch {}

// -------------------- Tiny JSON store --------------------
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

function readJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8") || "null") ?? fallback;
  } catch {
    return fallback;
  }
}
function writeJSON(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

// Store for watch channel + tokens
const WATCH_STATE_PATH = path.join(CONFIG_DIR, "drive_watch.json");
function readWatchState() {
  return readJSON(WATCH_STATE_PATH, {
    channels: {},
    startPageToken: null,
    lastChecked: 0,
  });
}
function writeWatchState(s) {
  writeJSON(WATCH_STATE_PATH, s);
}

// Ensure internal account exists
(function seedInternal() {
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  const hash = INTERNAL_PASSWORD_HASH || bcrypt.hashSync(INTERNAL_PASSWORD, 10);
  const i = usersDoc.users.findIndex((u) => u.username === INTERNAL_USERNAME);
  if (i === -1) {
    usersDoc.users.push({
      username: INTERNAL_USERNAME,
      passwordHash: hash,
      role: "internal",
      allowedClients: "*",
    });
  } else {
    usersDoc.users[i].passwordHash = hash;
    usersDoc.users[i].role = "internal";
    usersDoc.users[i].allowedClients = "*";
  }
  writeJSON(USERS_PATH, usersDoc);
})();

// -------------------- Google APIs --------------------
function getAuth() {
  if (GOOGLE_CREDENTIALS_JSON) {
    return new google.auth.GoogleAuth({
      credentials: JSON.parse(GOOGLE_CREDENTIALS_JSON),
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/presentations.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    });
  }
  if (GOOGLE_KEYFILE) {
    return new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEYFILE,
      scopes: [
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/presentations.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ],
    });
  }
  throw new Error("Google credentials missing");
}
function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}
function getSlides() {
  return google.slides({ version: "v1", auth: getAuth() });
}
function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

// ---------- Drive push notifications (changes.watch) ----------
async function getStartPageToken() {
  const drive = getDrive();
  const r = await drive.changes.getStartPageToken({
    supportsAllDrives: true,
  });
  return r.data.startPageToken;
}

// Start a single "changes" channel; Google will POST to /webhooks/drive
async function startChangesWatch() {
  if (!PUBLIC_BASE_URL) throw new Error("PUBLIC_BASE_URL required for Drive webhooks");
  const drive = getDrive();
  const id = uuidv4();
  const address = `${PUBLIC_BASE_URL.replace(/\/+$/, "")}/webhooks/drive?token=${encodeURIComponent(
    DRIVE_WEBHOOK_VERIFY_TOKEN
  )}`;

  const r = await drive.changes.watch({
    requestBody: {
      id,
      type: "web_hook",
      address,
      params: { includeCorpusRemovals: "true", includeTeamDriveItems: "true" },
    },
    supportsAllDrives: true,
  });

  const state = readWatchState();
  state.channels["changes"] = {
    id,
    resourceId: r.data.resourceId,
    address,
    expiration: Number(r.data.expiration || 0),
    createdAt: Date.now(),
  };
  if (!state.startPageToken) {
    state.startPageToken = await getStartPageToken();
  }
  writeWatchState(state);
  return state.channels["changes"];
}

async function stopChangesWatch() {
  const drive = getDrive();
  const state = readWatchState();
  const ch = state.channels["changes"];
  if (!ch) return false;
  try {
    await drive.channels.stop({ requestBody: { id: ch.id, resourceId: ch.resourceId } });
  } catch {
    // ignore; may already be expired
  }
  delete state.channels["changes"];
  writeWatchState(state);
  return true;
}

// Debounce map to avoid hammering ingest for the same clientId
const _ingestCooldown = new Map();
async function scheduleIngest(clientId, minMs = 120000) {
  const now = Date.now();
  const last = _ingestCooldown.get(clientId) || 0;
  if (now - last < minMs) return; // cooling down
  _ingestCooldown.set(clientId, now);
  try {
    console.log(`[drive-watch] ingest ${clientId}`);
    await ingestAllForClient(clientId); // includes library + data files
  } catch (e) {
    console.warn("[drive-watch] ingest failed", clientId, e);
  }
}

// Find which client folder a changed file belongs to
async function findOwningClientId(fileId) {
  try {
    const drive = getDrive();
    const meta = await drive.files.get({
      fileId,
      fields: "id,name,parents",
      supportsAllDrives: true,
    });
    const parents = meta.data.parents || [];
    if (!parents.length) return null;

    const ancestors = new Set(parents);
    const stack = [...parents];
    while (stack.length) {
      const cur = stack.pop();
      try {
        const r = await drive.files.get({
          fileId: cur,
          fields: "id,parents,mimeType",
          supportsAllDrives: true,
        });
        (r.data.parents || []).forEach((p) => {
          if (!ancestors.has(p)) {
            ancestors.add(p);
            stack.push(p);
          }
        });
      } catch {
        /* ignore */
      }
    }

    const libs = await getClientLibrariesCached(false);
    const match = libs.find((l) => ancestors.has(l.id));
    return match ? match.id : null;
  } catch {
    return null;
  }
}

// Process a webhook ping: list deltas and trigger ingest
async function processDrivePing(_headers) {
  const state = readWatchState();
  if (!state.startPageToken) {
    state.startPageToken = await getStartPageToken();
    writeWatchState(state);
    return;
  }

  const drive = getDrive();
  let pageToken = state.startPageToken;
  const touched = new Set();

  while (pageToken) {
    const r = await drive.changes.list({
      pageToken,
      fields:
        "changes(fileId,removed,file(id,parents,mimeType,trashed)),newStartPageToken,nextPageToken",
      includeRemoved: true,
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
      pageSize: 100,
      spaces: "drive",
    });

    for (const ch of r.data.changes || []) {
      const fid = ch.fileId || ch?.file?.id;
      if (!fid) continue;
      const clientId = await findOwningClientId(fid);
      if (clientId && !touched.has(clientId)) {
        touched.add(clientId);
        scheduleIngest(clientId); // debounced
      }
    }

    if (r.data.nextPageToken) {
      pageToken = r.data.nextPageToken;
    } else {
      if (r.data.newStartPageToken) {
        state.startPageToken = r.data.newStartPageToken;
        writeWatchState(state);
      }
      break;
    }
  }
}

// -------------------- Drive helpers --------------------
async function listClientFolders() {
  if (!DRIVE_ROOT_FOLDER_ID) return [];
  try {
    const drive = getDrive();
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await drive.files.list({
      q,
      fields: "files(id,name)",
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      orderBy: "name_natural",
    });
    return (r.data.files || []).map((f) => ({ id: f.id, name: f.name }));
  } catch {
    return [];
  }
}

async function driveFolderExists(id) {
  const all = await getClientLibrariesCached(false);
  return all.some((x) => x.id === id);
}

// NOTE: include parents so we can reconstruct paths for Data Files recognition.
async function listAllFilesUnder(folderId) {
  const drive = getDrive();
  const stack = [folderId];
  const out = [];
  while (stack.length) {
    const cur = stack.pop();
    const r = await drive.files.list({
      q: `'${cur}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,webViewLink,modifiedTime,parents)",
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of (r.data.files || [])) {
      if (f.mimeType === "application/vnd.google-apps.folder") stack.push(f.id);
      else out.push(f);
    }
  }
  return out;
}

// Folder meta cache to avoid repeated gets
const _folderMeta = new Map();
async function getFolderMetaCached(folderId) {
  if (!folderId) return null;
  if (_folderMeta.has(folderId)) return _folderMeta.get(folderId);
  try {
    const drive = getDrive();
    const r = await drive.files.get({
      fileId: folderId,
      fields: "id,name,parents,mimeType",
      supportsAllDrives: true,
    });
    _folderMeta.set(folderId, r.data || null);
    return r.data || null;
  } catch {
    _folderMeta.set(folderId, null);
    return null;
  }
}

// Build path names from file parents up to the client root id. Returns array of folder names (closest first).
async function getPathNamesToClient(fileParents, clientRootId) {
  const out = [];
  const visited = new Set();
  const stack = [...(fileParents || [])];
  while (stack.length) {
    const id = stack.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    if (id === clientRootId) break;
    const meta = await getFolderMetaCached(id);
    if (!meta) continue;
    if (meta.name) out.push(meta.name);
    (meta.parents || []).forEach((p) => {
      if (!visited.has(p)) stack.push(p);
    });
  }
  return out.reverse();
}
function pathIncludesSequence(pathNames, seq) {
  const a = pathNames.map((s) => String(s).toLowerCase());
  const b = seq.map((s) => String(s).toLowerCase());
  let j = 0;
  for (let i = 0; i < a.length && j < b.length; i++) {
    if (a[i] === b[j]) j++;
  }
  return j === b.length;
}

// -------------------- Client library cache --------------------
let _libCache = { data: [], ts: 0 };
async function getClientLibrariesCached(force = false) {
  const fresh = Date.now() - _libCache.ts < CLIENT_LIB_TTL_MS;
  if (!force && fresh && _libCache.data?.length) return _libCache.data;
  const libs = await listClientFolders();
  _libCache = { data: libs, ts: Date.now() };
  return libs;
}

// -------------------- Text extractors --------------------
async function extractTextFromFile(file) {
  const drive = getDrive();
  const slides = getSlides();
  const sheets = getSheets();

  if (file.mimeType === "application/vnd.google-apps.document") {
    const r = await drive.files.export(
      { fileId: file.id, mimeType: "text/plain" },
      { responseType: "arraybuffer" }
    );
    return { text: Buffer.from(r.data).toString("utf8") };
  }
  if (file.mimeType === "application/vnd.google-apps.presentation") {
    const pres = await slides.presentations.get({ presentationId: file.id });
    const pages = pres.data.slides || [];
    let text = [];
    for (const page of pages) {
      for (const el of page.pageElements || []) {
        const elements = el.shape?.text?.textElements || [];
        const s = elements.map((t) => t.textRun?.content || "").join("");
        if (s.trim()) text.push(s.trim());      }
    }
    return { text: text.join("\n\n") };
  }
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const s = await sheets.spreadsheets.get({ spreadsheetId: file.id });
    const sheetsList = s.data.sheets || [];
    const ranges = sheetsList
      .slice(0, 3)
      .map((sh) => `'${sh.properties.title}'!A1:Z100`);
    if (!ranges.length) return { text: "" };
    const vals = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: file.id,
      ranges,
    });
    const blocks = (vals.data.valueRanges || []).map((v) =>
      (v.values || []).map((row) => row.join(", ")).join("\n")
    );
    return { text: blocks.filter(Boolean).join("\n\n") };
  }
  return { text: "" };
}

// Extract PDF text with per-page boundaries
async function extractPdfWithPages(file) {
  const drive = getDrive();
  const r = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true, acknowledgeAbuse: true },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(r.data);

  try {
    let pdfjs;
    try {
      pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    } catch {
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    }
    const task = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: false,
    });
    const pdf = await task.promise;
    const pages = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str || "").join(" ").trim();
      pages.push({ page: i, text });
    }
    return { text: pages.map((p) => p.text).join("\n\n"), pages };
  } catch (e) {
    try {
      const mod = await import("pdf-parse");
      const pdfParse = (mod && (mod.default || mod)) || mod;
      const parsed = await pdfParse(buf);
      const t = parsed?.text?.trim() || "";
      return { text: t, pages: [{ page: 1, text: t }] };
    } catch (e2) {
      throw new Error(`PDF text extraction failed: ${String(e2?.message || e2)}`);
    }
  }
}

// -------------------- Utilities --------------------
function chunkText(txt, maxLen = 1800) {
  const chunks = [];
  let i = 0;
  while (i < txt.length) {
    chunks.push(txt.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}
const MONTHS = [
  "january","february","march","april","may","june",
  "july","august","september","october","november","december",
];
function monthNum(name) {
  const idx = MONTHS.indexOf(String(name || "").toLowerCase());
  return idx === -1 ? null : idx + 1;
}
function pad2(n) { return String(n).padStart(2, "0"); }
function latestDateFrom(text, fallbackISO) {
  const s = `${text || ""}`;
  const candidates = [];

  const m1 = s.matchAll(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{4})\b/gi
  );
  for (const m of m1) {
    const mname = m[1];
    const yr = parseInt(m[2], 10);
    const mn = monthNum(mname.startsWith("sep") ? "september" : mname);
    if (mn) candidates.push({ y: yr, m: mn });
  }

  const m2 = s.matchAll(/\b(0?[1-9]|1[0-2])[\/\-_.](\d{4})\b/g);
  for (const m of m2) {
    const mn = parseInt(m[1], 10);
    const yr = parseInt(m[2], 10);
    candidates.push({ y: yr, m: mn });
  }

  candidates.sort((a, b) => (a.y === b.y ? a.m - b.m : a.y - b.y));
  const best = candidates.pop();
  if (best) {
    return {
      month: MONTHS[best.m - 1][0].toUpperCase() + MONTHS[best.m - 1].slice(1),
      year: String(best.y),
      epoch: Date.parse(`${best.y}-${pad2(best.m)}-01T00:00:00Z`),
    };
  }

  if (fallbackISO) {
    const d = new Date(fallbackISO);
    if (!isNaN(d.getTime())) {
      const m = d.getUTCMonth() + 1;
      const y = d.getUTCFullYear();
      return {
        month: MONTHS[m - 1][0].toUpperCase() + MONTHS[m - 1].slice(1),
        year: String(y),
        epoch: Date.parse(`${y}-${pad2(m)}-01T00:00:00Z`),
      };
    }
  }
  return { month: "", year: "", epoch: 0 };
}
function inferReportTag(name, text) {
  const s = `${name} ${text || ""}`.toLowerCase();
  const rules = [
    ["conjoint", /(conjoint|cbc|acbc|choice\s*model|dcm)/i],
    ["ATU", /\batu\b|usage\s*&?\s*attitudes|u&a/i],
    ["message testing", /(message\s*testing|message\s*eval|messag(e|ing)\s*(test|evaluation)|positioning)/i],
    ["tracker", /(tracker|tracking|wave\s*\d+)/i],
    ["segmentation", /(segment|segmentation)/i],
    ["pricing", /(pricing|price\s*(test|study))/i],
    ["demand", /\bdemand\b/i],
    ["concept test", /(concept\s*test|concept\s*study)/i],
    ["qualitative", /\bqual(itative)?\b|focus\s*group|idi\b/i],
    ["quantitative", /\bquant(itative)?\b|\bsurvey\b/i],
    ["PMR", /\bpmr\b|primary\s*market\s*research/i],
  ];
  for (const [label, rx] of rules) if (rx.test(s)) return label;
  return "report";
}
const sanitize = (s) => String(s || "").replace(/[^\w\-:.]/g, "_").slice(0, 128);
function titleFromName(name) {
  return String(name || "").replace(/\.[^.]+$/, "");
}
function toMetricId(label){
  return String(label || '')
    .trim()
    .replace(/[^A-Za-z0-9]+/g,'_')
    .replace(/^_+|_+$/g,'')
    .toUpperCase();
}
async function ensureDir(dir){ try { await fsp.mkdir(dir, { recursive: true }); } catch {} }

// -------------------- Embeddings + Pinecone --------------------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embedTexts(texts) {
  if (!texts?.length) return [];
  const r = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return r.data.map((d) => d.embedding);
}

async function pineconeUpsert(vectors, namespace) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/vectors/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({ vectors, namespace }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function pineconeQuery(vector, namespace, topK = DEFAULT_TOPK) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({ vector, topK, includeMetadata: true, namespace }),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function pineconeDescribe() {
  try {
    const r = await fetch(`${PINECONE_INDEX_HOST}/describe_index_stats`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
      body: JSON.stringify({}),
    });
    if (!r.ok) return {};
    return r.json();
  } catch {
    return {};
  }
}

// -------------------- Auth helpers --------------------
function requireSession(req, res, next) {
  const token = req.get("x-auth-token");
  if (token && token === AUTH_TOKEN) return next();
  if (req.session?.user) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
function requireInternal(req, res, next) {
  if (req.session?.user?.role === "internal") return next();
  return res.status(403).json({ error: "Forbidden" });
}

// -------------------- Pages --------------------
app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  res.set("Cache-Control", "no-store");
  res.sendFile(path.resolve("public/index.html"));
});
app.get("/admin", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  if (req.session.user.role !== "internal") return res.redirect("/");
  res.set("Cache-Control", "no-store");
  res.sendFile(path.resolve("public/admin.html"));
});

// -------------------- Auth APIs --------------------
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const users = readJSON(USERS_PATH, { users: [] }).users;
    const user = users.find((u) => u.username === username);
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(
      String(password || ""),
      String(user.passwordHash || "")
    );
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = {
      username: user.username,
      role: user.role,
      allowedClients: user.allowedClients,
    };
    if (user.role !== "internal") {
      const allowed = user.allowedClients;
      req.session.activeClientId = Array.isArray(allowed)
        ? allowed[0]
        : allowed || null;
    } else {
      req.session.activeClientId = null; // internal must choose
    }
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: "Login failed" });
  }
});
app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// NOTE: Map 'internal' -> 'admin' in the /me response for the UI label
app.get("/me", async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not signed in" });
  const clients = await getClientLibrariesCached(false);
  const me = req.session.user;
  const roleLabel = me.role === "internal" ? "admin" : me.role;
  res.json({
    user: { username: me.username, role: roleLabel },
    activeClientId: req.session.activeClientId || null,
    clients,
  });
});

// Remove a user account
app.post(
  "/admin/users/delete",
  requireSession,
  requireInternal,
  async (req, res) => {
    try {
      const { username } = req.body || {};
      if (!username) return res.status(400).json({ error: "username required" });
      const usersDoc = readJSON(USERS_PATH, { users: [] });
      const before = usersDoc.users.length;
      usersDoc.users = usersDoc.users.filter((u) => u.username !== username);
      if (usersDoc.users.length === before)
        return res.status(404).json({ error: "user not found" });
      writeJSON(USERS_PATH, usersDoc);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: "failed to delete user" });
    }
  }
);

// Allow internal users to switch active client
app.post(
  "/auth/switch-client",
  requireSession,
  requireInternal,
  async (req, res) => {
    const { clientId } = req.body || {};
    if (!(await driveFolderExists(clientId)))
      return res.status(400).json({ error: "Unknown clientId" });
    req.session.activeClientId = clientId;
    res.json({ ok: true });
  }
);

// Back-compat (public) — returns same as /api/client-libraries
app.get("/clients/drive-folders", async (_req, res) => {
  res.json(await getClientLibrariesCached(false));
});

// NEW: Public client library endpoint (cached). Use this from your dropdown.
app.get("/api/client-libraries", async (_req, res) => {
  try {
    const libs = await getClientLibrariesCached(false);
    res.json(libs);
  } catch (e) {
    res.status(500).json({ error: "Failed to load client libraries" });
  }
});

// OPTIONAL: Admin-only cache refresh
app.post(
  "/api/client-libraries/refresh",
  requireSession,
  requireInternal,
  async (_req, res) => {
    try {
      const libs = await getClientLibrariesCached(true);
      res.json({ ok: true, count: libs.length });
    } catch (e) {
      res.status(500).json({ error: "Refresh failed" });
    }
  }
);

// -------------------- Manifest & stats --------------------
const MANIFEST_DIR = path.join(CONFIG_DIR, "manifests");
if (!fs.existsSync(MANIFEST_DIR)) fs.mkdirSync(MANIFEST_DIR, { recursive: true });

function calcSignatureFromFiles(files) {
  const basis = (files || [])
    .filter((f) => f && f.id && f.modifiedTime)
    .map((f) => `${f.id}:${f.modifiedTime}`)
    .sort()
    .join("|");
  return crypto.createHash("sha1").update(basis).digest("hex");
}
function readManifestDoc(clientId) {
  const p = path.join(MANIFEST_DIR, `${clientId}.json`);
  return readJSON(p, null);
}
function writeManifestDoc(clientId, payload) {
  const p = path.join(MANIFEST_DIR, `${clientId}.json`);
  writeJSON(p, payload);
}
async function isLibraryStale(clientId) {
  const files = await listAllFilesUnder(clientId);
  const liveSig = calcSignatureFromFiles(files);
  const liveCount = files.length;
  const man = readManifestDoc(clientId) || {};
  const stale = !man || man.driveSignature !== liveSig;
  return { stale, liveSig, liveCount, files };
}

// -------------------- Ingest (RAG docs) --------------------
async function ingestClientLibrary(clientId) {
  const files = await listAllFilesUnder(clientId);
  const supported = new Set([
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.spreadsheet",
    "application/pdf",
  ]);

  const ingested = [];
  const errors = [];
  let upserted = 0;

  for (const f of files) {
    if (!supported.has(f.mimeType)) continue;

    let text = "";
    let pages = null;
    let status = "complete";
    try {
      if (f.mimeType === "application/pdf") {
        try {
          const resPdf = await extractPdfWithPages(f);
          text = resPdf.text;
          pages = resPdf.pages || null;
        } catch (e) {
          status = String(e?.message || e);
        }
      } else {
        const t = await extractTextFromFile(f);
        text = t.text || "";
        if (!text?.trim()) status = "no text";
      }
    } catch (e) {
      status = String(e?.message || e);
    }

    const tags = latestDateFrom(`${f.name}\n${text || ""}`, f.modifiedTime);
    const report = inferReportTag(f.name, text);
    const monthTag = tags.month || "";
    const yearTag = tags.year || "";
    const recencyEpoch = tags.epoch || 0;

    let chunkCount = 0;
    try {
      if (status === "complete" && text?.trim()) {
        let vectors = [];

        if (f.mimeType === "application/pdf" && Array.isArray(pages) && pages.length) {
          for (const p of pages) {
            if (!p.text?.trim()) continue;
            const parts = chunkText(p.text, 1500);
            const embs = await embedTexts(parts);
            const v = embs.map((vec, i) => ({
              id: `${sanitize(clientId)}:${sanitize(f.id)}:p${p.page}:${i}`,
              values: vec,
              metadata: {
                clientId,
                fileId: f.id,
                fileName: f.name,
                fileUrl: f.webViewLink || "",
                study: f.name,
                date: f.modifiedTime || "",
                text: parts[i].slice(0, 4000),
                monthTag,
                yearTag,
                reportTag: report,
                recencyEpoch,
                page: p.page,
              },
            }));
            vectors = vectors.concat(v);
          }
        } else {
          const parts = chunkText(text, 1800);
          const embs = await embedTexts(parts);
          vectors = embs.map((vec, i) => ({
            id: `${sanitize(clientId)}:${sanitize(f.id)}:${i}`,
            values: vec,
            metadata: {
              clientId,
              fileId: f.id,
              fileName: f.name,
              fileUrl: f.webViewLink || "",
              study: f.name,
              date: f.modifiedTime || "",
              text: parts[i].slice(0, 4000),
              monthTag,
              yearTag,
              reportTag: report,
              recencyEpoch,
            },
          }));
        }

        if (vectors.length) {
          await pineconeUpsert(vectors, clientId);
          upserted += vectors.length;
          chunkCount = vectors.length;
        }
      } else if (status !== "complete") {
        errors.push({ file: f.name, msg: status });
      }
    } catch (e) {
      errors.push({ file: f.name, msg: String(e?.message || e) });
    }

    ingested.push({
      id: f.id,
      name: f.name,
      mimeType: f.mimeType,
      chunks: chunkCount,
      status,
      monthTag,
      yearTag,
      reportTag: report,
    });
  }

  let namespaceVectorCount;
  const stats = await pineconeDescribe();
  try {
    namespaceVectorCount = stats.namespaces?.[clientId]?.vectorCount;
  } catch {}

  const distinct = Array.from(
    new Set(ingested.filter((x) => x.status === "complete").map((x) => x.name))
  );
  const signature = calcSignatureFromFiles(files);
  const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
  writeJSON(manifestPath, {
    clientId,
    updatedAt: new Date().toISOString(),
    driveSignature: signature,
    driveCount: files.length,
    files: distinct,
  });

  return {
    ok: true,
    summary: {
      filesSeen: files.length,
      ingestedCount: ingested.filter((x) => x.status === "complete").length,
      skippedCount: files.filter((f) => !supported.has(f.mimeType)).length,
      errorsCount: errors.length,
      upserted,
      namespaceVectorCount,
    },
    ingested,
    errors,
  };
}

// -------------------- Data Files → cache for charts --------------------
function rowsToVariables(rows) {
  const get = (obj, keys) => {
    for (const k of keys) {
      if (obj[k] != null && String(obj[k]).trim() !== "") return obj[k];
      const found = Object.keys(obj).find(
        (kk) => kk.toLowerCase() === String(k).toLowerCase()
      );
      if (found && String(obj[found]).trim() !== "") return obj[found];
    }
    return undefined;
  };

  const byQ = new Map();
  for (const r of rows) {
    const q = String(get(r, ["Question","Variable","Var","Metric","Name"]) || "").trim();
    const code = String(get(r, ["Code","Value","Category","Option","Choice","Key"]) || "").trim();
    const label = String(get(r, ["Label","Text","Option Label","Answer"]) || code).trim();
    let pctRaw = get(r, ["Pct","Percent","%","Pct.","Percent%","Percentage"]);
    let nRaw   = get(r, ["N","Count","Base","n","Total N"]);
    const table = get(r, ["Table","Source","Q","Sheet"]) || "";

    if (!q || !code) continue;
    const pct = Number(String(pctRaw || "").toString().replace(/[^0-9.\-]/g,""));
    const n   = Number(String(nRaw   || "").toString().replace(/[^0-9.\-]/g,""));

    if (!byQ.has(q)) byQ.set(q, { q, baseN: 0, rows: [], table });
    const bucket = byQ.get(q);
    bucket.rows.push({ value: code, label, pct: isFinite(pct) ? pct : 0, n: isFinite(n) ? n : 0 });
    if (!bucket.baseN && isFinite(n) && n > 0) bucket.baseN = n;
  }

  const variables = {};
  for (const { q, baseN, rows, table } of byQ.values()) {
    const varId = toMetricId(q);
    variables[varId] = {
      label: q,
      type: "single",
      unit: "pct",
      base: { description: "All qualified", n: baseN || 0 },
      codes: rows.map((r) => ({ value: r.value, label: r.label })),
      stats: Object.fromEntries(rows.map((r) => [r.value, { pct: r.pct, n: r.n }])),
      provenance: { table }
    };
  }
  return { variables };
}

async function parseFinalFrequenciesFromXlsxBuffer(buf){
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  if (!ws) throw new Error("No worksheet found");
  const sheet = XLSX.utils.sheet_to_json(ws, { defval: "" });
  return rowsToVariables(sheet);
}

function parseFinalFrequenciesFromCsvText(text){
  const rows = csvParse(text, { columns: true, skip_empty_lines: true });
  return rowsToVariables(rows);
}

async function isFinalFreqFile(file, clientId) {
  const pathNames = await getPathNamesToClient(file.parents || [], clientId);
  return pathIncludesSequence(pathNames, [DATA_FILES_FOLDER, DATA_FINAL_FREQ_SUBFOLDER]);
}

async function inferProjectMeta(file, clientId) {
  const pathNames = await getPathNamesToClient(file.parents || [], clientId);
  let projectName = titleFromName(file.name);
  const dataIdx = pathNames.findIndex(
    (n) => String(n).toLowerCase() === DATA_FILES_FOLDER.toLowerCase()
  );
  if (dataIdx > 0) {
    projectName = pathNames[dataIdx - 1] || projectName;
  }
  const projectId = toMetricId(projectName);
  const title = projectName;
  const rec = latestDateFrom(file.name, file.modifiedTime);
  return {
    projectId, title,
    fieldStart: "", fieldEnd: "",
    recencyEpoch: rec.epoch || Date.parse(file.modifiedTime || "") || 0
  };
}

async function writeProjectCache({ clientId, projectId, title, fieldStart, fieldEnd, recencyEpoch, sourceFiles, variables }){
  const baseDir = path.join(DATA_CACHE_DIR, clientId);
  const projectsDir = path.join(baseDir, "projects");
  await ensureDir(projectsDir);

  const projectPath = path.join(projectsDir, `${projectId}.json`);
  await fsp.writeFile(
    projectPath,
    JSON.stringify({
      project: { projectId, title, fieldStart, fieldEnd, recencyEpoch, sourceFiles },
      variables
    }, null, 2),
    "utf8"
  );

  const indexPath = path.join(baseDir, "index.json");
  let index = { clientId, lastRebuild: new Date().toISOString(), projects: [], metrics: [] };
  try { index = JSON.parse(await fsp.readFile(indexPath, "utf8")); } catch {}
  const pIdx = index.projects.findIndex((p) => p.projectId === projectId);
  const projectMeta = {
    projectId, title, fieldStart, fieldEnd, recencyEpoch, sourceFiles,
    variables: Object.keys(variables).map((varId) => ({
      varId, label: variables[varId].label, type: variables[varId].type || "single", category: "Uncategorized"
    }))
  };
  if (pIdx >= 0) index.projects[pIdx] = projectMeta; else index.projects.push(projectMeta);

  const metricMap = new Map(index.metrics.map((m) => [m.metricId, m]));
  for (const [varId, v] of Object.entries(variables)) {
    if (!metricMap.has(varId)) metricMap.set(varId, { metricId: varId, label: v.label, unit: v.unit || "pct" });
  }
  index.metrics = Array.from(metricMap.values());
  index.lastRebuild = new Date().toISOString();
  await ensureDir(baseDir);
  await fsp.writeFile(indexPath, JSON.stringify(index, null, 2), "utf8");

  const seriesDir = path.join(baseDir, "series");
  await ensureDir(seriesDir);
  for (const [varId, v] of Object.entries(variables)) {
    const sPath = path.join(seriesDir, `${varId}.json`);
    let series = { metricId: varId, label: v.label, unit: v.unit || "pct", series: [] };
    try { series = JSON.parse(await fsp.readFile(sPath, "utf8")); } catch {}

    let value = undefined;
    let baseN = v.base?.n || 0;
    if (v.stats?.Top2Box?.pct != null) value = v.stats.Top2Box.pct;
    else if (v.stats?.index != null) value = v.stats.index;
    else if (v.extras?.mean != null) value = v.extras.mean;
    else {
      const firstKey = v.codes?.[0]?.value;
      if (firstKey && v.stats?.[firstKey]?.pct != null) value = v.stats[firstKey].pct;
    }

    if (value != null) {
      const point = { projectId, xLabel: title, value, baseN, ts: recencyEpoch || 0 };
      const idx = series.series.findIndex((p) => p.projectId === projectId);
      if (idx >= 0) series.series[idx] = point; else series.series.push(point);
      series.series.sort((a,b)=> (a.ts||0)-(b.ts||0) || a.xLabel.localeCompare(b.xLabel, undefined, { numeric:true }));
      await fsp.writeFile(sPath, JSON.stringify(series, null, 2), "utf8");
    }
  }
}

async function ingestClientData(clientId) {
  const drive = getDrive();
  const all = await listAllFilesUnder(clientId);

  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const XLS_MIME = "application/vnd.ms-excel";
  const CSV_MIME = "text/csv";
  const SHEET_MIME = "application/vnd.google-apps.spreadsheet";

  const finalFreqFiles = [];
  for (const f of all) {
    if (![XLSX_MIME, XLS_MIME, CSV_MIME, SHEET_MIME].includes(f.mimeType)) continue;
    if (await isFinalFreqFile(f, clientId)) finalFreqFiles.push(f);
  }

  let parsedCount = 0;
  const parsedProjects = [];

  for (const file of finalFreqFiles) {
    const meta = await inferProjectMeta(file, clientId);
    const sourceFiles = [{ driveId: file.id, name: file.name, lastModified: file.modifiedTime || "" }];

    let variables = {};
    try {
      if (file.mimeType === SHEET_MIME) {
        const r = await drive.files.export(
          { fileId: file.id, mimeType: "text/csv" },
          { responseType: "arraybuffer" }
        );
        const csvText = Buffer.from(r.data).toString("utf8");
        variables = parseFinalFrequenciesFromCsvText(csvText).variables;
      } else if (file.mimeType === CSV_MIME) {
        const r = await drive.files.get(
          { fileId: file.id, alt: "media", supportsAllDrives: true, acknowledgeAbuse: true },
          { responseType: "arraybuffer" }
        );
        const csvText = Buffer.from(r.data).toString("utf8");
        variables = parseFinalFrequenciesFromCsvText(csvText).variables;
      } else if (file.mimeType === XLSX_MIME || file.mimeType === XLS_MIME) {
        const r = await drive.files.get(
          { fileId: file.id, alt: "media", supportsAllDrives: true, acknowledgeAbuse: true },
          { responseType: "arraybuffer" }
        );
        const buf = Buffer.from(r.data);
        variables = (await parseFinalFrequenciesFromXlsxBuffer(buf)).variables;
      } else {
        continue;
      }

      await writeProjectCache({
        clientId,
        projectId: meta.projectId,
        title: meta.title,
        fieldStart: meta.fieldStart,
        fieldEnd: meta.fieldEnd,
        recencyEpoch: meta.recencyEpoch,
        sourceFiles,
        variables
      });

      parsedCount++;
      parsedProjects.push(meta.projectId);
    } catch (e) {
      console.warn("[data-ingest] parse failed:", file.name, e?.message || e);
    }
  }

  return { ok: true, parsedCount, projects: parsedProjects };
}

async function rebuildSeriesForMetric(clientId, metricId){
  const baseDir = path.join(DATA_CACHE_DIR, clientId);
  const projectsDir = path.join(baseDir, "projects");
  const sPath = path.join(baseDir, "series", `${metricId}.json`);
  await ensureDir(path.join(baseDir, "series"));

  let series = { metricId, label: metricId, unit: "pct", series: [] };
  try {
    const files = await fsp.readdir(projectsDir);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const pj = JSON.parse(await fsp.readFile(path.join(projectsDir, f), "utf8"));
      const v = pj.variables?.[metricId];
      if (!v) continue;
      let value = undefined;
      let baseN = v.base?.n || 0;
      if (v.stats?.Top2Box?.pct != null) value = v.stats.Top2Box.pct;
      else if (v.stats?.index != null) value = v.stats.index;
      else if (v.extras?.mean != null) value = v.extras.mean;
      else {
        const firstKey = v.codes?.[0]?.value;
        if (firstKey && v.stats?.[firstKey]?.pct != null) value = v.stats[firstKey].pct;
      }
      if (value != null) {
        series.label = v.label || series.label;
        series.unit = v.unit || series.unit;
        series.series.push({
          projectId: pj.project?.projectId || f.replace(/\.json$/,""),
          xLabel: pj.project?.title || f.replace(/\.json$/,""),
          value, baseN, ts: pj.project?.recencyEpoch || 0
        });
      }
    }
    series.series.sort((a,b)=> (a.ts||0)-(b.ts||0) || a.xLabel.localeCompare(b.xLabel, undefined, { numeric:true }));
  } catch {}
  await fsp.writeFile(sPath, JSON.stringify(series, null, 2), "utf8");
  return series;
}

// -------------------- Stats (simple counts) --------------------
app.get(
  "/admin/library-stats",
  requireSession,
  requireInternal,
  async (req, res) => {
    try {
      const clientId = String(req.query.clientId || "").trim();
      if (!clientId) return res.status(400).json({ error: "clientId required" });
      if (!(await driveFolderExists(clientId)))
        return res.status(400).json({ error: "Unknown clientId" });

      const all = await listAllFilesUnder(clientId);
      const driveCount = all.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      ).length;

      let dataFilesCount = 0;
      let rawDataCount = 0;
      for (const f of all) {
        const pathNames = await getPathNamesToClient(f.parents || [], clientId);
        if (pathIncludesSequence(pathNames, [DATA_FILES_FOLDER, DATA_FINAL_FREQ_SUBFOLDER])) dataFilesCount++;
        if (pathIncludesSequence(pathNames, [DATA_FILES_FOLDER, DATA_RAW_SUBFOLDER])) rawDataCount++;
      }

      const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
      const manifest = readJSON(manifestPath, { files: [] });
      const libraryCount = Array.isArray(manifest.files) ? manifest.files.length : 0;

      res.json({ clientId, driveCount, libraryCount, dataFilesCount, rawDataCount });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to get stats", detail: String(e?.message || e) });
    }
  }
);

// -------------------- Ingest routes --------------------
async function ingestAllForClient(clientId){
  const lib = await ingestClientLibrary(clientId);
  const data = await ingestClientData(clientId);
  return { lib, data };
}

app.post(
  "/admin/ingest-client",
  requireSession,
  requireInternal,
  async (req, res) => {
    try {
      const clientId = req.body?.clientId || req.session.activeClientId;
      if (!clientId) return res.status(400).json({ error: "clientId required" });
      if (!(await driveFolderExists(clientId)))
        return res.status(400).json({ error: "Unknown clientId" });

      const result = await ingestAllForClient(clientId);
      res.json({ ok: true, ...result });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to ingest", detail: String(e?.message || e) });
    }
  }
);

// Token-protected sync endpoint for Render Cron (auto-ingest)
app.post("/admin/ingest/sync", async (req, res) => {
  try {
    const token = req.get("x-auth-token");
    if (!token || token !== AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const { all, clientId, staleOnly = true, maxClients = 50 } = req.body || {};
    let clients = [];

    if (clientId) {
      if (!(await driveFolderExists(clientId)))
        return res.status(400).json({ error: "Unknown clientId" });
      clients = [{ id: clientId }];
    } else if (all) {
      clients = (await getClientLibrariesCached(true)).slice(0, Number(maxClients) || 50);
    } else {
      return res.status(400).json({ error: "Provide clientId or set all:true" });
    }

    const results = [];
    for (const c of clients) {
      const id = c.id || c;
      try {
        const check = await isLibraryStale(id);
        if (staleOnly && !check.stale) {
          results.push({ clientId: id, status: "skipped", reason: "up-to-date" });
          continue;
        }
        const r = await ingestAllForClient(id);
        results.push({ clientId: id, status: "ingested", summary: r.lib?.summary, dataParsed: r.data?.parsedCount });
      } catch (e) {
        results.push({ clientId: id, status: "error", error: String(e?.message || e) });
      }
    }

    res.json({ ok: true, count: results.length, results });
  } catch (e) {
    res.status(500).json({ error: "sync failed", detail: String(e?.message || e) });
  }
});

// -------------------- Drive-watch admin controls --------------------
app.post("/admin/drive-watch/start", async (req, res) => {
  const token = req.get("x-auth-token");
  if (!token || token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ch = await startChangesWatch();
    res.json({ ok: true, channel: ch, startPageToken: readWatchState().startPageToken });
  } catch (e) {
    res.status(500).json({ error: "failed to start watch", detail: String(e?.message || e) });
  }
});
app.post("/admin/drive-watch/stop", async (req, res) => {
  const token = req.get("x-auth-token");
  if (!token || token !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = await stopChangesWatch();
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: "failed to stop watch", detail: String(e?.message || e) });
  }
});

// -------------------- Webhook receiver --------------------
app.post("/webhooks/drive", express.text({ type: "*/*" }), async (req, res) => {
  try {
    if (!DRIVE_WEBHOOK_VERIFY_TOKEN || req.query.token !== DRIVE_WEBHOOK_VERIFY_TOKEN) {
      return res.status(401).end("unauthorized");
    }
    res.status(200).end();
    processDrivePing({
      resourceState: req.get("x-goog-resource-state"),
      resourceId: req.get("x-goog-resource-id"),
      channelId: req.get("x-goog-channel-id"),
      messageNumber: req.get("x-goog-message-number"),
    }).catch((e) => console.warn("[drive-webhook] process error", e));
  } catch {
    try { res.status(200).end(); } catch {}
  }
});

// -------------------- Secondary search (no API key) --------------------
async function fetchSecondaryInfo(query, max = 5) {
  const whitelist =
    "site:fda.gov OR site:ncbi.nlm.nih.gov OR site:who.int OR site:cdc.gov OR site:nejm.org OR site:bmj.com OR site:nature.com OR site:thelancet.com";
  const url =
    "https://duckduckgo.com/html/?q=" +
    encodeURIComponent(`${query} ${whitelist}`);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari",
      },
      redirect: "follow",
    });
    const html = await res.text();

    const items = [];
    // Regex literals with proper escapes:
    const linkRe =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snipRe =
      /<a[^>]*class="[^"]*result__snippet"[^>]*>([\s\S]*?)<\/a>|<a[^>]*>[\s\S]*?<\/a>\s*-\s*<span[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

    let m;
    const links = [];
    while ((m = linkRe.exec(html)) && links.length < max * 2) {
      const url = m[1].replace(/&amp;/g, "&");
      const title = m[2].replace(/<[^>]+>/g, "").trim();
      if (url && title) links.push({ url, title });
    }

    const snippets = [];
    let s;
    while ((s = snipRe.exec(html)) && snippets.length < links.length) {
      const snippet = (s[1] || s[2] || "")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      if (snippet) snippets.push(snippet);
    }

    const out = [];
    for (let i = 0; i < links.length && out.length < max; i++) {
      out.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snippets[i] || "",
      });
    }
    return out;
  } catch (e) {
    console.error("[secondary] failed:", e);
    return [];
  }
}

// -------------------- Support bullet generation --------------------
function buildReferenceBundle(refs) {
  return refs
    .map((r, i) => {
      const tag = `${r.monthTag || ""} ${r.yearTag || ""}`.trim();
      return `[${i + 1}] ${r.study || r.fileName}${tag ? " – " + tag : ""}${r.reportTag ? " • " + r.reportTag : ""}`;
    })
    .join("\n");
}
function extractCitedNumbers(text) {
  const out = new Set();
  if (!text) return [];
  const rx = /\[(\d+)\]/g;
  let m;
  while ((m = rx.exec(text))) {
    const n = parseInt(m[1], 10);
    if (!Number.isNaN(n)) out.add(n);
  }
  return Array.from(out).sort((a, b) => a - b);
}
async function generateSupportBullets({ question, refs, answer }) {
  const refBundle = buildReferenceBundle(refs);
  const system =
    "You write 3–6 concise, well-structured support bullets that directly back up the answer, using only the provided references. Each bullet must be a complete sentence and include bracketed numeric citations like [1] that map to the numbered references list. Prefer newer references. Avoid repeating the exact same phrasing as the answer.";
  const prompt = `Question:\n${question}\n\nAnswer draft:\n${answer}\n\nReferences (numbered):\n${refBundle}\n\nInstructions:\n- Write 3–6 bullets.\n- Each bullet must end with appropriate bracketed citations like [2] or [2][5].\n- Prioritize the most recent evidence.\n- Do not invent sources.\n\nBullets:`;

  const chat = await openai.chat.completions.create({
    model: ANSWER_MODEL,
    messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
    temperature: 0.2,
  });
  const raw = chat.choices?.[0]?.message?.content?.trim() || "";

  const lines = raw
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\-\u2022\*\d\.\s]+/, "").trim())
    .filter(Boolean);

  return lines.slice(0, 8).map((line) => {
    const refsCited = extractCitedNumbers(line);
    const epochs = refsCited
      .map((n) => {
        const idx = n - 1;
        return idx >= 0 && refs[idx] ? Number(refs[idx].recencyEpoch || 0) : 0;
      })
      .filter((e) => e > 0);
    const recencyEpoch = epochs.length ? Math.max(...epochs) : 0;
    const text = /\.\s*$/.test(line) ? line : `${line}.`;
    return { text, refs: refsCited, recencyEpoch };
  });
}

// -------------------- Search --------------------
app.post("/search", requireSession, async (req, res) => {
  try {
    const body = req.body || {};
    const clientId = body.clientId || req.session.activeClientId || null;
    if (!clientId) return res.status(400).json({ error: "clientId missing" });
    const q = String(body.userQuery || "").trim();
    if (!q) return res.status(400).json({ error: "userQuery required" });
    const wantSupport = !!body.generateSupport;

    const emb = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: [q],
    });
    const vec = emb.data[0].embedding;

    const result = await pineconeQuery(vec, clientId, DEFAULT_TOPK);
    let matches = Array.isArray(result.matches) ? result.matches : [];
    if (!matches.length) {
      const secondary = await fetchSecondaryInfo(q, 5);
      return res.json({
        answer: "",
        references: { chunks: [] },
        visuals: [],
        secondary,
        supportingBullets: [],
      });
    }

    const maxEpoch = Math.max(
      ...matches.map((m) => Number(m.metadata?.recencyEpoch || 0)),
      0
    );
    matches = matches
      .map((m) => {
        const base = Number(m.score || 0);
        const epoch = Number(m.metadata?.recencyEpoch || 0);
        const rec = maxEpoch ? epoch / maxEpoch : 0;
        const blend = base * 0.85 + rec * 0.15;
        return { ...m, _blend: blend };
      })
      .sort((a, b) => b._blend - a._blend);

    const refs = matches.map((m) => ({
      id: m.id,
      score: m.score,
      fileId: m.metadata?.fileId || "",
      page: m.metadata?.page || null,
      fileName: m.metadata?.fileName || "",
      fileUrl: m.metadata?.fileUrl || "",
      study: m.metadata?.study || "",
      date: m.metadata?.date || "",
      monthTag: m.metadata?.monthTag || "",
      yearTag: m.metadata?.yearTag || "",
      reportTag: m.metadata?.reportTag || "",
      recencyEpoch: Number(m.metadata?.recencyEpoch || 0) || 0,
      textSnippet: (m.metadata?.text || "").slice(0, 600),
    }));

    const ctx = refs
      .map(
        (r, i) =>
          `[${i + 1}] (${r.study || r.fileName} – ${r.monthTag} ${r.yearTag} • ${r.reportTag}) ${r.textSnippet}`
      )
      .join("\n\n");
    const system =
      "Answer strictly from the context. Include bracketed citations like [1], [2] that correspond to the references order. Prefer more recent tagged reports.";
    const prompt = `Question: ${q}\n\nContext:\n${ctx}\n\nWrite a concise answer (4–7 sentences) with [#] citations. If info is insufficient, say so.`;

    const chat = await openai.chat.completions.create({
      model: ANSWER_MODEL,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      temperature: 0.2,
    });
    const answer = chat.choices?.[0]?.message?.content?.trim() || "";

    let supportingBullets = [];
    if (wantSupport) {
      try {
        supportingBullets = await generateSupportBullets({ question: q, refs, answer });
        supportingBullets.sort((a, b) => (b.recencyEpoch || 0) - (a.recencyEpoch || 0));
      } catch (e) {
        console.warn("[support] generation failed:", e);
        supportingBullets = [];
      }
    }

    const secondary = await fetchSecondaryInfo(q, 5);

    res.json({
      answer,
      references: { chunks: refs },
      visuals: [],
      secondary,
      supportingBullets,
    });
  } catch (e) {
    res.status(500).json({ error: "Search failed", detail: String(e?.message || e) });
  }
});

// -------------------- Chart Query (reads data-cache) --------------------
app.get("/api/chart-query", requireSession, async (req, res) => {
  try {
    let clientId = String(req.query.clientId || "").trim();
    const metricId = String(req.query.metricId || "").trim();
    const segment = String(req.query.segment || "").trim();
    if (!metricId) return res.status(400).json({ error: "metricId required" });

    const isAdmin = req.session?.user?.role === "internal";
    if (!clientId || !isAdmin) {
      clientId = req.session?.activeClientId || null;
    }
    if (!clientId) return res.status(400).json({ error: "clientId required" });

    const baseDir   = path.join(DATA_CACHE_DIR, clientId);
    const indexPath = path.join(baseDir, "index.json");
    const seriesDir = path.join(baseDir, "series");
    const sPath     = path.join(seriesDir, `${metricId}.json`);

    try { await fsp.mkdir(seriesDir, { recursive: true }); } catch {}

    let series;
    try {
      const raw = await fsp.readFile(sPath, "utf8");
      series = JSON.parse(raw);
    } catch {
      series = await rebuildSeriesForMetric(clientId, metricId);
    }

    if (!series || !Array.isArray(series.series) || !series.series.length) {
      return res.status(404).json({ error: "No data for metric" });
    }

    const pts = series.series.slice().sort(
      (a,b) => (a.ts||0)-(b.ts||0) || String(a.xLabel).localeCompare(String(b.xLabel), undefined, { numeric: true })
    );

    const labels = pts.map(p => p.xLabel || p.projectId);
    const values = pts.map(p => (typeof p.value === "number" ? p.value : null));
    const chartType = pts.length <= 2 ? "bar" : "line";

    const table = pts.map(p => ({
      Project: p.xLabel || p.projectId,
      Value: typeof p.value === "number" ? p.value : null,
      "Base N": p.baseN || null
    }));

    const unit = (series.unit || "pct").toLowerCase();
    const footnote = `Trend for ${series.label} across ${pts.length} project${pts.length===1?"":"s"}. Values shown in ${unit === "pct" ? "percent (%)" : unit}.`;

    return res.json({
      chart: {
        type: chartType,
        labels,
        datasets: [{
          label: series.label || metricId,
          data: values
        }]
      },
      table,
      footnote,
      meta: {
        clientId,
        metricId,
        unit: unit === "pct" ? "pct" : unit
      }
        segment: segment || null,
    });
  } catch (e) {
    console.error("[/api/chart-query] error:", e);
    res.status(500).json({ error: "Chart query failed" });
  }
});

// -------------------- Secure PDF proxy --------------------
app.get("/api/drive-pdf", requireSession, async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "").trim();
    if (!fileId) return res.status(400).json({ error: "fileId required" });

    const drive = getDrive();
    let meta;
    try {
      meta = await drive.files.get({
        fileId,
        fields: "id,name,mimeType",
        supportsAllDrives: true,
      });
    } catch (e) {
      console.error("[drive-pdf] meta error:", e?.message || e);
      return res.status(404).json({ error: "File not found or inaccessible" });
    }

    const mt = String(meta?.data?.mimeType || "");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/pdf");

    if (mt === "application/pdf") {
      const r = await drive.files.get(
        { fileId, alt: "media", supportsAllDrives: true, acknowledgeAbuse: true },
        { responseType: "stream" }
      );
      r.data.on("error", (err) => {
        console.error("[drive-pdf] stream error:", err);
        if (!res.headersSent) res.status(500).end("stream error");
      });
      return void r.data.pipe(res);
    }

    if (mt.startsWith("application/vnd.google-apps.")) {
      const r = await drive.files.export(
        { fileId, mimeType: "application/pdf" },
        { responseType: "stream" }
      );
      r.data.on("error", (err) => {
        console.error("[drive-pdf] export stream error:", err);
        if (!res.headersSent) res.status(500).end("stream error");
      });
      return void r.data.pipe(res);
    }

    return res
      .status(415)
      .json({ error: `Unsupported mimeType for direct PDF rendering: ${mt}` });
  } catch (e) {
    console.error("[drive-pdf] failed:", e);
    res.status(500).json({ error: "Failed to fetch PDF" });
  }
});

// -------------------- Health --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// -------------------- Boot --------------------
app.listen(PORT, () => {
  console.log(`mr-broker running on :${PORT}`);
  if (!OPENAI_API_KEY) console.warn("[boot] OPENAI_API_KEY missing");
  if (!PINECONE_API_KEY || !PINECONE_INDEX_HOST)
    console.warn("[boot] Pinecone config missing");
  if (!DRIVE_ROOT_FOLDER_ID) console.warn("[boot] DRIVE_ROOT_FOLDER_ID missing");
  if (!PUBLIC_BASE_URL) console.warn("[boot] PUBLIC_BASE_URL missing (Drive webhooks disabled)");
  console.log(`[cookies] secure=${SECURE_COOKIES}`);
});
