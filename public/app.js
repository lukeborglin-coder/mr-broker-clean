/* public/app.js — shared helpers only (no legacy Ask handlers, no alerts)
   - KEEP: fetch helpers (jget/jpost)
   - ADD: inline message + thinking + refs helpers
   - UPDATE: formatRefsToSup merges adjacent [n][m] → <sup>n;m</sup>
   - NEW: toMetricId, guessMetricIdFromQuestion, and pass-throughs for chart API
*/

const API_BASE = (window.CONFIG || {}).API_BASE || "";

// JSON helpers
async function jget(u) {
  const r = await fetch(API_BASE + u);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
async function jpost(u, b) {
  const r = await fetch(API_BASE + u, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(b || {}),
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// Tiny DOM helpers
const $ = (sel, root = document) =>
  typeof sel === "string" ? root.querySelector(sel.startsWith("#") ? sel : `#${sel}`) : sel;
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Inline message helper
function showInlineMessage(msg, kind = "error") {
  const box = $("#msg");
  if (!box) return;
  box.textContent = msg || "";
  box.className = "msg " + (kind === "error" ? "" : "info");
  box.style.display = msg ? "block" : "none";
}
function clearInlineMessage() {
  const box = $("#msg");
  if (!box) return;
  box.textContent = "";
  box.className = "msg";
  box.style.display = "none";
}

// Thinking overlay + inline status
function setThinking(on) {
  const overlay = $("#overlay");
  const inline = $("#inlineStatus");
  if (overlay) overlay.classList.toggle("hidden", !on);
  if (inline) inline.style.display = on ? "flex" : "none";
  const ask = $("#ask");
  if (ask) ask.disabled = !!on;
}

// Merge bracketed citations into <sup>
function formatRefsToSup(text) {
  const s = String(text || "");
  const merged = s.replace(/(?:\[\d+\])+/g, (match) => {
    const nums = Array.from(match.matchAll(/\[(\d+)\]/g)).map((m) => m[1]);
    return `<sup>${nums.join(";")}</sup>`;
  });
  return merged
    .replace(/\s+\[(\d+)\]/g, "<sup>$1</sup>")
    .replace(/\[(\d+)\]/g, "<sup>$1</sup>");
}
function setHTMLWithRefs(el, text) {
  if (!el) return;
  el.innerHTML = formatRefsToSup(text);
}

// Derive support bullets from raw snippets
function deriveSupportBullets(snippets, { maxCount = 10, maxLen = 200 } = {}) {
  const lines = [];
  (snippets || []).forEach(s => {
    String(s || "").split(/\n+/).forEach(t => {
      const clean = String(t).replace(/\s+/g, " ").trim();
      if (!clean) return;
      lines.push(clean);
    });
  });
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const t = l.slice(0, maxLen).replace(/[;:,]\s*$/, ".");
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(/[.!?]$/.test(t) ? t : t + ".");
    if (out.length >= maxCount) break;
  }
  return out;
}

/* ==== NEW: Chart helpers/glue ==== */
function toMetricId(label) {
  return String(label || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}
function guessMetricIdFromQuestion(q) {
  const text = String(q || "").toLowerCase();
  const SYNONYMS = [
    { id: "SATISFACTION", rx: /\b(cs(at)?|sat(isfaction)?|overall\s+sat)\b/ },
    { id: "NPS", rx: /\b(nps|net\s+promoter)\b/ },
    { id: "AWARENESS", rx: /\b(aided|unaided|total)\s+awareness|\bawareness\b/ },
    { id: "CONSIDERATION", rx: /\bconsideration\b/ },
    { id: "PURCHASE_INTENT", rx: /\b(pi|purchase\s+intent|likelihood\s+to\s+buy|ltb)\b/ },
    { id: "USAGE", rx: /\busage\b/ },
    { id: "PREFERENCE", rx: /\bpreference\b/ },
    { id: "TRUST", rx: /\btrust\b/ },
    { id: "RECOMMEND", rx: /\brecommend(ation)?\b/ },
  ];
  for (const { id, rx } of SYNONYMS) {
    if (rx.test(text)) return id;
  }
  const quoted = text.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  if (quoted && quoted[1]) return toMetricId(quoted[1]);
  const m = text.match(/\btrend(?:ing)?\s+(?:of\s+)?([a-zA-Z0-9 _-]{3,})/);
  if (m && m[1]) return toMetricId(m[1]);
  return null;
}
async function fetchChart(metricId) {
  if (!(window.app && typeof window.app.fetchChart === "function")) return;
  return window.app.fetchChart(metricId);
}
function showChart(payload) {
  if (!(window.app && typeof window.app.showChart === "function")) return;
  return window.app.showChart(payload);
}

// Expose helpers
window.App = Object.freeze({
  jget,
  jpost,
  $,
  $$,
  showInlineMessage,
  clearInlineMessage,
  setThinking,
  formatRefsToSup,
  setHTMLWithRefs,
  deriveSupportBullets,
  toMetricId,
  guessMetricIdFromQuestion,
  fetchChart,
  showChart,
});
