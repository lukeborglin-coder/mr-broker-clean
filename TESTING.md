# TESTING

## A. Menus on Response Cards
1. Run a search.
2. Confirm ⋯ menu appears on main answer and each supporting card.
3. Keyboard: Tab to a card → Enter on ⋯ → Up/Down to navigate → Esc to close.

## B. Add to Report
1. Select text inside a card and choose **Add to Report** → item count increases in the footer bar.
2. Without selection, the full card text is added.
3. Open Reports page → items are present. Drag to reorder → refresh; order persists.

## C. Dismiss/Restore
1. Choose **Remove from Response** → card hides (soft delete).
2. Toggle your own show/hide logic if you expose a “Show dismissed” switch; cards marked `is-dismissed` should stay hidden by default.

## D. Export
1. Reports page → **Export MD** → downloads a `.md` file.
2. Use the browser Print dialog on `reports.html` to save a clean PDF.

## E. Backend API (happy path)
- `GET /api/reports` → `{ ok:true, data:[...] }`
- `POST /api/reports { title }` → `{ ok:true, data:{...} }`
- `POST /api/reports/:id/items { items:[...] }` → appends.
- `PUT /api/reports/:id/items/reorder { itemIds:[...] }` → order changes.
- All responses have `{ ok, data|error }` shape.

## F. Search Behavior
- With `SKIP_MANIFEST_FILTER=true`, results ignore manifest filter (useful while ingest is incomplete).
- Threshold fallback uses `topK` (50) instead of hard-coded 3.
- Theme list can exceed 4; duplicates are removed by title + reference-overlap.

