console.log("🔧 admin.js (fixed) loading...");

// -------- Helpers
const $ = (s) => document.querySelector(s);

function escapeHtml(s){
  return String(s ?? "").replace(/[&<>"']/g, m => (
    {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]
  ));
}

async function j(url, fallback, options={}){
  try{
    const res = await fetch(url, {
      headers: {'Accept':'application/json'},
      credentials: 'include',
      ...options
    });
    if(!res.ok) {
      console.warn('API error:', url, res.status, res.statusText);
      throw new Error(`${res.status}: ${res.statusText}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) return await res.json();
    return fallback;
  }catch(e){
    console.warn('fetch failed', url, e.message);
    return fallback;
  }
}

// Deep string extraction for library objects
function _deepFirstString(val, depth=4){
  if (val == null || depth < 0) return "";
  if (typeof val === "string" && val.trim()) return val;
  if (Array.isArray(val)){
    for (const v of val){
      const s = _deepFirstString(v, depth-1);
      if (s) return s;
    }
    return "";
  }
  if (typeof val === "object"){
    for (const k of Object.keys(val)){
      const s = _deepFirstString(val[k], depth-1);
      if (s) return s;
    }
  }
  try {
    const s = String(val);
    if (s && s !== "[object Object]") return s;
  } catch {}
  return "";
}

function labelFrom(lib){
  if (lib == null) return "";
  if (typeof lib === "string") return lib;
  const keys = ["name","title","clientName","displayName","label","text","client","library","folder","folderName","client_library","clientLibrary","ClientName","Name"];
  for (const k of keys){
    if (lib[k]){
      const s = _deepFirstString(lib[k]);
      if (s) return s;
    }
  }
  return _deepFirstString(lib) || "(unnamed library)";
}

function idFrom(lib){
  if (lib == null) return "";
  if (typeof lib === "string") return lib;
  const keys = ["id","slug","code","key","name","client","library","folder","folderName","client_library","clientLibrary"];
  for (const k of keys){
    if (lib[k]){
      const s = _deepFirstString(lib[k]);
      if (s) return s;
    }
  }
  return _deepFirstString(lib) || "";
}

function isBadValue(v){
  return !v || /\[object Object\]/i.test(String(v));
}

function fmtDate(x){
  try { return x ? new Date(x).toLocaleString() : "—"; } catch { return "—"; }
}

// -------- Elements
const els = {
  kpiAdmins: document.querySelector("#kpiTotalAdmins"),
  kpiClients: document.querySelector("#kpiTotalClients"),
  kpiLibraries: document.querySelector("#kpiClientLibraries"),
  librarySelect: document.querySelector("#librarySelect"),
  libraryStats: document.querySelector("#libraryStats"),
  adminAccounts: document.querySelector("#adminAccounts"),
  clientAccounts: document.querySelector("#clientAccounts"),
  modal: document.querySelector("#confirmModal"),
  confirmBtn: document.querySelector("#confirmDelete"),
  cancelBtn: document.querySelector("#cancelDelete"),
  confirmText: document.querySelector("#confirmText")
};

// -------- Init
(async function init(){
  try{
    await Promise.all([loadStats(), loadLibraries(), loadAdmins(), loadClients()]);
    console.log("✅ admin ready");
  }catch(e){
    console.error("admin init failed", e);
  }
})();

// -------- Loaders
async function loadStats(){
  const s = await j("/api/admin/stats", { totalAdmins:0, totalClients:0, clientLibraries:0 });
  if (els.kpiAdmins) els.kpiAdmins.textContent = s.totalAdmins ?? 0;
  if (els.kpiClients) els.kpiClients.textContent = s.totalClients ?? 0;
  if (els.kpiLibraries) els.kpiLibraries.textContent = s.clientLibraries ?? 0;
}

async function loadLibraries(){
  const data = await j("/api/libraries", []);
  if (!els.librarySelect) return;
  const libs = Array.isArray(data) ? data : (data.libraries || []);
  els.librarySelect.innerHTML = `<option value="">Choose a library…</option>`;
  libs.forEach(lb => {
    const label = labelFrom(lb);
    const id = idFrom(lb);
    const opt = document.createElement("option");
    opt.value = isBadValue(id) ? label : id;
    opt.textContent = (!label || /\[object Object\]/i.test(label)) ? "(unnamed library)" : label;
    els.librarySelect.appendChild(opt);
  });
  
  els.librarySelect.addEventListener("change", async () => {
    const id = els.librarySelect.value;
    if (!id || isBadValue(id)){
      els.libraryStats.innerHTML = `<span class="muted">Select a library to view stats.</span>`;
      return;
    }
    
    els.libraryStats.innerHTML = `<span class="muted">Loading library statistics...</span>`;
    
    const st = await j(`/api/libraries/${encodeURIComponent(id)}/stats`, { 
      totalFiles: 0, 
      processedFiles: 0, 
      lastSynced: null, 
      byCategory: { Reports: 0, QNR: 0, DataFiles: 0 }
    });
    
    const cat = st.byCategory || {};
    const totalFiles = st.totalFiles || 0;
    const processedFiles = st.processedFiles || 0;
    const lastSynced = st.lastSynced;
    
    els.libraryStats.innerHTML = `
      <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center;">
        <div>Google Drive files: <strong>${totalFiles}</strong></div>
        <div>Processed: <strong>${processedFiles}</strong></div>
        <div>Last synced: <strong>${fmtDate(lastSynced)}</strong></div>
      </div>
      <div style="margin-top:8px;border-top:1px dashed #e5e7eb;padding-top:8px;">
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;max-width:640px;">
          <div style="background:#fafafa;border:1px solid #f0f2f5;border-radius:8px;padding:8px 10px;">
            <div class="muted" style="font-size:12px;">Reports</div>
            <div style="font-weight:600;">${cat.Reports ?? 0}</div>
          </div>
          <div style="background:#fafafa;border:1px solid #f0f2f5;border-radius:8px;padding:8px 10px;">
            <div class="muted" style="font-size:12px;">QNR</div>
            <div style="font-weight:600;">${cat.QNR ?? 0}</div>
          </div>
          <div style="background:#fafafa;border:1px solid #f0f2f5;border-radius:8px;padding:8px 10px;">
            <div class="muted" style="font-size:12px;">Data files</div>
            <div style="font-weight:600;">${cat.DataFiles ?? 0}</div>
          </div>
        </div>
      </div>
      <div style="margin-top:12px;">
        <button onclick="manualSync()" style="background:#ff7a00;color:white;border:none;padding:6px 12px;border-radius:6px;font-size:12px;cursor:pointer;">
          🔄 Sync Google Drive
        </button>
      </div>`;
  });
  
  if (els.libraryStats) els.libraryStats.innerHTML = `<span class="muted">Select a library to view stats.</span>`;
}

// Manual sync function
async function manualSync() {
  const button = event.target;
  const originalText = button.innerHTML;
  button.innerHTML = '🔄 Syncing...';
  button.disabled = true;
  
  try {
    const result = await j("/admin/manual-sync", {}, { method: 'POST' });
    if (result.success) {
      alert('✅ Google Drive sync completed successfully!');
      // Refresh the current library stats
      if (els.librarySelect.value) {
        els.librarySelect.dispatchEvent(new Event('change'));
      }
      // Refresh stats
      await loadStats();
    } else {
      alert('❌ Sync failed: ' + (result.details || 'Unknown error'));
    }
  } catch (error) {
    alert('❌ Sync failed: ' + error.message);
  } finally {
    button.innerHTML = originalText;
    button.disabled = false;
  }
}

// Make manualSync globally available
window.manualSync = manualSync;

async function loadAdmins(){
  console.log('Loading admin accounts...');
  const admins = await j("/api/admin/users", []);
  console.log('Admin accounts response:', admins);
  
  const arr = Array.isArray(admins) ? admins : [];
  arr.sort((a,b) => {
    const tb = new Date(b.createdAt || b.created || 0).getTime();
    const ta = new Date(a.createdAt || a.created || 0).getTime();
    if (tb !== ta) return tb - ta;
    const sb = (b.username || b.email || b.id || "").toLowerCase();
    const sa = (a.username || a.email || a.id || "").toLowerCase();
    return sa.localeCompare(sb);
  });
  
  renderAccounts(els.adminAccounts, arr.map(a => ({
    id: a.id || a.username || a.email,
    title: a.username || a.email || a.id,
    role: "admin",
    createdAt: a.createdAt || a.created
  })));
}

async function loadClients(){
  console.log('Loading client accounts...');
  const clients = await j("/api/clients", []);
  console.log('Client accounts response:', clients);
  
  const arr = Array.isArray(clients) ? clients : [];
  arr.sort((a,b) => {
    const tb = new Date(b.createdAt || b.created || 0).getTime();
    const ta = new Date(a.createdAt || a.created || 0).getTime();
    if (tb !== ta) return tb - ta;
    const sb = (b.name || b.username || b.id || "").toLowerCase();
    const sa = (a.name || a.username || a.id || "").toLowerCase();
    return sa.localeCompare(sb);
  });
  
  renderAccounts(els.clientAccounts, arr.map(c => ({
    id: c.id || c.username || c.name,
    title: c.name || c.username || c.id,
    role: "client",
    createdAt: c.createdAt || c.created,
    library: c.library || c.libraryId || c.clientLibrary || "—"
  })));
}

// -------- Rendering & actions
function renderAccounts(container, arr){
  if (!container) return;
  container.classList.remove("scroll10");
  container.innerHTML = "";
  if (!arr.length){
    container.innerHTML = `<div class="muted">No accounts yet.</div>`;
    return;
  }
  if (arr.length > 10) container.classList.add("scroll10");

  arr.forEach(item => {
    const row = document.createElement("div");
    row.className = "row";
    let metaHtml = "";
    if (item.role === "client"){
      metaHtml = `<div class="meta">Library Access: ${escapeHtml(item.library ?? "—")}</div>`;
    }
    row.innerHTML = `
      <div>
        <div class="title">${escapeHtml(item.title)}</div>
        ${metaHtml}
      </div>
      <div class="menu">
        <button class="kebab" aria-label="More"><span></span><span></span><span></span></button>
        <div class="menu-items">
          <button data-action="delete">Delete account</button>
        </div>
      </div>
    `;
    const kebab = row.querySelector(".kebab");
    const menu = row.querySelector(".menu-items");
    kebab.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = menu.style.display === "block";
      document.querySelectorAll(".menu-items").forEach(m => m.style.display = "none");
      menu.style.display = open ? "none" : "block";
    });
    document.addEventListener("click", () => { menu.style.display = "none"; });

    const delBtn = row.querySelector("[data-action='delete']");
    delBtn.addEventListener("click", () => {
      menu.style.display = "none";
      confirmDelete(item);
    });

    container.appendChild(row);
  });
}

function confirmDelete(account){
  const modal = document.querySelector("#confirmModal");
  const confirmBtn = document.querySelector("#confirmDelete");
  const cancelBtn = document.querySelector("#cancelDelete");
  const text = document.querySelector("#confirmText");
  if (!modal || !confirmBtn || !cancelBtn || !text) return;
  text.textContent = `Delete account "${account.title}"? This action cannot be undone.`;
  modal.style.display = "flex";
  const cleanup = () => {
    modal.style.display = "none";
    confirmBtn.onclick = null;
    cancelBtn.onclick = null;
  };
  cancelBtn.onclick = cleanup;
  confirmBtn.onclick = async () => {
    try {
      const url = `/api/admin/users/${encodeURIComponent(account.id)}`;
      const res = await fetch(url, { method:"DELETE", credentials:"include" });
      if (!res.ok) throw new Error(String(res.status));
      
      // Refresh the appropriate section
      if (account.role === "admin") {
        await loadAdmins();
      } else {
        await loadClients();
      }
      await loadStats(); // Refresh the counters
    } catch(e) {
      console.warn("Delete failed:", e.message);
      alert("Failed to delete account: " + e.message);
    } finally {
      cleanup();
    }
  };
}

// --- Reports admin (list count only) ---
async function loadReportsAdmin(){
  try{
    const res = await fetch('/api/reports', { headers:{'Accept':'application/json'} });
    if (!res.ok) return;
    const js = await res.json();
    const count = (js && js.data && js.data.length) ? js.data.length : 0;
    const el = document.querySelector('#kpiReportsTotal');
    if (el) el.textContent = count;
  }catch{}
}
document.addEventListener('DOMContentLoaded', ()=>{
  try{ loadReportsAdmin(); }catch{}
});
