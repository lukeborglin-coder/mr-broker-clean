// server.js — full drop-in with login, admin, sessions, and Pinecone/OpenAI RAG
// - Preserves /upsert-chunks and /search endpoints
// - Adds session-based login (internal + client users), admin UI, and client restrictions
// - Uses Pinecone REST (index host via PINECONE_INDEX_HOST) and OpenAI embeddings

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import OpenAI from "openai";

// ---------------- Env + App ----------------
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath, override: true });

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "dev-auth-token";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST; // like https://xxxx.svc.eu-west1-aws.pinecone.io

if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY not set");
if (!PINECONE_API_KEY) console.warn("[warn] PINECONE_API_KEY not set");
if (!PINECONE_INDEX_HOST) console.warn("[warn] PINECONE_INDEX_HOST not set");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));
app.use(cors());

// ---------- Sessions ----------
const SESSION_SECRET = process.env.SESSION_SECRET || AUTH_TOKEN || "change-me";
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

// ---------- Minimal static serving ----------
app.use(express.static("public"));

// ---------- Mini JSON storage (users + clients) ----------
const CONFIG_DIR = path.resolve(process.cwd(), "config");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
const CLIENTS_PATH = path.join(CONFIG_DIR, "clients.json");

if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });

function readJSON(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8") || "null") ?? fallback;
  } catch (e) {
    console.error("[json] failed to read", p, e);
    return fallback;
  }
}

function writeJSON(p, obj) {
  try {
    fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
  } catch (e) {
    console.error("[json] failed to write", p, e);
  }
}

// Seed default internal user + an example client if files missing
(function seed() {
  if (!fs.existsSync(USERS_PATH)) {
    const seeded = {
      users: [
        {
          username: "cognitive_internal",
          // bcrypt hash for "coggpt25"
          passwordHash: "{INTERNAL_HASH_PLACEHOLDER}",
          role: "internal",
          allowedClients: "*"
        }
      ]
    };
    writeJSON(USERS_PATH, seeded);
    console.log("[seed] wrote config/users.json with internal account");
  }
  if (!fs.existsSync(CLIENTS_PATH)) {
    const seeded = {
      clients: [
        { id: "demo", name: "Demo Client", driveFolderId: "", subfolders: { reports: "", dataFiles: "", qnrs: "" } }
      ]
    };
    writeJSON(CLIENTS_PATH, seeded);
    console.log("[seed] wrote config/clients.json with demo client");
  }
})();

// After seeding, if placeholder is present, replace with env or a default hash
(function ensureInternalHash() {
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  let changed = false;
  for (const u of usersDoc.users) {
    if (u.username === "cognitive_internal" && u.passwordHash === "{INTERNAL_HASH_PLACEHOLDER}") {
      // Default to hash of "coggpt25" unless INTERNAL_HASH env is provided
      const envHash = process.env.INTERNAL_PASSWORD_HASH;
      u.passwordHash = envHash || "$2b$10$d4Ulzzx9nGf/ClBCgQTW6.12lZAtiwvTuKgA3BBVnSe6onWG6Nvpe"; // will replace later below
      changed = true;
    }
  }
  if (changed) writeJSON(USERS_PATH, usersDoc);
})();

// Replace the placeholder with the dynamic one before server start (safer when file just created)
try {
  const raw = fs.readFileSync(USERS_PATH, "utf8");
  if (raw.includes("{INTERNAL_HASH_PLACEHOLDER}")) {
    const replaced = raw.replace("{INTERNAL_HASH_PLACEHOLDER}", process.env.INTERNAL_PASSWORD_HASH || "$2b$10$d4Ulzzx9nGf/ClBCgQTW6.12lZAtiwvTuKgA3BBVnSe6onWG6Nvpe");
    fs.writeFileSync(USERS_PATH, replaced, "utf8");
  }
} catch {}

// ---------- Helpers ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

async function embedTexts(texts) {
  if (!texts || !texts.length) return [];
  const resp = await openai.embeddings.create({
    model: "text-embedding-3-large",
    input: texts
  });
  return resp.data.map(d => d.embedding);
}

