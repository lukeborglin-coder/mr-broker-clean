/* public/app.js — shared helpers only (no legacy Ask handlers, no alerts)
   - KEEP: fetch helpers (jget/jpost)
   - ADD: inline message + thinking helpers (used by pages if desired)
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

// Expose a small API for pages (optional)
window.App = Object.freeze({
  jget,
  jpost,
  $,
  $$,
  showInlineMessage,
  clearInlineMessage,
  setThinking,
});

// IMPORTANT:
// - Do NOT attach any click/keypress handlers to #ask or inputs here.
// - Do NOT read or enforce any client library selection here.
//   (index.html handles admin top-right dropdown + inline error.)
