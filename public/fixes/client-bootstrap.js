/**
 * JAICE client bootstrap (v2)
 * - Populates existing "Select a client library" dropdowns if present; does not create duplicates.
 * - Enables Ask box immediately for admins, even if there are no clients.
 * - When a client is chosen, posts /active-client and enables Ask/links.
 */
(function(){
  function q(sel){ return Array.from(document.querySelectorAll(sel)); }
  function byText(el){ return (el && (el.textContent || el.innerText || '')).trim(); }
  function enableAsk(){
    const input = document.querySelector('.askbox input, input[placeholder*="question"]');
    const btn   = document.querySelector('.askbox button, .asksend');
    if (input) { input.disabled = false; input.removeAttribute('disabled'); }
    if (btn)   { btn.disabled = false; btn.removeAttribute('disabled'); }
    const adminLink = document.getElementById('adminCenterLink');
    if (adminLink) { adminLink.style.pointerEvents = 'auto'; adminLink.style.opacity = '1'; }
  }
  async function getMe(){
    try { 
      const r = await fetch('/me', { credentials:'include' });
      if (!r.ok) return null;
      const p = await r.json();
      return p && p.user ? p.user : null;
    } catch { return null; }
  }
  async function getClients(){
    try{
      const r = await fetch('/clients', { credentials:'include' });
      if (!r.ok) return [];
      const p = await r.json();
      return (p && Array.isArray(p.clients)) ? p.clients : [];
    }catch{ return []; }
  }
  async function setActive(id){
    try{
      await fetch('/active-client', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ clientId: id }), credentials:'include' });
    }catch{}
  }
  function findExistingDropdowns(){
    const candidates = q('select');
    const matches = candidates.filter(sel => {
      const first = sel.options && sel.options[0] ? byText(sel.options[0]).toLowerCase() : '';
      const ph = byText(sel).toLowerCase();
      return first.includes('select a client') || ph.includes('select a client');
    });
    return matches;
  }
  function ensureSingleDropdown(dropdowns){
    if (dropdowns.length <= 1) return dropdowns;
    // Keep the first, remove duplicates added by older script versions
    for (let i = 1; i < dropdowns.length; i++){
      const d = dropdowns[i];
      if (d && d.parentElement) d.parentElement.removeChild(d);
    }
    return dropdowns.slice(0,1);
  }
  async function main(){
    const me = await getMe();
    const isAdmin = !!(me && me.role === 'admin');

    // Try to locate existing dropdown(s)
    let dropdowns = findExistingDropdowns();
    dropdowns = ensureSingleDropdown(dropdowns);

    const clients = await getClients();

    // If admin and no clients found, still enable Ask/Admin so they can proceed
    if (isAdmin && clients.length === 0){
      enableAsk();
    }

    // If we have a dropdown, populate it; otherwise, create one in #clientSelectorCorner
    let sel = dropdowns[0];
    if (!sel){
      const host = document.getElementById('clientSelectorCorner');
      if (host){
        sel = document.createElement('select');
        sel.style.padding = '6px 8px';
        sel.style.borderRadius = '6px';
        host.appendChild(sel);
      }
    }

    if (sel){
      sel.innerHTML = '<option value="">Select a client library</option>' + clients.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      sel.onchange = async () => {
        const v = sel.value;
        if (!v) return;
        await setActive(v);
        enableAsk();
      };
      // Auto-select if only one
      if (clients.length === 1){
        sel.value = clients[0].id;
        await setActive(sel.value);
        enableAsk();
      }
    } else {
      // No dropdown and no host; still enable Ask for admin (already handled) or when clients exist, pick first
      if (clients.length > 0){
        await setActive(clients[0].id);
        enableAsk();
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', main);
  else main();
})();
