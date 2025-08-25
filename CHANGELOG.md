# CHANGELOG

**Date:** 2025-08-24 00:24:08

## Overview
This update implements:
- Three‑dot overflow menus on every response card with actions: Add to Report, Remove from Response, Add More Detail, Simplify.
- Report creation/management (localStorage + backend persistence) and an **Active Report** footer bar.
- Report CRUD API: `/api/reports` (list/create/read/update/delete) and item endpoints.
- Drag‑and‑drop ordering in `reports.html` with export to Markdown (print to PDF via browser).
- Telemetry endpoint (`/api/telemetry`) – best‑effort, non‑blocking.
- Search improvements: `DEFAULT_TOPK=50` end‑to‑end; robust manifest filtering with a safety fallback; optional `SKIP_MANIFEST_FILTER`.
- Theme generation: removed hard cap of 3–4; up to `MAX_THEMES` (default 50) with de‑duplication.
- Accessibility: menus have ARIA roles; toasts are `aria-live=polite`.
- Minor UI fixes: menu z-index; favicon; styles.

## Notable File Size Changes
- `server.js` grew due to new endpoints and search logic.
- `app.js` grew due to menu/report utilities.
- `styles.css` gained a small block for menu/report styling.

