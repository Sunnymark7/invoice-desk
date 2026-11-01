# Interface review status

final result: blocked

The user explicitly requested no further tests or interface verification and will test the app personally. The final hover magnifier and removal of reorder buttons have not been visually verified. Packaging is not a substitute for runtime verification.

Visual references supplied in this chat:
- Empty import state: codex-clipboard-a0bcde86-7f1e-44c5-a9cc-75b4cb5c2ce1.png.
- Imported cards and side add button: codex-clipboard-94a6d562-21b4-42f7-979c-67087fc4a407.png.
- Controls to remove: codex-clipboard-7cb3b5be-cf6c-4351-8af6-ce528320c498.png.

Intentional adaptations: blue-green theme, local file input, invoice-specific fields, date/company sorting, one-row icon toolbar, header exports, multiple selection, and hover magnifier.

No external publication or remote Git push is authorized.

Latest change: free card drag preview and animated insertion gaps. No tests or UI verification were performed after this change, as explicitly requested.

Final follow-ups: conditional checkboxes, read-only sequence markers, hidden card page counts and invoice numbers, hover-copy total, and automatic date sorting on import. All remain untested at the user's request.

2026-11-01 follow-ups: consolidated the preview title into the filename in the review sidebar; moved an editable page position between zoom and rotation; enlarged previous/next controls; buffered page rendering and adjusted wheel navigation; added manual-confirmation thumbnail badges; emphasized selection tools on the left; remembered card scale independently of invoice drafts; put grid dates and companies on one line; removed the detail-count hint and the empty selection strip. No tests or UI verification were run. Web and packaged Tauri behavior remain for the user to verify separately.

Added a selection-toolbar action to merge only selected records into a PDF using the current export order, preserving retained pages and attachments. It shares the existing browser/native save path; missing selected pages are reported before export. No tests or UI verification were run, as requested.

Added three independent right-rail toggles for card filenames, company names and invoice dates in both layouts. Hidden states are saved immediately as local preferences and restored independently of drafts. Review warnings remain visible even when all three fields are hidden. No tests or UI verification were run, as requested.

The field toggles use circular buttons and three distinct hand-authored SVG line icons (document title, company building, calendar), with hover labels and diagonal slashes for hidden fields.

Extended thumbnail delete controls with a transparent pseudo-element 10px beyond each edge, keeping their visible size, icons, position and hover appearance. Touch targeting remains unverified under the user's no-test/no-UI-verification instruction.

Moved the scale control to the end of the right tool rail, below all three visibility buttons, including keyboard order. Reduced both expanded morph endpoints from 24px to 16px with transparent hit padding. No tests or UI verification were run, as requested.

Replaced the scale button's expand-arrow icon with a custom SVG vertical ruler, matching the other controls' line weight and color. No tests or UI verification were run.

Aligned the ruler axis, endpoints and a separate visual thumb; the native transparent range retains keyboard/pointer behavior and maps its 142px center travel to the tick positions. Added centered thumb enlargement on hover, drag and keyboard focus. Search now morphs left from its fixed 12px rounded rectangular button into a field with the same radius, with outside-click, focus and Escape dismissal. Unified control radii through tokens (12px controls, 16px groups, 4px insets, circular right-rail tools) and aligned toolbar heights. Based on the supplied screenshots; no tests or runtime UI verification were run.
