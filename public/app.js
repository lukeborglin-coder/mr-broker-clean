/* public/app.js (home)
   - Username left of Admin button (done in HTML)
   - Dropdown full width + centered (done in CSS)
   - Answer: headline (1–2 sentences) + up to 2 bullets
   - Additional Support: derive bullets from refs if none; Show more
   - References: "(open source)" without extra space
   - Quotes: more flexible parsing; up to 5
   - Slides: up to 5 from resp.visuals
*/

const API_BASE = (window.CONFIG||{}).API_BASE || "";

async function jget(u){ const r=await fetch(API_BASE+u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(u,b){ const r=await fetch(API_BASE+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

const $ = id => document.getElementById(id);
const show = el => el && (el.style.display="");
const hide = el => el && (el.style.display="none");
const isAdmin = role => role==="admin"||role==="internal";

function superscriptRefs(t){
  return String(t||"").replace(/\s+\[(\d+)\]/g,"[$1]").replace(/\[(\d+)\]/g,"<sup>$1</sup>");
}

function splitSentences(t){ return String(t).split(/(?<=[.!?])\s+/).filter(Boolean); }

function buildAnswer(answerText){
  const s = splitSentences(answerText);
  const head = s.slice(0, Math.min(2, s.length));
  const rest = s.slice(head.length, head.length+2);
  const headHtml = `<p class="answer-head">${superscriptRefs(head.join(" "))}</p>`;
  const bulletsHtml = rest.length ? `<ul class="answer-bullets">${rest.map(x=>`<li>${superscriptRefs(x)}</li>`).join("")}</ul>` : "";
  return headHtml + bulletsHtml;
}

// ——— Additional Support bullets (fallbacks so the box actually shows) ———
function collectBullets(resp, max=5){
  const fromResp = (resp?.structured?.headline?.bullets || [])
    .concat((resp?.supporting || []).map(s=>typeof s==="string"?s:s?.text).filter(Boolean))
    .concat(resp?.keyFindings || []);

  // Fallback: derive from remaining sentences in the answer
  let fallback = [];
  const a = String(resp?.answer||"").trim();
  if(!fromResp.length && a){
    const sents = splitSentences(a).slice(2); // after headline
    fallback = sents.slice(0, max).map(x=>x.replace(/\s+/g," ").trim());
  }

  // Fallback 2: pull short snippets from top references
  const refSnips = (resp?.references?.chunks||[])
    .map(r=>String(r.textSnippet||"").trim())
    .filter(Boolean)
    .slice(0,10)
    .flatMap(txt => splitSentences(txt))
    .map(x=>x.trim())
    .filter(Boolean);

  const pool = [...fromResp, ...fallback, ...refSnips];
  const seen = new Set(), out=[];
  for(const b of pool){
    const t = String(b).trim();
    if(!t) continue;
    const k = t.toLowerCase();
    if(!seen.has(k)){ seen.add(k); out.push(t); }
    if(out.length>=max*2) break; // keep a buffer for "show more"
  }
  return { first: out.slice(0,max), rest: out.slice(max) };
}

// References list: remove extra space before parentheses
function buildReferences(refs){
  return refs.map(r=>{
    const name = r?.study || r?.fileName || "Source";
    const link = r?.fileUrl ? `(<a class="link ref-link" href="${r.fileUrl}" target="_blank" rel="noopener">open source</a>)` : "";
    return `<li>${name} ${link}</li>`.replace(/\s+\)/,")"); // collapse "( open" -> "(open"
  }).join("");
}

// Quote extractor: “..” - Tag  OR ".." — Tag  OR '..' - Tag
function extractQuotes(refs, max=5){
  const out=[];
  const rx=/[“"](.*?)[”"]\s*[—-]\s*([^)^\n\r]+?)(?:\.|$)/g;
  for(const r of (refs||[])){
    const s = String(r?.textSnippet||"");
    let m, guard=0;
    while((m=rx.exec(s)) && out.length<max && guard<30){
      guard++;
      const quote=(m[1]||"").trim();
      const tag=(m[2]||"").trim();
      if(quote && tag) out.push({quote, tag});
    }
    if(out.length>=max) break;
  }
  return out.slice(0,max);
}

function takeImages(arr, n=5){ return (arr||[]).filter(Boolean).slice(0,n); }

let currentUser=null;
async function boot(){
  try{
    const { user, clients } = await jget("/me");
    currentUser = user;
    $("who").textContent = `${user.username}${isAdmin(user.role) ? " (admin)" : ""}`;
    if(isAdmin(user.role)) $("adminLink").style.display="inline-flex";

    const row = $("clientRow");
    const sel = $("client");
    if(sel){
      sel.innerHTML = `<option value="" selected disabled>select a client library for your query</option>` +
        (clients||[]).map(c=>`<option value="${c.id}">${c.name}</option>`).join("");
      if(isAdmin(user.role)){
        row.style.display="block";
        $("ask").disabled = !sel.value;
        sel.onchange = ()=>{ $("ask").disabled = !sel.value; };
      }else{
        if(clients?.length===1){ sel.value=clients[0].id; $("ask").disabled=false; }
        else row.style.display="block";
      }
    }
  }catch{ location.href="/login.html"; }
}
boot();

function render(resp){
  $("out").style.display="block";

  // Answer
  const a = String(resp?.answer||"").trim();
  if(a){ $("answer").innerHTML = buildAnswer(a); show($("answerPanel")); } else hide($("answerPanel"));

  // Additional Support
  const { first, rest } = collectBullets(resp, 5);
  if(first.length){
    $("supportList").innerHTML = first.map(b=>`<li>${superscriptRefs(b)}</li>`).join("");
    show($("supportCard"));
    const btn = $("showMoreBtn");
    if(rest.length){
      btn.style.display="";
      btn.onclick = ()=>{ $("supportList").insertAdjacentHTML("beforeend", rest.map(b=>`<li>${superscriptRefs(b)}</li>`).join("")); hide(btn); };
    } else hide(btn);
  } else hide($("supportCard"));

  // Quotes
  const refChunks = resp?.references?.chunks || [];
  const quotes = extractQuotes(refChunks, 5);
  if(quotes.length){
    $("quotes").innerHTML = quotes.map(q=>`<blockquote>“${q.quote}” <span class="tag">- ${q.tag}</span></blockquote>`).join("<br>");
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

async function doAsk(){
  const q = $("q").value.trim();
  const sel = $("client");
  const clientId = sel ? sel.value : "";
  if(!q) return;
  if(isAdmin(currentUser?.role) && !clientId){ alert("Select a client library before asking."); return; }

  try{
    const body = { userQuery:q };
    if(clientId) body.clientId = clientId;
    const resp = await jpost("/search", body);

    const refs = resp?.references?.chunks || [];
    if(!refs.length && !resp.answer){
      const m = $("msg"); m.className="msg info";
      m.textContent = "No matching passages found. Try Admin → Update Client Library to ingest files from Drive, then ask again."; show(m);
    }else{ const m=$("msg"); m.className="msg"; m.textContent=""; hide(m); }

    render(resp);
  }catch(e){
    const m=$("msg"); m.className="msg error"; m.textContent="Search failed: " + (e?.message||e); show(m);
  }
}

$("ask").onclick = doAsk;
$("q").addEventListener("keypress", e=>{ if(e.key==="Enter" && !$("ask").disabled) doAsk(); });
$("logoutBtn").onclick = async ()=>{ await jpost("/auth/logout",{}); location.href="/login.html"; };
