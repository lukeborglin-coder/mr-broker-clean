// ---- Flexible loaders for pdfjs and canvas variants ----
async function __loadPdfjsFlexible() {
  const candidates = [
    'pdfjs-dist/legacy/build/pdf.mjs',
    'pdfjs-dist/legacy/build/pdf.js',
    'pdfjs-dist/build/pdf.mjs',
    'pdfjs-dist'
  ];
  for (const p of candidates) {
    try { const mod = await import(p); return { mod, variant: p }; } catch {}
  }
  return { mod: null, variant: null };
}
async function __loadCanvasFlexible() {
  try { const m = await import('@napi-rs/canvas'); const createCanvas = m.createCanvas || (m.default && m.default.createCanvas); if (createCanvas) return { mod: m, variant: '@napi-rs/canvas' }; } catch {}
  try { const m = await import('canvas'); const createCanvas = m.createCanvas || (m.default && m.default.createCanvas); if (createCanvas) return { mod: m, variant: 'canvas' }; } catch {}
  return { mod: null, variant: null };
}
// --------------------------------------------------------
/* === MR Broker Server â€“ FULL v12 (ESM/CJS safe, no early returns in stats) === */

// ===== Dashboard payload builder (intent-aware; async) =====
async function buildDashboardPayload({answer, themes, relevantChunks, mostRecentRef}){
  try{
    // Snapshot (prefer canonical chartData)
    let snapshot = null;
    const charts = (themes||[]).map(t=>t.chartData).filter(Boolean);
    let c = Array.isArray(charts) ? charts.find(x=>x && x._preferred) || charts.find(x=>x && x.type==='pie') : charts;
    if (Array.isArray(c)) c = c[0];
    if (c && c.series && c.series.length){
      snapshot = {
        type: "pie",
        asOf: (mostRecentRef && (mostRecentRef.yearTag||mostRecentRef.monthTag)) ? `${mostRecentRef.monthTag||''} ${mostRecentRef.yearTag||''}`.trim() : null,
        labels: c.series.map(s=> s.label),
        values: c.series.map(s=> Number(s.value)||0),
        colors: (Array.isArray(c.colors) && c.colors.length? c.colors : (Array.isArray(c.series) ? c.series.map(s=> (s && s.color) || null) : null))
      };
      // label -> color map (preserve report palette)
      if (c.series){
        const cmap = {};
        c.series.forEach((s,i)=>{
          if (s && s.label){
            const col = s.color || (snapshot.colors && snapshot.colors[i]) || null;
            if (col) cmap[s.label] = col;
          }
        });
        if (Object.keys(cmap).length) snapshot.colorMap = cmap;
      }
    }

    // Trend from dated snippets (if available, 2+ timepoints)
    let trend = null;
    if (typeof buildTrendFromChunks === 'function'){
      trend = buildTrendFromChunks(relevantChunks) || null;
    }

    // Drivers (frequency of bullets)
    let drivers = null;
    const counts = {};
    (themes||[]).forEach(t=> (t.bullets||[]).forEach(b=>{
      const k = String(b).split(':')[0].trim().toLowerCase();
      if (k) counts[k] = (counts[k]||0)+1;
    }));
    const top = Object.entries(counts).sort((a,b)=>b[1]-a[1]).slice(0,5);
    if (top.length){ drivers = { type:"bars", items: top.map(([k,v])=>({label: k[0].toUpperCase()+k.slice(1), value:v})) }; }

    // Quotes (HCP/Patient/Caregiver only)
    const quotes = [];
    (themes||[]).forEach(t=> (t.quotes||[]).forEach(q=>{
      if (!q || !q.text || !q.speaker) return;
      const s = String(q.speaker).toLowerCase();
      if (s==='hcp' || s==='patient' || s==='caregiver') quotes.push({text:q.text, speaker:q.speaker});
    }));

    // Reports: enrich with Drive preview + thumbnail
    const reports = await (async () => {
      const arr = (relevantChunks || []).slice(0, 6);
      const out = [];
      for (const c of arr) {
        let thumb = null, preview = null;
        if (c.fileId) {
          try {
            thumb = await getPdfThumbnail(c.fileId, c.pageNumber || c.page || 1);
            preview = buildDrivePreviewUrl(c.fileId, c.pageNumber || c.page);
          } catch (e) {}
        }
        // Only include reports that have successfully generated thumbnails or valid file IDs
        if (c.fileName && c.fileId) {
          out.push({
            source: c.fileName,
            page: c.pageNumber || c.page,
            study: c.study,
            date: (c.monthTag ? (c.monthTag + ' ') : '') + (c.yearTag || ''),
            fileId: c.fileId || null,
            preview,
            thumbnail: thumb
          });
        }
      }
      return out;
    })();

    console.log('Debug - Server generating reports:', reports);
    console.log('Debug - First report:', reports[0]);
    return { headline: answer, snapshot, trend, drivers, quotes: quotes.slice(0, 4), reports };
  }catch(e){
    console.error('Error in buildAnalysisResponse:', e);
    console.error('Stack trace:', e.stack);
    return { headline: answer, reports: [] }; // Return empty reports array instead of undefined
  }
}

// ===== Drive thumbnails and preview links =====
import pdf2pic from 'pdf2pic';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';


// --- helper to fetch Drive file bytes as Buffer ---
async function __downloadDriveFile(fileId) {
  const auth = getAuth && typeof getAuth === 'function' ? getAuth() : undefined;
  const drive = google.drive({ version: 'v3', auth });
  const resp = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
  return Buffer.from(resp.data);
}

import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'fs';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';

// Get __dirname equivalent for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize fs.promises after imports
const fsp = fs.promises;

// Create a temporary directory for PDF processing
const TEMP_DIR = path.join(tmpdir(), 'jaice-pdf-temp');

async function ensureTempDir() {
  try {
    mkdirSync(TEMP_DIR, { recursive: true });
  } catch (error) {
    // Directory might already exist
  }
}

// Global auth client for Google Drive
let authClient;

// Initialize Google Drive authentication
async function initializeGoogleAuth() {
  try {
    authClient = getAuth();
    const client = await authClient.getClient();
    console.log('âœ… Google Drive authentication initialized successfully');
    return client;
  } catch (error) {
    console.error('âŒ Failed to initialize Google Drive auth:', error);
    throw error;
  }
}

// FIXED: More robust PDF thumbnail generation with file-based approach

// Simplified: do not download/convert. Just return our secure-slide URL.
async function getPdfThumbnail(fileId, pageNumber = 1) {
  if (!fileId) return null;
  const page = Number(pageNumber) > 0 ? Number(pageNumber) : 1;
  return `/secure-slide/${fileId}/${page}`;
}


function buildDrivePreviewUrl(fileId, page){
  const p = page && Number(page)>0 ? `#page=${Number(page)}` : '';
  return `https://drive.google.com/file/d/${fileId}/preview${p}`;
}

// ===== Extract trend from snippets across timepoints =====
function extractSharesFromText(text){
  if (!text) return null;
  const out = {};
  const reLabelVal = /(Evrysdi|Spinraza|Zolgensma|Untreated)\s*(?:-|:)?\s*(\d{1,2})(?:\.\d+)?\s*%/gi;
  let m;
  while((m = reLabelVal.exec(text))){
    const L = m[1]; const v = Number(m[2]);
    out[L] = v;
  }
  const keys = Object.keys(out);
  return keys.length ? out : null;
}

function buildTrendFromChunks(chunks){
  // group by (year, month)
  const pts = {};
  (chunks||[]).forEach(c=>{
    const y = Number(c.yearTag)||0; const m = monthToNum(c.monthTag||'');
    if (!y) return;
    const key = `${y}-${String(m).padStart(2,'0')}`;
    const parsed = extractSharesFromText(c.textSnippet||'');
    if (parsed){
      pts[key] = Object.assign(pts[key]||{}, parsed);
    }
  });
  const keys = Object.keys(pts).sort();
  if (keys.length < 2) return null;
  const labels = ["Evrysdi","Spinraza","Zolgensma","Untreated"];
  const series = labels.map(L=> ({ label:L, values: keys.map(k=> pts[k][L] ?? null) }));
  return { type: 'lines', timepoints: keys, labels, series };
}


async function extractTagsFromTitlePage(fileId){
  try{
    const pdfjsLoad = (typeof __loadPdfjsFlexible === 'function') ? await __loadPdfjsFlexible() : { mod: null };
    const pdfjsMod = pdfjsLoad.mod;
    const pdfjsLib = (pdfjsMod && (pdfjsMod.getDocument || pdfjsMod.GlobalWorkerOptions)) ? pdfjsMod
                     : (pdfjsMod && pdfjsMod.default ? pdfjsMod.default : null);
    if (!pdfjsLib) return { year:'', month:'', report:'' };
    const pdfBuffer = await __downloadDriveFile(fileId);
    const doc = await pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) }).promise;
    const page = await doc.getPage(1);
    const tc = await page.getTextContent();
    const text = (tc.items||[]).map(it=>it.str).join(' ').replace(/\s+/g,' ').trim();
    const monthWord = (text.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i)||[])[0] || '';
    const month = monthWord ? monthWord.slice(0,3) : '';
    const y = (text.match(/\b(20\d{2})\b/)||[])[1] || '';
    const lower = text.toLowerCase();
    let report = '';
    if (lower.includes('conjoint')) report = 'Conjoint';
    else if (lower.includes('atu')) report = 'ATU';
    else if (lower.includes('integrated') || lower.includes('pmr') || lower.includes('quant')) report = 'PMR';
    else if (lower.includes('competitive')) report = 'Competitive Readiness';
    else if (lower.includes('tracker')) report = 'Tracker';
    return { year:y||'', month:month||'', report };
  }catch(e){
    return { year:'', month:'', report:'' };
  }
}

async function ensureChunkTags(c){
  if (!c) return;
  const haveAll = c.yearTag && c.monthTag && c.reportTag;
  if (haveAll) return;
  let y = c.yearTag || '', m = c.monthTag || '', r = c.reportTag || '';
  if ((!y || !m || !r) && c.fileId){
    const t = await extractTagsFromTitlePage(c.fileId);
    y = y || t.year; m = m || t.month; r = r || t.report;
  }
  const fname = c.fileName || c.source || c.study || '';
  y = y || extractYearFromFileName(fname);
  m = m || extractMonthFromFileName(fname);
  r = r || extractReportTypeFromFileName(fname);
  c.yearTag = y; c.monthTag = m; c.reportTag = r;
}

// ===== Helpers =====
// recency + market share canonicalization (global scope) =====
const SMA_LABELS = ["Evrysdi","Spinraza","Zolgensma","Untreated"];
const COLOR_BY_LABEL = { Evrysdi:"#2563eb", Spinraza:"#16a34a", Zolgensma:"#f59e0b", Untreated:"#6b7280" };

