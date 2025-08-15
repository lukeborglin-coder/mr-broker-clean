/* public/app.js — shared helpers only (no legacy Ask handlers, no alerts)
   - KEEP: fetch helpers (jget/jpost)
   - ADD: inline message + thinking helpers (used by pages if desired)
   - ADD: formatRefsToSup() + deriveSupportBullets() for rendering answer + support
   - REMOVE: any client-selector coupling + alert popups
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

/* -------------------------
   Rendering/format helpers
--------------------------*/

/**
 * Convert bracketed numeric references to superscripts and
 * remove the space before them.
 *  "…options [1]. Also [2][3]" -> "…options<sup>1</sup>. Also <sup>2</sup><sup>3</sup>"
 *
 * Notes:
 * - works for chains like [2][3][10]
 * - ensures no space between last word and the superscript
 */
function formatRefsToSup(text) {
  if (!text) return text ?? "";
  // First, collapse any spaces before a bracketed number
  // and emit a placeholder to avoid double-processing.
  let out = String(text);

  // Convert [number] after a non-space char into <sup>number</sup>
  // \S matches the last non-space before the bracket; keep it, strip spaces.
  // Global so "[2][3]" becomes two supers.
  out = out.replace(/(\S)\s*\[(\d+)\]/g, (_, ch, num) => `${ch}<sup>${num}</sup>`);
  return out;
}

/**
 * Escape HTML for safely injecting text content into innerHTML.
 * Use this if you want to build HTML manually then append safe pieces.
 */
function escapeHTML(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Derive concise, clean support bullets from messy input (string or array).
 * - Splits on newlines/bullets/dashes and also on long sentences.
 * - Trims noise and whitespace.
 * - De-duplicates case-insensitively.
 * - Removes trailing periods.
 * - Caps bullet length (default 180 chars).
 * - Returns up to maxCount bullets (default 6).
 */
function deriveSupportBullets(input, opts = {}) {
  const maxLen = opts.maxLen ?? 180;
  const maxCount = opts.maxCount ?? 6;

  // Normalize to a single big string
  let raw = "";
  if (Array.isArray(input)) {
    raw = input.filter(Boolean).join("\n");
  } else if (typeof input === "object" && input) {
    // If it's an array of objects like [{text:"..."}, ...]
    if (Array.isArray(input.supporting)) {
      raw = input.supporting.map(x => (typeof x === "string" ? x : x?.text || "")).join("\n");
    } else {
      raw = Object.values(input).join("\n");
    }
  } else {
    raw = String(input || "");
  }

  // Early exit
  if (!raw.trim()) return [];

  // Break into candidates
  const primarySplits = raw
    .split(/\r?\n|•|▪|‣|·|–|-{1,2}|\u2022/g) // common bullet glyphs/dashes
    .flatMap(chunk => {
      const c = String(chunk || "").trim();
      if (!c) return [];
      // Further split on ". " when very long, but keep numbers like "2.5" intact
      return c.length > 220 ? c.split(/(?<=[^.0-9])\.\s+(?=[A-Z(“"0-9])/g) : [c];
    });

  // Clean each candidate
  const cleaned = primarySplits
    .map(s =>
      String(s)
        // squash inner whitespace
        .replace(/\s+/g, " ")
        // remove stray leading punctuation
        .replace(/^[•\-\–\—\·\:\;\,\.\s]+/, "")
        // trim
        .trim()
    )
    // Remove empty or obviously non-informative bits
    .filter(s => s && s.length > 3);

  // De-duplicate (case-insensitive, ignore trailing punctuation)
  const seen = new Set();
  const uniq = [];
  for (const s of cleaned) {
    // remove trailing period(s)
    let t = s.replace(/[\.]+$/g, "").trim();
    // guard: keep % signs/numbers attached, compress spaces again
    t = t.replace(/\s+/g, " ");
    const key = t.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      // hard cap length but try to cut at a boundary
      if (t.length > maxLen) {
        const cut = t.slice(0, maxLen);
        const soft = cut.lastIndexOf("; ");
        const soft2 = cut.lastIndexOf(", ");
        const soft3 = cut.lastIndexOf(" ");
        const idx = Math.max(soft, soft2, soft3);
        t = (idx > 50 ? cut.slice(0, idx) : cut).trim();
      }
      uniq.push(t);
    }
    if (uniq.length >= maxCount) break;
  }

  return uniq;
}

/**
 * Render utilities (optional):
 * - setHTMLWithRefs(el, text): safely escapes and injects text with refs -> <sup>
 */
function setHTMLWithRefs(el, text) {
  if (!el) return;
  // We only transform bracket refs; everything else is escaped.
  const withSup = formatRefsToSup(escapeHTML(text || ""));
  el.innerHTML = withSup;
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
  // NEW exports
  formatRefsToSup,
  deriveSupportBullets,
  setHTMLWithRefs,
  escapeHTML,
});

// IMPORTANT:
// - Do NOT attach any click/keypress handlers to #ask or inputs here.
// - Do NOT read or enforce any client library selection here.
//   (index.html handles admin top-right dropdown + inline error.)
