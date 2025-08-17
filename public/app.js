/* public/app.js — hydrates /me, shows Admin link, renders answer + dashboard
   - Admin button in top-right when role is internal/admin
   - Headline ALL CAPS with orange period handled via CSS
   - Single centered "Thinking…" overlay
   - On load: GET /me; if not authed => /login.html; then uncloak
   - Submit => POST /search with {q}
   - Dashboard cards: KPIs, Key Drivers, Key Barriers, Trends Over Time
   - Bullets → supporting quotes (italic + respondent tag) → slide carousel
   - Carousels: skip page 1, show one slide initially, arrows, auto-advance ~5s, staggered starts, pause after manual click
*/
const API_BASE = (window.CONFIG||{}).API_BASE || "";

async function jget(u){ const r=await fetch(API_BASE+u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(u,b){ const r=await fetch(API_BASE+u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

const $ = id => document.getElementById(id);

let me = null;
let autoTimers = []; // per-carousel auto-advance timers

function uncloack(){ document.body.classList.remove('cloak'); }

function showThinking(s){ const t=$('thinking'); if(!t) return; t.style.display = s ? '' : 'none'; }

function roleDisplay(r){ return r==='internal' ? 'admin' : (r||''); }

function ensureAdminLink(){ 
  const el = $('adminLink'); if(!el || !me) return;
  if(me.role==='internal' || me.role==='admin'){ el.style.display='inline-flex'; }
  else { el.style.display='none'; }
}

async function hydrateMe(){
  try{
    me = await jget('/me');
    $('username').textContent = me && me.username ? `${me.username} — ${roleDisplay(me.role)}` : '—';
    ensureAdminLink();
    uncloack();
  }catch(e){
    // Not signed in => login
    window.location.href = '/login.html';
  }
}

function pick(arr, n){ return (arr||[]).slice(0,n); }

function deriveSections(resp){
  // Flexible mapping to fit various backend shapes
  const lead = resp.answer || resp.headline || resp.summary || '';
  const bullets = resp.bullets || resp.points || [];
  const quotes = resp.quotes || resp.insights || [];
  const visuals = resp.visuals || resp.slides || [];

  // Heuristic buckets
  const drivers = (resp.drivers || []).concat(bullets.filter(b=>/driver|increase|satisf|like|prefer/i.test(b)));
  const barriers = (resp.barriers || []).concat(bullets.filter(b=>/barrier|decreas|dissatisf|pain|issue|concern|friction/i.test(b)));
  const kpis = (resp.kpis || []).concat(bullets.filter(b=>/KPI|NPS|CSAT|awareness|consideration|trial|repeat|share|growth|decline/i.test(b)));
  const trends = (resp.trends || []).concat(bullets.filter(b=>/trend|over time|month|quarter|year|increasing|decreasing/i.test(b)));

  // Quotes can be shared; allow mild duplication
  function normalizeQuotes(qs){
    return (qs||[]).map(q => {
      if(typeof q === 'string') return { text: q, tag: '' };
      // expected {text, tag} or {quote, source}
      return { text: q.text || q.quote || '', tag: q.tag || q.source || '' };
    });
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
  const root = $(containerId); root.innerHTML='';
  (quotes||[]).forEach(q => {
    if(!q.text) return;
    const div = document.createElement('div');
    div.className = 'quote';
    div.innerHTML = `${escapeHtml(q.text)}${q.tag?` <span class="tag">— ${escapeHtml(q.tag)}</span>`:''}`;
    root.appendChild(div);
  });
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function slidesFromVisuals(visuals){
  // Accepts entries like {type:'slide', fileId, page, thumbUrl} or direct {url}
  const slides = [];
  (visuals||[]).forEach(v => {
    if(v.type==='slide'){
      const page = Number(v.page||0);
      if(page<=1) return; // skip title slide (page 1)
      slides.push({ url: v.thumbUrl || v.url || `/api/drive-pdf?fileId=${encodeURIComponent(v.fileId)}&page=${page}`, page });
    } else if (v.url){
      slides.push({ url: v.url, page: v.page || null });
    }
  });
  return slides.slice(0,5);
}

function renderCarousel(rootId, visuals, staggerMs){
  const root = $(rootId);
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

  // Auto-advance ~5s with stagger
  const timer = setInterval(()=>{ if(!paused) go(idx+1); }, 5000);
  // Start slightly delayed per-card for staggered feel
  const startDelay = setTimeout(()=>{}, Math.min(3000, Math.max(0, staggerMs||0)));
  autoTimers.push(timer, startDelay);
}

function renderBullets(id, list){
  const ul = $(id); ul.innerHTML='';
  (list||[]).forEach(t=>{
    if(!t) return;
    const li = document.createElement('li');
    li.textContent = t;
    ul.appendChild(li);
  });
}

function clearTimers(){
  autoTimers.forEach(t=>clearInterval(t));
  autoTimers = [];
}

async function onSubmit(e){
  e.preventDefault();
  const q = $('q').value.trim();
  if(!q) return;
  clearTimers();
  showThinking(true);
  try{
    const resp = await jpost('/search', { q });
    const sections = deriveSections(resp);

    $('answerLead').textContent = sections.lead || '';
    $('answerWrap').style.display = '';

    renderBullets('kpiBullets', sections.kpis.bullets);
    renderQuotes('kpiQuotes', sections.kpis.quotes);
    renderCarousel('kpiSlides', sections.kpis.slides, 0);

    renderBullets('driverBullets', sections.drivers.bullets);
    renderQuotes('driverQuotes', sections.drivers.quotes);
    renderCarousel('driverSlides', sections.drivers.slides, 600);

    renderBullets('barrierBullets', sections.barriers.bullets);
    renderQuotes('barrierQuotes', sections.barriers.quotes);
    renderCarousel('barrierSlides', sections.barriers.slides, 1200);

    renderBullets('trendBullets', sections.trends.bullets);
    renderQuotes('trendQuotes', sections.trends.quotes);
    renderCarousel('trendSlides', sections.trends.slides, 1800);
  }catch(err){
    console.error(err);
    alert('Error: '+(err.message||err));
  }finally{
    showThinking(false);
  }
}

document.addEventListener('DOMContentLoaded', ()=>{
  hydrateMe();
  const f = $('askForm'); if(f) f.addEventListener('submit', onSubmit);
});