function normalizeLabel(lbl){
  if(!lbl) return null;
  const x = String(lbl).trim().toLowerCase();
  if (x.startsWith("evry")) return "Evrysdi";
  if (x.startsWith("spin")) return "Spinraza";
  if (x.startsWith("zol")) return "Zolgensma";
  if (x.includes("untreat") || x.includes("no treat") || x.includes("none")) return "Untreated";
  return String(lbl).trim();
}

function monthToNum(m){
  if (!m) return 0;
  const map={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const n = Number(String(m).replace(/[^0-9]/g,''));
  if (n>=1 && n<=12) return n;
  const k = String(m).slice(0,3).toLowerCase();
  return map[k]||0;
}

function preferMostRecent(chunks){
  const arr = (chunks||[]).map(c=>({...c,_y:Number(c.yearTag)||0,_m:monthToNum(c.monthTag)}));
  arr.sort((a,b)=> (b._y - a._y) || (b._m - a._m) || ((b.score||0)-(a.score||0)));
  return { mostRecent: arr[0] || null, ordered: arr };
}

function canonicalizeMarketShareChart(chart){
  if (!chart || !Array.isArray(chart.series)) return chart;
  const map = new Map();
  chart.series.forEach(s=>{
    if(!s) return;
    const L = normalizeLabel(s.label);
    if (!L) return;
    const val = Number(s.value)||0;
    map.set(L, (map.get(L)||0) + val);
  });
  // If totals look like a pie, force pie
  const sum = Array.from(map.values()).reduce((a,b)=>a+b,0);
  if (sum>=90 && sum<=110) chart.type = "pie";
  const series = SMA_LABELS.map(L=> ({ label:L, value: map.get(L)||0, color: COLOR_BY_LABEL[L] }));
  chart.series = series.filter(s=> s.value>0);
  chart.colors = chart.series.map(s=> s.color);
  chart.legend = chart.series.map(s=> s.label);
  chart._preferred = true;
  return chart;
}

// server.js - Jaice server with fixes for visual issues and chart display

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import session from "express-session";
import bcrypt from "bcryptjs";
import OpenAI from "openai";
import { google } from "googleapis";
import crypto from "node:crypto";

dotenv.config({ path: path.resolve(process.cwd(), ".env"), override: true });

const config = {
  server: {
    port: Number(process.env.PORT) || 3000,
    sessionSecret: process.env.SESSION_SECRET || "change-me-in-production",
    authToken: process.env.AUTH_TOKEN || "coggpt25",
    secureCookies: process.env.SECURE_COOKIES === "true",
  },
  ai: {
    openaiKey: process.env.OPENAI_API_KEY,
    embeddingModel: process.env.EMBEDDING_MODEL || "text-embedding-3-small",
    answerModel: process.env.ANSWER_MODEL || "gpt-4o-mini",
    defaultTopK: Number(process.env.DEFAULT_TOPK) || 50,
  },
  pinecone: {
    apiKey: process.env.PINECONE_API_KEY,
    indexHost: process.env.PINECONE_INDEX_HOST,
  },
  drive: {
    rootFolderId: process.env.DRIVE_ROOT_FOLDER_ID || "",
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
    credentialsJson: process.env.GOOGLE_CREDENTIALS_JSON || "",
  },
  data: {
    cacheDir: process.env.DATA_CACHE_DIR || path.resolve(process.cwd(), "data-cache"),
  },
  search: {
    skipManifestFilter: process.env.SKIP_MANIFEST_FILTER === "true",
    maxThemes: Number(process.env.MAX_THEMES) || 50,
    scoreThreshold: Number(process.env.SEARCH_SCORE_THRESHOLD || 0.5),
  },
  autoIngest: {
    onStart: String(process.env.AUTO_INGEST_ON_START || "false").toLowerCase() === "true",
    startDelayMs: Number(process.env.AUTO_INGEST_DELAY_MS || 2000),
    syncIntervalMs: Number(process.env.AUTO_SYNC_INTERVAL_MS || 3600000),
  },
};

const logger = {
  info: (...a)=>console.log("INFO", new Date().toISOString(), ...a),
  warn: (...a)=>console.warn("WARN", new Date().toISOString(), ...a),
  error: (...a)=>console.error("ERROR", new Date().toISOString(), ...a),
};

// FIXED: Regex-free HTML injector with proper chart rendering script
async function serveHtmlWithUi(res, filePath) {
  try {
    let html = await fsp.readFile(filePath, "utf8");
    
    // FIXED: Updated chart rendering function with proper data labels and no duplication
    const chartScript = `
    <script>
    // Global chart instances tracker
    window.chartInstances = window.chartInstances || new Map();
    
    function renderChart(containerId, chartData) {
      const container = document.getElementById(containerId);
      if (!container) {
        console.warn('Chart container not found:', containerId);
        return;
      }
      
      // CRITICAL: Destroy existing chart instance if it exists
      if (window.chartInstances.has(containerId)) {
        const existingChart = window.chartInstances.get(containerId);
        try {
          existingChart.destroy();
          console.log('Destroyed existing chart:', containerId);
        } catch (e) {
          console.warn('Error destroying chart:', e);
        }
        window.chartInstances.delete(containerId);
      }
      
      // CRITICAL: Clear existing content to prevent duplication
      container.innerHTML = '';
      
      console.log('Rendering chart:', containerId, chartData);
      
      if (window.Chart && chartData && chartData.series && chartData.series.length > 0) {
        const canvas = document.createElement('canvas');
        canvas.style.maxHeight = '250px';
        canvas.style.width = '100%';
        canvas.id = containerId + '_canvas';
        container.appendChild(canvas);
        
        const labels = chartData.series.map(s => s.label);
        const data = chartData.series.map(s => s.value);
        
        // Determine chart type intelligently
        let chartType = 'bar'; // Default to bar charts
        
        // Only use pie charts for market share data that adds up to ~100%
        const total = data.reduce((sum, val) => sum + val, 0);
        if (chartData.type === 'pie' && total >= 90 && total <= 110) {
          chartType = 'pie';
        } else if (chartData.type === 'line') {
          chartType = 'line';
        }
        
        // Enhanced color selection with brand colors
        let backgroundColor, borderColor;
        if (chartType === 'pie') {
          backgroundColor = labels.map(label => {
            const lowerLabel = label.toLowerCase();
            // Match pharmaceutical product colors
            if (lowerLabel.includes('evrysdi') || lowerLabel.includes('risdiplam')) return '#ff7a00';
            if (lowerLabel.includes('spinraza') || lowerLabel.includes('nusinersen')) return '#2563eb';
            if (lowerLabel.includes('zolgensma') || lowerLabel.includes('onasemnogene')) return '#16a34a';
            if (lowerLabel.includes('untreated') || lowerLabel.includes('no treatment')) return '#94a3b8';
            if (lowerLabel.includes('other') || lowerLabel.includes('others')) return '#6366f1';
            
            // Fallback to orange palette
            const index = labels.indexOf(label);
            const palette = ['#2563eb','#16a34a','#f59e0b','#6b7280','#7c3aed','#dc2626','#059669','#64748b']; // Neutral, not brand-specific
            return palette[index % palette.length];
          });
          borderColor = '#fff';
        } else {
          backgroundColor = labels.map((_, i) => \`rgba(255, 122, 0, \${0.8 - i * 0.1})\`);
          borderColor = labels.map((_, i) => 'rgba(255, 122, 0, 1)');
        }
        
        const chartConfig = {
          type: chartType,
          data: {
            labels: labels,
            datasets: [{
              label: chartData.title || 'Values',
              data: data,
              backgroundColor: backgroundColor,
              borderColor: borderColor,
              borderWidth: chartType === 'pie' ? 2 : 1,
              fill: chartType === 'line' ? false : true
            }]
          },
          plugins: [ChartDataLabels], // CRITICAL: Register the plugin
          options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: {
                display: chartType === 'pie', // Only show legend for pie charts
                position: chartType === 'pie' ? 'right' : 'top',
                labels: {
                  font: { size: 12 },
                  padding: 15,
                  usePointStyle: true
                }
              },
              tooltip: {
                callbacks: {
                  label: function(context) {
                    const value = context.parsed || context.parsed === 0 ? context.parsed : context.raw;
                    return context.label + ': ' + value + '%';
                  }
                }
              },
              // FIXED: Proper data labels configuration
              datalabels: {
                display: true,
                color: chartType === 'pie' ? '#fff' : '#333',
                font: {
                  weight: 'bold',
                  size: 14
                },
                formatter: function(value, context) {
                  return value + '%';
                },
                anchor: chartType === 'pie' ? 'center' : 'end',
                align: chartType === 'pie' ? 'center' : 'top',
                offset: chartType === 'pie' ? 0 : -8,
                clip: false // Ensure labels always show
              }
            },
            scales: chartType === 'pie' ? {} : {
              y: {
                display: false, // Clean look
                grid: { display: false },
                border: { display: false }
              },
              x: {
                grid: { display: false },
                border: { display: false },
                ticks: {
                  maxRotation: 45,
                  font: { size: 11 }
                }
              }
            },
            // FIXED: Enhanced animations and interactions
            onHover: function(event, activeElements) {
              event.native.target.style.cursor = activeElements.length > 0 ? 'pointer' : 'default';
            },
            animation: {
              onComplete: function() {
                // Additional data label rendering for non-pie charts
                if (chartType !== 'pie') {
                  const ctx = this.chart.ctx;
                  ctx.font = 'bold 12px Arial';
                  ctx.fillStyle = '#333';
                  ctx.textAlign = 'center';
                  ctx.textBaseline = 'bottom';
                  
                  this.data.datasets.forEach((dataset, i) => {
                    const meta = this.chart.getDatasetMeta(i);
                    meta.data.forEach((bar, index) => {
                      const value = dataset.data[index];
                      if (value && value > 0) {
                        ctx.fillText(value + '%', bar.x, bar.y - 5);
                      }
                    });
                  });
                }
              }
            }
          }
        };
        
        // CRITICAL: Register the plugin and create chart
        if (window.ChartDataLabels) {
          Chart.register(ChartDataLabels);
        }
        
        try {
          const chartInstance = new Chart(canvas.getContext('2d'), chartConfig);
          window.chartInstances.set(containerId, chartInstance);
        } catch (error) {
          console.error('Chart creation failed:', error);
          container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">Chart rendering failed</p>';
        }
      } else if (chartData && chartData.series) {
        // Fallback to styled list format with percentages
        const ul = document.createElement('ul');
        ul.style.margin = '16px 0';
        ul.style.paddingLeft = '0';
        ul.style.listStyle = 'none';
        
        chartData.series.forEach((item, index) => {
          const li = document.createElement('li');
          li.style.margin = '8px 0';
          li.style.padding = '12px 16px';
          li.style.background = 'rgba(37, 99, 235, ' + (0.10 + (index * 0.05)) + ')';
          li.style.borderRadius = '8px';
          li.style.borderLeft = '4px solid #2563eb';
          li.style.display = 'flex';
          li.style.justifyContent = 'space-between';
          li.style.alignItems = 'center';
          
          li.innerHTML = '<span style="font-weight: 600;">' + item.label + '</span>' +
            '<span style="background: #2563eb; color: white; padding: 6px 12px; border-radius: 16px; font-size: 14px; font-weight: bold;">' +
            item.value + '%</span>';
          ul.appendChild(li);
        });
        
        container.appendChild(ul);
      } else {
        console.warn('No chart data available for', containerId);
        container.innerHTML = '<p style="color: #666; text-align: center; padding: 20px;">No chart data available</p>';
      }
    }
    </script>`;
    
    const scriptTag = '\n  <script src="/ui/user-menu.js" defer></script>\n' + chartScript + '\n';
    if (!html.includes('/ui/user-menu.js')) {
      const lower = html.toLowerCase();
      const marker = "</body>";
      const idx = lower.lastIndexOf(marker);
      if (idx !== -1) {
        html = html.slice(0, idx) + scriptTag + html.slice(idx);
      } else {
        html += scriptTag;
      }
    }
    res.set("Cache-Control", "no-store");
    res.type("html").send(html);
  } catch (e) {
    logger.error("Failed to serve HTML:", e.message);
    res.set("Cache-Control","no-store");
    res.sendFile(filePath);
  }
}

const app = express();
app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// PDF Preview endpoint - serve PDF pages on-demand with improved stream handling
// removed /pdf-preview route
// /* removed /secure-slide/ route */


app.use(session({
  secret: config.server.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: config.server.secureCookies, maxAge: 1000*60*60*8 }
}));

