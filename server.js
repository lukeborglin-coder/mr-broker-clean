// server.js — Express app with login, sessions, Google Drive client folders, and RAG search
// This file is a full replacement that *updates your existing functionality*:
// - Keeps /search and /upsert-chunks endpoints (auth-gated)
// - Adds session login (cognitive_internal / coggpt25) and client-user accounts
// - Shows client libraries from Drive subfolders of DRIVE_ROOT_FOLDER_ID (no manual subfolder config)
// - Admin page is only accessible after login; client-user creation requires username/password/confirm + client folder
// - Removes any UI dependency on "Top K" (server uses DEFAULT_TOPK internally)

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

// Auth / security
const SESSION_SECRET = process.env.SESSION_SECRET || "change-me";
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-auth-token"; // header-based token for ingestion if desired

// RAG config
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "text-embedding-3-large";
const ANSWER_MODEL = process.env.ANSWER_MODEL || "gpt-4o-mini";
const DEFAULT_TOPK = Number(process.env.DEFAULT_TOPK || 6);

// Pinecone (using REST)
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST || ""; // e.g., https://XXXX-XXXX.svc.YYYY-1.pinecone.io

// Google Drive Root (top-level secure library folder)
const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID || "";

// Google auth (either a keyfile path or raw JSON)
const GOOGLE_KEYFILE = process.env.GOOGLE_APPLICATION_CREDENTIALS || "";
const GOOGLE_CREDENTIALS_JSON = process.env.GOOGLE_CREDENTIALS_JSON || "";

// -------------------- App Setup --------------------
const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "15mb" }));

// Sessions (MemoryStore for simplicity; swap to Redis for production)
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: !!process.env.NODE_ENV && process.env.NODE_ENV !== "development",
      maxAge: 1000 * 60 * 60 * 8, // 8 hours
    },
  })
);

// Static files
app.use(express.static("public"));

// -------------------- Lightweight JSON "DB" --------------------
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}
function readJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    const data = fs.readFileSync(p, "utf8");
    return (data && JSON.parse(data)) ?? fallback;
  } catch (e) {
    console.error("[json] read error:", e?.message || e);
    return fallback;
  }
}
function writeJSON(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("[json] write error:", e?.message || e);
  }
}

// Seed internal user if file absent
(function seedInternalUser() {
  ensureConfigDir();
  if (!fs.existsSync(USERS_PATH)) {
    // bcrypt hash for "coggpt25" (precomputed). You can override with INTERNAL_PASSWORD_HASH.
    const defaultHash =
      process.env.INTERNAL_PASSWORD_HASH ||
      "$2b$10$wU2s/7vQ5U5mZHsajCwQXOFQ8cJk8N3U3m4l5o9pQJ6y0yqJ4b2x2";
    const seeded = {
      users: [
        {
          username: "cognitive_internal",
          passwordHash: defaultHash,
          role: "internal",
          allowedClients: "*", // can access/switch to any client library
        },
      ],
    };
    writeJSON(USERS_PATH, seeded);
    console.log("[seed] created config/users.json with internal account");
  }
})();

