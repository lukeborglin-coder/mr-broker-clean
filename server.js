// server.js — stable baseline for client chatbot project
// Endpoints:
//   POST /upsert-chunks  -> { clientId, fileName, fileUrl, study, date, chunks:[{idSuffix,text}] }
//   POST /search         -> { clientId, userQuery, topK }
// Behavior:
//   - Pinecone namespace per clientId
//   - Returns { answer, bullets, quotes, references } for UI
//   - Helpful diagnostics routes and explicit error messages

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// ---------- Env + App ----------
const envPath = path.resolve(process.cwd(), ".env");
dotenv.config({ path: envPath, override: true });

const PORT = Number(process.env.PORT || 3000);
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const PINECONE_API_KEY = process.env.PINECONE_API_KEY || "";
const PINECONE_INDEX_HOST = process.env.PINECONE_INDEX_HOST || ""; // e.g. https://myindex-xxxx.svc.us-east1-gcp.pinecone.io
const DEFAULT_CLIENT_ID = process.env.DEFAULT_CLIENT_ID || "demo";

if (!OPENAI_API_KEY) console.warn("[warn] OPENAI_API_KEY not set");
if (!PINECONE_API_KEY) console.warn("[warn] PINECONE_API_KEY not set");
if (!PINECONE_INDEX_HOST) console.warn("[warn] PINECONE_INDEX_HOST not set (required)");
if (!AUTH_TOKEN) console.warn("[warn] AUTH_TOKEN not set — set one for production");

const app = express();
app.use(express.json({ limit: "20mb" }));
app.use(cors());
app.use(express.static("public"));

// ---------- Auth ----------
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next(); // local/dev
  const token = req.get("x-auth-token");
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "Unauthorized: missing/invalid x-auth-token" });
  }
  next();
});

// ---------- Clients ----------
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const pine = new Pinecone({ apiKey: PINECONE_API_KEY });
const index = PINECONE_INDEX_HOST
  ? pine.Index(PINECONE_INDEX_HOST) // SDK supports host alias
  : null;

// ---------- Helpers ----------
function ns(clientId) {
  return (clientId || "").trim() || DEFAULT_CLIENT_ID;
}

function cleanQuotesKeepPeriod(s) {
  if (!s) return "";
  let t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    t = t.slice(1, -1).trim();
  }
  return t;
}

function shapeForUi(answerText, matches) {
  // Build bullets from the top few retrieved chunks' first sentences
  const bullets = [];
  const quotes = [];
  const references = [];

  (matches || []).slice(0, 6).forEach((m) => {
    const txt = (m?.metadata?.text || "").trim();
    const fileName = m?.metadata?.fileName || m?.metadata?.title || "Untitled";
    const firstSentence = txt.split(/(?<=\.)\s+/)[0] || txt;
    if (firstSentence) bullets.push(firstSentence.replace(/\.\s*$/, "") + ".");
    // Create clean quote candidates from the same sentence
    if (firstSentence) quotes.push(cleanQuotesKeepPeriod(firstSentence));
    references.push({
      title: m?.metadata?.title || fileName,
      fileName,
      page: m?.metadata?.page,
      slide: m?.metadata?.slide,
    });
  });

  // Deduplicate quotes & references lightly
  const qset = new Set();
  const quotesUnique = [];
  for (const q of quotes) {
    const k = q.toLowerCase();
    if (!qset.has(k)) {
      qset.add(k);
      quotesUnique.push(q.endsWith(".") ? q : q + ".");
    }
  }

  const rset = new Set();
  const refsUnique = [];
  for (const r of references) {
    const key = (r.title || r.fileName || "").toLowerCase();
    if (!rset.has(key)) {
      rset.add(key);
      refsUnique.push(r);
    }
  }

  return {
    answer: answerText || "",
    bullets: bullets.slice(0, 6),
    quotes: quotesUnique.slice(0, 6),
    references: refsUnique.slice(0, 12),
  };
}

