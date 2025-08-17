/* public/app.js — robust answer rendering + clear error surfacing */
const API_BASE = (window.CONFIG||{}).API_BASE || "";

async function jget(u){
  const r = await fetch(API_BASE+u, { credentials: 'include' });
  if(!r.ok){
    const txt = await r.text().catch(()=>String(r.status));
    throw new Error(txt || `HTTP ${r.status}`);
  }
  // try JSON else throw
  try { return await r.json(); } catch { throw new Error('Invalid JSON from '+u); }
}

async function jpost(u,b){
  const r = await fetch(API_BASE+u, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    credentials: 'include',
    body: JSON.stringify(b||{})
  });
  if(!r.ok){
    const txt = await r.text().catch(()=>String(r.status));
    throw new Error(txt || `HTTP ${r.status}`);
  }
  try { return await r.json(); } catch { throw new Error('Invalid JSON from '+u); }
}

const $ = id => document.getElementById(id);

let me = null;
let autoTimers = [];
function showThinking(s){ const t=$('thinking'); if(t) t.style.display = s?'':'none'; }
function roleDisplay(r){ return r==='internal' ? 'admin' : (r||''); }
function ensureAdminLink(){ const el=$('adminLink'); if(!el||!me) return; el.style.display=(me.role==='internal'||me.role==='admin')?'inline-flex':'none'; }
function uncloack(){ document.body.classList.remove('cloak'); }

function showError(msg){
  let banner = $('errorBanner');
  if(!banner){
    banner = document.createElement('div');
    banner.id = 'errorBanner';
    banner.style.cssText = 'margin:8px 0;padding:10px 12px;border:1px solid #fecaca;background:#fff1f2;color:#991b1b;border-radius:10px;';
    const wrap = document.querySelector('.wrap') || document.body;
    wrap.prepend(banner);
  }
  banner.textContent = typeof msg === 'string' ? msg : (msg && msg.message) || 'Something went wrong.';
}

async function hydrateMe(){
  try{
    me = await jget('/me');
    $('username').textContent = me && me.username ? `${me.username} — ${roleDisplay(me.role)}` : '—';
    ensureAdminLink();
    uncloack();
  }catch(e){
    window.location.href = '/login.html';
  }
}

// -------- Answer shaping --------
function safeArray(x){ return Array.isArray(x) ? x : (x ? [x] : []); }

function extractLead(resp){
  // Common shapes
  return (
    resp?.answer ||
    resp?.headline ||
    resp?.summary ||
    resp?.result?.answer ||
    resp?.data?.answer ||
    resp?.output?.answer ||
    (typeof resp?.text === 'string' ? resp.text : '') ||
    ''
  );
}

function extractBullets(resp){
  let bullets = resp?.bullets || resp?.points || resp?.result?.bullets || resp?.data?.bullets || resp?.output?.bullets || [];
  // If none, derive from refs/secondary
  if(!bullets?.length){
    const refs = safeArray(resp?.refs || resp?.references || resp?.citations || resp?.result?.refs || resp?.secondary || []);
    bullets = refs.slice(0,4).map(r => {
      if(typeof r === 'string') return r;
      const t = r.title || r.name || r.headline || r.snippet || r.text;
      return t || (r.url ? new URL(r.url).hostname : '');
    }).filter(Boolean);
  }
  return bullets.slice(0,5);
}

function extractQuotes(resp){
  const qs = resp?.quotes || resp?.insights || resp?.result?.quotes || resp?.data?.quotes || resp?.output?.quotes || [];
  return safeArray(qs).slice(0,5).map(q => {
    if(typeof q === 'string') return { text:q, tag:'' };
    return { text: q.text || q.quote || q.snippet || '', tag: q.tag || q.source || q.speaker || '' };
  }).filter(q=>q.text);
}

function extractVisuals(resp){
  // Accept resp.visuals / resp.slides / resp.result.visuals
  const visuals = resp?.visuals || resp?.slides || resp?.result?.visuals || [];
  return safeArray(visuals);
}