// -------------------- Google Drive Helpers --------------------
function getDrive() {
  // Accept either a keyfile path or raw JSON credentials
  let auth;
  if (GOOGLE_CREDENTIALS_JSON) {
    try {
      const creds = JSON.parse(GOOGLE_CREDENTIALS_JSON);
      auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      });
    } catch (e) {
      throw new Error("Invalid GOOGLE_CREDENTIALS_JSON: " + (e?.message || e));
    }
  } else if (GOOGLE_KEYFILE) {
    auth = new google.auth.GoogleAuth({
      keyFile: GOOGLE_KEYFILE,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  } else {
    throw new Error(
      "Missing Google credentials. Set GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_CREDENTIALS_JSON."
    );
  }
  return google.drive({ version: "v3", auth });
}

/**
 * Lists direct subfolders under the DRIVE_ROOT_FOLDER_ID; each is a "client library".
 * Returns: [{ id, name }]
 */
async function listClientFolders() {
  if (!DRIVE_ROOT_FOLDER_ID) return [];
  try {
    const drive = getDrive();
    const q = `'${DRIVE_ROOT_FOLDER_ID}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const r = await drive.files.list({
      q,
      fields: "files(id, name)",
      pageSize: 200,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    return (r.data.files || []).map((f) => ({ id: f.id, name: f.name }));
  } catch (e) {
    console.error("[drive] listClientFolders:", e?.message || e);
    return [];
  }
}

async function driveFolderExists(folderId) {
  if (!folderId) return false;
  const list = await listClientFolders();
  return list.some((f) => f.id === folderId);
}

// -------------------- Middleware --------------------
function requireSession(req, res, next) {
  // Permit header token for ingestion only
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

// -------------------- Pages --------------------
app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  res.sendFile(path.resolve("public/index.html"));
});
app.get("/admin", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  if (req.session.user.role !== "internal") return res.redirect("/");
  res.sendFile(path.resolve("public/admin.html"));
});

// -------------------- Auth APIs --------------------
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password, selectedClientId } = req.body || {};
    const usersDoc = readJSON(USERS_PATH, { users: [] });
    const found = usersDoc.users.find((u) => u.username === username);
    if (!found) return res.status(401).json({ error: "Invalid credentials" });

    const ok = await bcrypt.compare(
      String(password || ""),
      String(found.passwordHash || "")
    );
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    req.session.user = {
      username: found.username,
      role: found.role,
      allowed: found.allowedClients,
    };

    // Set active client library for the session
    if (found.role === "internal") {
      // internal can optionally pick a client on the login screen
      let active = null;
      if (selectedClientId && (await driveFolderExists(selectedClientId))) {
        active = selectedClientId;
      } else {
        const folders = await listClientFolders();
        active = folders[0]?.id || null; // fallback to first available
      }
      req.session.activeClientId = active;
    } else {
      // client user: forced to their allowed client library
      const allowed = found.allowedClients;
      req.session.activeClientId = Array.isArray(allowed)
        ? allowed[0]
        : allowed || null;
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[auth/login] error:", e?.message || e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/me", async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not signed in" });
  try {
    const clients = await listClientFolders();
    res.json({
      user: req.session.user,
      activeClientId: req.session.activeClientId || null,
      clients,
    });
  } catch (e) {
    res.status(200).json({
      user: req.session.user,
      activeClientId: req.session.activeClientId || null,
      clients: [],
      warning: "Could not list Drive folders. Check DRIVE_ROOT_FOLDER_ID and credentials.",
    });
  }
});

// Internal users can switch the active client
app.post("/auth/switch-client", requireSession, requireInternal, async (req, res) => {
  const { clientId } = req.body || {};
  if (!(await driveFolderExists(clientId))) {
    return res.status(400).json({ error: "Unknown clientId (not found under Drive root)" });
  }
  req.session.activeClientId = clientId;
  res.json({ ok: true });
});

// Public (no auth) helper to show available client libraries on login (for internal user dropdown)
app.get("/clients/drive-folders", async (_req, res) => {
  const folders = await listClientFolders();
  res.json(folders);
});
// Alias (kept for compatibility if you referenced it anywhere else)
app.get("/clients/public-list", async (_req, res) => {
  const folders = await listClientFolders();
  res.json(folders);
});

// -------------------- Admin APIs (internal only) --------------------
// List users (scrub hash)
app.get("/admin/users/list", requireSession, requireInternal, (_req, res) => {
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  const scrubbed = usersDoc.users.map((u) => ({
    username: u.username,
    role: u.role,
    allowedClients: u.allowedClients,
  }));
  res.json(scrubbed);
});

// Create client user with username/password/confirm + clientFolderId
app.post("/admin/users/create", requireSession, requireInternal, async (req, res) => {
  try {
    const { username, password, confirmPassword, clientFolderId } = req.body || {};
    if (!username || !password || !confirmPassword || !clientFolderId) {
      return res
        .status(400)
        .json({ error: "username, password, confirmPassword, and clientFolderId are required" });
    }
    if (password !== confirmPassword) {
      return res.status(400).json({ error: "Passwords do not match" });
    }
    if (!(await driveFolderExists(clientFolderId))) {
      return res.status(400).json({ error: "Unknown client folder under Drive root" });
    }

    const usersDoc = readJSON(USERS_PATH, { users: [] });
    if (usersDoc.users.some((u) => u.username === username)) {
      return res.status(400).json({ error: "Username already exists" });
    }

    const passwordHash = await bcrypt.hash(String(password), 10);
    usersDoc.users.push({
      username,
      passwordHash,
      role: "client",
      allowedClients: clientFolderId,
    });
    writeJSON(USERS_PATH, usersDoc);
    res.json({ ok: true });
  } catch (e) {
    console.error("[admin/users/create] error:", e?.message || e);
    res.status(500).json({ error: "Failed to create user" });
  }
});

// -------------------- RAG Helpers --------------------
if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY not set");
if (!PINECONE_API_KEY) console.warn("[warn] PINECONE_API_KEY not set");
if (!PINECONE_INDEX_HOST) console.warn("[warn] PINECONE_INDEX_HOST not set");
if (!DRIVE_ROOT_FOLDER_ID) console.warn("[warn] DRIVE_ROOT_FOLDER_ID not set");

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embedTexts(texts) {
  if (!texts?.length) return [];
  const resp = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return resp.data.map((d) => d.embedding);
}

async function pineconeUpsert(vectors, namespace) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/vectors/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({ vectors, namespace }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Pinecone upsert failed: ${r.status} ${r.statusText} — ${detail}`);
  }
  return r.json();
}

