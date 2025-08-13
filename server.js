// server.js — recency‑aware synthesis + conversational headline + supporting detail/quotes
// + client-side slide rendering support

import fs from "node:fs";
import path from "node:path";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { google } from "googleapis";
import OpenAI from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

// ---------- Env / App ----------
dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });
const PORT = process.env.PORT || 3000;

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

// ---------- Name / Date helpers ----------
function cleanReportName(name) {
  if (!name) return "Untitled";
  let n = String(name).replace(/\.pdf$/i, "");
  n = n.replace(/([_\-]\d{6,8})$/i, "");     // _111324, -20250115
  n = n.replace(/([_\-]Q[1-4]\d{4})$/i, ""); // _Q42024
  n = n.replace(/([_\-][WV]\d{1,2})$/i, ""); // _W6
  n = n.replace(/([_\-]v\d+)$/i, "");        // _v2
  return n.trim();
}
function dateFromName(name) {
  const s = String(name || "");
  let m;
  m = s.match(/(20\d{2})[-_ ]?(0[1-9]|1[0-2])/); if (m) return new Date(+m[1], +m[2]-1, 1).getTime();
  m = s.match(/Q([1-4])\s?20(\d{2})/i);        if (m) return new Date(2000+ +m[2], (+m[1]-1)*3, 1).getTime();
  m = s.match(/(20\d{2})/);                    if (m) return new Date(+m[1], 0, 1).getTime();
  m = s.match(/(0[1-9]|1[0-2])([0-3]\d)(2\d)/); if (m) return new Date(2000+ +m[3], +m[1]-1, +m[2]).getTime();
  return 0;
}

// ---------- Serve raw PDF for client-side pdf.js ----------
app.get("/file/pdf", async (req, res) => {
  try {
    const fileId = String(req.query.fileId || "");
    if (!fileId) return res.status(400).send("fileId required");
    const r = await drive.files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
    const buf = Buffer.from(r.data || []);
    if (!buf.length) return res.status(404).send("empty");
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.end(buf);
  } catch (e) {
    res.status(500).json({ error: e?.message || String(e) });
  }
});

// ---------- Auth guard for API ----------
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  if ((req.get("x-auth-token") || "").trim() !== AUTH_TOKEN) return res.status(401).json({ error: "Unauthorized" });
  next();
});

// ---------- Embedding / ingest ----------
async function embedText(text) {
  const { data } = await openai.embeddings.create({ model: EMBEDDING_MODEL, input: text });
  return data[0].embedding;
}
async function parsePdfPages(buffer) {
  const mod = await import("pdf-parse/lib/pdf-parse.js").catch(() => null);
  const fn = (mod?.default || mod) || (await import("pdf-parse")).default;
  const parsed = await fn(buffer);
  return (parsed.text || "").split("\f").map(p=>p.trim()).filter(Boolean);
}
function chunkText(str, chunk=2000, overlap=200){const out=[];let i=0;while(i<str.length){out.push(str.slice(i,i+chunk));i+=Math.max(1,chunk-overlap);}return out;}
async function upsertChunks({ clientId, fileId, fileName, chunks, page }) {
  const vectors=[];
  for (let i=0;i<chunks.length;i++){
    const values=await embedText(chunks[i]);
    vectors.push({ id:`${fileId}_${page??0}_${i}_${Date.now()}`, values, metadata:{ clientId,fileId,fileName,page,text:chunks[i] }});
  }
  if (vectors.length) await index.namespace(clientId).upsert(vectors);
}
async function ingestSingleDrivePdf({ clientId, fileId, fileName, maxPages=Infinity }) {
  const buf=await downloadDriveFile();
  async function downloadDriveFile(){const r=await drive.files.get({fileId,alt:"media"},{responseType:"arraybuffer"});return Buffer.from(r.data||[]);}
  const pages=await parsePdfPages(buf);
  const limit=Math.min(pages.length, Number.isFinite(maxPages)?maxPages:pages.length);
  for (let p=0;p<limit;p++){const t=pages[p];if(!t)continue;const ch=chunkText(t,2000,200);await upsertChunks({clientId,fileId,fileName,chunks:ch,page:p+1});}
}

// ---------- Search helpers ----------
async function buildDiverseSources(matches, maxSources=8){
  const byFile=new Map();
  for(const m of matches){const fid=m.metadata?.fileId;if(!fid)continue;if(!byFile.has(fid))byFile.set(fid,m);}
  const diverse=[...byFile.values()];
  const metas=await Promise.all(diverse.map(async m=>{
    try{
      const info=await drive.files.get({fileId:m.metadata.fileId,fields:"id,name,modifiedTime",supportsAllDrives:true}).then(r=>r.data);
      const tName=dateFromName(info.name||m.metadata.fileName||"");
      const tMod=info.modifiedTime?new Date(info.modifiedTime).getTime():0;
      return { match:m, name:info.name||m.metadata.fileName||"", ts:Math.max(tName,tMod) };
    }catch{
      return { match:m, name:m.metadata.fileName||"", ts:dateFromName(m.metadata.fileName||"") };
    }
  }));
  metas.sort((a,b)=> (b.ts||0)-(a.ts||0));
  return metas.slice(0,maxSources).map((x,i)=>({
    ref: i+1,
    fileId: x.match.metadata.fileId,
    fileName: cleanReportName(x.name || x.match.metadata.fileName || "Untitled"),
    page: x.match.metadata.page ?? x.match.metadata.slide ?? 1,
    text: x.match.metadata.text || ""
  }));
}

