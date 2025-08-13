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
