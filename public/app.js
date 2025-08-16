/* public/app.js — shared helpers only (no legacy Ask handlers, no alerts)
   - KEEP: fetch helpers (jget/jpost)
   - ADD: inline message + thinking + refs helpers
   - UPDATE: formatRefsToSup merges adjacent [n][m] → <sup>n;m</sup>
   - NEW: toMetricId (client-side), guessMetricIdFromQuestion, and safe passthroughs to window.app.fetchChart / window.app.showChart
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

// Tiny DOM helpers (kept for any existing pages that rely on them)
const $ = (sel, root = document) =>
  typeof sel === "string" ? root.querySelector(sel.startsWith("#") ? sel : `#${sel}`) : sel;
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// Inline message helper (NO popups)
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

// Thinking overlay + inline status (pages may call these)
function setThinking(on) {
  const overlay = $("#overlay");
  const inline = $("#inlineStatus");
  if (overlay) overlay.classList.toggle("hidden", !on);
  if (inline) inline.style.display = on ? "flex" : "none";
  const ask = $("#ask");
  if (ask) ask.disabled = !!on;
}

/**
 * Replace bracketed numeric citations with a single <sup> group.
 * Examples:
 *   "text [1]"            → "text <sup>1</sup>"
 *   "text [1][2][5]"      → "text <sup>1;2;5</sup>"
 *   "text ... [2] [3]"    → "text ... <sup>2</sup> <sup>3</sup>"
 */
function formatRefsToSup(text) {
  const s = String(text || "");

  // First, turn any runs like [1][2][3] into one sup with semicolons
  const merged = s.replace(/(?:\[\d+\])+/g, (match) => {
    const nums = Array.from(match.matchAll(/\[(\d+)\]/g)).map((m) => m[1]);
    return `<sup>${nums.join(";")}</sup>`;
  });

  // Then, handle singletons that weren't part of a run, or were separated by spaces
  return merged
    .replace(/\s+\[(\d+)\]/g, "<sup>$1</sup>")
    .replace(/\[(\d+)\]/g, "<sup>$1</sup>");
}

function setHTMLWithRefs(el, text) {
  if (!el) return;
  el.innerHTML = formatRefsToSup(text);
}

// Optional: derive concise bullets from raw snippets if API didn't return structured bullets
function deriveSupportBullets(snippets, { maxCount = 10, maxLen = 200 } = {}) {
  const lines = [];
  (snippets || []).forEach(s => {
    String(s || "").split(/\n+/).forEach(t => {
      const clean = String(t).replace(/\s+/g, " ").trim();
      if (!clean) return;
      lines.push(clean);
    });
  });
  // de-dup and trim
  const seen = new Set();
  const out = [];
  for (const l of lines) {
    const t = l.slice(0, maxLen).replace(/[;:,]\s*$/, ".");
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // ensure sentence punctuation
    out.push(/[.!?]$/.test(t) ? t : t + ".");
    if (out.length >= maxCount) break;
  }
  return out;
}

/* =========================
   NEW: chart helpers/glue
   ========================= */

/** Mirror of server toMetricId. */
function toMetricId(label) {
  return String(label || "")
    .trim()
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

/**
 * Guess a metricId from a natural-language question.
 * You can extend `SYNONYMS` as you add more metrics.
 */
function guessMetricIdFromQuestion(q) {
  const text = String(q || "").toLowerCase();

  // Common research metrics & synonyms
  const SYNONYMS = [
    { id: "SATISFACTION", rx: /\b(cs(at)?|sat(isfaction)?|overall\s+sat)\b/ },
    { id: "NPS",          rx: /\b(nps|net\s+promoter)\b/ },
    { id: "AWARENESS",    rx: /\b(aided|unaided|total)\s+awareness|\bawareness\b/ },
    { id: "CONSIDERATION",rx: /\bconsideration\b/ },
    { id: "PURCHASE_INTENT", rx: /\b(pi|purchase\s+intent|likelihood\s+to\s+buy|ltb)\b/ },
    { id: "USAGE",        rx: /\busage\b/ },
    { id: "PREFERENCE",   rx: /\bpreference\b/ },
    { id: "TRUST",        rx: /\btrust\b/ },
    { id: "RECOMMEND",    rx: /\brecommend(ation)?\b/ },
  ];

  for (const { id, rx } of SYNONYMS) {
    if (rx.test(text)) return id;
  }

  // Fallback: capture quoted metric names or last proper noun-ish phrase
  const quoted = text.match(/["“”'‘’]([^"“”'‘’]+)["“”'‘’]/);
  if (quoted && quoted[1]) return toMetricId(quoted[1]);

  // Another fallback: look for phrases like "trend of <metric>"
  const m = text.match(/\btrend(?:ing)?\s+(?:of\s+)?([a-zA-Z0-9 _-]{3,})/);
  if (m && m[1]) return toMetricId(m[1]);

  return null;
}

/**
 * Safe passthroughs to the page-level chart API (exposed by index.html).
 * These NO-OP if the page hasn't defined window.app.
 */
async function fetchChart(metricId) {
  if (!(window.app && typeof window.app.fetchChart === "function")) return;
  return window.app.fetchChart(metricId);
}
function showChart(payload) {
  if (!(window.app && typeof window.app.showChart === "function")) return;
  return window.app.showChart(payload);
}

// Expose a small API for pages (optional)
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

  // NEW exports
  toMetricId,
  guessMetricIdFromQuestion,
  fetchChart,      // pass-through to window.app.fetchChart if present
  showChart,       // pass-through to window.app.showChart if present
});

// IMPORTANT:
// - Do NOT attach any click/keypress handlers to #ask or inputs here.
// - Do NOT read or enforce any client library selection here.