const CONFIG_DIR = path.resolve(process.cwd(), "config");
const USERS_PATH = path.join(CONFIG_DIR, "users.json");
const MANIFEST_DIR = path.join(CONFIG_DIR, "manifests");

// Wrapped for maximum compatibility (no top-level await)
;(async () => {
  try {
    await fsp.mkdir(CONFIG_DIR, { recursive: true });
    await fsp.mkdir(MANIFEST_DIR, { recursive: true });
    await fsp.mkdir(config.data.cacheDir, { recursive: true });
  } catch (e) {
    logger.error("mkdir bootstrap failed:", e?.message || e);
  }
})();

function readJSON(p,fallback){ 
  try{ 
    if(!fs.existsSync(p)) return fallback; 
    return JSON.parse(fs.readFileSync(p,"utf8")||"null") ?? fallback;
  }catch(e){ 
    logger.warn("readJSON failed", p, e.message); 
    return fallback; 
  } 
}

function writeJSON(p,obj){ 
  try{ 
    fs.writeFileSync(p, JSON.stringify(obj,null,2)); 
  }catch(e){ 
    logger.error("writeJSON failed", p, e.message);
  } 
}

// seed internal admin (non-destructive)
(function seedUsers(){
  const u = readJSON(USERS_PATH, { users: []});
  const username = "cognitive_internal";
  // Only seed if missing; never overwrite an existing account
  const existingIndex = u.users.findIndex(x => (x.username||'').toLowerCase() === username);
  if (existingIndex === -1) {
    const passwordHash = bcrypt.hashSync(config.server.authToken || "coggpt25", 10);
    const admin = { username, passwordHash, role:"internal", allowedClients:"*" };
    u.users.push(admin);
    writeJSON(USERS_PATH, u);
    logger.info("Seeded default internal admin user");
  } else {
    logger.info("Admin user already exists; not overwriting");
  }
})();

function getAuth(){
  if (config.drive.credentialsJson){
    return new google.auth.GoogleAuth({ 
      credentials: JSON.parse(config.drive.credentialsJson), 
      scopes:[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/presentations.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ]
    });
  }
  if (config.drive.keyFile){
    return new google.auth.GoogleAuth({ 
      keyFile: config.drive.keyFile, 
      scopes:[
        "https://www.googleapis.com/auth/drive.readonly",
        "https://www.googleapis.com/auth/presentations.readonly",
        "https://www.googleapis.com/auth/spreadsheets.readonly",
      ]
    });
  }
  throw new Error("Google credentials missing");
}

const openai = new OpenAI({ apiKey: config.ai.openaiKey });

async function embedTexts(texts){
  const r = await openai.embeddings.create({ model: config.ai.embeddingModel, input: texts });
  return r.data.map(d=>d.embedding);
}

async function pineconeQuery(vector, namespace, topK){
  const r = await fetch(`${config.pinecone.indexHost}/query`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Api-Key": config.pinecone.apiKey },
    body: JSON.stringify({ vector, topK, includeMetadata:true, namespace })
  });
  if(!r.ok){ throw new Error(`Pinecone query failed: ${await r.text()}`); }
  return r.json();
}

// === FIXED Supporting Findings helpers ===
async function proposeThemeAssignments(openai, model, userQuery, chunks) {
  const refs = (chunks || []).map((c, i) => ({
    id: c.id || `ref${i + 1}`,
    text: c.textSnippet,
    file: c.fileName
  }));

  // Ensure we have enough references to create themes
  if (refs.length < 2) {
    logger.warn(`Only ${refs.length} references available - creating single theme`);
    return [{
      title: "Research Findings",
      refIds: refs.map(r => r.id)
    }];
  }

  const prompt = `Create up to 10 DISTINCT themes for: "${userQuery}"

Available references (assign each to EXACTLY ONE theme):
${refs.map(r => `${r.id}: ${r.text.substring(0, 200)}...`).join("\n\n")}

RULES:
- Create up to 10 themes that don't overlap
- Each reference assigned to ONLY ONE theme
- Distribute references evenly across themes
- Theme titles should be specific to the query context

Return JSON:
{"themes":[
  {"title":"Theme 1 Name", "refIds":["ref1","ref2"]},
  {"title":"Theme 2 Name", "refIds":["ref3"]},
  {"title":"Theme 3 Name", "refIds":["ref4","ref5"]}
]}`;

  const cmp = await openai.chat.completions.create({
    model,
    temperature: 0.7,
    response_format: { type: "json_object" },
    messages: [{ role: "user", content: prompt }],
    max_tokens: 800
  });

  try {
    const data = JSON.parse(cmp.choices[0]?.message?.content || "{}");
    let themes = Array.isArray(data.themes) ? data.themes : [];
    
    // Ensure no reference appears in multiple themes
    const usedRefIds = new Set();
    const uniqueThemes = [];
    
    for (const theme of themes) {
      if (!theme.refIds || !Array.isArray(theme.refIds)) continue;
      
      const availableRefIds = theme.refIds.filter(id => !usedRefIds.has(id));
      
      if (availableRefIds.length >= 1) {
        availableRefIds.forEach(id => usedRefIds.add(id));
        uniqueThemes.push({
          title: theme.title,
          refIds: availableRefIds
        });
      }
    }
    
    // Assign any unused references to a fallback theme
    const unusedRefs = refs.filter(r => !usedRefIds.has(r.id));
    if (unusedRefs.length > 0) {
      uniqueThemes.push({
        title: "Additional Insights",
        refIds: unusedRefs.map(r => r.id)
      });
    }
    
    // Final dedup by title + reference Jaccard overlap
    const normalized = new Set();
    const finalThemes = [];
    for (const t of uniqueThemes) {
      const key = String(t.title||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,' ');
      if (normalized.has(key)) continue;
      let tooSimilar = false;
      for (const u of finalThemes) {
        const A = new Set((t.refIds||[]).map(String));
        const B = new Set((u.refIds||[]).map(String));
        const inter = [...A].filter(x=>B.has(x)).length;
        const jaccard = inter / (A.size + B.size - inter || 1);
        if (jaccard >= 0.6) { tooSimilar = true; break; }
      }
      if (!tooSimilar) { normalized.add(key); finalThemes.push(t); }
    }
    
    logger.info(`Generated ${finalThemes.length} unique themes with no overlap`);
    return finalThemes.slice(0, config.search.maxThemes || 50);
  } catch (e) {
    logger.error("Theme assignment failed:", e.message);
    return [{
      title: "Research Findings", 
      refIds: refs.map(r => r.id)
    }];
  }
}

async function buildSupportingThemes(openai, model, userQuery, chunks) {
  if (!chunks || chunks.length === 0) {
    return [];
  }

  const proposals = await proposeThemeAssignments(openai, model, userQuery, chunks);
  const byId = Object.fromEntries((chunks || []).map(c => [c.id, c]));
  const out = [];

  for (const th of proposals) {
    const refs = (th.refIds || []).map(id => byId[id]).filter(Boolean);
    if (!refs.length) continue;

    const themeContext = refs.map(r => `[${r.id}] ${r.textSnippet}`).join("\n\n");
    
    const prompt = `Analyze "${th.title}" theme using ONLY these references:

${themeContext}

Extract information for this theme:

1. Create up to 10 key findings with [1], [2] style citations
2. Look for NUMERIC data and create appropriate charts:
   - Market share data (parts of whole) â†’ "pie" chart
   - Separate issues/barriers â†’ "bar" chart  
   - Trends over time â†’ "line" chart
3. Find actual quoted text (in quotation marks) with speaker attribution

IMPORTANT: Only create charts if you find real numbers in the references above.
IMPORTANT: For quotes, speaker must be EXACTLY one of: "Patient", "Caregiver", or "HCP" - no other speaker types allowed.

JSON format:
{
  "title": "${th.title}",
  "subtitle": "One sentence describing this theme",
  "bullets": ["Finding 1 with [1] citation", "Finding 2 with [2] citation"],
  "chartData": {
    "type": "pie",
    "series": [{"label": "Category A", "value": 45}, {"label": "Category B", "value": 55}]
  },
  "quotes": [{"text": "actual quoted text", "speaker": "Patient"}]
}`;

    const cmp = await openai.chat.completions.create({
      model,
      temperature: 0.3,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1200
    });

    let obj = {};
    try { 
      obj = JSON.parse(cmp.choices[0]?.message?.content || "{}");
    } catch {
      logger.warn("Failed to parse theme JSON, skipping");
      continue;
    }
    
    if (!obj || !obj.title) continue;

    // FIXED: Enhanced chart validation with proper percentage handling
    if (obj.chartData && obj.chartData.series) {
      const series = Array.isArray(obj.chartData.series) ? obj.chartData.series : [];
      const validSeries = series
        .filter(s => s && typeof s.value === "number" && isFinite(s.value) && s.value > 0 && s.label)
        .slice(0, 8);
      
      if (validSeries.length >= 2) {
        let chartType = obj.chartData.type || 'bar';
        
        // Auto-detect market share data
        const total = validSeries.reduce((sum, s) => sum + s.value, 0);
        if (total >= 90 && total <= 110 && validSeries.length >= 2) {
          chartType = 'pie';
        }
        
        obj.chartData = {
          type: chartType,
          series: validSeries,
          title: obj.title
        };
        if (obj.chartData) { 
          obj.chartData = canonicalizeMarketShareChart(obj.chartData); 
          obj.chartData._preferred = true; 
        }
      } else {
        delete obj.chartData;
      }
    } else {
      delete obj.chartData;
    }

    // Ensure unique bullets
    const bullets = Array.isArray(obj.bullets) ? obj.bullets : [];
    const uniqueBullets = [...new Set(bullets)].slice(0, 4);

    // FIXED: Strict quote filtering - only allow Patient, Caregiver, HCP
    const validQuotes = Array.isArray(obj.quotes) ?
      obj.quotes
        .filter(q => {
          if (!q || !q.text || !q.speaker) return false;
          const speaker = q.speaker.toLowerCase().trim();
          return speaker === 'patient' || speaker === 'caregiver' || speaker === 'hcp';
        })
        .slice(0, 1) // Only one quote per theme to prevent duplication
      : [];

    out.push({
      title: obj.title,
      subtitle: obj.subtitle,
      bullets: uniqueBullets,
      chartData: obj.chartData,
      quotes: validQuotes
    });

    if (out.length >= 4) break;
  }

  logger.info(`Built ${out.length} supporting themes`);
  return out;
}