async function pineconeQuery(vector, namespace, topK = DEFAULT_TOPK) {
  const r = await fetch(`${PINECONE_INDEX_HOST}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Api-Key": PINECONE_API_KEY },
    body: JSON.stringify({
      vector,
      topK,
      includeMetadata: true,
      namespace,
    }),
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Pinecone query failed: ${r.status} ${r.statusText} — ${detail}`);
  }
  return r.json();
}

function sanitizeIdPart(s) {
  return String(s || "").replace(/[^\w\-:.]/g, "_").slice(0, 128);
}

// -------------------- Ingestion --------------------
// POST /upsert-chunks
// Body: { clientId, fileName, fileUrl, study, date, chunks: [{ idSuffix?, text }] }
// Requires: (a) logged-in internal user OR (b) x-auth-token header = AUTH_TOKEN
app.post("/upsert-chunks", requireSession, async (req, res) => {
  const headerToken = req.get("x-auth-token");
  const isInternal = req.session?.user?.role === "internal";
  if (!isInternal && headerToken !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { clientId, fileName, fileUrl, study, date, chunks } = req.body || {};
    if (!clientId || !Array.isArray(chunks) || !chunks.length) {
      return res.status(400).json({ error: "clientId and chunks[] are required" });
    }
    // Confirm clientId maps to a Drive client folder (prevents typos creating stray namespaces)
    if (!(await driveFolderExists(clientId))) {
      return res.status(400).json({ error: "Unknown clientId (not a Drive client folder)" });
    }

    const texts = chunks.map((c) => String(c.text || ""));
    const embs = await embedTexts(texts);

    const vectors = embs.map((vec, i) => ({
      id: `${sanitizeIdPart(clientId)}:${sanitizeIdPart(fileName || "file")}:${sanitizeIdPart(
        chunks[i].idSuffix ?? i
      )}`,
      values: vec,
      metadata: {
        clientId,
        fileName: fileName || "",
        fileUrl: fileUrl || "",
        study: study || "",
        date: date || "",
        chunkIndex: String(chunks[i].idSuffix ?? i),
        text: texts[i].slice(0, 4000),
      },
    }));

    const up = await pineconeUpsert(vectors, clientId);
    res.json({ ok: true, upserted: up });
  } catch (e) {
    console.error("[upsert-chunks] error:", e?.message || e);
    res.status(500).json({ error: "Failed to upsert", detail: String(e?.message || e) });
  }
});

