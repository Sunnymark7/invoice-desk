# Local development policy

- Work directly in this checkout and make local Git commits at completed milestones.
- On 2026-11-01 the user explicitly authorized publishing this project to Sunnymark7/invoice-desk main and GitHub Pages. Other remotes, release uploads and Sites publication remain outside scope. Never upload private invoices or local drafts.
- Keep the local pre-push guard enabled, scoped to the authorized repository and main branch.
- Keep invoice recognition, manual review, page order, totals, draft recovery, and export consistent.
- Verify web behavior and packaged Tauri behavior separately. Never treat compilation as proof that the desktop UI or native save dialog works.
- Do not commit private invoices, generated exports, dependency directories, or build products.

- On 2026-11-01 the user allowed local invoice-recognition regression checks. Run relevant local recognition and invoice-integrity checks; never upload their private source files. Runtime UI verification remains for the user. Local compilation, packaging and Git commits are authorized.
