// public/admin.js
// Implements: spacing, fields BEFORE lists, top-right link actions, selection → actions,
// username | password(show/hide via reset) | library, carets for tree, full-width layout.

async function jget(u){ const r=await fetch(u); if(!r.ok) throw new Error(await r.text()); return r.json(); }
async function jpost(u,b){ const r=await fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}); if(!r.ok) throw new Error(await r.text()); return r.json(); }

const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
const show = el => el && (el.classList.remove("hidden"));
const hide = el => el && (el.classList.add("hidden"));

let LIBS = [];
let USERS = [];

(async function init(){
  // whoami + gate
  try{
    const me = await jget("/me");
    if((me?.user?.role||"").toLowerCase()!=="admin"){ location.href="/"; return; }
    $("#who").textContent = `${me.user.username} · ${me.user.role}`;
  }catch{
    location.href="/login.html"; return;
  }
  $("#logoutBtn").onclick = async ()=>{ await jpost("/auth/logout",{}); location.href="/login.html"; };

  // load libraries
  LIBS = await jget("/api/client-libraries");
  fillSelect($("#cu_client"), LIBS);
  fillSelect($("#statsClient"), LIBS);
  fillSelect($("#ingestClient"), LIBS);
  fillSelect($("#clientLibrarySelect"), LIBS);

  // build library tree
  buildLibraryTree(LIBS);
  $("#refreshLibsBtn").onclick = async ()=>{
    try{
      await jpost("/api/client-libraries/refresh",{});
    }catch{}
    LIBS = await jget("/api/client-libraries");
    fillSelect($("#cu_client"), LIBS);
    fillSelect($("#statsClient"), LIBS);
    fillSelect($("#ingestClient"), LIBS);
    fillSelect($("#clientLibrarySelect"), LIBS);
    buildLibraryTree(LIBS);
  };

  // stats
  $("#statsClient").addEventListener("change", loadStats);

  // ingest
  $("#ingestBtn").onclick = doIngest;

  // forms toggles
  $("#addClientLink").onclick = ()=>$("#clientForm").classList.toggle("hidden");
  $("#addAdminLink").onclick = ()=>$("#adminForm").classList.toggle("hidden");

  // lists
  USERS = await jget("/admin/users/list");
  renderClients();
  renderAdmins();

  // actions
  $("#clientSelectAll").addEventListener("change", (e)=>{
    $$("#clientTbody input[type=checkbox]").forEach(cb=>cb.checked=e.target.checked);
    toggleClientActions();
  });
  $("#clientDeleteBtn").onclick = deleteSelectedClients;
  $("#clientApplyLibraryBtn").onclick = updateSelectedLibraries;

  // create client
  $("#createClientBtn").onclick = createClient;
  // create admin
  $("#createAdminBtn").onclick = createAdmin;
})();

function fillSelect(sel, libs){
  if(!sel) return;
  sel.innerHTML = `<option value="">Select a client library</option>` + libs.map(l=>`<option value="${l.id}">${l.name}</option>`).join("");
}