async function pineconeUpsert(vectors, namespace) {
  const url = `${PINECONE_INDEX_HOST}/vectors/upsert`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": PINECONE_API_KEY
    },
    body: JSON.stringify({ vectors, namespace })
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Pinecone upsert failed: ${r.status} ${r.statusText} — ${detail}`);
  }
  return r.json();
}

async function pineconeQuery(vector, namespace, topK = 6) {
  const url = `${PINECONE_INDEX_HOST}/query`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Api-Key": PINECONE_API_KEY
    },
    body: JSON.stringify({
      vector,
      topK,
      includeMetadata: true,
      namespace
    })
  });
  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`Pinecone query failed: ${r.status} ${r.statusText} — ${detail}`);
  }
  return r.json();
}

function sanitizeIdPart(s) {
  return String(s || "")
    .replace(/[^\w\-:.]/g, "_")
    .slice(0, 128);
}

// ---------- Auth middlewares ----------
function requireSession(req, res, next) {
  if (req.session?.user) return next();
  // allow token-based programmatic calls (e.g., Power Automate) to proceed for ingestion
  const token = req.get("x-auth-token");
  if (token && token === AUTH_TOKEN) return next();
  return res.status(401).json({ error: "Unauthorized" });
}

function requireInternal(req, res, next) {
  const user = req.session?.user;
  if (user?.role === "internal") return next();
  return res.status(403).json({ error: "Forbidden" });
}

// ---------- Pages ----------
app.get("/", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  res.sendFile(path.resolve("public/index.html"));
});

app.get("/admin", (req, res) => {
  if (!req.session?.user) return res.redirect("/login.html");
  if (req.session.user.role !== "internal") return res.redirect("/");
  res.sendFile(path.resolve("public/admin.html"));
});

// ---------- Basic auth API ----------
app.post("/auth/login", async (req, res) => {
  try {
    const { username, password, selectedClientId } = req.body || {};
    const usersDoc = readJSON(USERS_PATH, { users: [] });
    const found = usersDoc.users.find(u => u.username === username);
    if (!found) return res.status(401).json({ error: "Invalid credentials" });
    const ok = await bcrypt.compare(String(password || ""), String(found.passwordHash || ""));
    if (!ok) return res.status(401).json({ error: "Invalid credentials" });

    // session user
    req.session.user = { username: found.username, role: found.role, allowed: found.allowedClients };
    // choose active client
    if (found.role === "internal") {
      const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
      const clientIds = clientsDoc.clients.map(c => c.id);
      if (selectedClientId && clientIds.includes(selectedClientId)) {
        req.session.activeClientId = selectedClientId;
      } else {
        req.session.activeClientId = clientIds[0] || null;
      }
    } else {
      // client user
      if (Array.isArray(found.allowedClients) && found.allowedClients.length) {
        req.session.activeClientId = found.allowedClients[0];
      } else if (found.allowedClients && found.allowedClients !== "*") {
        req.session.activeClientId = found.allowedClients;
      } else {
        req.session.activeClientId = null;
      }
    }
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Login failed" });
  }
});

app.post("/auth/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/me", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not signed in" });
  const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
  res.json({
    user: req.session.user,
    activeClientId: req.session.activeClientId || null,
    clients: clientsDoc.clients.map(c => ({ id: c.id, name: c.name }))
  });
});

app.post("/auth/switch-client", (req, res) => {
  if (!req.session?.user) return res.status(401).json({ error: "Not signed in" });
  const { clientId } = req.body || {};
  const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
  const exists = clientsDoc.clients.some(c => c.id === clientId);
  if (!exists) return res.status(400).json({ error: "Unknown clientId" });
  if (req.session.user.role !== "internal") {
    // must be allowed
    const udoc = readJSON(USERS_PATH, { users: [] });
    const u = udoc.users.find(x => x.username === req.session.user.username);
    const allowed = u?.allowedClients;
    const all = allowed === "*" || (Array.isArray(allowed) && allowed.includes(clientId)) || allowed === clientId;
    if (!all) return res.status(403).json({ error: "Client not allowed" });
  }
  req.session.activeClientId = clientId;
  res.json({ ok: true });
});

// Public list of clients (id + name) for login dropdown
app.get("/clients/public-list", (req, res) => {
  const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
  res.json(clientsDoc.clients.map(c => ({ id: c.id, name: c.name })));
});

// ---------- Admin APIs (internal only) ----------
app.get("/admin/users/list", requireSession, requireInternal, (req, res) => {
  const usersDoc = readJSON(USERS_PATH, { users: [] });
  const scrubbed = usersDoc.users.map(u => ({ username: u.username, role: u.role, allowedClients: u.allowedClients }));
  res.json(scrubbed);
});

app.post("/admin/users/create", requireSession, requireInternal, async (req, res) => {
  try {
    const { username, password, allowedClients } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    const usersDoc = readJSON(USERS_PATH, { users: [] });
    if (usersDoc.users.some(u => u.username === username)) return res.status(400).json({ error: "Username exists" });
    const passwordHash = await bcrypt.hash(String(password), 10);
    usersDoc.users.push({ username, passwordHash, role: "client", allowedClients: allowedClients || [] });
    writeJSON(USERS_PATH, usersDoc);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create user" });
  }
});

app.get("/admin/clients/list", requireSession, requireInternal, (req, res) => {
  const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
  res.json(clientsDoc.clients);
});

app.post("/admin/clients/upsert", requireSession, requireInternal, (req, res) => {
  try {
    const { id, name, driveFolderId, subfolders } = req.body || {};
    if (!id || !name) return res.status(400).json({ error: "id and name required" });
    const clientsDoc = readJSON(CLIENTS_PATH, { clients: [] });
    const idx = clientsDoc.clients.findIndex(c => c.id === id);
    const item = { id, name, driveFolderId: driveFolderId || "", subfolders: { reports: "", dataFiles: "", qnrs: "", ...(subfolders || {}) } };
    if (idx >= 0) clientsDoc.clients[idx] = item;
    else clientsDoc.clients.push(item);
    writeJSON(CLIENTS_PATH, clientsDoc);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to upsert client" });
  }
});

// ---------- Ingestion: POST /upsert-chunks ----------
// Header: x-auth-token: AUTH_TOKEN (for automation) OR logged-in internal
app.post("/upsert-chunks", requireSession, async (req, res) => {
  // allow automation via token:
  const token = req.get("x-auth-token");
  if (!(req.session?.user?.role === "internal") && token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const { clientId, fileName, fileUrl, study, date, chunks } = req.body || {};
    if (!clientId || !chunks || !Array.isArray(chunks) || !chunks.length) {
      return res.status(400).json({ error: "clientId and chunks[] required" });
    }

    const texts = chunks.map(c => String(c.text || ""));
    const embeddings = await embedTexts(texts);

    const vectors = embeddings.map((vec, i) => ({
      id: `${sanitizeIdPart(clientId)}:${sanitizeIdPart(fileName || "file")}:${sanitizeIdPart(chunks[i].idSuffix ?? i)}`,
      values: vec,
      metadata: {
        clientId,
        fileName: fileName || "",
        fileUrl: fileUrl || "",
        study: study || "",
        date: date || "",
        chunkIndex: String(chunks[i].idSuffix ?? i),
        text: texts[i].slice(0, 4000)
      }
    }));

    const up = await pineconeUpsert(vectors, clientId);
    res.json({ ok: true, upserted: up });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to upsert", detail: String(e?.message || e) });
  }
});

// ---------- Search: POST /search ----------
app.post("/search", requireSession, async (req, res) => {
  try {
    const token = req.get("x-auth-token");
    const usingToken = token && token === AUTH_TOKEN;

    const user = req.session?.user;
    const body = req.body || {};
    const topK = Math.min(Number(body.topK || 6), 15);

    // Determine clientId
    let clientId = body.clientId || req.session?.activeClientId || null;
    if (!clientId) return res.status(400).json({ error: "clientId missing" });

    // Enforce client restrictions unless using token
    if (!usingToken && user?.role !== "internal") {
      const usersDoc = readJSON(USERS_PATH, { users: [] });
      const u = usersDoc.users.find(x => x.username === user.username);
      const allowed = u?.allowedClients;
      const permitted = allowed === "*" || (Array.isArray(allowed) && allowed.includes(clientId)) || allowed === clientId;
      if (!permitted) return res.status(403).json({ error: "Client not allowed" });
    }

    const userQuery = String(body.userQuery || "").trim();
    if (!userQuery) return res.status(400).json({ error: "userQuery required" });

    const [qEmb] = await embedTexts([userQuery]);
    const out = await pineconeQuery(qEmb, clientId, topK);
    const matches = Array.isArray(out.matches) ? out.matches : [];

    const refs = matches.map(m => ({
      id: m.id,
      score: m.score,
      fileName: m.metadata?.fileName || "",
      fileUrl: m.metadata?.fileUrl || "",
      study: m.metadata?.study || "",
      date: m.metadata?.date || "",
      textSnippet: (m.metadata?.text || "").slice(0, 500)
    }));

    // Build a concise grounded answer
    const sys = `You are a pharma market research assistant. Answer strictly from the provided context. Cite with [#] markers that map to the provided references order. Be concise.`;
    const contextBlocks = refs.map((r, i) => `[${i+1}] (${r.study || r.fileName} ${r.date || ""}) ${r.textSnippet}`).join("\n\n");
    const prompt = `Question: ${userQuery}\n\nContext:\n${contextBlocks}\n\nWrite a 4-7 sentence answer summarizing the most relevant facts, with [#] citations.`;

    const chat = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: prompt }
      ],
      temperature: 0.2
    });

    const answer = chat.choices?.[0]?.message?.content?.trim() || "I don't have enough information.";

    res.json({
      answer,
      references: { chunks: refs },
      visuals: []
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Search failed", detail: String(e?.message || e) });
  }
});

// ---------- Health ----------
app.get("/health", (req, res) => res.json({ ok: true }));

// ---------- Fallback: redirect unauth users to login ----------
app.use((req, res, next) => {
  if (!req.session?.user && req.accepts("html")) return res.redirect("/login.html");
  next();
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`mr-broker running on :${PORT}`);
});
