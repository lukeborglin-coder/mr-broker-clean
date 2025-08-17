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

function roleDisplay(r){return r==='internal'?'admin':(r||'');}

function ensureAdminLink(){const el=$('adminLink');if(!el||!window.__me) return;if(__me.role==='internal'||__me.role==='admin'){el.style.display='inline-flex';}else{el.style.display='none';}}

async function hydrateMe(){
  try{
    const me = await jget('/me'); window.__me = me;
    const u = $('username'); if(u) u.textContent = (me && me.username) ? `${me.username} — ${roleDisplay(me.role)}` : '—';
    ensureAdminLink();
    document.body.classList.remove('cloak');
  }catch(e){
    window.location.href = '/login.html';
  }
}

function showThinking(s){const t=$('thinking'); if(t) t.style.display = s?'':'none';}

function escapeHtml(s){return (s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[m]));}

function deriveSections(resp){
  const lead = resp.answer||resp.headline||resp.summary||'';
  const bullets = resp.bullets||resp.points||[];
  const quotes = resp.quotes||resp.insights||[];
  const visuals = resp.visuals||resp.slides||[];

  const drivers = (resp.drivers||[]).concat(bullets.filter(b=>/driver|increase|satisf|like|prefer/i.test(b)));
  const barriers = (resp.barriers||[]).concat(bullets.filter(b=>/barrier|decreas|dissatisf|pain|issue|concern|friction/i.test(b)));
  const kpis = (resp.kpis||[]).concat(bullets.filter(b=>/KPI|NPS|CSAT|awareness|consideration|trial|repeat|share|growth|decline/i.test(b)));
  const trends = (resp.trends||[]).concat(bullets.filter(b=>/trend|over time|month|quarter|year|increasing|decreasing/i.test(b)));

  function normalizeQuotes(qs){
    return (qs||[]).map(q=>{
      if(typeof q==='string') return {text:q, tag:''};
      return {text:q.text||q.quote||'', tag:q.tag||q.source||''};
    });
  }
  const qnorm = normalizeQuotes(quotes);
  const pick=(arr,n)=>(arr||[]).slice(0,n);

  return {
    lead,
    kpis:{bullets:pick(kpis,5),quotes:pick(qnorm,3),slides:visuals},
    drivers:{bullets:pick(drivers,5),quotes:pick(qnorm,3),slides:visuals},
    barriers:{bullets:pick(barriers,5),quotes:pick(qnorm,3),slides:visuals},
    trends:{bullets:pick(trends,5),quotes:pick(qnorm,3),slides:visuals}
  };
}

function renderQuotes(containerId, quotes){
  const root=$(containerId); if(!root) return; root.innerHTML='';
  (quotes||[]).forEach(q=>{
    if(!q.text) return;
    const div=document.createElement('div'); div.className='quote';
    div.innerHTML = `${escapeHtml(q.text)}${q.tag?` <span class="tag">— ${escapeHtml(q.tag)}</span>`:''}`;
    root.appendChild(div);
  });
}

function slidesFromVisuals(visuals){
  const slides=[];
  (visuals||[]).forEach(v=>{
    if(v.type==='slide'){
      const page=Number(v.page||0); if(page<=1) return;
      slides.push({url: v.thumbUrl||v.url||(`/api/drive-pdf?fileId=${encodeURIComponent(v.fileId)}&page=${page}`), page});
    } else if (v.url){
      slides.push({url:v.url,page:v.page||null});
    }
  });
  return slides.slice(0,5);
}

let __autoTimers = [];
function clearTimers(){ __autoTimers.forEach(t=>clearInterval(t)); __autoTimers=[]; }

function renderCarousel(rootId, visuals, staggerMs){
  const root=$(rootId); if(!root) return;
  root.innerHTML='';
  const slides=slidesFromVisuals(visuals);
  if(!slides.length){ root.style.display='none'; return; }
  root.style.display='block';

  const viewport=document.createElement('div'); viewport.className='viewport';
  const img=document.createElement('img'); viewport.appendChild(img);

  const nav=document.createElement('div'); nav.className='nav';
  const prev=document.createElement('button'); prev.innerHTML='&#x2039;';
  const next=document.createElement('button'); next.innerHTML='&#x203A;';
  nav.appendChild(prev); nav.appendChild(next);

  const dots=document.createElement('div'); dots.className='dots';

  root.appendChild(viewport); root.appendChild(nav); root.appendChild(dots);

  let idx=0; let paused=false;
  function draw(){ const s=slides[idx]; img.src=s.url; dots.querySelectorAll('button').forEach((b,i)=>b.classList.toggle('active',i===idx)); }
  function go(i){ idx=(i+slides.length)%slides.length; draw(); }
  slides.forEach((s,i)=>{ const b=document.createElement('button'); b.addEventListener('click',()=>{paused=true;go(i);}); dots.appendChild(b); });
  prev.addEventListener('click',()=>{paused=true;go(idx-1);});
  next.addEventListener('click',()=>{paused=true;go(idx+1);});
  draw();

  const timer=setInterval(()=>{ if(!paused) go(idx+1); },5000);
  __autoTimers.push(timer);
}

async function onSubmit(e){
  e.preventDefault();
  const q=$('q')?.value?.trim(); if(!q) return;
  clearTimers();
  showThinking(true);
  try{
    const resp=await jpost('/search',{q});
    const sections=deriveSections(resp);
    const setList=(id,list)=>{const ul=$(id); if(!ul) return; ul.innerHTML=''; (list||[]).forEach(t=>{if(!t) return; const li=document.createElement('li'); li.textContent=t; ul.appendChild(li);});};
    $('answerLead').textContent = sections.lead||'';
    $('answerWrap').style.display='';

    setList('kpiBullets', sections.kpis.bullets); renderQuotes('kpiQuotes', sections.kpis.quotes); renderCarousel('kpiSlides', sections.kpis.slides, 0);
    setList('driverBullets', sections.drivers.bullets); renderQuotes('driverQuotes', sections.drivers.quotes); renderCarousel('driverSlides', sections.drivers.slides, 600);
    setList('barrierBullets', sections.barriers.bullets); renderQuotes('barrierQuotes', sections.barriers.quotes); renderCarousel('barrierSlides', sections.barriers.slides, 1200);
    setList('trendBullets', sections.trends.bullets); renderQuotes('trendQuotes', sections.trends.quotes); renderCarousel('trendSlides', sections.trends.slides, 1800);
  }catch(err){
    console.error(err); alert('Error: '+(err.message||err));
  }finally{
    showThinking(false);
  }
}