// -------------------- Search --------------------
// POST /search
// Body: { userQuery, clientId? } (clientId optional for internal users; otherwise taken from session)
// Returns: { answer, references: { chunks: [...] }, visuals: [] }
app.post("/search", requireSession, async (req, res) => {
  try {
    const headerToken = req.get("x-auth-token");
    const usingToken = headerToken && headerToken === AUTH_TOKEN;

    const user = req.session?.user;
    const body = req.body || {};

    // Determine namespace (client library)
    let clientId = body.clientId || req.session?.activeClientId || null;
    if (!clientId) return res.status(400).json({ error: "clientId missing" });

    // Enforce client-user restrictions (internal can access any)
    if (!usingToken && user?.role !== "internal") {
      const usersDoc = readJSON(USERS_PATH, { users: [] });
      const u = usersDoc.users.find((x) => x.username === user.username);
      const allowed = u?.allowedClients;
      const permitted =
        allowed === "*" ||
        (Array.isArray(allowed) && allowed.includes(clientId)) ||
        allowed === clientId;
      if (!permitted) return res.status(403).json({ error: "Client not allowed" });
    }

    const userQuery = String(body.userQuery || "").trim();
    if (!userQuery) return res.status(400).json({ error: "userQuery required" });

    // Embed query -> Pinecone similarity
    const [qEmb] = await embedTexts([userQuery]);
    const out = await pineconeQuery(qEmb, clientId, DEFAULT_TOPK);
    const matches = Array.isArray(out.matches) ? out.matches : [];

    const refs = matches.map((m) => ({
      id: m.id,
      score: m.score,
      fileName: m.metadata?.fileName || "",
      fileUrl: m.metadata?.fileUrl || "",
      study: m.metadata?.study || "",
      date: m.metadata?.date || "",
      textSnippet: (m.metadata?.text || "").slice(0, 500),
    }));

    // Build concise, cited answer
    const sys =
      "You are a pharma market research assistant. Answer strictly from the provided context. Use bracketed numeric citations like [1], [2] that map to the order of provided references. Be concise and factual.";
    const contextBlocks = refs
      .map(
        (r, i) => `[${i + 1}] (${r.study || r.fileName} ${r.date || ""}) ${r.textSnippet}`
      )
      .join("\n\n");
    const prompt = `Question: ${userQuery}

Context:
${contextBlocks}

Write a 4–7 sentence answer summarizing the most relevant facts, with [#] citations. If the context is insufficient, say so.`.trim();

    const chat = await openai.chat.completions.create({
      model: ANSWER_MODEL,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt },
      ],
      temperature: 0.2,
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "I don't have enough information.";

    res.json({
      answer,
      references: { chunks: refs },
      visuals: [],
    });
  } catch (e) {
    console.error("[search] error:", e?.message || e);
    res.status(500).json({ error: "Search failed", detail: String(e?.message || e) });
  }
});

// -------------------- Health & Errors --------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// 404
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

// Error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("[unhandled]", err?.stack || err);
  res.status(500).json({ error: "Internal error" });
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`mr-broker running on :${PORT}`);
  if (!OPENAI_API_KEY) console.warn("[boot] OPENAI_API_KEY missing");
  if (!PINECONE_API_KEY || !PINECONE_INDEX_HOST) console.warn("[boot] Pinecone config missing");
  if (!DRIVE_ROOT_FOLDER_ID) console.warn("[boot] DRIVE_ROOT_FOLDER_ID missing");
});