async function answerStructured(question, sources){
  const ctx = sources.map(s=>`# Ref ${s.ref}
File: ${s.fileName} | Page: ${s.page}
---
${s.text}`).join("\n\n");

  const prompt = `You are a pharma market-research analyst.
Use ONLY the refs to answer. Create a conversational but precise "headline" with 2–4 sentences AND add 1–3 short bullets summarizing the main angles. Use numeric citations with NO brackets and NO space before the superscript (use ^n^ placeholders that I'll convert to superscripts).

Also produce:
- "supporting" bullets (3–7) that stay very close to the wording and numbers from the sources—use ^n^ tags to cite.
- OPTIONAL "quotes" array: 1–4 brief verbatim snippets (<=25 words each) that directly support the headline; each must appear in the context and include a ^n^ citation.

Return STRICT JSON:
{
  "headline": { "paragraph": "sentences with ^n^ tags", "bullets": ["bullet with ^n^"] },
  "supporting": [ { "text": "close-to-source bullet with numbers and ^n^" } ],
  "quotes": ["short quote with ^n^"]
}

Avoid inventing numbers. Prefer recent evidence.

Question:
${question}

CONTEXT:
${ctx}`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role:"user", content: prompt }],
    temperature: 0.2,
    response_format: { type:"json_object" }
  });

  let obj={ headline:{ paragraph:"", bullets:[] }, supporting:[], quotes:[] };
  try{ obj=JSON.parse(r.choices?.[0]?.message?.content||"{}"); }catch{}
  obj.headline = {
    paragraph: String(obj.headline?.paragraph||"").trim(),
    bullets: Array.isArray(obj.headline?.bullets)? obj.headline.bullets.slice(0,3).map(s=>String(s||"").trim()).filter(Boolean) : []
  };
  obj.supporting = Array.isArray(obj.supporting)? obj.supporting.slice(0,7).map(b=>({ text:String(b?.text||"").trim() })).filter(b=>b.text) : [];
  obj.quotes = Array.isArray(obj.quotes)? obj.quotes.slice(0,4).map(q=>String(q||"").trim()).filter(Boolean) : [];
  return obj;
}

// ---------- Drive allowlist ----------
let _driveCache={ids:new Set(),ts:0};
async function listDriveFileIds(){
  const now=Date.now(); if(now-_driveCache.ts<60_000 && _driveCache.ids.size>0) return _driveCache.ids;
  const ids=new Set(); if(!DRIVE_ROOT_FOLDER_ID) return ids;
  const q=`'${DRIVE_ROOT_FOLDER_ID}' in parents and trashed = false`;
  let pageToken=null;
  do{
    const r=await drive.files.list({ q, fields:"files(id,name,mimeType),nextPageToken", pageSize:1000, includeItemsFromAllDrives:true, supportsAllDrives:true, pageToken });
    (r.data.files||[]).forEach(f=>{ if((f.mimeType||"").toLowerCase().includes("pdf")) ids.add(f.id); });
    pageToken=r.data.nextPageToken||null;
  }while(pageToken);
  _driveCache={ids,ts:now}; return ids;
}

// ---------- SEARCH ----------
app.post("/search", async (req, res) => {
  try{
    if(!index) return res.status(503).json({ error:"Pinecone index not ready yet" });
    const { clientId="demo", userQuery, topK=40 } = req.body||{};
    if(!userQuery) return res.status(400).json({ error:"userQuery required" });

    const vector=await embedText(userQuery);
    let filter;
    if (LIVE_DRIVE_FILTER) {
      const live=await listDriveFileIds();
      filter = live.size ? { fileId:{ $in:[...live] } } : { fileId:{ $in:["__none__"] } };
    }

    const q=await index.namespace(clientId).query({ vector, topK:Number(topK)||40, includeMetadata:true, filter });
    const matches=q.matches||[];

    const sources=await buildDiverseSources(matches, 8);
    const structured=await answerStructured(userQuery, sources);

    const references=sources.map(s=>({ ref:s.ref, fileId:s.fileId, fileName:cleanReportName(s.fileName), page:s.page||1 }));
    // visuals: just metadata; client renders with pdf.js using /file/pdf
    const visuals=sources.slice(0, 6).map(s=>({
      fileId:s.fileId,
      fileName:s.fileName,
      page:s.page||1,
      imageUrl:`/preview/page.png?fileId=${encodeURIComponent(s.fileId)}&page=${encodeURIComponent(s.page||1)}`
    }));

    res.json({ structured, references, visuals });
  }catch(e){
    res.status(500).json({ error:e?.message||String(e) });
  }
});

// ---------- Boot ----------
(async ()=>{
  try{ await ensurePineconeIndex(); index=pinecone.index(PINECONE_INDEX); }catch(e){ console.error("pinecone bootstrap failed",e); }
  app.listen(PORT, ()=>console.log(`mr-broker running on :${PORT}`));
})();