// ---------- Diagnostics ----------
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/env", (req, res) => {
  res.json({
    PORT,
    DEFAULT_CLIENT_ID,
    hasAuthToken: Boolean(AUTH_TOKEN),
    openaiKeyLen: (OPENAI_API_KEY || "").length,
    pineKeyLen: (PINECONE_API_KEY || "").length,
    pineHost: PINECONE_INDEX_HOST,
  });
});
app.get("/whoami", (req, res) => res.json({ clientIdDefault: DEFAULT_CLIENT_ID }));
app.get("/ping-pinecone", async (req, res) => {
  try {
    if (!index) return res.status(500).json({ error: "Pinecone index not configured" });
    const stats = await index.describeIndexStats();
    res.json({ ok: true, stats });
  } catch (e) {
    res.status(500).json({ error: "Pinecone error", detail: String(e?.message || e) });
  }
});

// ---------- Ingest ----------
app.post("/upsert-chunks", async (req, res) => {
  try {
    if (!index) return res.status(500).json({ error: "PINECONE_INDEX_HOST is not configured" });

    const { clientId, fileName, fileUrl, study, date, chunks } = req.body || {};
    if (!Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "No chunks provided" });
    }

    const namespace = ns(clientId);

    const vectors = chunks.map((c, i) => {
      const id = `${fileName || "file"}:${c.idSuffix ?? i}`;
      return {
        id,
        values: [], // we will use server-side sparse embeddings; keep empty for now if using hybrid
        metadata: {
          text: c.text,
          fileName,
          fileUrl,
          study,
          date,
        },
      };
    });

    // If you're using text-embedding for dense vectors, compute here:
    // const emb = await openai.embeddings.create({ model: "text-embedding-3-large", input: chunks.map(c => c.text) })
    // and map to vectors[i].values = emb.data[i].embedding

    await index.namespace(namespace).upsert(vectors);
    res.json({ ok: true, upserted: vectors.length, namespace });
  } catch (e) {
    console.error("upsert-chunks error:", e);
    res.status(500).json({ error: "Failed to upsert", detail: String(e?.message || e) });
  }
});

// ---------- Search ----------
app.post("/search", async (req, res) => {
  try {
    if (!index) return res.status(500).json({ error: "PINECONE_INDEX_HOST is not configured" });

    const { clientId, userQuery, topK = 6 } = req.body || {};
    const namespace = ns(clientId);

    if (!userQuery || !String(userQuery).trim()) {
      return res.status(400).json({ error: "userQuery is required" });
    }

    // Get a query embedding (you can switch to hybrid if you’ve set it up)
    const embed = await openai.embeddings.create({
      model: "text-embedding-3-large",
      input: userQuery,
    });
    const qvec = embed.data[0].embedding;

    const results = await index.namespace(namespace).query({
      vector: qvec,
      topK: Math.max(3, Math.min(24, Number(topK) || 6)),
      includeMetadata: true,
    });

    const matches = results?.matches || [];
    if (!matches.length) {
      return res.json({
        answer: "",
        bullets: [],
        quotes: [],
        references: [],
        note: `No hits in Pinecone for clientId="${namespace}". Check clientId and ingestion.`,
      });
    }

    // Build a compact context for the LLM
    const context = matches
      .slice(0, 12)
      .map((m, i) => `#${i + 1} (${m?.metadata?.fileName || "file"})\n${m?.metadata?.text || ""}`)
      .join("\n\n---\n\n");

    const prompt = `
You are a research analyst. Answer the question using ONLY the provided context.
If you can compute a trend (e.g., 79% -> 83%) prefer the latest.
Cite supporting details in bullet form, and pull 2-4 short quotes from the text.
Keep quotes without outer double quotes, but keep ending periods.

QUESTION:
${userQuery}

CONTEXT:
${context}

Write JSON with keys: answer (string), bullets (array of 3-6 strings), quotes (array of 2-4 strings).
`;

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      messages: [
        { role: "system", content: "You output strictly compact JSON." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    let draft = {};
    try {
      draft = JSON.parse(completion.choices?.[0]?.message?.content || "{}");
    } catch {
      draft = {};
    }

    // Ensure UI shape & add references
    const ui = shapeForUi(draft?.answer || "", matches);
    if (Array.isArray(draft?.bullets)) ui.bullets = draft.bullets;
    if (Array.isArray(draft?.quotes)) ui.quotes = draft.quotes.map(cleanQuotesKeepPeriod);

    res.json(ui);
  } catch (e) {
    console.error("search error:", e);
    res.status(500).json({ error: "Search failed", detail: String(e?.message || e) });
  }
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`mr-broker running on :${PORT}`);
});
