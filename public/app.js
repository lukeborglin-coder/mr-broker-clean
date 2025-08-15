/* public/app.js
   - Header username under buttons; admin/internal both treated as admin
   - Orange ask + lighter prompt handled in HTML/CSS
   - Answer rendering: Headline (1–2 sentences) + up to 2 bullets
   - Additional Support (bullets up to 5 + Show more)
   - References: single ordered numbers; "(open source)" after title
   - Supporting Quotes: extract up to 5 quotes from reference snippets
   - Supporting Slides: show up to 5 images from resp.visuals
*/

const CONFIG = window.CONFIG || {};
const API_BASE = CONFIG.API_BASE || "";

async function jget(url){ const r = await fetch(API_BASE + url); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(url, body){
  const r = await fetch(API_BASE + url, { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(body||{}) });
  if(!r.ok) throw new Error(await r.text()); return r.json();
}

function $(id){ return document.getElementById(id); }
function show(el){ if(el){ el.style.display = ""; } }
function hide(el){ if(el){ el.style.display = "none"; } }
function isAdminRole(role){ return role === "admin" || role === "internal"; }

// Superscript [#] and ensure no preceding space
function superscriptRefs(text){
  if(!text) return "";
  return String(text).replace(/\s+\[(\d+)\]/g,"[$1]").replace(/\[(\d+)\]/g,"<sup>$1</sup>");
}

// Split into sentences (simple heuristic)
function splitSentences(t){
  return String(t).split(/(?<=[.!?])\s+/).filter(Boolean);
}

// Build answer as headline (1–2 sentences) + up to 2 bullets from leftover sentences
function buildAnswer(answerText){
  const sents = splitSentences(answerText);
  const head = sents.slice(0, Math.min(2, sents.length));
  const rest = sents.slice(head.length).slice(0, 2);

  const headHtml = `<p class="answer-head">${superscriptRefs(head.join(" "))}</p>`;
  const bulletsHtml = rest.length ? `<ul class="answer-bullets">${rest.map(x=>`<li>${superscriptRefs(x)}</li>`).join("")}</ul>` : "";
  return headHtml + bulletsHtml;
}

// Gather bullets for Additional Support (de-duped)
function collectBullets(resp, max=5){
  const fromHeadline = (resp?.structured?.headline?.bullets || []);
  const fromSupporting = (resp?.supporting || []).map(s => typeof s === "string" ? s : s?.text).filter(Boolean);
  const fromKey = (resp?.keyFindings || []);
  const all = [...fromHeadline, ...fromSupporting, ...fromKey].map(s => String(s).trim()).filter(Boolean);
  const seen = new Set(), out = [];
  for(const b of all){ const k=b.toLowerCase(); if(!seen.has(k)){ seen.add(k); out.push(b); } }
  return { first: out.slice(0,max), rest: out.slice(max) };
}

// References: single ordered numbers; "(open source)" after title
function buildReferences(refs){
  return refs.map(r => {
    const name = r?.study || r?.fileName || "Source";
    const link = r?.fileUrl ? ` (<a class="link ref-link" href="${r.fileUrl}" target="_blank" rel="noopener">open source</a>)` : "";
    return `<li>${name}${link}</li>`;
  }).join("");
}

// Try to extract respondent quotes from reference snippets
// Looks for “quoted text” followed by a tag like - Something user / - HCP, etc.
function extractQuotes(refs, max=5){
  const out = [];
  const rx = /“([^”]+)”\s*-\s*([^.\n]+)|"([^"]+)"\s*-\s*([^.\n]+)/g;
  for(const r of refs){
    const s = String(r?.textSnippet || "");
    let m; let guard=0;
    while((m = rx.exec(s)) && out.length < max && guard < 20){
      guard++;
      const quote = (m[1] || m[3] || "").trim();
      const tag = (m[2] || m[4] || "").trim();
      if(quote && tag) out.push({ quote, tag });
    }
    if(out.length >= max) break;
  }
  return out.slice(0, max);
}

function takeImages(arr, n=5){ return (arr || []).filter(Boolean).slice(0, n); }