function buildLibraryTree(libs){
  const root = $("#libsTree");
  const msg = $("#libsMsg");
  root.innerHTML = "";
  msg.textContent = libs.length ? "" : "No libraries found.";
  libs.forEach(lib=>{
    const li = document.createElement("li");
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.className = "caret-title";
    summary.textContent = lib.name;
    details.appendChild(summary);
    const content = document.createElement("div");
    content.className = "small muted";
    content.textContent = "Loading folders…";
    details.appendChild(content);
    details.addEventListener("toggle", async ()=>{
      summary.classList.toggle("open", details.open);
      if(!details.open) return;
      content.textContent="Loading folders…";
      try{
        const j = await jget(`/admin/drive/children?parentId=${encodeURIComponent(lib.id)}`);
        const ul = document.createElement("ul");
        (j.folders||[]).forEach(f=>{
          const d = document.createElement("details");
          const s = document.createElement("summary");
          s.className = "caret-title";
          s.textContent = f.name;
          d.appendChild(s);
          const inner = document.createElement("div"); inner.className="small muted"; inner.textContent="Loading…"; d.appendChild(inner);
          d.addEventListener("toggle", async ()=>{
            s.classList.toggle("open", d.open);
            if(!d.open) return;
            inner.textContent="Loading…";
            try{
              const jj = await jget(`/admin/drive/children?parentId=${encodeURIComponent(f.id)}`);
              const list = document.createElement("ul");
              (jj.folders||[]).forEach(sf=>{
                const sd=document.createElement("details");
                const ss=document.createElement("summary");
                ss.className="caret-title";
                ss.textContent=sf.name;
                sd.appendChild(ss);
                const inner2=document.createElement("div"); inner2.className="small muted"; inner2.textContent="Loading…"; sd.appendChild(inner2);
                sd.addEventListener("toggle", async ()=>{
                  ss.classList.toggle("open", sd.open);
                  if(!sd.open) return;
                  inner2.textContent="Loading…";
                  try{
                    const j3 = await jget(`/admin/drive/children?parentId=${encodeURIComponent(sf.id)}`);
                    const l3=document.createElement("ul");
                    (j3.files||[]).forEach(file=>{ const it=document.createElement("li"); it.textContent=file.name; l3.appendChild(it); });
                    inner2.innerHTML=""; l3.children.length ? inner2.appendChild(l3) : inner2.textContent="No files.";
                  }catch{ inner2.textContent="Failed."; }
                });
                const li2=document.createElement("li"); li2.appendChild(sd); list.appendChild(li2);
              });
              (jj.files||[]).forEach(file=>{ const liF=document.createElement("li"); liF.textContent=file.name; list.appendChild(liF); });
              inner.innerHTML=""; list.children.length ? inner.appendChild(list) : inner.textContent="Empty.";
            }catch{ inner.textContent="Failed."; }
          });
          const liF=document.createElement("li"); liF.appendChild(d); ul.appendChild(liF);
        });
        (j.files||[]).forEach(file=>{ const liF=document.createElement("li"); liF.textContent=file.name; ul.appendChild(liF); });
        content.innerHTML=""; ul.children.length ? content.appendChild(ul) : content.textContent="Empty.";
      }catch{ content.textContent="Failed to load."; }
    });
    li.appendChild(details);
    root.appendChild(li);
  });
}

async function loadStats(){
  const clientId = $("#statsClient").value;
  const out = $("#statsOut");
  if(!clientId){ out.textContent="Select a client."; return; }
  out.textContent="Loading…";
  try{
    const j = await jget(`/admin/library-stats?clientId=${encodeURIComponent(clientId)}`);
    const accounts = (j.accounts||[]).map(a=>`${a.username}${a.role==="internal"?" (admin)":""}`).join(", ");
    out.innerHTML = `
      <div><strong>Drive files:</strong> ${j.driveFiles ?? "—"}</div>
      <div><strong>Reports:</strong> ${j.reportsCount ?? 0}</div>
      <div><strong>Data files:</strong> ${j.dataFilesCount ?? 0}</div>
      <div><strong>QNRs:</strong> ${j.qnrsCount ?? 0}</div>
      <div style="margin-top:8px;"><strong>Accounts with access:</strong> ${accounts || "None"}</div>
    `;
  }catch(e){ out.textContent="Failed to load stats."; }
}

async function doIngest(){
  const clientId = $("#ingestClient").value;
  const out = $("#ingestOut");
  if(!clientId){ out.textContent="Select a client."; return; }
  out.textContent="Updating…";
  try{
    const j = await jpost("/admin/ingest-client", { clientId });
    out.textContent = `OK. Upserted: ${j.summary?.upserted ?? 0}`;
  }catch(e){ out.textContent = "Update failed."; }
}

