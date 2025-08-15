// server.js — auth + Drive crawl + RAG + auto-tagging + recency re-ranking
// Adds: "Secondary Information" web results in /search; maps 'internal' -> 'admin' in /me
// Adds: Role selection in /admin/users/create; /admin/library-stats; manifest write on ingest
// Fixes: defines chunkText() and uses it correctly; robust ingest + tags (month/year/report)
// NEW: /api/client-libraries — live-from-Drive dropdown (cached), so no manual updates on deploy
// UPDATES (Aug 2025):
// - Admin creation no longer requires a client folder; admins get access to all libraries ("*").
// - Session cookie security is controlled by SECURE_COOKIES env (false OK for local/dev).
// - Send Cache-Control: no-store for .html/.css/.js (and for "/" + "/admin") to avoid stale UI.
// - Minor: /auth/login now stores allowedClients consistently.

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { google } from "googleapis";

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

async function listAllFilesUnder(folderId) {
  const drive = getDrive();
  const stack = [folderId];
  const out = [];
  while (stack.length) {
    const cur = stack.pop();
    const r = await drive.files.list({
      q: `'${cur}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of r.data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") stack.push(f.id);
      else out.push(f);
    }
  }
  return out;
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
    return Buffer.from(r.data).toString("utf8");
  }
  if (file.mimeType === "application/vnd.google-apps.presentation") {
    const pres = await slides.presentations.get({ presentationId: file.id });
    const pages = pres.data.slides || [];
    let text = [];
    for (const page of pages) {
      for (const el of page.pageElements || []) {
        const elements = el.shape?.text?.textElements || [];
        const s = elements.map((t) => t.textRun?.content || "").join("");
        if (s.trim()) text.push(s.trim());
      }
    }
    return text.join("\n\n");
  }
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const s = await sheets.spreadsheets.get({ spreadsheetId: file.id });
    const sheetsList = s.data.sheets || [];
    const ranges = sheetsList
      .slice(0, 3)
      .map((sh) => `'${sh.properties.title}'!A1:Z100`);
    if (!ranges.length) return "";
    const vals = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: file.id,
      ranges,
    });
    const blocks = (vals.data.valueRanges || []).map((v) =>
      (v.values || []).map((row) => row.join(", ")).join("\n")
    );
    return blocks.filter(Boolean).join("\n\n");
  }
  return "";
}

// PDF extractor with robust fallback (optional libs)
async function tryExtractPdfText(file) {
  // Download bytes
  const drive = getDrive();
  const r = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(r.data);

  // First try pdf-parse
  try {
    const mod = await import("pdf-parse");
    const pdfParse = (mod && (mod.default || mod)) || mod;
    if (typeof pdfParse === "function") {
      const parsed = await pdfParse(buf);
      if (parsed?.text?.trim()) return parsed.text;
    }
  } catch {}

  // Fallback to pdfjs-dist (try modern then legacy path)
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
    let all = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map((it) => it.str || "").join(" ");
      if (text.trim()) all.push(text.trim());
    }
    return all.join("\n\n");
  } catch (e) {
    throw new Error(`PDF text extraction failed: ${String(e?.message || e)}`);
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
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
function monthNum(name) {
  const idx = MONTHS.indexOf(String(name || "").toLowerCase());
  return idx === -1 ? null : idx + 1;
}
function pad2(n) {
  return String(n).padStart(2, "0");
}
function latestDateFrom(text, fallbackISO) {
  const s = `${text || ""}`;
  const candidates = [];

  // Month name + year (e.g., June 2025)
  const m1 = s.matchAll(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december)\s+(\d{4})\b/gi
  );
  for (const m of m1) {
    const mname = m[1];
    const yr = parseInt(m[2], 10);
    const mn = monthNum(mname.startsWith("sep") ? "september" : mname);
    if (mn) candidates.push({ y: yr, m: mn });
  }

  // numeric mm/yyyy or m/yyyy
  const m2 = s.matchAll(/\b(0?[1-9]|1[0-2])[\/\-_\.](\d{4})\b/g);
  for (const m of m2) {
    const mn = parseInt(m[1], 10);
    const yr = parseInt(m[2], 10);
    candidates.push({ y: yr, m: mn });
  }

  // choose latest
  candidates.sort((a, b) => (a.y === b.y ? a.m - b.m : a.y - b.y));
  const best = candidates.pop();
  if (best) {
    return {
      month:
        MONTHS[best.m - 1][0].toUpperCase() + MONTHS[best.m - 1].slice(1),
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

const sanitize = (s) => String(s || "").replace(/[^\w\-:.]/g, "_").slice(0, 128);

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

// OPTIONAL: Admin-only cache refresh (e.g., to bust cache immediately after adding folders)
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

// -------------------- Admin APIs --------------------
app.get(
  "/admin/users/list",
  requireSession,
  requireInternal,
  (_req, res) => {
    const usersDoc = readJSON(USERS_PATH, { users: [] });
    res.json(
      usersDoc.users.map((u) => ({
        username: u.username,
        role: u.role,
        allowedClients: u.allowedClients,
      }))
    );
  }
);

// UPDATED: role-aware creation. Admins (role=internal) do NOT require clientFolderId.
app.post(
  "/admin/users/create",
  requireSession,
  requireInternal,
  async (req, res) => {
    try {
      const {
        username,
        password,
        confirmPassword,
        clientFolderId,
        role,
      } = req.body || {};
      if (!username || !password || !confirmPassword)
        return res
          .status(400)
          .json({ error: "username, password, confirmPassword required" });
      if (password !== confirmPassword)
        return res.status(400).json({ error: "Passwords do not match" });

      const normalizedRole =
        String(role || "client").toLowerCase() === "admin" ? "internal" : "client";

      // For clients, a valid Drive folder is required.
      if (normalizedRole !== "internal") {
        if (!clientFolderId)
          return res.status(400).json({ error: "clientFolderId required for client" });
        if (!(await driveFolderExists(clientFolderId)))
          return res.status(400).json({ error: "Unknown client folder" });
      }

      const usersDoc = readJSON(USERS_PATH, { users: [] });
      if (usersDoc.users.some((u) => u.username === username))
        return res.status(400).json({ error: "Username exists" });

      const record = {
        username,
        passwordHash: await bcrypt.hash(String(password), 10),
        role: normalizedRole,
        allowedClients: normalizedRole === "internal" ? "*" : clientFolderId,
      };
      usersDoc.users.push(record);
      writeJSON(USERS_PATH, usersDoc);

      res.json({
        ok: true,
        user: { username: record.username, role: record.role, allowedClients: record.allowedClients },
      });
    } catch {
      res.status(500).json({ error: "Failed to create user" });
    }
  }
);

// -------------------- Manifest & stats --------------------
const MANIFEST_DIR = path.join(CONFIG_DIR, "manifests");
if (!fs.existsSync(MANIFEST_DIR)) fs.mkdirSync(MANIFEST_DIR, { recursive: true });

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

      // Count current Drive files (non-folders)
      const all = await listAllFilesUnder(clientId);
      const driveCount = all.filter(
        (f) => f.mimeType !== "application/vnd.google-apps.folder"
      ).length;

      // Count library (manifest) files if present
      const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
      const manifest = readJSON(manifestPath, { files: [] });
      const libraryCount = Array.isArray(manifest.files) ? manifest.files.length : 0;

      res.json({ clientId, driveCount, libraryCount });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to get stats", detail: String(e?.message || e) });
    }
  }
);

// Ingest library (Docs/Slides/Sheets + PDFs when possible) with auto-tagging
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
        let status = "complete";
        try {
          if (f.mimeType === "application/pdf") {
            try {
              text = await tryExtractPdfText(f);
            } catch (e) {
              status = String(e?.message || e);
            }
          } else {
            text = await extractTextFromFile(f);
            if (!text?.trim()) status = "no text";
          }
        } catch (e) {
          status = String(e?.message || e);
        }

        // Auto-tags (even if no text, we can use name/modifiedTime)
        const tags = latestDateFrom(`${f.name}\n${text || ""}`, f.modifiedTime);
        const report = inferReportTag(f.name, text);
        const monthTag = tags.month || "";
        const yearTag = tags.year || "";
        const recencyEpoch = tags.epoch || 0;

        let chunkCount = 0;
        if (status === "complete" && text?.trim()) {
          const parts = chunkText(text, 1800);
          const embeddings = await embedTexts(parts);
          const vectors = embeddings.map((vec, i) => ({
            id: `${sanitize(clientId)}:${sanitize(f.name)}:${i}`,
            values: vec,
            metadata: {
              clientId,
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
          if (vectors.length) {
            await pineconeUpsert(vectors, clientId);
            upserted += vectors.length;
            chunkCount = vectors.length;
          }
        } else {
          // mark as error
          errors.push({ file: f.name, msg: status });
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

      // --- NEW: write/update manifest with distinct ingested file names
      try {
        const distinct = Array.from(
          new Set(ingested.filter((x) => x.status === "complete").map((x) => x.name))
        );
        const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
        writeJSON(manifestPath, {
          clientId,
          updatedAt: new Date().toISOString(),
          files: distinct,
        });
      } catch (e) {
        console.warn("[manifest] write failed:", e);
      }

      res.json({
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
      });
    } catch (e) {
      res
        .status(500)
        .json({ error: "Failed to ingest", detail: String(e?.message || e) });
    }
  }
);

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

// -------------------- Search --------------------
app.post("/search", requireSession, async (req, res) => {
  try {
    const body = req.body || {};
    const clientId = body.clientId || req.session.activeClientId || null;
    if (!clientId) return res.status(400).json({ error: "clientId missing" });
    const q = String(body.userQuery || "").trim();
    if (!q) return res.status(400).json({ error: "userQuery required" });

    // Embedding for the query
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
      });
    }

    // Recency-aware sort (use tags if present)
    const maxEpoch = Math.max(
      ...matches.map((m) => Number(m.metadata?.recencyEpoch || 0)),
      0
    );
    matches = matches
      .map((m) => {
        const base = Number(m.score || 0);
        const epoch = Number(m.metadata?.recencyEpoch || 0);
        const rec = maxEpoch ? epoch / maxEpoch : 0;
        const blend = base * 0.85 + rec * 0.15; // small recency boost
        return { ...m, _blend: blend };
      })
      .sort((a, b) => b._blend - a._blend);

    const refs = matches.map((m) => ({
      id: m.id,
      score: m.score,
      fileName: m.metadata?.fileName || "",
      fileUrl: m.metadata?.fileUrl || "",
      study: m.metadata?.study || "",
      date: m.metadata?.date || "",
      monthTag: m.metadata?.monthTag || "",
      yearTag: m.metadata?.yearTag || "",
      reportTag: m.metadata?.reportTag || "",
      textSnippet: (m.metadata?.text || "").slice(0, 600),
    }));

    const ctx = refs
      .map(
        (r, i) =>
          `[${i + 1}] (${r.study || r.fileName} – ${r.monthTag} ${
            r.yearTag
          } • ${r.reportTag}) ${r.textSnippet}`
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

    const secondary = await fetchSecondaryInfo(q, 5);

    res.json({ answer, references: { chunks: refs }, visuals: [], secondary });
  } catch (e) {
    res.status(500).json({ error: "Search failed", detail: String(e?.message || e) });
  }
});

// --- Drive children listing for admin tree ----
app.get(
  "/admin/drive/children",
  requireSession,
  requireInternal,
  async (req, res) => {
    try {
      const parentId = String(req.query.parentId || "").trim();
      if (!parentId) return res.status(400).json({ error: "parentId required" });

      const drive = getDrive();
      // Folders
      const fr = await drive.files.list({
        q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name)",
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: "name_natural",
      });
      // Files (non-folders)
      const r = await drive.files.list({
        q: `'${parentId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
        fields: "files(id,name,mimeType)",
        pageSize: 1000,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        orderBy: "name_natural",
      });

      res.json({
        folders: (fr.data.files || []).map((f) => ({ id: f.id, name: f.name })),
        files: (r.data.files || []).map((f) => ({ id: f.id, name: f.name })),
      });
    } catch (e) {
      res.status(500).json({ error: "Failed to list children" });
    }
  }
);

// -------------------- Health --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`mr-broker running on :${PORT}`);
  if (!OPENAI_API_KEY) console.warn("[boot] OPENAI_API_KEY missing");
  if (!PINECONE_API_KEY || !PINECONE_INDEX_HOST)
    console.warn("[boot] Pinecone config missing");
  if (!DRIVE_ROOT_FOLDER_ID) console.warn("[boot] DRIVE_ROOT_FOLDER_ID missing");
  console.log(`[cookies] secure=${SECURE_COOKIES}`);
});
