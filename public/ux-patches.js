// Non-invasive UI patches to apply requested behavior WITHOUT changing your layout logic.
(function () {
  // Helpers
  const cleanOuterQuotes = s => String(s || "").trim().replace(/^["“]+/, "").replace(/["”]+$/, "");
  const splitQuoteAndTag = s => {
    const txt = cleanOuterQuotes(s);
    const m = txt.match(/^(.*?)(?:\s*[–—-]\s*(.+))?$/); // “…text…” - Tag
    return { quote: (m ? m[1] : txt).trim(), tag: (m && m[2] ? m[2] : "").trim() };
  };
  const stripFinalPeriod = s => String(s || "").trim().replace(/[.。]\s*$/, "");

  function patchQuotes() {
    const root = document.querySelector("#quotes");
    if (!root || root.dataset.patchedQuotes) return;
    // Accept either <ul><li>…</li></ul> or a simple container
    const items = Array.from(root.querySelectorAll("li")).length
      ? Array.from(root.querySelectorAll("li"))
      : Array.from(root.children);

    if (!items.length) return;
    const frag = document.createDocumentFragment();
    items.forEach(node => {
      const text = (node.innerText || node.textContent || "").trim();
      const { quote, tag } = splitQuoteAndTag(text);
      const wrap = document.createElement("div");
      wrap.className = "quote-item";
      const q = document.createElement("p");
      q.className = "quote-text";
      q.textContent = quote; // italic via CSS
      wrap.appendChild(q);
      if (tag) {
        const t = document.createElement("div");
        t.className = "quote-tag";
        t.textContent = "— " + tag; // smaller via CSS
        wrap.appendChild(t);
      }
      frag.appendChild(wrap);
    });
    root.innerHTML = "";
    root.appendChild(frag);
    root.dataset.patchedQuotes = "1";
  }

  function patchBullets() {
    const root = document.querySelector("#bullets");
    if (!root || root.dataset.patchedBullets) return;
    root.querySelectorAll("li").forEach(li => {
      li.textContent = stripFinalPeriod(li.textContent || "");
    });
    root.dataset.patchedBullets = "1";
  }

  function patchRefs() {
    const root = document.querySelector("#refs") || document.querySelector(".refs");
    if (!root || root.dataset.patchedRefs) return;
    root.querySelectorAll("a").forEach(a => {
      if (a.textContent && a.textContent.includes("_")) {
        a.textContent = a.textContent.replace(/_/g, " ");
      }
    });
    // Hide lone "p.1" labels if they exist as separate elements
    root.querySelectorAll("*").forEach(el => {
      const txt = (el.textContent || "").trim();
      if (/^p\.?1$/i.test(txt)) el.remove();
    });
    root.dataset.patchedRefs = "1";
  }

  function patchVisuals() {
    // If any slide/PDF thumbnails slip in, remove them; keep only charts (canvas)
    const visuals = document.querySelector("#charts, #report-slides, .slides");
    if (!visuals || visuals.dataset.patchedVisuals) return;
    visuals.querySelectorAll("img, [data-slide-preview], .slide-preview").forEach(n => n.remove());
    visuals.dataset.patchedVisuals = "1";
  }

  // Run on DOM changes so it re-applies after each search render
  const obs = new MutationObserver(() => {
    patchQuotes();
    patchBullets();
    patchRefs();
    patchVisuals();
  });

  window.addEventListener("DOMContentLoaded", () => {
    obs.observe(document.body, { subtree: true, childList: true });
    patchQuotes();
    patchBullets();
    patchRefs();
    patchVisuals();
  });
})();