// === FIXED Google Drive sync (using current manifest files) ===
async function syncGoogleDriveData() {
  if (!config.drive.rootFolderId) {
    logger.warn("No Google Drive root folder configured - skipping sync");
    return;
  }

  try {
    logger.info("ðŸ”„ Starting Google Drive sync...");
    
    const drive = google.drive({ version: "v3", auth: authClient || getAuth() });
    const clientFolders = await listClientFolders();
    
    for (const clientFolder of clientFolders) {
      logger.info(`ðŸ“ Syncing client: ${clientFolder.name}`);
      
      // Get current files from Drive
      const allFiles = await getAllFilesRecursively(drive, clientFolder.id);
      
      // Filter for supported file types
      const supportedTypes = [
        'application/pdf',
        'application/vnd.google-apps.document',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.google-apps.presentation',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.google-apps.spreadsheet',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ];
      
      const currentFiles = allFiles.filter(file => {
        const isSupported = supportedTypes.includes(file.mimeType) || 
                           file.mimeType.includes('document') || 
                           file.mimeType.includes('presentation') || 
                           file.mimeType.includes('spreadsheet') ||
                           file.name.toLowerCase().endsWith('.pdf');
        return isSupported;
      });

      // Load existing manifest
      const manifestPath = path.join(MANIFEST_DIR, `${clientFolder.id}.json`);
      let existingManifest = { files: [], lastUpdated: null };
      
      if (fs.existsSync(manifestPath)) {
        try {
          existingManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
          logger.warn(`Failed to read manifest for ${clientFolder.name}:`, e.message);
        }
      }

      // Update manifest with current files only (remove deleted files)
      const updatedManifest = {
        files: currentFiles.map(f => {
          const existingFile = existingManifest.files.find(ef => ef.id === f.id);
          return {
            id: f.id,
            name: f.name,
            mimeType: f.mimeType,
            modifiedTime: f.modifiedTime,
            size: f.size || 0,
            folderPath: f.folderPath,
            processed: existingFile ? existingFile.processed : false
          };
        }),
        lastUpdated: new Date().toISOString(),
        clientId: clientFolder.id,
        clientName: clientFolder.name
      };

      writeJSON(manifestPath, updatedManifest);
      
      const processedCount = updatedManifest.files.filter(f => f.processed).length;
      logger.info(`âœ… Updated manifest for ${clientFolder.name}: ${updatedManifest.files.length} files (${processedCount} processed)`);

      // Ingest / embed files to Pinecone when needed
      const forceReembed = (String(process.env.FORCE_REEMBED||'').toLowerCase()==='true');
      let upserted = 0;
      for (const f of updatedManifest.files){
        const existing = existingManifest.files.find(ef => ef.id === f.id) || {};
        const changed = forceReembed || !existing.processed || (existing.modifiedTime !== f.modifiedTime);
        if (!changed) continue;
        try{
          const text = await extractTextForEmbedding(f);
          const [vec] = await embedTexts([text]);
          const meta = { fileId: f.id, fileName: f.name, mimeType: f.mimeType };
          await pineconeUpsert([{ id: f.id, values: vec, metadata: meta }], clientFolder.id);
          f.processed = true;
          upserted++;
        }catch(e){ logger.warn('Embed failed for', f.name, e?.message||e); }
      }
      writeJSON(manifestPath, updatedManifest);
      logger.info(`📥 Ingest complete for ${clientFolder.name}: ${upserted} files embedded`);
    }

    logger.info("âœ… Google Drive sync completed");
    
  } catch (error) {
    logger.error("âš  Google Drive sync failed:", error.message);
  }
}

// Helper function to recursively get all files from a folder and its subfolders
async function getAllFilesRecursively(drive, folderId, folderPath = '') {
  const allFiles = [];
  
  try {
    const query = `'${folderId}' in parents and trashed=false`;
    const response = await drive.files.list({
      q: query,
      fields: "files(id,name,mimeType,modifiedTime,size,parents)",
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true
    });

    const items = response.data.files || [];
    
    for (const item of items) {
      if (item.mimeType === 'application/vnd.google-apps.folder') {
        const subFolderPath = folderPath ? `${folderPath}/${item.name}` : item.name;
        const subFiles = await getAllFilesRecursively(drive, item.id, subFolderPath);
        allFiles.push(...subFiles);
      } else {
        allFiles.push({
          ...item,
          folderPath: folderPath || 'Root'
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to get files from folder ${folderId}:`, error.message);
  }
  
  return allFiles;
}


// ---- Embedding helpers ----
async function extractTextForEmbedding(file){
  // Only implementing PDF robustly; other types fallback to name
  try {
    if (file.mimeType === 'application/pdf') {
      const { mod } = await __loadPdfjsFlexible();
      const pdfjsLib = (mod && (mod.getDocument||mod.GlobalWorkerOptions)) ? mod : (mod && mod.default ? mod.default : null);
      const bytes = await __downloadDriveFile(file.id);
      const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
      const pages = Math.min(doc.numPages, 10);
      let text = file.name + "\n";
      for (let p=1; p<=pages; p++){
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map(it=>it.str).join(" ") + "\n";
      }
      return text.slice(0, 8000);
    }
  } catch(e){ logger.warn("extractTextForEmbedding failed:", e?.message||e); }
  return file.name;
}

async function pineconeUpsert(vectors, namespace){
  const body = { vectors, namespace };
  const r = await fetch(`${config.pinecone.indexHost}/vectors/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Api-Key': config.pinecone.apiKey },
    body: JSON.stringify(body)
  });
  if (!r.ok){ throw new Error('Pinecone upsert failed: '+r.status); }
  return r.json();
}
// Auto-sync initialization
async function initializeAutoSync() {
  if (config.autoIngest.onStart) {
    logger.info("ðŸš€ Auto-ingest enabled - starting initial sync");
    
    setTimeout(async () => {
      try {
        await syncGoogleDriveData();
      } catch (error) {
        logger.error("Initial sync failed:", error.message);
      }
    }, config.autoIngest.startDelayMs);
  }

  if (config.autoIngest.syncIntervalMs > 0) {
    const intervalMinutes = Math.round(config.autoIngest.syncIntervalMs / 60000);
    logger.info(`â° Scheduled sync enabled - will run every ${intervalMinutes} minutes`);
    
    setInterval(async () => {
      try {
        logger.info("ðŸ”„ Running scheduled sync (recurring)");
        await syncGoogleDriveData();
      } catch (error) {
        logger.error("Scheduled sync failed:", error.message);
      }
    }, config.autoIngest.syncIntervalMs);
  }
}

// === Helper functions ===


// ===== Filename-based tag extraction helpers (clean) =====
function extractYearFromFileName(name){
  const s = String(name||'');
  
  // Check for MMDDYY format like 111324 (at end of filename)
  let m = s.match(/(\d{2})(\d{2})(\d{2})(?:\.pdf)?$/);
  if (m) {
    const year = m[3];
    return '20' + year; // Convert YY to 20YY
  }
  
  // Check for Q4YYYY pattern like Q42024
  m = s.match(/[Qq](\d+)(20\d{2})/);
  if (m) return m[2];
  
  // prefer explicit 20xx
  m = s.match(/(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/);
  if (m) return m[1];
  // MMDDYYYY
  m = s.match(/(?:^|[^0-9])(?:0?[1-9]|1[0-2])(?:\D|_)?(?:[0-3]?\d)(?:\D|_)?(20\d{2})(?:[^0-9]|$)/);
  if (m) return m[1];
  // YYYYMMDD
  m = s.match(/(?:^|[^0-9])(20\d{2})(?:\D|_)?(?:0?[1-9]|1[0-2])(?:\D|_)?(?:[0-3]?\d)(?:[^0-9]|$)/);
  if (m) return m[1];
  return '';
}

function extractMonthFromFileName(name){
  const months=['January','February','March','April','May','June','July','August','September','October','November','December'];
  const s = String(name||'').toLowerCase();
  
  // Check for MMDDYY format like 111324 (at end of filename)
  let m = s.match(/(\d{2})(\d{2})(\d{2})(?:\.pdf)?$/);
  if (m) {
    const monthNum = parseInt(m[1], 10);
    if (monthNum >= 1 && monthNum <= 12) {
      return months[monthNum - 1];
    }
  }
  
  // Check for Q4YYYY patterns
  if (s.match(/[Qq]4/)) return 'December';
  if (s.match(/[Qq]3/)) return 'September';
  if (s.match(/[Qq]2/)) return 'June';
  if (s.match(/[Qq]1/)) return 'March';
  
  // month word
  for (let i=0;i<months.length;i++){
    if (s.includes(months[i].toLowerCase())) return months[i];
  }
  // numeric month like 12_20_2025 or 2025-12-20 or 122025
  m = s.match(/(?:^|[^0-9])(0?[1-9]|1[0-2])(?:\D|_)?(?:[0-3]?\d)?(?:\D|_)?20\d{2}(?:[^0-9]|$)/);
  if (m) { const n = parseInt(m[1],10); return months[n-1] || ''; }
  m = s.match(/(?:^|[^0-9])20\d{2}(?:\D|_)?(0?[1-9]|1[0-2])(?:\D|_)?(?:[0-3]?\d)?(?:[^0-9]|$)/);
  if (m) { const n = parseInt(m[1],10); return months[n-1] || ''; }
  return '';
}

function extractReportTypeFromFileName(name){
  const s = String(name||'').toLowerCase();
  if (s.includes('atu')) return 'ATU';
  if (s.includes('conjoint')) return 'Conjoint';
  if (s.includes('tracker')) return 'Tracker';
  if (s.includes('pmr') || s.includes('integrated') || s.includes('quant')) return 'PMR';
  if (s.includes('competitive') && s.includes('readiness')) return 'Competitive Readiness';
  return 'Survey';
}

// ===== end tag helpers =====
function requireSession(req,res,next){ 
  const t=req.get("x-auth-token"); 
  if(t && t===config.server.authToken) return next(); 
  if(req.session?.user) return next(); 
  res.status(401).json({ error:"Authentication required"}); 
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: "Unauthorized" });
}

// ---- Admin role utilities ----
function getRole(req) {
  return String((req.session && req.session.user && req.session.user.role) || '').toLowerCase().trim();
}

function isAdmin(req) { 
  return getRole(req) === 'admin'; 
}

function requireAdmin(req, res, next) {
  if (isAdmin(req)) return next();
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    res.status(403).json({ error: 'Admin access required' });
  }
  res.redirect('/');
}

// Pages
// Explicit asset routes (defensive)
app.get('/styles.css', (req, res) => { 
  res.type('text/css'); 
  res.sendFile(path.resolve('public/styles.css')); 
});

app.get('/enhanced_chart_rendering.js', (req, res) => { 
  res.type('application/javascript'); 
  res.sendFile(path.resolve('public/enhanced_chart_rendering.js')); 
});

app.get("/", async (req,res)=>{
  if(!req.session?.user){ 
    res.redirect("/login.html"); 
    return;
  }
  await serveHtmlWithUi(res, path.resolve("public/index.html")); 
});

app.get('/admin', requireAuth, async (req, res) => {
  if (!isAdmin(req)) {
    res.redirect('/');
    return;
  }
  await serveHtmlWithUi(res, path.resolve('public/admin.html')); 
});

// Admin Stats API endpoint
app.get("/api/admin/stats", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    // Get user data
    const usersData = readJSON(USERS_PATH, { users: [] });
    const adminCount = usersData.users.filter(u => u.role === 'admin').length;
    const clientCount = usersData.users.filter(u => u.role === 'client').length;
    
    // Get client libraries count
    const clientFolders = await listClientFolders();
    const libraryCount = clientFolders.length;
    
    // Mock searches today (you can implement real tracking later)
    const searchesToday = 0;
    
    res.json({
      totalAdmins: adminCount,
      totalClients: clientCount,
      clientLibraries: libraryCount,
      searchesToday: searchesToday
    });
  } catch (error) {
    logger.error("Failed to get admin stats:", error);
    res.status(500).json({ error: "Failed to get admin stats" });
  }
});