// -------- Accounts --------
function renderClients(){
  const tbody = $("#clientTbody");
  tbody.innerHTML = "";
  const clients = USERS.filter(u=>u.role!=="internal");
  clients.forEach(u=>{
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="checkbox" data-username="${u.username}"/></td>
      <td>${u.username}</td>
      <td>
        <button class="btn small" data-showpass="${u.username}">Show</button>
        <span class="small muted" data-passval="${u.username}" style="margin-left:6px;"></span>
      </td>
      <td>${renderLibraryCell(u.allowedClients)}</td>
    `;
    tbody.appendChild(tr);
  });

  // hook selection + pass show
  $$("#clientTbody input[type=checkbox]").forEach(cb=>cb.addEventListener("change", toggleClientActions));
  $$("#clientTbody button[data-showpass]").forEach(btn=>btn.addEventListener("click", onShowPassword));
  toggleClientActions();
}

function renderAdmins(){
  const tbody = $("#adminTbody");
  tbody.innerHTML = "";
  const admins = USERS.filter(u=>u.role==="internal");
  admins.forEach(u=>{
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${u.username}</td><td>admin</td>`;
    tbody.appendChild(tr);
  });
}

function renderLibraryCell(allowed){
  if(allowed==="*" || (Array.isArray(allowed) && allowed.includes("*"))) return "All";
  const lib = LIBS.find(l=>l.id===allowed);
  return lib ? lib.name : (allowed||"");
}

function selectedClientUsernames(){
  return $$("#clientTbody input[type=checkbox]:checked").map(cb=>cb.getAttribute("data-username"));
}

function toggleClientActions(){
  const any = selectedClientUsernames().length>0;
  if(any) show($("#clientActions")); else hide($("#clientActions"));
}

async function deleteSelectedClients(){
  const names = selectedClientUsernames();
  if(!names.length) return;
  if(!confirm(`Delete ${names.length} account(s)?`)) return;
  for(const username of names){
    try{
      await jpost("/admin/users/delete", { username });
      USERS = USERS.filter(u=>u.username!==username);
    }catch{ alert(`Failed to delete ${username}`); }
  }
  renderClients();
}

async function updateSelectedLibraries(){
  const names = selectedClientUsernames();
  const libId = $("#clientLibrarySelect").value;
  if(!names.length || !libId) return;
  for(const username of names){
    try{
      await jpost("/admin/users/update-library", { username, clientFolderId: libId });
      const u = USERS.find(x=>x.username===username);
      if(u) u.allowedClients = libId;
    }catch{ alert(`Failed to update ${username}`); }
  }
  renderClients();
}

async function onShowPassword(e){
  const username = e.currentTarget.getAttribute("data-showpass");
  const span = $(`[data-passval="${CSS.escape(username)}"]`);
  try{
    const j = await jpost("/admin/users/reset-password", { username });
    span.textContent = j.temporaryPassword ? j.temporaryPassword : "N/A";
    e.currentTarget.textContent = "Reset again";
  }catch{
    span.textContent="Failed";
  }
}

// -------- Create accounts --------
async function createClient(){
  const username = $("#cu_username").value.trim();
  const password = $("#cu_password").value;
  const confirmPassword = $("#cu_confirm").value;
  const clientFolderId = $("#cu_client").value;
  const msg = $("#createClientMsg");
  msg.textContent = "…";
  try{
    const j = await jpost("/admin/users/create", { username, password, confirmPassword, clientFolderId, role:"client" });
    if(j?.user){
      USERS.push(j.user);
      renderClients();
      msg.textContent = "Created.";
      $("#clientForm").classList.add("hidden");
      $("#cu_username").value = $("#cu_password").value = $("#cu_confirm").value = "";
      $("#cu_client").value = "";
    }else{
      msg.textContent = j.error || "Failed.";
    }
  }catch(e){ msg.textContent = "Failed."; }
}

async function createAdmin(){
  const username = $("#au_username").value.trim();
  const password = $("#au_password").value;
  const confirmPassword = $("#au_confirm").value;
  const msg = $("#createAdminMsg");
  msg.textContent = "…";
  try{
    const j = await jpost("/admin/users/create", { username, password, confirmPassword, clientFolderId:"ALL", role:"admin" });
    if(j?.user){
      USERS.push(j.user);
      renderAdmins();
      msg.textContent = "Created.";
      $("#adminForm").classList.add("hidden");
      $("#au_username").value = $("#au_password").value = $("#au_confirm").value = "";
    }else{
      msg.textContent = j.error || "Failed.";
    }
  }catch(e){ msg.textContent = "Failed."; }
}
