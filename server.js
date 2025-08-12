import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cors()); // allow browser-based demo to call the API

// ✅ Serve the frontend mockup
app.use(express.static("public"));

// Health check
app.get("/health", (req, res) => res.json({ ok: true }));

// Auth check middleware — only for API routes
app.use((req, res, next) => {
  // Only protect these endpoints
  if (
    req.path.startsWith("/search") ||
    req.path.startsWith("/upsert-chunks") ||
    req.path.startsWith("/create-report")
  ) {
    const token = req.get("x-auth-token");
    if (process.env.AUTH_TOKEN && token !== process.env.AUTH_TOKEN) {
      return res.status(401).json({ error: "Unauthorized" });
    }
  }
  next();
});

// Ingestion: upsert chunks into Pinecone
app.post("/upsert-chunks", async (req, res) => {
  try {
    const { clientId, fileName, fileUrl, study, date, chunks } = req.body;
    if (!clientId || !Array.isArray(chunks) || chunks.length === 0) {
      return res.status(400).json({ error: "Missing clientId or chunks" });
    }

    // 1) Get embeddings from OpenAI (batch)
    const embedResp = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { model: "text-embedding-3-small", input: chunks.map(c => c.text) },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    // 2) Prepare Pinecone vectors
    const vectors = embedResp.data.data.map((e, i) => ({
      id: `${fileName || "doc"}-${chunks[i].idSuffix ?? i}`,
      values: e.embedding,
      metadata: {
        clientId: clientId || "",
        fileName: fileName || "",
        fileUrl: fileUrl || "",
        study: study || "",
        date: date || "",
        pageOrSlide: 0,
        chunkText: chunks[i].text || ""
      }
    }));

    // 3) Upsert into Pinecone
    await axios.post(
      `${process.env.PINECONE_INDEX_HOST}/vectors/upsert`,
      { namespace: clientId, vectors },
      { headers: { "Api-Key": process.env.PINECONE_API_KEY } }
    );

    res.json({ ok: true, upserted: vectors.length });
  } catch (err) {
    console.error("Upsert error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Upsert failed", detail: err?.response?.data || err.message });
  }
});

// Search: query Pinecone and ask OpenAI to draft answer
app.post("/search", async (req, res) => {
  try {
    const { clientId, userQuery, topK = 6 } = req.body;
    if (!clientId || !userQuery) {
      return res.status(400).json({ error: "Missing clientId or userQuery" });
    }

    // 1) Embed the user query
    const qEmbed = await axios.post(
      "https://api.openai.com/v1/embeddings",
      { model: "text-embedding-3-small", input: userQuery },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );
    const vector = qEmbed.data.data[0].embedding;

    // 2) Query Pinecone
    const qResp = await axios.post(
      `${process.env.PINECONE_INDEX_HOST}/query`,
      { namespace: clientId, vector, topK, includeMetadata: true },
      { headers: { "Api-Key": process.env.PINECONE_API_KEY } }
    );

    const matches = (qResp.data.matches || []).map(m => m.metadata);

    // 3) Ask OpenAI to write a grounded answer
    const contextLines = matches.map(m =>
      `- [${m.fileName} — ${m.study} (${m.date})] ${m.chunkText}\nLink: ${m.fileUrl}`
    ).join("\n");

    const messages = [
      {
        role: "system",
        content: "Answer strictly from the provided context. If unsure, say what's missing. Always include a 'Sources' list with 'fileName — study (date) → fileUrl'. If a trend or KPI is mentioned, describe the direction (up/down/flat) and waves; do not invent numbers."
      },
      {
        role: "user",
        content: `Question: ${userQuery}\n\nContext:\n${contextLines}\n\nProduce a concise answer (3–6 sentences) followed by:\nSources:\n• fileName — study (date) → fileUrl`
      }
    ];

    const chatResp = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      { model: "gpt-4o-mini", temperature: 0.2, messages },
      { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` } }
    );

    res.json({
      answer: chatResp.data.choices?.[0]?.message?.content || "",
      sources: matches
    });
  } catch (err) {
    console.error("Search error:", err?.response?.data || err.message);
    res.status(500).json({ error: "Search failed", detail: err?.response?.data || err.message });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`mr-broker running on :${port}`));