// === JAICE: Insights Dashboard (non-invasive) ===
(function(){
  if (window.__JAICE_DASHBOARD_INIT__) return; window.__JAICE_DASHBOARD_INIT__ = true;

  function groupBulletsIntoThemes(bullets=[], question=""){
    const text = (question||"").toLowerCase();
    const defs = [
      {key:"satisfaction",  title:"Satisfaction Drivers",    kws:["satisfaction","drivers","importance","key drivers","usage drivers"]},
      {key:"convenience",   title:"Adherence & Convenience", kws:["adherence","convenience","administration","easy","recommendation","hcp"]},
      {key:"safety",        title:"Safety & Tolerability",   kws:["safety","tolerability","side effect","long-term","tolerable"]},
      {key:"awareness",     title:"Awareness & Education",   kws:["aware","informed","knowledge","education"]},
      {key:"access",        title:"Access & Coverage",       kws:["access","coverage","cost","insurance"]},
    ];
    const buckets = {}; defs.forEach(d => buckets[d.key] = {title:d.title, bullets:[]});
    const pick = t => {
      const s = (t||"").toLowerCase();
      for (const d of defs){ if (d.kws.some(k => s.includes(k) || text.includes(k))) return d.key; }
      return "satisfaction";
    };
    for (const b of (bullets||[])){ buckets[pick(b)].bullets.push(b); }
    for (const k of Object.keys(buckets)){ if (!buckets[k].bullets.length) delete buckets[k]; }
    return buckets;
  }

  function buildCarousel(urls=[], index=0){
    if (!urls || !urls.length) return null;
    const root = document.createElement("div"); root.className="carousel"; root.setAttribute("data-auto","1");
    const track = document.createElement("div"); track.className="carousel-track";
    urls.forEach(u => { const img=document.createElement("img"); img.src=u; track.appendChild(img); });
    root.appendChild(track);
    const nav = document.createElement("div"); nav.className="nav";
    const left = document.createElement("button"); left.innerHTML="&#9664;";
    const right = document.createElement("button"); right.innerHTML="&#9654;";
    nav.appendChild(left); nav.appendChild(right); root.appendChild(nav);
    let i = 0, n = urls.length;
    function go(delta){ if (!n) return; i = (i + delta + n) % n; track.style.transform = `translateX(${-i*100}%)`; }
    let timer = setInterval(() => go(+1), 5000 + (index%5)*1000);
    function stop(){ if (timer){ clearInterval(timer); timer = null; root.dataset.auto="0"; } }
    left.addEventListener("click", () => { stop(); go(-1); });
    right.addEventListener("click", () => { stop(); go(+1); });
    return root;
  }

  function ensureDashboardContainer(){
    const out = document.getElementById("out"); if (!out) return null;
    let el = document.getElementById("dashboard");
    if (!el){
      el = document.createElement("div");
      el.id = "dashboard";
      el.className = "panel";
      el.style.display = "none";
      el.innerHTML = '<h3>Insights Dashboard</h3><div id="dashGrid" class="dash-grid"></div>';
      out.insertBefore(el, out.firstChild);
    }
    return el;
  }

  function render({question, bullets, slides}){
    const container = ensureDashboardContainer(); if (!container) return;
    const dash = container.querySelector("#dashGrid"); dash.innerHTML = "";
    const buckets = groupBulletsIntoThemes(bullets, question);
    const keys = Object.keys(buckets);
    if (!keys.length && (!slides || !slides.length)){ container.style.display = "none"; return; }
    container.style.display = "";

    let attached = false;
    keys.forEach((k, idx) => {
      const b = buckets[k];
      const box = document.createElement("div"); box.className="dash-box";
      const h = document.createElement("h4"); h.textContent = b.title; box.appendChild(h);
      if (b.bullets && b.bullets.length){
        const summary = document.createElement("div"); summary.className="summary"; summary.textContent = b.bullets[0]; box.appendChild(summary);
        if (b.bullets.length > 1){
          const ul = document.createElement("ul");
          b.bullets.slice(1).forEach(t => { const li=document.createElement("li"); li.textContent=t; ul.appendChild(li); });
          box.appendChild(ul);
        }
      }
      const shouldAttach = (!attached && (k==="satisfaction" || idx===0)) && slides && slides.length;
      if (shouldAttach){
        const c = buildCarousel(slides.slice(0,5), idx); if (c) box.appendChild(c); attached = true;
      }
      dash.appendChild(box);
    });

    if (!keys.length && slides && slides.length){
      const box = document.createElement("div"); box.className="dash-box";
      const h = document.createElement("h4"); h.textContent = "Report Slides"; box.appendChild(h);
      const c = buildCarousel(slides.slice(0,5), 0); if (c) box.appendChild(c);
      dash.appendChild(box);
    }
  }

  const mo = new MutationObserver(() => {
    const out = document.getElementById("out");
    if (!out || out.style.display === "none") return;
    const list = document.getElementById("supportList");
    const bullets = list ? Array.from(list.querySelectorAll("li")).map(li => li.textContent.trim()).filter(Boolean) : [];
    const grid = document.getElementById("slidesGrid");
    const slides = grid ? Array.from(grid.querySelectorAll("img")).map(img => img.src) : [];
    const q = (document.getElementById("q") && document.getElementById("q").value) || "";
    render({ question: q, bullets, slides });
  });
  mo.observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["style", "class"] });
})();
