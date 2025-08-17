// public/app.js — hydrate + Admin + single overlay + Dashboard (KPIs/Drivers/Barriers/Trends)
const API_BASE = (window.CONFIG||{}).API_BASE || "";
async function jget(u){ const r=await fetch(API_BASE+u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(u,b){ const r=await fetch(API_BASE+u,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }
const $ = (id)=> document.getElementById(id);

function showOverlay(on){
  const ov = $('#overlay'); const btn = $('#ask');
  if (ov) ov.classList.toggle('show', !!on);
  if (btn) btn.disabled = !!on;
}

async function hydrate(){
  try{
    const me = await jget('/me');
    const who = $('#who');
    const roleLabel = me?.user?.role;
    if (who){ who.textContent = (me?.user?.username||'') + ' — ' + roleLabel; who.classList.remove('hidden'); }
    const adminEl = $('#adminLink');
    if (adminEl && (roleLabel === 'admin' || roleLabel === 'internal')) adminEl.classList.remove('hidden');
    $('#app').classList.remove('cloak');
  }catch(e){ location.href = '/login.html'; }
}

// ==== Dashboard helpers ====
function groupBulletsIntoThemes(bullets){
  const out = { KPIs:[], "Key Drivers":[], "Key Barriers":[], "Trends Over Time":[] };
  const lower = s => (s||"").toLowerCase();
  (bullets||[]).forEach(b=>{
    const t = lower(b);
    if(/kpi|%|percent|nps|csat|satisfaction|awareness|consideration|usage/.test(t)) out.KPIs.push(b);
    else if(/driver|because|due to|reason|leads to|contribute|influenc/.test(t)) out["Key Drivers"].push(b);
    else if(/barrier|concern|issue|challenge|pain|limit|hesitan/.test(t)) out["Key Barriers"].push(b);
    else out["Trends Over Time"].push(b);
  });
  return out;
}

function extractQuotes(rawQuotes, refsText){
  const quotes = [];
  (rawQuotes||[]).forEach(q=>{
    if(typeof q==='string') quotes.push({text:q, tag:'Respondent'});
    else quotes.push({ text:q.text||q.quote||'', tag:q.speaker||q.tag||'Respondent' });
  });
  (refsText||"").split("\\n").forEach(line=>{
    const m = line.match(/[“"](.*?)[”"]\\s*(—|- )\\s*(.+)$/);
    if(m && m[1] && m[3]) quotes.push({ text:m[1], tag:m[3] });
  });
  return quotes;
}

function makeCarousel(slides, mountId, autoDelayMs){
  const mount = document.getElementById(mountId);
  if(!mount) return;
  mount.innerHTML = `
    <div class="carousel">
      <div class="carousel-track"></div>
      <div class="nav">
        <button class="prev" aria-label="Previous">◀</button>
        <button class="next" aria-label="Next">▶</button>
      </div>
    </div>`;
  const track = mount.querySelector('.carousel-track');
  slides.forEach(s=>{
    const d = document.createElement('div');
    d.className = 'carousel-slide';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = s.url;
    img.alt = s.alt || 'Slide';
    d.appendChild(img);
    track.appendChild(d);
  });
  let idx = 0, auto = true;
  function go(i){
    idx = (i+slides.length)%slides.length;
    track.style.transform = `translateX(-${idx*100}%)`;
  }
  mount.querySelector('.prev').addEventListener('click', ()=>{ auto=false; go(idx-1); });
  mount.querySelector('.next').addEventListener('click', ()=>{ auto=false; go(idx+1); });
  if (slides.length>1 && autoDelayMs>0){
    setInterval(()=>{ if(auto) go(idx+1); }, autoDelayMs);
  }
  go(0);
}

function buildDashCard({title, bullets=[], quotes=[], slides=[], autoDelayMs=5000}, staggerMs){
  const grid = $('#dashGrid');
  const qid = 'q'+Math.random().toString(36).slice(2,8);
  const sid = 's'+Math.random().toString(36).slice(2,8);
  const card = document.createElement('div');
  card.className = 'card';
  card.innerHTML = `
    <div class="dash-title"><h3>${title}</h3></div>
    ${bullets.length? `<ul class="dash-bullets">`+bullets.slice(0,6).map(b=>`<li>${b}</li>`).join("")+`</ul>`:""}
    ${quotes.length? `<div class="dash-quotes" id="${qid}">`+quotes.slice(0,3).map(q=>`<blockquote><em>${q.text}</em> — ${q.tag}</blockquote>`).join("")+`</div>`:""}
    ${slides.length? `<div id="${sid}"></div>`:""}
  `;
  grid.appendChild(card);
  if (slides.length){
    setTimeout(()=> makeCarousel(slides, sid, autoDelayMs), staggerMs);
  }
}

function slidesFromRefs(refs){
  const out = [];
  (refs||[]).forEach(r=>{
    const fileId = r.fileId || r.id || r.sourceId;
    const page = r.page || r.pageNumber || 1;
    if (!fileId) return;
    if (page<=1) return; // skip title slides
    const url = `/api/drive-pdf?fileId=${encodeURIComponent(fileId)}#page=${page}`;
    out.push({ url, alt: (r.title||'Slide') + ' — p'+page });
  });
  return out.slice(0,5);
}

function buildDashboard(payload){
  const { bullets=[], quotes=[], refs=[], chartPayload=null } = payload||{};
  const dash = $('#dashGrid');
  dash.innerHTML = "";
  const groups = groupBulletsIntoThemes(bullets);
  const refsText = (refs||[]).map(r=>r.snippet||"").join("\\n");
  const minedQuotes = extractQuotes(quotes, refsText);
  const allSlides = slidesFromRefs(refs);

  let stagger = 0;
  const step = 700;
  if (groups.KPIs.length || minedQuotes.length || allSlides.length){
    buildDashCard({ title:"KPIs", bullets:groups.KPIs, quotes:minedQuotes, slides:allSlides }, stagger); stagger+=step;
  }
  if (groups["Key Drivers"].length){
    buildDashCard({ title:"Key Drivers", bullets:groups["Key Drivers"], quotes:minedQuotes, slides:allSlides }, stagger); stagger+=step;
  }
  if (groups["Key Barriers"].length){
    buildDashCard({ title:"Key Barriers", bullets:groups["Key Barriers"], quotes:minedQuotes, slides:allSlides }, stagger); stagger+=step;
  }
  if (groups["Trends Over Time"].length || chartPayload){
    buildDashCard({ title:"Trends Over Time", bullets:groups["Trends Over Time"], quotes:minedQuotes, slides:allSlides }, stagger);
  }
  dash.style.display = (dash.children.length? 'grid' : 'none');
}

// ==== Ask ====
async function ask(){
  const q = $('#q').value.trim();
  if (!q) return $('#q').focus();
  showOverlay(true);
  try{
    const resp = await jpost('/search', { userQuery: q, generateSupport: true });
    const aw = $('#answerWrap'), a = $('#answer');
    if (resp.answer){ a.innerHTML = resp.answer; aw.classList.remove('hidden'); } else { aw.classList.add('hidden'); }
    const bullets = (resp.additionalSupport||[]).slice(0,12);
    const quotes = (resp.quotes||[]).map(q=>({ text:q.text||q.quote||q, tag:q.speaker||q.tag||'Respondent' }));
    const refs = (resp.visuals||resp.refs||[]);
    const chartPayload = resp.chart || resp.trend || null;
    buildDashboard({ bullets, quotes, refs, chartPayload });
  }catch(err){
    alert('Search failed');
  }finally{
    showOverlay(false);
  }
}

window.addEventListener('DOMContentLoaded', ()=>{
  hydrate();
  $('#ask').addEventListener('click', ask);
  $('#q').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ e.preventDefault(); ask(); }});
  $('#logoutBtn').addEventListener('click', async ()=>{ try{ await jpost('/auth/logout',{});}catch{} location.href='/login.html'; });
});