// ------- boot -------
let currentUser=null;
async function boot(){
  try{
    const { user, clients } = await jget("/me");
    currentUser = user;

    const who = $("who");
    if(who) who.textContent = user.username + (isAdminRole(user.role) ? " (admin)" : "");

    const adminLink = $("adminLink");
    if(adminLink && isAdminRole(user.role)) adminLink.style.display = "inline-flex";

    const row = $("clientRow");
    const sel = $("client");
    if(sel){
      sel.innerHTML = `<option value="" selected disabled>select a client library for your query</option>` +
        (clients||[]).map(c => `<option value="${c.id}">${c.name}</option>`).join("");

      if(isAdminRole(user.role)){
        if(row) row.style.display = "flex";
        const ask = $("ask"); if(ask) ask.disabled = !sel.value;
        sel.onchange = () => { if(ask) ask.disabled = !sel.value; };
      } else {
        if(clients?.length === 1){ sel.value = clients[0].id; const ask=$("ask"); if(ask) ask.disabled=false; }
        else if(row){ row.style.display="flex"; }
      }
    }
  } catch { location.href = "/login.html"; }
}
boot();

// ------- render -------
function render(resp){
  $("out").style.display = "block";

  // Answer -> headline + bullets
  const a = (resp?.answer || "").trim();
  if(a){
    $("answer").innerHTML = buildAnswer(a);
    show($("answerPanel"));
  } else hide($("answerPanel"));

  // Additional Support bullets
  const { first, rest } = collectBullets(resp, 5);
  if(first.length){
    $("supportList").innerHTML = first.map(b=>`<li>${superscriptRefs(b)}</li>`).join("");
    show($("supportCard"));
    if(rest.length){
      const btn = $("showMoreBtn");
      btn.style.display = "";
      btn.onclick = () => { $("supportList").insertAdjacentHTML("beforeend", rest.map(b=>`<li>${superscriptRefs(b)}</li>`).join("")); hide(btn); };
    } else hide($("showMoreBtn"));
  } else hide($("supportCard"));

  // Quotes
  const refChunks = resp?.references?.chunks || [];
  const quotes = extractQuotes(refChunks, 5);
  if(quotes.length){
    $("quotes").innerHTML = quotes.map(q => `<blockquote>“${q.quote}” <span class="tag">- ${q.tag}</span></blockquote>`).join("<br>");
    show($("quotesCard"));
  } else hide($("quotesCard"));

  // Slides
  const slides = takeImages(resp?.visuals, 5);
  if(slides.length){
    $("slidesGrid").innerHTML = slides.map(src=>`<img src="${src}" alt="supporting slide">`).join("");
    show($("slidesCard"));
  } else hide($("slidesCard"));

  // References
  if(refChunks.length){
    $("refs").innerHTML = buildReferences(refChunks);
    show($("refsCard"));
  } else hide($("refsCard"));
}

// ------- ask -------
async function doAsk(){
  const q = $("q").value.trim();
  const sel = $("client");
  const clientId = sel ? sel.value : "";
  if(!q) return;
  if(isAdminRole(currentUser?.role) && !clientId){ alert("Select a client library before asking."); return; }

  try{
    const body = { userQuery: q };
    if(clientId) body.clientId = clientId;
    const resp = await jpost("/search", body);

    const refs = resp?.references?.chunks || [];
    if(!refs.length && !resp.answer){
      const m = document.getElementById("msg");
      m.className = "msg info";
      m.textContent = "No matching passages found. Try Admin → Update Client Library to ingest files from Drive, then ask again.";
      show(m);
    } else {
      const m = document.getElementById("msg");
      m.className = "msg"; m.textContent = ""; hide(m);
    }
    render(resp);
  } catch(e){
    const m = document.getElementById("msg");
    m.className = "msg error";
    m.textContent = "Search failed: " + (e?.message || e);
    show(m);
  }
}
$("ask").onclick = doAsk;
$("q").addEventListener("keypress", (e)=>{ if(e.key==="Enter" && !$("ask").disabled) doAsk(); });

$("logoutBtn").onclick = async () => { await jpost("/auth/logout", {}); location.href = "/login.html"; };
