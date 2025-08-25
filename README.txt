JAICE Admin Page Update (Header Reuse)

Files included (drop-in):
- views/partials/header.ejs   <-- Shared header (matches Home/Reports; includes logo, beta, nav, user, library select, kebab)
- views/admin.ejs             <-- Admin page template that includes the shared header
- public/admin.css            <-- Page-scoped styles for Admin content (no header styles)
- public/admin.js             <-- Admin page logic (stats, libraries, accounts, activity)

How to install:
1) Copy `views/partials/header.ejs` and `views/admin.ejs` into your templates directory.
   If you already have a Home/Reports header partial, paste that exact markup into `views/partials/header.ejs` or point the include to your existing file.

2) Ensure the `/admin` route renders `admin` with locals:
     res.render('admin', { active:'admin', currentUser: req.user });

3) Put `public/admin.css` and `public/admin.js` in your static folder (rooted at `/`).

4) Confirm your endpoints exist:
   - GET /api/admin/stats
   - GET /api/libraries
   - GET /api/libraries/:id/stats
   - GET /api/clients
   - GET /api/admin/users
   - GET /api/admin/activity?window=today
