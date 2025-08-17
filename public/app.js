/* public/app.js — ensure session cookies travel with fetch */
const API_BASE = (window.CONFIG||{}).API_BASE || "";

async function jget(u){
  const r = await fetch(API_BASE+u, { credentials: 'include' });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}
async function jpost(u,b){
  const r = await fetch(API_BASE+u, {
    method:"POST",
    headers:{"Content-Type":"application/json"},
    credentials: 'include',
    body: JSON.stringify(b||{})
  });
  if(!r.ok) throw new Error(await r.text());
  return r.json();
}

const $ = id => document.getElementById(id);

let me = null;
let autoTimers = [];
function showThinking(s){ const t=$('thinking'); if(t) t.style.display = s?'':'none'; }
function roleDisplay(r){ return r==='internal' ? 'admin' : (r||''); }
function ensureAdminLink(){ const el=$('adminLink'); if(!el||!me) return; el.style.display=(me.role==='internal'||me.role==='admin')?'inline-flex':'none'; }
function uncloack(){ document.body.classList.remove('cloak'); }

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

function escapeHtml(s){ return (s||'').replace(/[&<>\"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;','\\'':'&#39;'}[m])); }
function pick(arr, n){ return (arr||[]).slice(0,n); }
function deriveSections(resp){
  const lead = resp.answer || resp.headline || resp.summary || '';
  const bullets = resp.bullets || resp.points || [];
  const quotes = resp.quotes || resp.insights || [];
  const visuals = resp.visuals || resp.slides || [];

  const drivers = (resp.drivers || []).concat(bullets.filter(b=>/driver|increase|satisf|like|prefer/i.test(b)));
  const barriers = (resp.barriers || []).concat(bullets.filter(b=>/barrier|decreas|dissatisf|pain|issue|concern|friction/i.test(b)));
  const kpis = (resp.kpis || []).concat(bullets.filter(b=>/KPI|NPS|CSAT|awareness|consideration|trial|repeat|share|growth|decline/i.test(b)));
  const trends = (resp.trends || []).concat(bullets.filter(b=>/trend|over time|month|quarter|year|increasing|decreasing/i.test(b)));

  function normalizeQuotes(qs){
    return (qs||[]).map(q => (typeof q==='string') ? {text:q, tag:''} : {text:q.text||q.quote||'', tag:q.tag||q.source||''});
  }
  const qnorm = normalizeQuotes(quotes);

  return {
    lead,
    kpis: { bullets: pick(kpis,5), quotes: pick(qnorm,3), slides: visuals },
    drivers: { bullets: pick(drivers,5), quotes: pick(qnorm,3), slides: visuals },
    barriers: { bullets: pick(barriers,5), quotes: pick(qnorm,3), slides: visuals },
    trends: { bullets: pick(trends,5), quotes: pick(qnorm,3), slides: visuals },
  };
}

function renderQuotes(containerId, quotes){
  const root = document.getElementById(containerId); if(!root) return; root.innerHTML='';
  (quotes||[]).forEach(q => {
    if(!q.text) return;
    const div = document.createElement('div');
    div.className = 'quote';
    div.innerHTML = `${escapeHtml(q.text)}${q.tag?` <span class="tag">— ${escapeHtml(q.tag)}</span>`:''}`;
    root.appendChild(div);
  });
}

function slidesFromVisuals(visuals){
  const slides = [];
  (visuals||[]).forEach(v => {
    if(v.type==='slide'){
      const page = Number(v.page||0);
      if(page<=1) return;
      slides.push({ url: v.thumbUrl || v.url || `/api/drive-pdf?fileId=${encodeURIComponent(v.fileId)}&page=${page}`, page });
    } else if (v.url){
      slides.push({ url: v.url, page: v.page || null });
    }
  });
  return slides.slice(0,5);
}

let autoTimers = [];
function clearTimers(){ autoTimers.forEach(t=>clearInterval(t)); autoTimers = []; }

function renderCarousel(rootId, visuals, staggerMs){
  const root = document.getElementById(rootId);
  root.innerHTML = '';
  const slides = slidesFromVisuals(visuals);
  if(!slides.length){ root.style.display='none'; return; }
  root.style.display='block';

  const viewport = document.createElement('div');
  viewport.className = 'viewport';
  const img = document.createElement('img');
  viewport.appendChild(img);

  const nav = document.createElement('div');
  nav.className = 'nav';
  const prev = document.createElement('button'); prev.innerHTML = '&#x2039;';
  const next = document.createElement('button'); next.innerHTML = '&#x203A;';
  nav.appendChild(prev); nav.appendChild(next);

  const dots = document.createElement('div');
  dots.className = 'dots';

  root.appendChild(viewport);
  root.appendChild(nav);
  root.appendChild(dots);

  let idx = 0;
  let paused = false;

  function draw(){
    const s = slides[idx];
    img.src = s.url;
    dots.querySelectorAll('button').forEach((b,i)=>b.classList.toggle('active', i===idx));
  }
  function go(i){
    idx = (i + slides.length) % slides.length;
    draw();
  }

  slides.forEach((s,i)=>{
    const b = document.createElement('button');
    b.addEventListener('click', () => { paused = true; go(i); });
    dots.appendChild(b);
  });

  prev.addEventListener('click', ()=>{ paused=true; go(idx-1); });
  next.addEventListener('click', ()=>{ paused=true; go(idx+1); });

  draw();
  const timer = setInterval(()=>{ if(!paused) go(idx+1); }, 5000);
  autoTimers.push(timer);
}

async function onSubmit(e){
  e.preventDefault();
  const q = document.getElementById('q').value.trim();
  if(!q) return;
  clearTimers();
  showThinking(true);
  try{
    const resp = await jpost('/search', { q });
    const sections = deriveSections(resp);

    document.getElementById('answerLead').textContent = sections.lead || '';
    document.getElementById('answerWrap').style.display = '';

    const setList=(id,list)=>{const ul=document.getElementById(id); ul.innerHTML=''; (list||[]).forEach(t=>{ if(!t) return; const li=document.createElement('li'); li.textContent=t; ul.appendChild(li); });};
    setList('kpiBullets', sections.kpis.bullets); renderQuotes('kpiQuotes', sections.kpis.quotes); renderCarousel('kpiSlides', sections.kpis.slides, 0);
    setList('driverBullets', sections.drivers.bullets); renderQuotes('driverQuotes', sections.drivers.quotes); renderCarousel('driverSlides', sections.drivers.slides, 600);
    setList('barrierBullets', sections.barriers.bullets); renderQuotes('barrierQuotes', sections.barriers.quotes); renderCarousel('barrierSlides', sections.barriers.slides, 1200);
    setList('trendBullets', sections.trends.bullets); renderQuotes('trendQuotes', sections.trends.quotes); renderCarousel('trendSlides', sections.trends.slides, 1800);
  }catch(err){
    console.error(err);
    alert('Error: '+(err.message||err));
  }finally{
    showThinking(false);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  hydrateMe();
  const f = document.getElementById('askForm'); if(f) f.addEventListener('submit', onSubmit);
});