// Admin Accounts API endpoint
app.get("/api/admin/accounts", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    const usersData = readJSON(USERS_PATH, { users: [] });
    
    // Return user data without passwords
    const accounts = usersData.users.map(user => ({
      username: user.username,
      role: user.role,
      clientFolderId: user.clientFolderId || null,
      createdAt: user.createdAt || 'Unknown',
      allowedClients: user.allowedClients || null
    }));
    
    res.json(accounts);
  } catch (error) {
    logger.error("Failed to get admin accounts:", error);
    res.status(500).json({ error: "Failed to get admin accounts" });
  }
});

// Create User API endpoint
app.post("/api/admin/users/create", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    const { username, password, role, clientFolderId } = req.body;
    
    if (!username || !password || !role) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }
    
    if (password.length < 6) {
      res.status(400).json({ error: "Password must be at least 6 characters" });
      return;
    }
    
    const usersData = readJSON(USERS_PATH, { users: [] });
    
    // Check if username already exists
    const existingUser = usersData.users.find(u => u.username.toLowerCase() === username.toLowerCase());
    if (existingUser) {
      res.status(400).json({ error: "Username already exists" });
      return;
    }
    
    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create new user
    const newUser = {
      username,
      passwordHash,
      role: role === 'admin' ? 'internal' : role, // Map admin to internal
      createdAt: new Date().toISOString()
    };
    
    if (clientFolderId && role === 'client') {
      newUser.clientFolderId = clientFolderId;
      newUser.allowedClients = clientFolderId;
    }
    
    usersData.users.push(newUser);
    writeJSON(USERS_PATH, usersData);
    
    logger.info(`Created ${role} account: ${username}`);
    
    res.json({
      username: newUser.username,
      role: newUser.role,
      createdAt: newUser.createdAt
    });
    
  } catch (error) {
    logger.error("Failed to create user:", error);
    res.status(500).json({ error: "Failed to create user account" });
  }
});

// Add manual sync endpoint
app.post("/admin/manual-sync", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    logger.info("ðŸ”§ Manual Google Drive sync triggered from admin panel");
    await syncGoogleDriveData();
    res.json({ 
      success: true,
      message: "Google Drive sync completed successfully", 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    logger.error("Manual Google Drive sync failed:", error);
    res.status(500).json({ 
      success: false,
      error: "Google Drive sync failed", 
      details: error.message 
    });
  }
});

// Library Stats API endpoint - Fixed to show Google Drive files
app.get("/admin/library-stats", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    const { clientId } = req.query;
    
    if (!clientId) {
      res.status(400).json({ error: "Client ID required" });
      return;
    }
    
    // Get manifest data for the client
    const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
    let manifest = { files: [], lastUpdated: null };
    
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        logger.warn(`Failed to read manifest for ${clientId}:`, e.message);
      }
    }
    
    // Count processed vs total files
    const totalFiles = manifest.files.length;
    const processedFiles = manifest.files.filter(f => f.processed).length;
    
    res.json({
      driveCount: totalFiles,
      libraryCount: processedFiles,
      lastUpdated: manifest.lastUpdated,
      clientId: clientId
    });
    
  } catch (error) {
    logger.error("Failed to get library stats:", error);
    res.status(500).json({ error: "Failed to get library statistics" });
  }
});

// Delete User API endpoint
app.delete("/api/admin/users/:username", requireAuth, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    const { username } = req.params;
    
    if (username === req.session.user.username) {
      res.status(400).json({ error: "Cannot delete your own account" });
      return;
    }
    
    const usersData = readJSON(USERS_PATH, { users: [] });
    const userIndex = usersData.users.findIndex(u => u.username === username);
    
    if (userIndex === -1) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    
    const deletedUser = usersData.users.splice(userIndex, 1)[0];
    writeJSON(USERS_PATH, usersData);
    
    logger.info(`Deleted user account: ${username}`);
    
    res.json({
      message: `User ${username} deleted successfully`,
      deletedUser: {
        username: deletedUser.username,
        role: deletedUser.role
      }
    });
    
  } catch (error) {
    logger.error("Failed to delete user:", error);
    res.status(500).json({ error: "Failed to delete user account" });
  }
});

// Auth endpoints
app.get('/me', async (req, res) => {
  if (!req.session || !req.session.user) {
    res.status(401).json({ ok:false, error: 'Not authenticated' });
    return;
  }
  const u = req.session.user;
  const role = String(u.role || '').toLowerCase().trim();
  const activeClientId = req.session.activeClientId || null;
  res.json({ ok:true, user: { username: u.username, role }, activeClientId });
});

app.post('/auth/login', express.json(), async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      res.status(400).json({ ok:false, error: 'Missing credentials' });
      return;
    }
    const store = readJSON(USERS_PATH, { users: [] });
    const uname = String(username).trim().toLowerCase();
    const user = store.users.find(u => String(u.username||'').toLowerCase() === uname);
    if (!user) {
      res.status(401).json({ ok:false, error: 'Invalid username or password' });
      return;
    }
    let passOk = false;
    if (user.passwordHash) { 
      try { 
        passOk = await bcrypt.compare(password, user.passwordHash); 
      } catch {}
    }
    if (!passOk && user.password) { 
      passOk = (user.password === password); 
    }
    if (!passOk) {
      res.status(401).json({ ok:false, error: 'Invalid username or password' });
      return;
    }
    const role = String(user.role || '').toLowerCase().trim();
    if (!['admin','client'].includes(role)) {
      res.status(403).json({ ok:false, error: 'Unauthorized role' });
      return;
    }
    req.session.user = { 
      username: user.username, 
      role, 
      allowedClients: user.allowedClients || null, 
      clientFolderId: user.clientFolderId || null 
    };
    res.json({ ok:true, user: { username: user.username, role } });
  } catch (err) {
    logger.error('Login error', err);
    res.status(500).json({ ok:false, error: 'Login failed' });
  }
});

app.post('/auth/logout', (req, res) => {
  try {
    req.session.destroy(() => res.json({ ok:true }));
  } catch {
    res.json({ ok:true });
  }
});

app.post('/auth/change-password', express.json(), async (req,res)=>{
  try{
    const { currentPassword, newPassword } = req.body || {};
    if (!req.session?.user) {
      res.status(401).json({ ok:false, error:'Not authenticated' });
      return;
    }
    if (!newPassword) {
      res.status(400).json({ ok:false, error:'New password required' });
      return;
    }
    const store = readJSON(USERS_PATH, { users: [] });
    const idx = store.users.findIndex(u => u.username === req.session.user.username);
    if (idx === -1) {
      res.status(404).json({ ok:false, error:'User not found' });
      return;
    }
    const user = store.users[idx];
    // verify current
    let passOk = false;
    if (user.passwordHash) {
      try { 
        passOk = await bcrypt.compare(currentPassword||'', user.passwordHash); 
      } catch {}
    }
    if (!passOk && user.password) passOk = (user.password === (currentPassword||''));
    if (!passOk) {
      res.status(401).json({ ok:false, error:'Current password incorrect' });
      return;
    }
    // update
    const newHash = await bcrypt.hash(newPassword, 10);
    delete user.password;
    user.passwordHash = newHash;
    store.users[idx] = user;
    writeJSON(USERS_PATH, store);
    res.json({ ok:true });
  }catch(err){
    logger.error('change-password error', err);
    res.status(500).json({ ok:false, error:'Failed to change password' });
  }
});

// Static files with cache control
app.use(express.static("public", {
  index:false, 
  setHeaders(res,filePath){ 
    if(/\.(html|css|js)$/i.test(filePath)){ 
      res.setHeader("Cache-Control","no-store"); 
    } else { 
      res.setHeader("Cache-Control","public, max-age=86400"); 
    } 
  }
}));

// Admin endpoints
app.post("/admin/sync-data", requireAuth, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }
  
  try {
    logger.info("ðŸ”§ Manual data sync triggered");
    await syncGoogleDriveData();
    res.json({ 
      message: "Data sync completed successfully", 
      timestamp: new Date().toISOString() 
    });
  } catch (error) {
    logger.error("Manual data sync failed:", error);
    res.status(500).json({ 
      error: "Data sync failed", 
      details: error.message 
    });
  }
});

