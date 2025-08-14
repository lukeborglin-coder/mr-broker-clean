// server.js — login/session + Google Drive client libraries + RAG search
// Changes:
// - Default EMBEDDING_MODEL -> text-embedding-3-small (1536)
// - Internal users NO LONGER get an auto-selected client
// - /admin/ingest-client returns friendly per-file lists (ingested/skipped/errors) and a summary
// - Optional PDF support via dynamic import (no static pdf-parse import)

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
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath, override: true });

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

const INTERNAL_USERNAME = "cognitive_internal";
const INTERNAL_PASSWORD =
  process.env.INTERNAL_PASSWORD && String(process.env.INTERNAL_PASSWORD).trim()
    ? String(process.env.INTERNAL_PASSWORD).trim()
    : "coggpt25";
const INTERNAL_PASSWORD_HASH =
  process.env.INTERNAL_PASSWORD_HASH && String(process.env.INTERNAL_PASSWORD_HASH).trim()
    ? String(process.env.INTERNAL_PASSWORD_HASH).trim()
    : null;

// -------------------- App --------------------
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: !!process.env.NODE_ENV && process.env.NODE_ENV !== "development",
      maxAge: 1000 * 60 * 60 * 8,
    },
  })
);
app.use(express.static("public"));

// -------------------- Users JSON store --------------------
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
function readJSON(p, fallback) {
  try { if (!fs.existsSync(p)) return fallback; return JSON.parse(fs.readFileSync(p, "utf8") || "null") ?? fallback; }
  catch { return fallback; }
}
function writeJSON(p, obj) { try { fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8"); } catch {} }
(function upsertInternalUser() {
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  const passwordHash = INTERNAL_PASSWORD_HASH || bcrypt.hashSync(INTERNAL_PASSWORD, 10);
  const idx = usersDoc.users.findIndex(u => u.username === INTERNAL_USERNAME);
  if (idx === -1) usersDoc.users.push({ username: INTERNAL_USERNAME, passwordHash, role: "internal", allowedClients: "*" });
  else { usersDoc.users[idx].passwordHash = passwordHash; usersDoc.users[idx].role="internal"; usersDoc.users[idx].allowedClients="*"; }
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
  } else if (GOOGLE_KEYFILE) {
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
function getDrive() { return google.drive({ version: "v3", auth: getAuth() }); }
function getSlides() { return google.slides({ version: "v1", auth: getAuth() }); }
function getSheets() { return google.sheets({ version: "v4", auth: getAuth() }); }

async function listClientFolders() {
  if (!DRIVE_ROOT_FOLDER_ID) return [];
  try {
    const drive = getDrive();
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await drive.files.list({ q, fields: "files(id,name)", pageSize: 200, supportsAllDrives:true, includeItemsFromAllDrives:true });
    return (r.data.files || []).map(f => ({ id:f.id, name:f.name }));
  } catch { return []; }
}
async function driveFolderExists(folderId) {
  const list = await listClientFolders();
  return list.some(x => x.id === folderId);
}

// Recursively list files inside a client folder
async function listAllFilesUnder(folderId) {
  const drive = getDrive();
  const folders = [folderId];
  const files = [];
  while (folders.length) {
    const cur = folders.pop();
    const r = await drive.files.list({
      q: `'${cur}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,webViewLink,modifiedTime)",
      pageSize: 1000,
      supportsAllDrives:true, includeItemsFromAllDrives:true
    });
    for (const f of r.data.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") folders.push(f.id);
      else files.push(f);
    }
  }
  return files;
}

// Extract text from Google file types
async function extractTextFromFile(file) {
  const drive = getDrive();
  const slides = getSlides();
  const sheets = getSheets();

  if (file.mimeType === "application/vnd.google-apps.document") {
    const r = await drive.files.export({ fileId: file.id, mimeType: "text/plain" }, { responseType: "arraybuffer" });
    return Buffer.from(r.data).toString("utf8");
  }
  if (file.mimeType === "application/vnd.google-apps.presentation") {
    const p = await slides.presentations.get({ presentationId: file.id });
    const pages = p.data.slides || [];
    let out = [];
    for (const page of pages) {
      for (const el of page.pageElements || []) {
        const text = el.shape?.text?.textElements || [];
        const s = text.map(t => t.textRun?.content || "").join("");
        if (s.trim()) out.push(s.trim());
      }
    }
    return out.join("\n\n");
  }
  if (file.mimeType === "application/vnd.google-apps.spreadsheet") {
    const s = await sheets.spreadsheets.get({ spreadsheetId: file.id });
    const sheetsList = s.data.sheets || [];
    const ranges = sheetsList.slice(0, 3).map(sh => `'${sh.properties.title}'!A1:Z100`);
    if (!ranges.length) return "";
    const vals = await sheets.spreadsheets.values.batchGet({ spreadsheetId: file.id, ranges });
    const blocks = (vals.data.valueRanges || []).map(v => (v.values || []).map(row => row.join(", ")).join("\n"));
    return blocks.filter(Boolean).join("\n\n");
  }
  return "";
}

// Optional PDF extractor with robust fallback
async function tryExtractPdfText(file) {
  // 1) Download raw PDF bytes from Drive
  const drive = getDrive();
  const r = await drive.files.get(
    { fileId: file.id, alt: "media" },
    { responseType: "arraybuffer" }
  );
  const buf = Buffer.from(r.data);

  // 2) First try: pdf-parse (fast, simple)
  try {
    const mod = await import("pdf-parse");
    const pdfParse = (mod && (mod.default || mod)) || mod;
    if (typeof pdfParse === "function") {
      const parsed = await pdfParse(buf);
      if (parsed?.text?.trim()) return parsed.text;
    }
  } catch (_) {
    // swallow and fall through to pdfjs
  }

  // 3) Fallback: pdfjs-dist (works in Node, resilient)
  try {
    // Try modern export first; fall back to legacy if needed
    let pdfjs;
    try {
      pdfjs = await import("pdfjs-dist/build/pdf.mjs");
    } catch {
      pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    }

    const loadingTask = pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: false
    });
    const pdf = await loadingTask.promise;

    let all = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items.map(it => it.str || "").join(" ");
      if (text.trim()) all.push(text.trim());
    }
    const joined = all.join("\n\n").trim();
    if (joined) return joined;

    throw new Error("Empty text from pdfjs.");
  } catch (e) {
    throw new Error(
      "PDF text extraction failed. Try converting this PDF to a Google Doc or ensure pdf-parse/pdfjs are available. " +
      `Reason: ${String(e?.message || e)}`
    );
  }
}

// -------------------- Pinecone helpers --------------------
async function embedTexts(texts) {
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  if (!texts?.length) return [];
  const resp = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: texts });
  return resp.data.map(d => d.embedding);
}
async function pineconeUpsert(vectors, namespace) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/vectors/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({ vectors, namespace })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function pineconeQuery(vector, namespace, topK = DEFAULT_TOPK) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({ vector, topK, includeMetadata: true, namespace })
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function pineconeDescribe() {
  const r = await fetch(`${PINECONE_INDEX_HOST}/describe_index_stats`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({})
  });
  if (!r.ok) return {};
  return r.json();
}
const sanitize = s => String(s||"").replace(/[^\w\-:.]/g, "_").slice(0,128);

// -------------------- Auth & pages --------------------
function requireSession(req, res, next) {
  const token = req.get("x-auth-token");
  if (token && token === AUTH_TOKEN) return next();
  if (req.session?.user) return next();
  return res.status(401).json({ error: "Unauthorized" });
}
function requireInternal(req, res, next) {
  const user = req.session?.user;
  if (user?.role === "internal") return next();
  return res.status(403).json({ error: "Forbidden" });
}

app.get("/", (req,res)=>{ if(!req.session?.user) return res.redirect("/login.html"); res.sendFile(path.resolve("public/index.html")); });
app.get("/admin", (req,res)=>{ if(!req.session?.user) return res.redirect("/login.html"); if(req.session.user.role!=="internal") return res.redirect("/"); res.sendFile(path.resolve("public/admin.html")); });

// Login: DO NOT auto-select a client for internal users
app.post("/auth/login", async (req,res)=>{
  try{
    const { username, password } = req.body || {};
    const users = readJSON(USERS_PATH, { users: [] }).users;
    const found = users.find(u => u.username === username);
    if (!found) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(String(password||""), String(found.passwordHash||""));
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });
    req.session.user = { username: found.username, role: found.role, allowed: found.allowedClients };
    if (found.role !== "internal") {
      const allowed = found.allowedClients;
      req.session.activeClientId = Array.isArray(allowed) ? allowed[0] : allowed || null;
    } else {
      req.session.activeClientId = null; // internal: must choose
    }
    res.json({ ok:true });
  } catch(e){ res.status(500).json({ error:"Login failed" }); }
});

app.post("/auth/logout",(req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });

app.get("/me", async (req,res)=>{
  if(!req.session?.user) return res.status(401).json({ error:"Not signed in" });
  const clients = await listClientFolders();
  res.json({ user:req.session.user, activeClientId:req.session.activeClientId||null, clients });
});

app.post("/auth/switch-client", requireSession, requireInternal, async (req,res)=>{
  const { clientId } = req.body || {};
  if (!(await driveFolderExists(clientId))) return res.status(400).json({ error:"Unknown clientId" });
  req.session.activeClientId = clientId;
  res.json({ ok:true });
});

app.get("/clients/drive-folders", async (_req,res)=>{ res.json(await listClientFolders()); });

// -------------------- Admin APIs --------------------
app.get("/admin/users/list", requireSession, requireInternal, (_req,res)=>{
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  res.json(usersDoc.users.map(u => ({ username:u.username, role:u.role, allowedClients:u.allowedClients })));
});

app.post("/admin/users/create", requireSession, requireInternal, async (req,res)=>{
  try{
    const { username, password, confirmPassword, clientFolderId } = req.body || {};
    if (!username || !password || !confirmPassword || !clientFolderId) return res.status(400).json({ error:"username, password, confirmPassword, clientFolderId required" });
    if (password !== confirmPassword) return res.status(400).json({ error:"Passwords do not match" });
    if (!(await driveFolderExists(clientFolderId))) return res.status(400).json({ error:"Unknown client folder" });
    const usersDoc = readJSON(USERS_PATH, { users: [] });
    if (usersDoc.users.some(u => u.username === username)) return res.status(400).json({ error:"Username exists" });
    usersDoc.users.push({ username, passwordHash: await bcrypt.hash(String(password),10), role:"client", allowedClients: clientFolderId });
    writeJSON(USERS_PATH, usersDoc);
    res.json({ ok:true });
  }catch(e){ res.status(500).json({ error:"Failed to create user" }); }
});

// Ingest entire client library from Drive (Docs/Slides/Sheets + PDFs optional)
app.post("/admin/ingest-client", requireSession, requireInternal, async (req,res)=>{
  try{
    const clientId = req.body?.clientId || req.session.activeClientId;
    if (!clientId) return res.status(400).json({ error:"clientId required" });
    if (!(await driveFolderExists(clientId))) return res.status(400).json({ error:"Unknown clientId" });

    const files = await listAllFilesUnder(clientId);
    const supportedTypes = new Set([
      "application/vnd.google-apps.document",
      "application/vnd.google-apps.presentation",
      "application/vnd.google-apps.spreadsheet",
      "application/pdf",
    ]);

    const ingested = [];
    const skipped = [];
    const errors = [];
    let totalChunks = 0, upserted = 0;

    for (const f of files) {
      if (!supportedTypes.has(f.mimeType)) {
        skipped.push({ id:f.id, name:f.name, mimeType:f.mimeType, reason:"unsupported type" });
        continue;
      }

      try{
        let text = "";
        if (f.mimeType === "application/pdf") {
          try { text = await tryExtractPdfText(f); }
          catch (e) { skipped.push({ id:f.id, name:f.name, mimeType:f.mimeType, reason:String(e?.message||e) }); continue; }
        } else {
          text = (await extractTextFromFile(f)) || "";
        }
        if (!text.trim()) { skipped.push({ id:f.id, name:f.name, mimeType:f.mimeType, reason:"no text" }); continue; }

        const chunks = chunkText(text, 1800).map((t,i)=>({ idSuffix:i, text:t }));
        totalChunks += chunks.length;
        const embeddings = await embedTexts(chunks.map(c=>c.text));
        const vectors = embeddings.map((vec,i)=>({
          id: `${String(clientId).replace(/[^\w\-:.]/g,"_").slice(0,128)}:${String(f.name).replace(/[^\w\-:.]/g,"_").slice(0,128)}:${String(i)}`,
          values: vec,
          metadata: {
            clientId,
            fileName: f.name,
            fileUrl: f.webViewLink || "",
            study: f.name,
            date: f.modifiedTime || "",
            chunkIndex: String(i),
            text: chunks[i].text.slice(0,4000)
          }
        }));
        await pineconeUpsert(vectors, clientId);
        upserted += vectors.length;
        ingested.push({ id:f.id, name:f.name, mimeType:f.mimeType, chunks:vectors.length });
      }catch(e){
        errors.push({ file:f.name, msg:String(e?.message||e) });
      }
    }

    let namespaceVectorCount;
    try {
      const stats = await pineconeDescribe();
      namespaceVectorCount = stats.namespaces?.[clientId]?.vectorCount;
    } catch {}

    res.json({
      ok:true,
      summary: {
        filesSeen: files.length,
        ingestedCount: ingested.length,
        skippedCount: skipped.length,
        errorsCount: errors.length,
        totalChunks,
        upserted,
        namespaceVectorCount
      },
      ingested,
      skipped,
      errors
    });
  }catch(e){
    res.status(500).json({ error:"Failed to ingest", detail:String(e?.message||e) });
  }
});

// -------------------- Search --------------------
app.post("/search", requireSession, async (req,res)=>{
  try{
    const headerToken = req.get("x-auth-token");
    const usingToken = headerToken && headerToken === AUTH_TOKEN;

    const user = req.session?.user;
    const body = req.body || {};
    const clientId = body.clientId || req.session.activeClientId || null;
    if (!clientId) return res.status(400).json({ error:"clientId missing" });

    if (!usingToken && user?.role !== "internal") {
      const usersDoc = readJSON(USERS_PATH, { users: [] });
      const u = usersDoc.users.find(x => x.username === user.username);
      const allowed = u?.allowedClients;
      const permitted = allowed === "*" || (Array.isArray(allowed) && allowed.includes(clientId)) || allowed === clientId;
      if (!permitted) return res.status(403).json({ error:"Client not allowed" });
    }

    const userQuery = String(body.userQuery || "").trim();
    if (!userQuery) return res.status(400).json({ error:"userQuery required" });

    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const [qEmb] = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: [userQuery] }).then(r => r.data.map(d=>d.embedding));
    const out = await pineconeQuery(qEmb, clientId, DEFAULT_TOPK);
    const matches = Array.isArray(out.matches) ? out.matches : [];

    if (!matches.length) {
      return res.json({ answer: "", references: { chunks: [] }, visuals: [] });
    }

    const refs = matches.map(m => ({
      id: m.id,
      score: m.score,
      fileName: m.metadata?.fileName || "",
      fileUrl: m.metadata?.fileUrl || "",
      study: m.metadata?.study || "",
      date: m.metadata?.date || "",
      textSnippet: (m.metadata?.text || "").slice(0, 500)
    }));

    const sys = "You are a pharma market research assistant. Answer strictly from the provided context. Use bracketed numeric citations like [1], [2] mapping to the references order. Be concise and factual.";
    const ctx = refs.map((r,i)=>`[${i+1}] (${r.study || r.fileName} ${r.date||""}) ${r.textSnippet}`).join("\n\n");
    const prompt = `Question: ${userQuery}\n\nContext:\n${ctx}\n\nWrite a 4–7 sentence answer summarizing the most relevant facts, with [#] citations. If information is insufficient, say so.`;

    const chat = await openai.chat.completions.create({ model: ANSWER_MODEL, messages:[{role:"system",content:sys},{role:"user",content:prompt}], temperature:0.2 });
    const answer = chat.choices?.[0]?.message?.content?.trim() || "";

    res.json({ answer, references:{ chunks: refs }, visuals:[] });
  }catch(e){
    res.status(500).json({ error:"Search failed", detail:String(e?.message||e) });
  }
});

// -------------------- Health --------------------
app.get("/health", (_req,res)=>res.json({ok:true}));

app.listen(PORT, ()=>{
  console.log(`mr-broker running on :${PORT}`);
  if (!OPENAI_API_KEY) console.warn("[boot] OPENAI_API_KEY missing");
  if (!PINECONE_API_KEY || !PINECONE_INDEX_HOST) console.warn("[boot] Pinecone config missing");
  if (!DRIVE_ROOT_FOLDER_ID) console.warn("[boot] DRIVE_ROOT_FOLDER_ID missing");
});


