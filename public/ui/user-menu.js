// Lightweight user menu (conflict-safe)
// Renders ONLY on pages that do NOT already include a native profile control (#profileBtn).
(async () => {
  try {
    // Skip if page already has a header profile/menu
    if (document.querySelector('#profileBtn') || document.querySelector('.header .profile')) return;

    const res = await fetch('/me', { credentials: 'include' });
    if (!res.ok) return;
    const data = await res.json();
    if (!data || !data.user) return;

    const user = data.user;
    const role = (user.role || '').toLowerCase(); // 'admin' already if internal is mapped server-side

    // Container
    const wrap = document.createElement('div');
    wrap.style.position = 'fixed';
    wrap.style.top = '12px';
    wrap.style.right = '12px';
    wrap.style.zIndex = '10'; // lower than page header which usually uses >100
    wrap.style.fontFamily = 'Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';

    // Pill
    const pill = document.createElement('div');
    pill.style.display = 'flex';
    pill.style.alignItems = 'center';
    pill.style.gap = '8px';
    pill.style.padding = '6px 10px';
    pill.style.border = '1px solid #e5e7eb';
    pill.style.borderRadius = '999px';
    pill.style.background = '#fff';
    pill.style.boxShadow = '0 2px 8px rgba(0,0,0,.05)';
    pill.style.fontSize = '12px';
    pill.style.color = '#4b5563';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = user.username;

    const sep = document.createElement('span');
    sep.textContent = '•';

    const roleSpan = document.createElement('span');
    roleSpan.textContent = role || '';

    // Menu button
    const btn = document.createElement('button');
    btn.setAttribute('type', 'button');
    btn.setAttribute('aria-label', 'Open user menu');
    btn.style.border = '0';
    btn.style.background = 'transparent';
    btn.style.cursor = 'pointer';
    btn.style.padding = '0 2px';
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.75"/><circle cx="12" cy="12" r="1.75"/><circle cx="19" cy="12" r="1.75"/></svg>';

    // Dropdown
    const menu = document.createElement('div');
    menu.style.position = 'absolute';
    menu.style.top = '36px';
    menu.style.right = '0';
    menu.style.minWidth = '180px';
    menu.style.background = '#fff';
    menu.style.border = '1px solid #e5e7eb';
    menu.style.borderRadius = '12px';
    menu.style.boxShadow = '0 12px 28px rgba(0,0,0,.12)';
    menu.style.padding = '6px';
    menu.style.display = 'none';

    function addItem(label, onClick, href) {
      const el = href ? document.createElement('a') : document.createElement('button');
      if (href) {
        el.href = href;
      } else {
        el.type = 'button';
        el.addEventListener('click', onClick);
      }
      el.style.display = 'block';
      el.style.width = '100%';
      el.style.textAlign = 'left';
      el.style.padding = '8px 10px';
      el.style.borderRadius = '8px';
      el.style.border = '0';
      el.style.background = 'transparent';
      el.style.cursor = 'pointer';
      el.style.fontSize = '13px';
      el.style.color = '#111827';
      el.onmouseenter = () => { el.style.background = '#f3f4f6'; };
      el.onmouseleave = () => { el.style.background = 'transparent'; };
      el.textContent = label;
      menu.appendChild(el);
      return el;
    }

    if (role === 'admin') {
      addItem('Admin Center', null, '/admin');
    }
    addItem('Sign Out', async () => {
      try { await fetch('/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
      window.location.href = '/login.html';
    });

    // Toggle menu visibility
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', () => { menu.style.display = 'none'; });

    // Assemble
    pill.appendChild(nameSpan);
    if (role) {
      pill.appendChild(sep);
      pill.appendChild(roleSpan);
    }
    pill.appendChild(btn);
    pill.appendChild(menu);
    wrap.appendChild(pill);
    document.body.appendChild(wrap);
  } catch (err) {
    // silent fail
    console.warn('user-menu (safe) failed', err);
  }
})();