app.get("/admin/sync-status", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }

  try {
    const clientFolders = await listClientFolders();
    const status = [];

    for (const folder of clientFolders) {
      const manifestPath = path.join(MANIFEST_DIR, `${folder.id}.json`);
      let manifest = { files: [], lastUpdated: null };
      
      if (fs.existsSync(manifestPath)) {
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        } catch (e) {
          // ignore
        }
      }

      status.push({
        clientId: folder.id,
        clientName: folder.name,
        fileCount: manifest.files.length,
        processedCount: manifest.files.filter(f => f.processed).length,
        lastUpdated: manifest.lastUpdated
      });
    }

    res.json({ status, serverStartTime: new Date().toISOString() });
  } catch (error) {
    logger.error("Failed to get sync status:", error);
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

// FIXED: Get current file manifest for a client
app.get("/api/client-manifest/:clientId", async (req, res) => {
  try {
    const { clientId } = req.params;
    const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
    
    if (fs.existsSync(manifestPath)) {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      
      // Filter out any files that might not exist anymore
      const validFiles = manifest.files.filter(file => file && file.name);
      
      res.json({
        ...manifest,
        files: validFiles
      });
    } else {
      res.json({ files: [], lastUpdated: null });
    }
  } catch (error) {
    logger.error("Manifest fetch error:", error);
    res.status(500).json({ error: "Failed to fetch manifest" });
  }
});

// ===== Manifest-driven filter to drop stale references =====
async function filterChunksToCurrentManifest(chunks, clientId){
  try{
    if (!Array.isArray(chunks) || chunks.length === 0) return chunks || [];
    if (!clientId) return chunks;

    const manifest = await getClientManifest(clientId);
    const files = Array.isArray(manifest?.files) ? manifest.files : [];
    const processedCount = files.filter(f => f && f.processed === true).length;

    // If nothing processed / empty manifest, don't drop results
    if (files.length === 0 || processedCount === 0) {
      return chunks;
    }

    // Create comprehensive matching sets for current files
    const currentFileIds = new Set(files.map(f => f.id).filter(Boolean));
    const currentNormalizedNames = new Set(files.map(f => f.name ? f.name.toLowerCase().replace(/[^a-z0-9]/g, '') : '').filter(Boolean));
    
    // Also track all possible name variations for renamed files
    const nameVariations = new Set();
    files.forEach(f => {
      if (f.name) {
        nameVariations.add(f.name.toLowerCase());
        nameVariations.add(f.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
        // Add partial matches for common patterns
        const words = f.name.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        words.forEach(word => nameVariations.add(word));
      }
    });

    const filtered = (chunks||[]).filter(c => {
      // First check if file ID matches current files
      if (c.fileId && currentFileIds.has(c.fileId)) {
        return true;
      }
      
      // Then check various name patterns
      const candidates = [
        c.fileName, c.source, c.study, c.title, c.name
      ].filter(Boolean);
      
      for (const candidate of candidates) {
        const normalized = candidate.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (currentNormalizedNames.has(normalized)) {
          return true;
        }
        
        // Check if any words from the candidate match current file variations
        const candidateWords = candidate.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
        const matchingWords = candidateWords.filter(word => nameVariations.has(word));
        
        // If significant word overlap, consider it a match (handles renames)
        if (matchingWords.length > 0 && matchingWords.length / candidateWords.length > 0.5) {
          return true;
        }
      }
      
      return false;
    });

    // If filtering removes everything, fallback to original chunks to avoid empty results
    if (filtered.length === 0) {
      logger.warn(`Manifest filter removed all chunks - using original results as fallback`);
      return chunks; 
    }
    
    logger.info(`Manifest filter: ${chunks.length} â†’ ${filtered.length} chunks (handles renamed files)`);
    return filtered;
  }catch(e){
    logger.warn("Manifest filter fallback:", e?.message||e);
    return chunks||[];
  }
}

async function getClientManifest(clientId) {
  const manifestPath = path.join(MANIFEST_DIR, `${clientId}.json`);
  if (fs.existsSync(manifestPath)) {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  return { files: [], lastUpdated: null };
}

// Client libraries endpoint
async function listClientFolders(){
  if (!config.drive.rootFolderId){
    return [{id:"sample_client_1", name:"Genentech Research"}];
  }
  try{
    const drive = google.drive({version:"v3", auth: authClient || getAuth()});
    const q = `'${config.drive.rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    const resp = await drive.files.list({ 
      q, 
      fields:"files(id,name)", 
      pageSize:200, 
      supportsAllDrives:true, 
      includeItemsFromAllDrives:true 
    });
    return (resp.data.files||[]).map(f=>({id:f.id, name:f.name}));
  }catch(e){
    logger.error("Failed to list client folders:", e.message);
    return [];
  }
}

app.get("/api/client-libraries", async (req,res)=>{
  const libs = await listClientFolders();
  logger.info(`Returning ${libs.length} client libraries`);
  res.json(libs);
});

// MAIN SEARCH ENDPOINT - FIXED for thumbnails and file names
app.post("/search", requireSession, async (req,res)=>{
  try{
    const { userQuery, clientId, filters } = req.body || {};
    if(!userQuery || !String(userQuery).trim()) {
      res.status(400).json({ error:"Query is required"});
      return;
    }
    
    const namespace = clientId || req.session?.activeClientId || "sample_client_1";
    logger.info(`Search query: "${userQuery}" in namespace: ${namespace}`);
    
    const [queryEmbedding] = await embedTexts([String(userQuery).trim()]);
    const topK = filters?.topK || config.ai.defaultTopK;
    const searchResults = await pineconeQuery(queryEmbedding, namespace, topK);
    const matches = (searchResults.matches||[]).sort((a,b)=>(b.score||0)-(a.score||0));
    
    logger.info("Pinecone search returned", matches.length, "results");
    logger.info("Top scores:", matches.slice(0,5).map(m=> (m.score||0).toFixed(3)).join(", "));
    
    const threshold = config.search.scoreThreshold;
    let relevantChunks = matches.filter(m=> (m.score||0) >= threshold).map((m,i)=>{
      const md = m.metadata||{};
      return {
        id:`ref${i+1}`,
        fileName: md.fileName || md.source || "Unknown Document",
        study: md.study || md.title || md.fileName || "Unknown Study",
        yearTag: md.year || md.yearTag || extractYearFromFileName(md.fileName||""),
        monthTag: md.month || md.monthTag || extractMonthFromFileName(md.fileName||""),
        reportTag: md.reportType || md.reportTag || extractReportTypeFromFileName(md.fileName||""),
        textSnippet: md.text || md.content || "Content not available",
        score: m.score,
        pageNumber: md.page || md.pageNumber || 1,
        page: md.page || md.pageNumber || 1,
        source: md.source || md.fileName || "Unknown Document",
        chunkIndex: md.chunkIndex,
        // CRITICAL: Add Google Drive file ID from metadata
        fileId: md.fileId || md.driveId || md.gdocId || null
      };
    });
    
    if (relevantChunks.length===0 && matches.length>0){
      logger.warn(`No matches exceeded threshold ${threshold}. Using topK as fallback.`);
      const fallbackCount = Math.min(matches.length, Number(topK)||50);
      relevantChunks = matches.slice(0,fallbackCount).map((m,i)=>{
        const md = m.metadata||{};
        return {
          id:`ref${i+1}`,
          fileName: md.fileName || md.source || "Unknown Document",
          study: md.study || md.title || md.fileName || "Unknown Study",
          yearTag: md.year || md.yearTag || extractYearFromFileName(md.fileName||""),
          monthTag: md.month || md.monthTag || extractMonthFromFileName(md.fileName||""),
          reportTag: md.reportType || md.reportTag || extractReportTypeFromFileName(md.fileName||""),
          textSnippet: md.text || md.content || "Content not available",
          score: m.score,
          pageNumber: md.page || md.pageNumber || 1,
          page: md.page || md.pageNumber || 1,
          source: md.source || md.fileName || "Unknown Document",
          chunkIndex: md.chunkIndex,
          // CRITICAL: Add Google Drive file ID from metadata
          fileId: md.fileId || md.driveId || md.gdocId || null
        };
      });
    }
    
    logger.info(`Processed ${relevantChunks.length} relevant chunks`);

    // ENHANCED: Better file ID mapping from current Google Drive manifest with name updates
    try {
      const manifestPath = path.join(MANIFEST_DIR, `${namespace}.json`);
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const currentFiles = manifest.files || [];
        
        // Create multiple mappings for robust file matching
        const fileIdToCurrentData = new Map();
        const normalizedNameToCurrentData = new Map();
        
        currentFiles.forEach(file => {
          if (file.id && file.name) {
            const currentData = {
              id: file.id,
              currentName: file.name,  // This is the up-to-date name from Drive
              mimeType: file.mimeType,
              modifiedTime: file.modifiedTime
            };
            
            // Map by file ID (most reliable)
            fileIdToCurrentData.set(file.id, currentData);
            
            // Map by normalized name for fallback matching
            const normalizedName = file.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            normalizedNameToCurrentData.set(normalizedName, currentData);
          }
        });
        
        // Update chunks with current Google Drive file information
        relevantChunks.forEach(chunk => {
          let matched = false;
          
          // First, try to match by existing fileId in metadata
          if (chunk.fileId && fileIdToCurrentData.has(chunk.fileId)) {
            const currentData = fileIdToCurrentData.get(chunk.fileId);
            chunk.fileName = currentData.currentName;  // Use CURRENT name from Drive
            chunk.source = currentData.currentName;
            matched = true;
            console.log(`âœ… Updated by fileId: ${chunk.fileId} â†’ ${currentData.currentName}`);
          }
          
          // If no fileId match, try matching by normalized filename
          if (!matched && chunk.fileName) {
            const normalizedChunkName = chunk.fileName.toLowerCase().replace(/[^a-z0-9]/g, '');
            
            if (normalizedNameToCurrentData.has(normalizedChunkName)) {
              const currentData = normalizedNameToCurrentData.get(normalizedChunkName);
              chunk.fileId = currentData.id;
              chunk.fileName = currentData.currentName;  // Use CURRENT name from Drive
              chunk.source = currentData.currentName;
              matched = true;
              console.log(`âœ… Updated by name match: ${normalizedChunkName} â†’ ${currentData.currentName} (${currentData.id})`);
            }
          }
          
          // Try partial matching for renamed files
          if (!matched && chunk.fileName) {
            const chunkWords = chunk.fileName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
            
            for (const [fileId, currentData] of fileIdToCurrentData.entries()) {
              const currentWords = currentData.currentName.toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2);
              
              // Calculate word overlap
              const commonWords = chunkWords.filter(word => currentWords.includes(word));
              const similarity = commonWords.length / Math.max(chunkWords.length, currentWords.length);
              
              // If significant similarity (>60% word overlap), assume it's the same file
              if (similarity > 0.6) {
                chunk.fileId = currentData.id;
                chunk.fileName = currentData.currentName;  // Use CURRENT name from Drive
                chunk.source = currentData.currentName;
                matched = true;
                console.log(`âœ… Updated by similarity match: ${chunk.fileName} â†’ ${currentData.currentName} (${similarity.toFixed(2)} similarity)`);
                break;
              }
            }
          }
        });
        
        logger.info(`Mapped file IDs for ${relevantChunks.filter(c => c.fileId).length} chunks from current manifest`);
        logger.info(`Using current file names from Google Drive (handles renames)`);
      }
    } catch (error) {
      logger.error('Error mapping file IDs from manifest:', error);
    }

    // Drop any references not in current Drive manifest (prevents stale docs)
    if (Array.isArray(relevantChunks)) {
      const activeClient = (req.session && req.session.clientId) || (filters && filters.clientId) || null;
      if (!config.search.skipManifestFilter) {
        relevantChunks = await filterChunksToCurrentManifest(relevantChunks, activeClient);
      } else { 
        logger.info('Manifest filter skipped via SKIP_MANIFEST_FILTER'); 
      }
      logger.info(`After manifest filter: ${relevantChunks.length} chunks`);
    
      // If nothing survives filtering, avoid hallucinations: return a grounded message
      if (!relevantChunks || relevantChunks.length === 0) {
        res.json({
          answer: "I couldn't find grounded content in the selected library for that question.",
          supporting: [],
          reportSlides: [],
          references: [],
          ok: true
        });
        return;
      }
    }

    // Select most recent study once (global for this request)
    const recency = preferMostRecent(relevantChunks);
    const mostRecentRef = recency.mostRecent;

    // Generate main answer with better headline structure
    const context = relevantChunks.map((c,i)=>`[${i+1}] ${c.textSnippet}`).join("\n\n");
    let generatedAnswer = "No answer.";
    
    try{
      const prompt = `You are a research analyst providing direct answers based ONLY on the snippets below.

User Question: "${userQuery}"

Relevant Information from Documents:
${context}

Instructions:
Create a structured answer with:
1. HEADLINE: A direct, factual answer to the question (NOT a newspaper headline). Start with key findings, percentages, or specific answers.
2. DETAILS: 2-3 supporting sentences that provide context and evidence with [1], [2] citations

HEADLINE Examples:
- "Evrysdi holds 35% market share, followed by Spinraza at 32% and Zolgensma at 13%"
- "The primary barriers are insurance coverage issues (53%), access concerns (26%), and efficacy questions (16%)"
- "Treatment effectiveness shows 75% of patients experienced improvement within 6 months"

Format your response as:
HEADLINE: [Direct answer with key data/findings]
DETAILS: [Supporting context with citations]

Answer:`;
      
      const completion = await openai.chat.completions.create({
        model: config.ai.answerModel,
        messages: [{ role:"user", content: prompt }],
        temperature: 0.2, 
        max_tokens: 500
      });
      generatedAnswer = completion.choices[0]?.message?.content || generatedAnswer;
    }catch(e){
      logger.warn("OpenAI completion failed:", e.message);
      generatedAnswer = "HEADLINE: Limited evidence found in research library\nDETAILS: Unable to generate comprehensive answer based on available documents.";
    }

    // Generate supporting themes without duplication
    let supportingThemes = [];
    try {
      const model = config.ai.answerModel;
      supportingThemes = await buildSupportingThemes(openai, model, userQuery, relevantChunks);
      logger.info(`Generated ${supportingThemes.length} supporting themes with proper chart data`);
    } catch(e) {
      logger.warn('buildSupportingThemes failed:', e?.message || e);
    }

    // Basic themes aggregation for backwards compatibility
    const byReportType = {};
    const byYear = {};
    for (const c of relevantChunks){
      if (c?.reportTag) byReportType[c.reportTag] = (byReportType[c.reportTag]||0)+1;
      if (c?.yearTag) byYear[c.yearTag] = (byYear[c.yearTag]||0)+1;
    }

    const themes = [
      { key:"byReportType", title:"References by Report Type", type:"bar",
        data: Object.entries(byReportType).map(([label,value])=>({label,value})).sort((a,b)=>b.value-a.value) },
      { key:"byYear", title:"References by Year", type:"bar",
        data: Object.entries(byYear).map(([label,value])=>({label,value})).sort((a,b)=> String(a.label).localeCompare(String(b.label))) },
    ];

    // FIXED: Generate reports with actual thumbnails (not fallback placeholders)
    const reports = await (async () => {
      const arr = (relevantChunks || []).slice(0, 6);
      const out = [];
      
      for (const c of arr) {
        let thumb = null, preview = null;
        
        if (c.fileId) {
          try {
            console.log(`[suppressed] Generating thumbnail for: ${c.fileName} (${c.fileId}) page ${c.page}`);
            thumb = await getPdfThumbnail(c.fileId, c.page || 1);
            preview = buildDrivePreviewUrl(c.fileId, c.page);
            console.log(`Thumbnail result: ${thumb ? 'SUCCESS' : 'FAILED'}`);
          } catch (e) {
            console.error('Error getting thumbnail for', c.fileId, e);
          }
        }
        
        // Only include if we have valid data
        if (c.fileName && c.fileId) {
          out.push({
            source: c.fileName,        // Use actual file name from manifest
            page: c.page || 1,
            study: c.fileName,         // Use file name as study
            date: (c.monthTag ? (c.monthTag + ' ') : '') + (c.yearTag || ''),
            fileId: c.fileId,
            preview,
            thumbnail: thumb           // This will be base64 data URL or null
          });
        }
      }
      
      console.log(`Generated ${out.length} reports with thumbnails`);
      return out;
    })();

    console.log('Debug - Generated reports with thumbnails:', reports);
    console.log('Debug - First report:', reports[0]);

    res.json({
      dashboard: await buildDashboardPayload({answer: generatedAnswer, themes, relevantChunks, mostRecentRef}),
      answer: generatedAnswer,
      supportingThemes: supportingThemes || [],
      references: { chunks: relevantChunks },
      reports,  // This now contains actual thumbnails and correct file names
      themes,
      quotes: [], 
      visuals: [], 
      supportingData: [], 
      secondary: [], 
      supportingBullets: [],
      searchMeta: { 
        totalResults: matches.length, 
        threshold, 
        usedFallback: relevantChunks.length>0 && (matches[0]?.score||0)<threshold
      }
    });
  }catch(err){
    logger.error("Search error:", err);
    res.status(500).json({ error:"Failed to process search query" });
  }
});

// === Simple Reports Store (per-user) ===
const REPORTS_DB = path.resolve(process.cwd(), "data-cache", "reports.json");
function getUserKey(req){ return (req.session?.user?.username) ? `u:${req.session.user.username}` : `s:${req.sessionID||'anon'}`; }
function readReportsDb(){ try{ return JSON.parse(fs.readFileSync(REPORTS_DB,"utf-8")); }catch(e){ return {}; } }
function writeReportsDb(db){ try{ fs.mkdirSync(path.dirname(REPORTS_DB), {recursive:true}); fs.writeFileSync(REPORTS_DB, JSON.stringify(db,null,2)); }catch(e){ logger.warn("Failed to write reports DB:", e.message); } }
function sanitizeText(s) {
  // Strip ASCII control chars (0x00â€“0x1F and DEL 0x7F), collapse whitespace, trim, cap length
  const str = String(s ?? "");
  const cleaned = str.replace(/[\x00-\x1F\x7F]+/g, " ");
  return cleaned.replace(/\s+/g, " ").trim().slice(0, 20000);
}

app.get("/api/reports", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  const list = Object.values(db[key]||{});
  res.json({ ok:true, data: list });
});

app.post("/api/reports", requireSession, (req,res)=>{
  const { title } = req.body||{};
  const db = readReportsDb(); const key = getUserKey(req);
  const id = `rep_${new Date().toISOString().replace(/[-:TZ.]/g,'').slice(0,14)}_${Math.random().toString(36).substr(2,5)}`;
  const now = Date.now();
  const rep = { id, title: sanitizeText(title||"My Working Report"), items: [], createdBy: req.session?.user?.username||null, createdAt: now, updatedAt: now };
  db[key] = db[key] || {}; db[key][id] = rep; writeReportsDb(db);
  res.json({ ok:true, data: rep });
});

app.get("/api/reports/:id", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  const rep = (db[key]||{})[req.params.id];
  if(!rep) return res.status(404).json({ ok:false, error:"Not found" });
  res.json({ ok:true, data: rep });
});

app.put("/api/reports/:id", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  const rep = (db[key]||{})[req.params.id];
  if(!rep) return res.status(404).json({ ok:false, error:"Not found" });
  if (typeof req.body.title === 'string') rep.title = sanitizeText(req.body.title);
  if (Array.isArray(req.body.items)) rep.items = req.body.items.map(it=> ({
    id: String(it.id||Math.random().toString(36).slice(2)),
    responseId: sanitizeText(it.responseId||""),
    content: sanitizeText(it.content||""),
    sourceMeta: it.sourceMeta && typeof it.sourceMeta==='object' ? it.sourceMeta : {},
    createdAt: Number(it.createdAt||Date.now())
  }));
  rep.updatedAt = Date.now(); writeReportsDb(db);
  res.json({ ok:true, data: rep });
});

app.delete("/api/reports/:id", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  if (db[key] && db[key][req.params.id]) { delete db[key][req.params.id]; writeReportsDb(db); }
  res.json({ ok:true, data: true });
});

app.post("/api/reports/:id/items", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  const rep = (db[key]||{})[req.params.id];
  if(!rep) return res.status(404).json({ ok:false, error:"Not found" });
  const items = Array.isArray(req.body?.items)? req.body.items : [];
  for (const it of items){
    rep.items.push({
      id: String(it.id||Math.random().toString(36).slice(2)),
      responseId: sanitizeText(it.responseId||""),
      content: sanitizeText(it.content||""),
      sourceMeta: it.sourceMeta && typeof it.sourceMeta==='object' ? it.sourceMeta : {},
      createdAt: Number(it.createdAt||Date.now())
    });
  }
  rep.updatedAt = Date.now(); writeReportsDb(db);
  res.json({ ok:true, data: rep });
});

app.put("/api/reports/:id/items/reorder", requireSession, (req,res)=>{
  const db = readReportsDb(); const key = getUserKey(req);
  const rep = (db[key]||{})[req.params.id];
  if(!rep) return res.status(404).json({ ok:false, error:"Not found" });
  const ids = Array.isArray(req.body?.itemIds) ? req.body.itemIds.map(String) : [];
  const map = new Map(rep.items.map(it=>[String(it.id), it]));
  rep.items = ids.map(id=> map.get(String(id))).filter(Boolean);
  rep.updatedAt = Date.now(); writeReportsDb(db);
  res.json({ ok:true, data: rep });
});

app.post("/api/telemetry", (req,res)=>{
  try { logger.info("telemetry", req.body||{}); } catch(_) {}
  res.json({ ok:true });
});

// Health check
app.get("/health", (req,res)=> res.json({ ok:true, time:new Date().toISOString() }));

// --- Improved: /api/libraries returns readable names
app.get("/api/libraries", requireAuth, requireAdmin, async (req, res) => {
  try {
    if (!isAdmin(req)) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }
    const folders = await listClientFolders().catch(() => []);
    const libs = [];
    (Array.isArray(folders) ? folders : []).forEach(item => {
      if (item == null) return;
      if (typeof item === 'string') {
        libs.push({ id: item, name: item });
      } else if (typeof item === 'object') {
        const id = item.id || item.folderId || item.gid || item.code || item.key || item.slug || item.name || item.folderName;
        const name = item.name || item.title || item.clientName || item.displayName || item.folderName || item.label || item.text || item.client || item.library || id || 'Unnamed';
        libs.push({ id, name });
      }
    });
    res.json(libs);
  } catch (e) {
    logger && logger.error && logger.error("GET /api/libraries", e);
    res.json([]);
  }
});

// === v11: Stats per library (ESM/CJS-safe, NO `return` statements inside handler) ===
app.get("/api/libraries/:id/stats", requireAuth, requireAdmin, async (req, res) => {
  if (!isAdmin(req)) { 
    res.status(403).json({ error: 'Admin access required' }); 
    return;
  }

  try {
    const { id } = req.params;
    
    // Get manifest data from Google Drive sync
    const manifestPath = path.join(MANIFEST_DIR, `${id}.json`);
    let manifest = { files: [], lastUpdated: null };
    
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch (e) {
        logger.warn(`Failed to read manifest for ${id}:`, e.message);
      }
    }
    
    const totalFiles = manifest.files.length;
    const processedFiles = manifest.files.filter(f => f.processed).length;
    
    // Categorize files
    let reportCount = 0;
    let qnrCount = 0;
    let dataCount = 0;
    
    manifest.files.forEach(file => {
      const folderPath = (file.folderPath || '').toLowerCase();
      const fileName = (file.name || '').toLowerCase();
      
      if (folderPath.includes('report') || fileName.includes('report')) {
        reportCount++;
      } else if (folderPath.includes('qnr') || folderPath.includes('questionnaire')) {
        qnrCount++;
      } else if (folderPath.includes('data')) {
        dataCount++;
      } else {
        reportCount++;
      }
    });
    
    res.json({
      totalFiles: totalFiles,
      processedFiles: processedFiles,
      lastSynced: manifest.lastUpdated,
      byCategory: {
        Reports: reportCount,
        QNR: qnrCount,
        DataFiles: dataCount
      },
      // Legacy format for compatibility
      files: totalFiles,
      lastIndexed: manifest.lastUpdated,
      byFolder: {
        Reports: reportCount,
        QNR: qnrCount,
        DataFiles: dataCount
      }
    });
    
  } catch (error) {
    logger.error("Failed to get library stats:", error);
    res.status(500).json({ 
      totalFiles: 0, 
      processedFiles: 0, 
      lastSynced: null,
      byCategory: { Reports: 0, QNR: 0, DataFiles: 0 },
      // Legacy format
      files: 0, 
      lastIndexed: null, 
      byFolder: { Reports: 0, QNR: 0, DataFiles: 0 } 
    });
  }
});

// Start server
if (!global._started){
  global._started=true;
  const server = 

// ---------------------------------------------------------------------------
// SECURE SLIDE ROUTE (brace-safe, ESM-safe)
// ---------------------------------------------------------------------------
console.info('âœ” secure-slide route ready');
app.get('/secure-slide/:fileId/:page', async (req, res) => {
  try {
    const rawFileId = req.params.fileId || '';
    const pageNumber = Math.max(1, parseInt(req.params.page, 10) || 1);
    const fileId = decodeURIComponent(rawFileId);

    if (!fileId) {
      return res.status(400).json({ error: 'File ID is required' });
    }

    // Reuse your existing auth initialization
    if (!authClient) {
      await initializeGoogleAuth();
    }
    const drive = google.drive({ version: 'v3', auth: authClient });

    // Download the PDF bytes into memory (no temp files)
    const arrayBuffer = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'arraybuffer' }
    ).then(r => r.data);
    const pdfBuffer = Buffer.from(arrayBuffer);

    // ---- Load pdfjs (try multiple entry points) and canvas (Windows-friendly) ----
    async function loadPdfjs() {
      const candidates = [
        'pdfjs-dist/legacy/build/pdf.mjs',
        'pdfjs-dist/legacy/build/pdf.js',
        'pdfjs-dist/build/pdf.mjs',
        'pdfjs-dist'
      ];
      for (const p of candidates) {
        try { return { mod: await import(p), variant: p }; } catch {}
      }
      return { mod: null, variant: null };
    }
    async function loadCanvas() {
      try {
        const m = await import('@napi-rs/canvas');
        const createCanvas = m.createCanvas || (m.default && m.default.createCanvas);
        if (createCanvas) return { mod: m, variant: '@napi-rs/canvas' };
      } catch {}
      try {
        const m = await import('canvas');
        const createCanvas = m.createCanvas || (m.default && m.default.createCanvas);
        if (createCanvas) return { mod: m, variant: 'canvas' };
      } catch {}
      return { mod: null, variant: null };
    }
    // -----------------------------------------------------------------------------

    const { mod: pdfjsLib } = await loadPdfjs();
    const { mod: canvasMod } = await loadCanvas();

    // If deps arenâ€™t available, fail fast (keeps UI snappy, no errors)
    if (!pdfjsLib || !canvasMod) {
      console.warn('secure-slide: missing pdfjs or canvas; returning 204');
      return res.status(204).end();
    }

    const createCanvas =
      canvasMod.createCanvas ||
      (canvasMod.default && canvasMod.default.createCanvas);
    if (!createCanvas) return res.status(204).end();

    // Render the requested page to PNG
    const loadingTask = pdfjsLib.getDocument({
  data: new Uint8Array(pdfBuffer),
  disableWorker: true,
  isEvalSupported: false
});
    const pdf = await loadingTask.promise;
    const pageIndex = Math.min(pageNumber, pdf.numPages);
    const page = await pdf.getPage(pageIndex);

    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const ctx = canvas.getContext('2d');

    await page.render({ canvasContext: ctx, viewport }).promise;

    const buf = canvas.toBuffer('image/png');
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600, immutable');
    return res.end(buf);
  } catch (err) {
    console.error('secure-slide error:', err?.message || err);
    return res.status(204).end();
  }
}); // <-- keep this exact closing line
// ---------------------------------------------------------------------------


// Health endpoint for slide deps

app.get('/secure-slide/health', async (req, res) => {
  const out = { ok: true, pdfjs: false, canvas: false, variant: { pdfjs: null, canvas: null } };
  try { const { mod, variant } = await __loadPdfjsFlexible(); out.pdfjs = !!mod; out.variant.pdfjs = variant; } catch {}
  try { const { mod, variant } = await __loadCanvasFlexible(); out.canvas = !!mod; out.variant.canvas = variant; } catch {}
  res.json(out);
});


app.listen(config.server.port, async ()=>{
    logger.info(`Jaice server running on port ${config.server.port}`);
    logger.info(`Secure cookies: ${config.server.secureCookies}`);
    logger.info(`AI Model: ${config.ai.answerModel}`);
    logger.info(`Embedding Model: ${config.ai.embeddingModel}`);
    logger.info(`Auto-ingest on start: ${config.autoIngest.onStart}`);
    
    if (config.autoIngest.syncIntervalMs > 0) {
      const intervalHours = Math.round(config.autoIngest.syncIntervalMs / 3600000 * 10) / 10;
      logger.info(`Recurring sync: Every ${intervalHours} hours`);
    } else {
      logger.warn(`Recurring sync: DISABLED`);
    }
    
    // Initialize Google Drive authentication
    try {
      await initializeGoogleAuth();
    } catch (error) {
      logger.error('Failed to initialize Google Drive authentication:', error);
    }
    
    // Initialize auto-sync
    await initializeAutoSync();
  });

  // Add cleanup function for temp files on server shutdown
  process.on('SIGINT', () => {
    try {
      rmSync(TEMP_DIR, { recursive: true, force: true });
      console.log('Cleaned up temporary files');
    } catch (error) {
      console.warn('Failed to cleanup temp directory:', error.message);
    }
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    try {
      rmSync(TEMP_DIR, { recursive: true, force: true });
      console.log('Cleaned up temporary files');
    } catch (error) {
      console.warn('Failed to cleanup temp directory:', error.message);
    }
    process.exit(0);
  });
}

// (idempotent) text signature endpoint - appended safely
try {
  const __existing = app._router && app._router.stack && app._router.stack.find(s => s.route && s.route.path === '/secure-slide/text/:fileId/:page');
  if (!__existing) {
    app.get('/secure-slide/text/:fileId/:page', async (req, res) => {
      const fileId = req.params.fileId;
      const pageNumber = Math.max(1, parseInt(req.params.page, 10) || 1);
      try {
        const buffer = await __downloadDriveFile(fileId);
        const { mod } = await __loadPdfjsFlexible();
        const pdfjsLib = (mod && (mod.getDocument || mod.GlobalWorkerOptions)) ? mod : (mod && mod.default ? mod.default : null);
        if (!pdfjsLib || !pdfjsLib.getDocument) {
          throw new Error('PDF.js library not properly loaded or getDocument not available');
        }
        const task = pdfjsLib.getDocument({ data: new Uint8Array(buffer), disableWorker: true, isEvalSupported: false });
        const doc = await task.promise;
        const clamped = Math.min(doc.numPages, Math.max(1, pageNumber));
        const page = await doc.getPage(clamped);
        const content = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        const text = (content.items || []).map(i => (i && i.str) ? i.str : '').join(' ').replace(/\s+/g, ' ').trim();
        res.setHeader('Cache-Control', 'public, max-age=1800');
        res.status(200).json({
          ok: true,
          page: clamped,
          length: text.length,
          hasDigits: /\d/.test(text),
          hasPercent: /%/.test(text),
          snippet: text.slice(0, 600)
        });
      } catch (err) {
        console.error('secure-slide text error (appended):', fileId, pageNumber, err);
        res.status(200).json({ ok: false, error: String(err) });
      }
    });
  }
} catch(_){}
