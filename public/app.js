/* public/app.js (admin-role fix)
   - Treats both 'admin' and 'internal' as admin for UI checks
   - Everything else unchanged (superscripts, Additional Support, References, Slides, Secondary)
*/

const CONFIG = window.CONFIG || {};
const API_BASE = CONFIG.API_BASE || "";

// ------- helpers -------
async function jget(url){
  const r = await fetch(API_BASE + url);
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
async function jpost(url, body){
  const r = await fetch(API_BASE + url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {})
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

function $(id){ return document.getElementById(id); }
function show(el){ el && el.classList.remove("hidden"); el && (el.style.display = ""); }
function hide(el){ el && el.classList.add("hidden"); el && (el.style.display = "none"); }
function safeArray(v){
  if(!v) return [];
  if(Array.isArray(v)) return v;
  if(typeof v === "object") return Object.values(v);
  return [];
}
function isAdminRole(role){ return role === "admin" || role === "internal"; }

// Turn " ... [2]" or "...[2]" into "...<sup>2</sup>"
function superscriptRefs(text){
  if(!text) return "";
  return String(text)
    .replace(/\s+\[(\d+)\]/g, "[$1]")      // remove space before bracket
    .replace(/\[(\d+)\]/g, "<sup>$1</sup>");
}

// Extract up to N bullets from structured fields; remove ending period
function collectBullets(resp, max = 5){
  const fromHeadline = safeArray(resp?.structured?.headline?.bullets);
  const fromSupporting = safeArray(resp?.supporting).map(s => typeof s === "string" ? s : s?.text).filter(Boolean);
  const fromKeyFindings = safeArray(resp?.keyFindings);

  const all = [...fromHeadline, ...fromSupporting, ...fromKeyFindings]
    .map(s => String(s).trim().replace(/[.;\s]+$/,""))
    .filter(Boolean);

  const seen = new Set();
  const unique = [];
  for(const b of all){
    const k = b.toLowerCase();
    if(!seen.has(k)){ seen.add(k); unique.push(b); }
  }
  return { first: unique.slice(0, max), rest: unique.slice(max) };
}

// Build references (ordered list)
function buildReferences(refs){
  return safeArray(refs).map((r, i) => {
    const title = r?.study || r?.fileName || "Source";
    const link = r?.fileUrl ? `<a class="link" href="${r.fileUrl}" target="_blank" rel="noopener">open source</a>` : "";
    return `<li>
      <div><strong>${i+1}.</strong> ${title}</div>
      ${link}
    </li>`;
  }).join("");
}

// Limit images to at most n
function takeImages(arr, n = 6){
  return safeArray(arr).filter(Boolean).slice(0, n);
}

// Secondary info cards
function buildSecondary(items){
  return safeArray(items).slice(0,5).map(s => {
    const title = s?.title || "";
    const snippet = s?.snippet || s?.summary || "";
    const url = s?.url || s?.link || "";
    const link = url ? `<a class="link" href="${url}" target="_blank" rel="noopener">open source</a>` : "";
    return `<div class="secondary-item">
      <h4>${title}</h4>
      <p>${snippet}</p>
      ${link}
    </div>`;
  }).join("");
}

// ------- boot (user + clients) -------
let currentUser = null;
async function boot(){
  try{
    const { user, clients } = await jget("/me");
    currentUser = user;

    // Header label and Admin link visibility
    const who = $("who");
    if(who) who.textContent = user.username + (isAdminRole(user.role) ? " (admin)" : "");

    const adminLink = $("adminLink");
    if(adminLink && isAdminRole(user.role)){ adminLink.style.display = "inline-flex"; }

    // Client selection behavior
    const row = $("clientRow");
    const sel = $("client");
    if(sel){
      sel.innerHTML = `<option value="" selected disabled>Select a client</option>` +
        safeArray(clients).map(c => `<option value="${c.id}">${c.name}</option>`).join("");

      if(isAdminRole(user.role)){
        // Admins must choose a client
        if(row) row.style.display = "flex";
        const ask = $("ask");
        if(ask) ask.disabled = !sel.value;
        sel.onchange = () => { if(ask) ask.disabled = !sel.value; };
      } else {
        // Non-admins: preselect single client if available
        if(clients?.length === 1){
          sel.value = clients[0].id;
          const ask = $("ask"); if(ask) ask.disabled = false;
        } else if(row){
          row.style.display = "flex";
        }
      }
    }
  } catch {
    location.href = "/login.html";
  }
}
boot();

// ------- results rendering -------
function render(resp){
  const out = $("out");
  if(out) out.style.display = "block";

  // Answer
  const hasAnswer = Boolean(resp?.answer && String(resp.answer).trim());
  if(hasAnswer){
    $("answer").innerHTML = superscriptRefs(String(resp.answer).trim());
    show($("answerPanel"));
  } else { hide($("answerPanel")); }

  // Additional Support
  const { first: bullets, rest: moreBullets } = collectBullets(resp, 5);
  const supportCard = $("supportCard");
  const supportList = $("supportList");
  const showMoreBtn = $("showMoreBtn");
  if(bullets.length){
    supportList.innerHTML = bullets.map(b => `<li>${superscriptRefs(b)}</li>`).join("");
    show(supportCard);
    if(moreBullets.length){
      show(showMoreBtn);
      showMoreBtn.onclick = () => {
        supportList.insertAdjacentHTML("beforeend",
          moreBullets.map(b => `<li>${superscriptRefs(b)}</li>`).join(""));
        hide(showMoreBtn);
      };
    } else {
      hide(showMoreBtn);
    }
  } else {
    hide(supportCard);
  }

  // References
  const refChunks = resp?.references?.chunks || [];
  const refsCard = $("refsCard");
  const refsEl = $("refs");
  if(refChunks.length){
    refsEl.innerHTML = buildReferences(refChunks);
    show(refsCard);
  } else { hide(refsCard); }

  // Report Slides
  const slides = takeImages(resp?.visuals, 6);
  const slidesCard = $("slidesCard");
  const slidesGrid = $("slidesGrid");
  if(slides.length){
    slidesGrid.innerHTML = slides.map(src => `<img src="${src}" alt="report slide">`).join("");
    show(slidesCard);
  } else { hide(slidesCard); }

  // Secondary Information
  const secondary = safeArray(resp?.secondary);
  const secondaryCard = $("secondaryCard");
  const secondaryList = $("secondaryList");
  if(secondary.length){
    secondaryList.innerHTML = buildSecondary(secondary);
    show(secondaryCard);
  } else { hide(secondaryCard); }
}

// ------- ask flow -------
async function doAsk(){
  const q = $("q")?.value?.trim();
  const clientSel = $("client");
  const clientId = clientSel ? clientSel.value : "";
  if(!q) return;

  if(isAdminRole(currentUser?.role) && !clientId){
    alert("Select a client library before asking.");
    return;
  }

  try{
    const body = { userQuery: q };
    if(clientId) body.clientId = clientId;

    const resp = await jpost("/search", body);

    const refs = resp?.references?.chunks || [];
    if(!refs.length && !resp?.answer){
      const msg = document.createElement("div");
      msg.className = "panel";
      msg.innerHTML = `<div class="small">No matching passages found. Try Admin → Update Client Library to ingest files from Drive, then ask again.</div>`;
      const container = document.querySelector(".results") || $("out");
      if(container){ container.prepend(msg); setTimeout(()=>msg.remove(), 6000); }
    }
    render(resp);
  } catch (e){
    alert("Search failed: " + (e?.message || e));
  }
}

// Bind handlers
const askBtn = $("ask");
if(askBtn) askBtn.addEventListener("click", doAsk);
const qInput = $("q");
if(qInput) qInput.addEventListener("keypress", (e) => {
  if(e.key === "Enter" && (!askBtn || !askBtn.disabled)) doAsk();
});
const logoutBtn = $("logoutBtn");
if(logoutBtn){
  logoutBtn.onclick = async () => {
    try { await jpost("/auth/logout", {}); } finally { location.href = "/login.html"; }
  };
}