function deriveSections(resp){
  const lead = extractLead(resp);
  const bullets = extractBullets(resp);
  const quotes = extractQuotes(resp);
  const visuals = extractVisuals(resp);

  // Heuristic buckets
  const drivers = (resp.drivers || []).concat(bullets.filter(b=>/driver|increase|satisf|like|prefer/i.test(b)));
  const barriers = (resp.barriers || []).concat(bullets.filter(b=>/barrier|decreas|dissatisf|pain|issue|concern|friction/i.test(b)));
  const kpis = (resp.kpis || []).concat(bullets.filter(b=>/KPI|NPS|CSAT|awareness|consideration|trial|repeat|share|growth|decline/i.test(b)));
  const trends = (resp.trends || []).concat(bullets.filter(b=>/trend|over time|month|quarter|year|increasing|decreasing/i.test(b)));

  const pick=(arr,n)=>(arr||[]).slice(0,n);
  return {
    lead,
    kpis:{bullets:pick(kpis,5),quotes:pick(quotes,3),slides:visuals},
    drivers:{bullets:pick(drivers,5),quotes:pick(quotes,3),slides:visuals},
    barriers:{bullets:pick(barriers,5),quotes:pick(quotes,3),slides:visuals},
    trends:{bullets:pick(trends,5),quotes:pick(quotes,3),slides:visuals}
  };
}

function renderQuotes(containerId, quotes){
  const root = $(containerId); if(!root) return; root.innerHTML='';
  (quotes||[]).forEach(q=>{
    if(!q.text) return;
    const div=document.createElement('div'); div.className='quote';
    div.innerHTML = `${escapeHtml(q.text)}${q.tag?` <span class="tag">— ${escapeHtml(q.tag)}</span>`:''}`;
    root.appendChild(div);
  });
}

function escapeHtml(s){ return (s||'').replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\\'':'&#39;'}[m])); }

function slidesFromVisuals(visuals){
  const slides=[];
  (visuals||[]).forEach(v=>{
    if(v?.type==='slide'){
      const page=Number(v.page||0); if(page<=1) return;
      slides.push({ url: v.thumbUrl || v.url || `/api/drive-pdf?fileId=${encodeURIComponent(v.fileId)}&page=${page}`, page });
    } else if (v?.url){
      slides.push({ url: v.url, page: v.page||null });
    }
  });
  return slides.slice(0,5);
}

function clearTimers(){ autoTimers.forEach(t=>clearInterval(t)); autoTimers=[]; }

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
  autoTimers.push(timer);
}

function renderBullets(id, list){
  const ul=$(id); if(!ul) return; ul.innerHTML='';
  (list||[]).forEach(t=>{ if(!t) return; const li=document.createElement('li'); li.textContent=t; ul.appendChild(li); });
}

// -------- Submit handler --------
async function onSubmit(e){
  e.preventDefault();
  const q = $('q').value.trim();
  if(!q) return;
  clearTimers();
  showError(''); // clear
  showThinking(true);
  try{
    const resp = await jpost('/search', { q });
    console.debug('Search response:', resp);
    const sections = deriveSections(resp);

    $('answerLead').textContent = sections.lead || '';
    $('answerWrap').style.display = '';

    renderBullets('kpiBullets', sections.kpis.bullets); renderQuotes('kpiQuotes', sections.kpis.quotes); renderCarousel('kpiSlides', sections.kpis.slides, 0);
    renderBullets('driverBullets', sections.drivers.bullets); renderQuotes('driverQuotes', sections.drivers.quotes); renderCarousel('driverSlides', sections.drivers.slides, 600);
    renderBullets('barrierBullets', sections.barriers.bullets); renderQuotes('barrierQuotes', sections.barriers.quotes); renderCarousel('barrierSlides', sections.barriers.slides, 1200);
    renderBullets('trendBullets', sections.trends.bullets); renderQuotes('trendQuotes', sections.trends.quotes); renderCarousel('trendSlides', sections.trends.slides, 1800);
  }catch(err){
    console.error('Search error:', err);
    showError(err && err.message || 'Error');
  }finally{
    showThinking(false);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  hydrateMe();
  const f = $('askForm'); if(f) f.addEventListener('submit', onSubmit);
});
