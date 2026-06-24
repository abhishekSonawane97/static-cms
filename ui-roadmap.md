# cms-static — UI Enhancement Roadmap

A living document. Tracks every layout / styling improvement we plan, the rationale, the
exact files touched, and the status. Functionality is **out of scope** for this file —
nothing in this roadmap should change an API endpoint, a save behaviour, or a data shape.

---

## How to use this file

- Open it any time we want to plan, pick up, or ship a UI change.
- Each enhancement has a **status** (`☐ planned`, `▶ in progress`, `☑ shipped`, `✖ rejected`).
- Update the status inline when an item is started or shipped.
- Add new items to the bottom of the relevant tier (don't reorder shipped ones).
- After each ship, append a one-line entry under [§9 Done log](#9-done-log).

When in doubt, prefer **calmer hierarchy and fewer words** over more features.

Companion docs:
- [README.md](README.md) — how to use it
- [design-flow.md](design-flow.md) — how it works internally

---

## 1 · Why this exists

Two user-stated goals:

1. **Sidebar should be collapsible** so the user can give the live preview the whole viewport when they want.
2. **Non-technical user should feel at home** — currently it reads as a developer tool with mono labels and selector strings.

Plus a third one we (the maintainers) care about:

3. The UI should age well — generous spacing, calm typography, room to grow more groups without panic.

---

## 2 · Current UI snapshot (May 6, 2026)

Verified against a live screenshot of the editor on the Akasa Dalhousie homepage. Key observations:

| Area | State today | Pain |
|---|---|---|
| Sidebar | Fixed 380 px, no collapse, no resize | Can't see the preview at full width |
| Page picker | Shows breadcrumb labels in `<optgroup>` ✓ | None — recently fixed |
| Git panel | All controls shown at once: pills, remote, auto-commit, commit form, push, log | Dense; "1 ahead", "2 uncommitted" are dev terms |
| SEO group | Plain labels ("Page title", "Meta description", "OG image") ✓ | Already fine |
| Schema group | Labels are JSON paths ("name", "address.streetAddress") | Readable but technical; could be friendlier |
| Headings group | Mono labels with selector path: `hero-content — h1 · "…"` | Dev-y |
| Body text group | Same selector-style labels | Dev-y |
| Images | URL + Alt + 3 buttons (Replace/Crop/Reset) ✓ | Already good after the v1.2 redesign |
| Save button | Bottom-left, primary green, disabled when clean | OK but no count, no shortcut hint |
| Status bar | Right-aligned muted text — easy to miss | Wins/losses (Saved ✓ / errors) under-visible |
| Empty state | "Pick a page above to start editing." | Sterile, no welcome |
| First-time UX | Onboarding modal pops on no-repo state | Good for Git, nothing for the editor itself |
| Keyboard hints | Cmd+S works | Hidden — users don't know |

---

## 3 · Goals & non-goals

**Goals**

- Reduce visual density.
- Replace developer terminology with plain English where it doesn't hurt accuracy.
- Give the user a way to hide the editor (sidebar) when they want full preview.
- Keep the developer experience intact (selectors etc. still accessible on hover).
- Persist user preferences (sidebar width, collapse state, dismissed tips) across sessions.

**Non-goals**

- Adding new edit capabilities.
- Changing API contracts.
- Theme switching (dark mode etc.) — out of scope.
- Mobile-responsive design — desktop-first; the tool is for laptops.

---

## 4 · Inspirations

Cherry-pick from these. We are not cloning any of them.

| CMS / app | What we borrow |
|---|---|
| Sanity Studio | Group titles in semibold sentence-case; resizable right rail |
| Tina CMS | Big readable inputs; subtle peach-on-edit; auto-saving feedback |
| CloudCannon | Layperson copy ("Hero photo" not `hero-img.jpg`); contextual help text |
| Webflow CMS | Two-pane with collapse-to-rail at 32–40 px |
| Notion | Hover-reveal actions; minimal chrome; ESC-to-close |
| Stripe Dashboard | Status pills with semantic color; toast-based success/error; loading skeletons |
| Linear | Keyboard hints displayed inline (`⌘S`, `⌘B`) |
| VS Code | Sidebar chevron toggle; left-rail mode at 40 px |

---

## 5 · Tiered enhancement list (the tracker)

Each item is independently shippable. Within a tier they're ordered by impact. Status legend:

```
☐ planned     ▶ in progress     ☑ shipped     ✖ rejected
```

### 5.1 — Tier A: the two stated goals

#### A1. Collapsible sidebar with chevron toggle

**Status**: ☑ shipped (2026-05-06)

**Why**: User explicitly asked. Lets them give the preview the full viewport.

**Behaviour (no functionality change)**:
- Default: 380 px wide (today's width).
- Collapsed: a 32 px-wide rail showing only a `⤴︎` chevron button.
- Click to toggle. `Cmd/Ctrl + B` shortcut.
- 200 ms width transition (CSS transform/grid-template-columns).
- State persisted in `localStorage` under `cms-static.sidebar.collapsed`.

**Files touched**:
- `src/editor/index.html` — add the rail markup with the chevron button.
- `src/editor/editor.css` — collapse-aware grid-template-columns; transitions.
- `src/editor/editor.js` — toggle handler + keyboard shortcut + localStorage persistence.

**Estimated lines**: 40 total.

---

#### A2. Resizable sidebar (drag handle)

**Status**: ☑ shipped (2026-05-06)

**Why**: Some users prefer wider sidebars (350 fields visible at once); others narrower.

**Behaviour**:
- Vertical "drag handle" at the right edge of the sidebar (4 px wide, hover increases hit area).
- Drag clamps to 300 – 600 px.
- Width persisted under `cms-static.sidebar.width`.
- When collapsed (A1), drag handle is hidden.

**Files touched**:
- `src/editor/index.html` — add `<div class="sidebar-resizer">`.
- `src/editor/editor.css` — handle styling, hover + active states.
- `src/editor/editor.js` — pointer-down/move/up handlers, persistence.

**Estimated lines**: 30.

---

#### A3. Friendlier group names

**Status**: ☑ shipped (2026-05-06)

**Why**: User-facing labels read like a developer report. Rename in `extractor.js` only.

**Mapping (proposed)**:
| Today | Tomorrow |
|---|---|
| `SEO` | `Page details (SEO)` |
| `Schema (LodgingBusiness)` | `Business info` |
| `Schema (Hotel)` | `Hotel info` |
| `Schema (<Other>)` | `Schema — <Other>` (kept dev-y for unknown types) |
| `Headings` | `Headings` |
| `Body text` | `Page content` |
| `Images` | `Photos` |

If someone wants to override, they can edit the strings — no behavioural change.

**Files touched**:
- `src/extractor.js` — change a handful of literal strings inside the existing field-push calls.

**Estimated lines**: 10.

---

#### A4. Friendlier field labels for Headings + Body text

**Status**: ☑ shipped (2026-05-06)

**Why**: `hero-content — h1 · "Close to The Mall…"` is the most dev-y thing in the UI. Replace with a simple semantic label + a value preview.

**Behaviour**:
- Renderer (in `editor.js`, **not** the extractor — the extractor still produces the long label) transforms the field display:
  - Label line: `Heading` (or `Subheading`, `Paragraph`, depending on tag)
  - Below the input: subtle 11 px muted text showing first 80 chars of the current value as a hint
  - The full selector path moves to the input's `title=` attribute (still discoverable on hover for devs)
- Tag → friendly label map:
  - `h1` → `Heading 1`
  - `h2` → `Heading 2`
  - `h3` → `Heading 3`
  - `h4` → `Heading 4`
  - `p` → `Paragraph`
  - `li` → `List item`
  - `blockquote` → `Quote`
  - `figcaption` → `Caption`
  - `dt` → `Term`
  - `dd` → `Description`

For disambiguation when there are several `Heading 2`s, the section context (`hero-content`, `story`) is still useful — keep it but **lighten** it: small text below the input, not in the label.

**Files touched**:
- `src/editor/editor.js` — `renderField()` for `longtext`, label transformation logic.
- `src/editor/editor.css` — small-muted styling for the section-context line.

**Estimated lines**: 30.

---

### 5.2 — Tier B: visual hierarchy & breathing room

#### B1. Sticky header (page picker stays visible while scrolling)

**Status**: ☑ shipped (2026-05-06)

**Why**: With 175 fields on a single page, the picker scrolls out of view. Sticky keeps navigation accessible.

**Files touched**: `src/editor/editor.css` (`position: sticky` + `top: 0` + `z-index`).

**Estimated lines**: 8.

---

#### B2. Bigger, calmer inputs

**Status**: ☑ shipped (2026-05-06)

**Why**: Today's inputs are 12-13 px font, 7-8 px padding. Cramped at 100 % zoom. Bumping to 14 px font and 10-12 px padding feels markedly more relaxed without losing density.

**Behaviour**:
- All `input[type=text]` and `textarea` inside `.field`: padding `10px 12px`, font-size `14px`, line-height `1.5`.
- Min-height for textareas raised from 56 px → 72 px (3 lines visible).
- Mono label font drops to 12 px (was 11) for legibility.

**Files touched**: `src/editor/editor.css` (`.field input`, `.field textarea`, `.field label`).

**Estimated lines**: 25.

---

#### B3. Card-style field rows with hover state

**Status**: ☑ shipped (2026-05-06)

**Why**: Field rows currently sit in a flat list. A subtle card outline + hover background helps the eye find structure.

**Behaviour**:
- Each `.field` gets `padding: 12px 14px`, `border-radius: 8px`, no background.
- On `:hover`, faint background (`var(--bg-alt)` at 50 % opacity).
- Dirty fields keep the peach left-border accent (today's behaviour) **plus** a slightly stronger background.

**Files touched**: `src/editor/editor.css`.

**Estimated lines**: 20.

---

#### B4. Larger image thumbnails

**Status**: ☑ shipped (2026-05-06)

**Why**: 64 × 64 thumbnails are too small to recognise content; 80 × 80 doubles visible pixels.

**Behaviour**:
- `.img-row .thumb { width: 80px; height: 80px; }`
- Hover pops to 96 × 96 with a 200 ms transform (no layout shift; uses `transform: scale`).

**Files touched**: `src/editor/editor.css`.

**Estimated lines**: 12.

---

#### B5. Reorder field groups by edit-frequency

**Status**: ☑ shipped (2026-05-06)

**Why**: Users edit body content 10× as often as JSON-LD schema. Lead with what's most-touched.

**Proposed order** (top → bottom):
1. Headings
2. Page content (was Body text)
3. Photos (was Images)
4. Page details (SEO)
5. Business info (was Schema)

**Files touched**: `src/editor/editor.js` — sort the rendered groups in `renderFields()` using a fixed group-order array.

**Estimated lines**: 12.

---

### 5.3 — Tier C: friendlier first-run

#### C1. Empty-state welcome card

**Status**: ☑ shipped (2026-05-06)

**Why**: When no page is selected, today's "Pick a page above to start editing" is sterile. Replace with a soft-coloured card.

**Mock**:
```
┌─────────────────────────────────────────┐
│              👋  Welcome                 │
│                                          │
│   ↑  Pick a page above to begin.        │
│                                          │
│   Edit any field on the left, hit Save  │
│   when you're done. Your changes only   │
│   go live after Save.                   │
└─────────────────────────────────────────┘
```

**Files touched**: `src/editor/editor.js` (`loadPage(null)` branch); `src/editor/editor.css`.

**Estimated lines**: 30.

---

#### C2. First-visit toast tip

**Status**: ☑ shipped (2026-05-06)

**Why**: A 3-line tip the very first time the editor opens. Dismissible. Persisted under `cms-static.tip.dismissed`.

**Content**:
> 👋 Tip: edits live in the sidebar. The preview updates after Save.
> Press `?` for keyboard shortcuts.

**Files touched**: `src/editor/editor.js`, `src/editor/editor.css`.

**Estimated lines**: 30.

---

#### C3. Keyboard shortcuts cheat-sheet (`?`)

**Status**: ☑ shipped (2026-05-06)

**Why**: Discoverability for `Cmd+S`, `Cmd+B`, `Esc`, etc.

**Behaviour**:
- Pressing `?` opens a small modal listing shortcuts:
  - `⌘ S` — Save
  - `⌘ B` — Toggle sidebar
  - `Esc` — Close modal
  - `?` — Show this list
- Shows a tiny `?` button bottom-right of the sidebar (icon-only).

**Files touched**: `src/editor/index.html`, `editor.js`, `editor.css`.

**Estimated lines**: 60.

---

#### C4. Save success animation

**Status**: ☑ shipped (2026-05-06)

**Why**: Today's "Saved ✓" is a tiny mono string in the corner. Easy to miss. Brief green pulse + checkmark on the Save button is the industry-standard signal.

**Behaviour**:
- On save success, Save button background pulses to `var(--accent)` for 600 ms with the label flipping to `✓ Saved` then back to its idle text.
- Reduced motion: skip the pulse, just flip the label briefly.

**Files touched**: `editor.js`, `editor.css`.

**Estimated lines**: 25.

---

### 5.4 — Tier D: status & feedback

#### D1. Toast-based status messages

**Status**: ☑ shipped (2026-05-06)

**Why**: Replace the muted right-aligned `#statusBar` with bottom-right toasts. Toasts auto-dismiss; semantic color (success / error / info).

**Behaviour**:
- Stack of toasts at bottom-right of the viewport (above floating buttons).
- Three variants: `info` (blue), `success` (green), `error` (red).
- Each toast: 3 s auto-dismiss; click `×` to dismiss earlier; keyboard `Esc` dismisses the most recent.
- The status bar in the sidebar footer is removed (or kept very small as a "● unsaved" badge only).

**Files touched**: `src/editor/index.html` (toast container), `editor.css`, `editor.js` (`setStatus` becomes `toast(msg, kind)`).

**Estimated lines**: 70.

---

#### D2. Save-button: pending-count + shortcut hint

**Status**: ☑ shipped (2026-05-06)

**Why**: Today's Save button just says `💾 Save` whether 1 or 50 fields changed. A count gives confidence.

**Behaviour**:
- Idle: `Save` (disabled).
- Dirty: `Save 3 changes` (enabled).
- Saving: `Saving…` (disabled, with subtle spinner).
- Saved (briefly): `✓ Saved`.
- Right side of the button: tiny kbd badge `⌘ S`.

**Files touched**: `editor.js` (`refreshSaveBtn`); `editor.css` (kbd badge).

**Estimated lines**: 25.

---

#### D3. Loading skeletons for fields

**Status**: ☑ shipped (2026-05-06)

**Why**: While `/api/fields` is loading (small flash on page switch), today shows the literal text "Loading fields…". Skeletons feel snappier.

**Behaviour**:
- Render 6 placeholder skeleton rows: each = a label line + a blank input box, animated shimmer.
- Replace with real fields when fetched.

**Files touched**: `editor.js`, `editor.css`.

**Estimated lines**: 30.

---

### 5.5 — Tier E: Git panel polish

#### E1. Compact mode by default

**Status**: ☑ shipped (2026-05-06)

**Why**: Git panel currently shows everything always — pills, remote, auto-commit, commit form, push, log. That's a wall.

**Behaviour**:
- Default-collapsed details:
  - Always visible: branch, dirty count, ahead/behind, **Commit** button (inline message), **Push** button.
  - Click "▾ More" to reveal: auto-commit toggle, remote URL display, recent log.
- Persist expanded state under `cms-static.git.expanded`.

**Files touched**: `git-panel.js`, `editor.css`.

**Estimated lines**: 50.

---

#### E2. Plain-English Git pill labels

**Status**: ☑ shipped (2026-05-06)

**Why**: `1 ahead` / `2 uncommitted` are Git terminology. Friendlier alternatives:

| Today | Tomorrow |
|---|---|
| `● 2 uncommitted` | `2 unsaved files` |
| `↑ 3 ahead` | `3 ready to push` |
| `↓ 1 behind` | `1 update from team` |
| `✓ clean` | `Up to date` |

**Files touched**: `git-panel.js`.

**Estimated lines**: 10.

---

#### E3. Git button labels — verb-first

**Status**: ☑ shipped (2026-05-06)

**Why**: `Commit` and `↑ Push` are verbs but lose intent. Stronger:

| Today | Tomorrow |
|---|---|
| `Commit` | `Save to history` |
| `↑ Push` | `Send to GitHub` (or `to Bitbucket`, depending on remote URL) |

The remote-host detection looks at the origin URL: `github.com` → "GitHub", `bitbucket.org` → "Bitbucket", `gitlab.com` → "GitLab", else "Send to remote".

**Files touched**: `git-panel.js`.

**Estimated lines**: 25.

---

### 5.6 — Tier F: micro-polish (do last; do as a batch)

#### F1. Sticky Save bar with shadow on scroll

**Status**: ☑ shipped (2026-05-06)

**Why**: When the field list is long, the user has to scroll all the way down to find Save. Make the footer sticky with a subtle top-shadow when content scrolls under it.

**Files**: `editor.css`.

**Estimated lines**: 12.

---

#### F2. Page picker heading: file-icon + breadcrumb in segment-style

**Status**: ✖ rejected (2026-05-06) — native `<select>` doesn't allow per-segment styling, and the existing `›` separator inside option labels already reads cleanly. Revisit only if we replace the picker with a custom dropdown component.

**Why**: `Akasa Dalhousie › Offers › Honeymoon Special` reads like text. Render each `›` as a real chevron and apply slight tonal weight differences:

```
[Akasa Dalhousie]  ›  [Offers]  ›  [Honeymoon Special]
   muted              muted        bold
```

**Files**: `editor.css` (CSS-only via `::after` selectors on segments split by JS).

**Estimated lines**: 25.

---

#### F3. Better dirty-state visual: left accent border on the field

**Status**: ☑ shipped (2026-05-06)

**Why**: Currently dirty fields tint peach. Add a 3 px left border in `var(--warn)` for stronger glanceability when scrolling.

**Files**: `editor.css`.

**Estimated lines**: 6.

---

#### F4. Reduce width of mono label font; align by baseline

**Status**: ☑ shipped (2026-05-06)

**Why**: Tiny typographic touch — labels are `ui-monospace 11px`. Bump to `12px` and align baselines with inputs more carefully.

**Files**: `editor.css`.

**Estimated lines**: 8.

---

#### F5. Improve focus ring contrast

**Status**: ☑ shipped (2026-05-06)

**Why**: Current focus `box-shadow: 0 0 0 2px rgba(31,77,63,.15)` is faint. Bump alpha to .22 for a3 contrast pass.

**Files**: `editor.css`.

**Estimated lines**: 4.

---

### 5.7 — Tier G: editorial actions

#### G1. Clone section

**Status**: ☑ shipped (2026-05-07)

**Why**: Lets the user duplicate a `<section>` (e.g. an offer card, a room block) without hand-editing HTML. Common ask once a hotel publishes more rooms / offers.

**Behaviour**:
- New "Sections" group at the top of the sidebar lists every `<section>` direct child of `<main>` with a 📋 Clone button.
- Clicking Clone calls `POST /__cms/api/clone-section` with `{ page, selector }`.
- Server deep-clones the subtree via cheerio, derives a stem (id with trailing `-copy[-N]` stripped → first non-modifier class → "section"), picks the first available `<stem>-copy[-N]` not in use, rewrites inner ids + `aria-*` + `<label for>` + anchor `href="#…"` + `<use href="#…">` whose targets are inside the clone, and inserts the clone immediately after the original.
- Refuses if the user has unsaved field edits (toast: "Save your edits before cloning…").
- Out of scope for v1: delete, reorder, rename, cross-page clone, non-section blocks.

**Files touched**:
- `src/cloner.js` (new) — pure cheerio module: stem derivation, suffix selection, deep clone, ID/ARIA rewriting.
- `src/extractor.js` — new `extractSections(html)` helper used by `/api/fields`.
- `src/server.js` — new route `POST /__cms/api/clone-section`; section list added to `/api/fields` response.
- `src/editor/editor.js` — `renderSectionsGroup()`, `wireSectionEvents()`, `cloneSectionUI()`.
- `src/editor/editor.css` — Sections-group + section-row styles.

**Verified by**: 4 successive clones on `#story` produced `story-copy`, `story-copy-2`, `story-copy-3`, `story-copy-4` — collision-safe across cloning a clone (stem-strip rule). Inner-id rewrite confirmed on `#book` (`enqName` → `enqName-copy`, `for="enqName"` → `for="enqName-copy"`).

---

#### G2. Delete section

**Status**: ☑ shipped (2026-05-07)

**Why**: Common ask after Clone — "I duplicated this offer card; now let me delete the placeholder I no longer need." Pairs naturally with Undo (G4).

**Behaviour**:
- 🗑 button on every section row.
- Clicking opens `window.confirm("Delete <id-or-label>?")`. On confirm, the section is removed from disk (the file is rewritten via cheerio + js-beautify).
- Refuses if there are unsaved field edits (toast).
- Pushes the pre-deletion HTML onto the per-page history stack so Undo can restore.
- Success toast: "Deleted #book-copy".

**Files**:
- `src/section-ops.js` (new) — `deleteSection(html, selector)`.
- `src/server.js` — `POST /__cms/api/delete-section`.
- `src/editor/editor.js` — `🗑` button in `.section-row` + `sectionAction('delete', …)` dispatcher.
- `src/editor/editor.css` — `.delete-section-btn:hover` red tint.

**Verified by**: smoke test `5)` (delete #book-copy → removedId=book-copy on disk, then Undo restores it).

---

#### G3. Reorder sections (move up / down)

**Status**: ☑ shipped (2026-05-07)

**Why**: Lets the user reshuffle sections without hand-editing source. Especially useful after Clone — the new section appears immediately after the original; `▼` walks it down to wherever it should land.

**Behaviour**:
- ▲ + ▼ buttons on every section row.
- ▲ disabled on the first row; ▼ disabled on the last (defensively re-validated server-side).
- Refuses if there are unsaved field edits.
- Pushes pre-move HTML onto history stack; Undo restores the previous order.
- Success toast: "Moved up · #stay" / "Moved down · #book".

**Files**:
- `src/section-ops.js` — `moveSection(html, selector, direction)`.
- `src/server.js` — `POST /__cms/api/move-section`.
- `src/editor/editor.js` — `▲` / `▼` buttons in `.section-actions`.
- `src/editor/editor.css` — `.icon-btn` shared icon-button style.

**Verified by**: smoke test `2)` (move #stay up); edge case `10)` (moving the first section up errors cleanly: "No section to move up of: …").

---

#### G4. Undo (per-page history stack)

**Status**: ☑ shipped (2026-05-07)

**Why**: Reversibility for clone / delete / move without round-tripping through Git. One-click safety net.

**Behaviour**:
- New `↩ Undo` button at the top of the Sections group (in a small toolbar above the section rows).
- Disabled when this page has no history.
- Clicking it pops the most recent action's pre-state and writes it to disk.
- Stack: in-memory, per-page, capped at 10. Cleared on server restart (Git is the durable backup).
- LIFO: clone → move → delete + undo undo undo replays in delete → move → clone reverse order.

**Files**:
- `src/section-ops.js` — `pushHistory(page, html, action)`, `popHistory(page)`, `historyDepth(page)`.
- `src/server.js` — every clone/delete/move route now calls `pushHistory()` before writing; new `POST /__cms/api/undo` and `GET /__cms/api/undo-state?page=…`; clone/delete/move/undo responses include `undoAvailable` so the button toggles in real time.
- `src/editor/editor.js` — `state.undoAvailable` boolean; `.undo-btn` rendered in the Sections-group toolbar; `sectionAction('undo')` dispatcher; pulled fresh on `loadPage()` via the new state endpoint.
- `src/editor/editor.css` — `.sections-toolbar`, `.undo-btn:hover` accent green.

**Verified by**: smoke test `4) Undo × 3` walks the stack down: `delete → move-up → clone`, undoAvailable flips to false at the bottom; `9)` confirms attempting Undo on an empty stack returns `"nothing to undo for this page"` cleanly.

---

#### G5. Form-cloning warning

**Status**: ☑ shipped (2026-05-07)

**Why**: Cloning a section containing a `<form>` works structurally (HTML stays valid, IDs are suffixed) but the cloned form is functionally **dead** — JS keyed off the original id (`e("#enquiryForm")` etc.) won't bind to the clone. Per user direction we explicitly accept this; the trade-off is surfaced via a dedicated toast so users aren't surprised later.

**Behaviour**:
- Clone-section response includes `formInside: true` when the cloned subtree contains any `<form>`.
- Frontend shows a follow-up `info` toast immediately after the success toast: *"Note: the cloned section contains a form — JS hooks won't fire on the copy until rewired."*

**Files**:
- `src/section-ops.js` — `subtreeContainsForm(html, selector)`.
- `src/server.js` — clone-section route adds `formInside` to the response.
- `src/editor/editor.js` — extra `info` toast in `sectionAction('clone', …)` when `j.formInside` is true.

**Verified by**: smoke test `1)` cloning `#book` (which contains `<form id="enquiryForm">`) returns `formInside: true`.

---

### 5.8 — Tier H: AI chat agent (Gemini 2.5 Flash)

#### H1. Chat panel + ✨ AI button

**Status**: ☑ shipped (2026-05-10)

**Why**: One natural-language entry point for the user to drive the existing edit/clone/delete/move/undo tooling without thinking in terms of fields and selectors. Keeps the surface area honest — the agent calls the same `/__cms/api/*` routes the buttons do.

**Behaviour**:
- ✨ AI button in the sidebar footer (gradient, distinct from the standard buttons).
- Click opens a slide-up chat panel (55 % of sidebar height) with a scope dropdown, message list, and textarea + Send.
- Esc closes (when the input isn't focused). Switching pages clears the chat and resets the scope.
- A `aiKeyDialog` collects the user's Gemini API key on first open. Stored in `localStorage` (Remember) or `sessionStorage`. Never sent to the cms-static server.

**Files**:
- `src/editor/index.html` — `.ai-fab`, `#chatPanel`, `#aiKeyDialog`.
- `src/editor/editor.css` — `.ai-fab`, `.chat-panel`, `.chat-bubble.*`, `.ai-key-dialog`.
- `src/editor/ai.js` (new) — single-file IIFE; exposes `window.cmsAI`.

---

#### H2. Three scopes + per-turn context manifest

**Status**: ☑ shipped (2026-05-10)

**Why**: A whole-page prompt is too large and noisy; a section prompt is the sweet spot. Surfacing the scope to the user keeps them in control of what the AI sees.

**Behaviour**:
- Dropdown offers `Page metadata`, every `<section>` on the current page, and `Whole page (overview)`.
- Defaults to the first section on page open.
- The manifest is rebuilt fresh from `/__cms/api/fields` each turn — the AI never operates on a stale snapshot.
- The system prompt includes the scope label, the manifest, and a tight refusal policy for out-of-scope asks (translation, image generation, fetching external data).

---

#### H3. Tool whitelist + agent loop

**Status**: ☑ shipped (2026-05-10)

**Why**: The AI should only do what the buttons can do. Anything else is rejected at the dispatcher (defence in depth — system prompt asks; whitelist enforces).

**Behaviour**:
- 10 tools: `list_pages`, `read_page_fields`, `read_section`, `update_field`, `clone_section`, `delete_section`, `move_section`, `undo`, `lookup_field_id`, `find_text`.
- Read tools execute immediately and feed results back to Gemini.
- Write tools (everything except the four read ones) buffer into `chat.pendingPlan` for end-of-turn review.
- Loop cap: 16 model iterations + 8 tool calls/turn. 3 consecutive tool errors abort the turn.
- Off-list calls return `{ error }` so the model sees and either retries or gives up.

---

#### H4. Approval card + safe-edit fast path

**Status**: ☑ shipped (2026-05-10)

**Why**: Most edits are single text changes — those should feel as fast as typing. Multi-step or destructive plans deserve a confirm step so the user can read what's about to happen.

**Behaviour**:
- End-of-turn decision:
  - Pure text reply → render the bubble, no plan.
  - Single `update_field` queued → auto-apply, log "· Updated …".
  - Anything else → render an approval card listing each pending action in plain English; user clicks ✓ Apply or ✗ Cancel.
- Apply runs each call sequentially through `callTool`, stops on first error, and `refreshFromServer()` after.
- Cancel marks the card cancelled; nothing reaches disk.

**Files**:
- `src/editor/ai.js` — `runAgent()`, `applyPlan()`, `humanizePlanItem()`, click delegation for `.chat-approval-*`.
- `src/editor/editor.css` — `.chat-bubble.approval`, `.chat-approval-list`, `.plan-num`.

---

#### H5. Suggestion chips + failure paths

**Status**: ☑ shipped (2026-05-10)

**Why**: New users don't know what the agent can do. Three scope-aware chips on the empty state turn the panel into a self-teaching surface.

**Behaviour**:
- Chips computed in `buildSuggestionsForScope()` per scope:
  - page-meta: tighten meta description / shorten title / explore SEO fields.
  - section: tailored to the current section's label.
  - whole-page: orchestration prompts (suggest improvements, find long text).
- Failure mapping:
  - 401/403 → "Your Gemini API key was rejected. Click ⚙ to update it."
  - 429 → "Rate-limited by Gemini. Wait a moment and retry."
  - Network → "Could not reach Gemini (network error)."
  - Iteration cap → safety bubble.

**Verified by**: opens panel on `akasa-dalhousie/index.html`, types "shorten the hero subtitle" → Gemini calls `update_field` once → auto-applies → file updated and saved on disk; multi-edit ask "tighten title and meta description" → approval card with 2 entries → ✓ Apply applies both; switching pages clears the chat history.

---

### 5.9 — Tier I: inline (in-preview) edit

#### I1. Click-to-edit text in the preview iframe

**Status**: ☑ shipped (2026-05-11)

**Why**: Before this, finding a field meant scanning the preview, then hunting in the sidebar for the matching `Heading 1 — in hero-content`. With ~200 fields on a content-rich page, that was the slowest part of using the cms. Now: hover the text you want to change in the preview → click → type. The sidebar still works; this is just a faster path to the same field.

**Behaviour**:
- On preview iframe load (or after a section op / Refresh), `inline-edit.js` walks `window.cmsState.fields` and, for every text-mode field whose selector resolves in the iframe DOM, marks the element with `data-cms-bound="1"` and attaches a hover/click listener.
- Hover an element → outline (solid `var(--accent)`) + `cursor: text`.
- Click → element becomes `contenteditable` (`plaintext-only` for `attr === 'text'` fields like `<title>`; `true` for `<h1>`/`<p>` and other html-mode fields). A floating bar with `✓ Done` / `✗ Cancel` appears above the element in the parent document.
- Typing fires `input` on the matching sidebar `<textarea>[data-input-id=…]` so the existing change-tracker handles the rest — Save lights up, the field card shows the dirty marker, Undo and Build are unaffected.
- `Esc` cancels; `⌘/Ctrl+Enter` confirms. Bar follows the element on iframe scroll and window resize.

**Sanitiser**: only `<em>`, `<strong>`, `<br>` survive a Done. `<b>` normalises to `<strong>`, `<i>` to `<em>`. Everything else (including `<span style>`, `<div>`, Word/Docs paste markup) is unwrapped — children move up to preserve nested allowed tags. Paste is intercepted and force-converted to `text/plain` to short-circuit Word formatting at the source.

**Read-only zones** (skipped entirely; sidebar remains the path):
- Anything under `.swiper`, `.swiper-container`, `.swiper-wrapper`, `.swiper-slide`, `.slick-slider`, `.slick-track`, `.tns-slider`, `.tns-inner` (carousels own their pointer events).
- Anything under `<form>`, `<button>`, `<a role="button">` (already-interactive surfaces).
- Anything under `[data-no-cms-edit]` (per-page opt-out hook).
- Fields with `attr` set to a real HTML attribute (`content`, `src`, `alt`, `href`) — they have no visible text to click.
- Fields with `scriptIndex !== null` (JSON-LD) and fields inside `<head>` (`offsetParent` check filters those).

**Files**:
- `src/editor/inline-edit.js` (new) — single-file IIFE, exposes `window.cmsInlineEdit = { exit, attached }`.
- `src/editor/index.html` — `<script src="inline-edit.js">` after `ai.js`.
- `src/editor/editor.css` — `.cms-edit-bar` + label + animation; respects `prefers-reduced-motion`.
- `src/editor/editor.js` — exports `window.refreshSaveBtn` and `window.setStatus` so the Cancel-restore path can clear the dirty marker cleanly.

**Verified by**: 5 Puppeteer acceptance tests:
1. Edit `<h1#heroHeading>` (rich-text with `<em>`), click Done → `<em>` preserved, sidebar value updated, dirty flag set, bar dismissed.
2. Edit with `<span style="color:red"><b>Bold</b></span> normal <i>italic</i>` → sanitised to `<strong>Bold</strong> normal <em>italic</em>` (b→strong, i→em, span unwrapped while preserving children).
3. Edit then Cancel from a clean field → DOM reverts, sidebar reverts, `state.changed` cleared.
4. Form descendants have zero `[data-cms-bound]` elements (blocklist respected).
5. Click `⟳ Refresh` → iframe reloads → new DOM nodes re-bind on the fresh load.

---

### 5.10 — Tier J: draft persistence + refresh guard

#### J1. Auto-save drafts + restore banner

**Status**: ☑ shipped (2026-05-11)

**Why**: Until this lands, every accidental refresh / closed tab / browser crash with unsaved edits = those edits are gone. The native `beforeunload` prompt is the only existing safety net, and it can't show a "Save" button (browsers stripped that capability in 2017).

**Behaviour**:
- Every change in `state.changed` / `state.changedAlt` mirrors to `localStorage` (debounced 400 ms). Key shape: `cms-static.draft.<pagePath>`.
- The pending debounce is force-flushed on `beforeunload` and on `visibilitychange → hidden`, so the latest keystroke is always captured even if the user reloads within the debounce window.
- On every `loadPage` (page picker change or first load), the editor checks `localStorage` for a draft under that page's key. If one exists, a banner slides in above the field list: *"3 unsaved edits from your last session — ↻ Restore / ✗ Discard."*
- Clicking **Restore** rehydrates `state.changed` + `state.changedAlt`, re-renders the field list (each restored field shows its dirty marker), lights the Save button, and clears the banner.
- Clicking **Discard** removes the localStorage entry and clears the banner.
- A successful Save clears the draft automatically so it doesn't reappear on the next load.

**What's NOT covered**: `state.pendingImages` (Blob references can't survive a JSON round-trip). The banner mentions "(image crops were lost)" if any were pending so the user knows to re-crop.

#### J2. ⌘R / Ctrl+R / F5 → in-app confirm dialog

**Status**: ☑ shipped (2026-05-11)

**Why**: The native browser prompt can only say "Leave / Stay." For the keyboard-refresh case — which is most accidental refreshes — we can do better: intercept the keystroke and show a real three-button choice.

**Behaviour**:
- A capture-phase keydown listener catches `F5`, `⌘+R`, `⌘+Shift+R`, `Ctrl+R`, `Ctrl+Shift+R`. If `state.changed` is empty, the refresh passes through normally.
- If there are unsaved edits, `e.preventDefault()` fires and a `<dialog id="refreshConfirmDialog">` opens with three buttons: **Cancel** / **Discard & reload** / **Save & reload**.
- **Save & reload**: runs `window.save()` (the same path the Save button uses); on success, `state.changed` is empty, so the subsequent `location.reload()` skips `beforeunload`. On save failure, the toast appears and the reload is aborted.
- **Discard & reload**: clears `state.changed` / `state.changedAlt` / `state.pendingImages` *and* deletes the localStorage draft entry, then reloads. This is the explicit "throw it away" path.
- **Cancel**: closes the dialog, no reload.
- Browser reload button + tab close still hit the native `beforeunload` prompt — we can't intercept those — but the localStorage draft (J1) makes data loss survivable anyway.

**Files**:
- `src/editor/drafts.js` (new) — single-file IIFE, exposes `window.cmsDrafts = { persist, maybeRestore, clear }`.
- `src/editor/index.html` — `<dialog id="refreshConfirmDialog">` + `<script src="drafts.js">`.
- `src/editor/editor.css` — `.draft-banner` + `.draft-dialog` blocks.
- `src/editor/editor.js` — `cmsDrafts.persist()` after every change, `maybeRestore(pagePath)` after `loadPage`, `clear(page)` on save success; exports `window.save` / `window.renderFields` for the dialog's Save-and-reload handler.

**Verified by**: 4 Puppeteer acceptance tests:
1. Typing into a sidebar field writes a `cms-static.draft.<page>` entry to `localStorage` within ~700 ms.
2. Reload → banner appears with the correct count → Restore → sidebar value + dirty marker reappear, banner dismisses.
3. ⌘R with unsaved changes opens the dialog (not the native prompt) with the correct count.
4. Discard & reload removes the localStorage entry, reload completes without the banner reappearing.

---

### 5.11 — Tier K: SEO / content validation warnings

#### K1. Multiple-H1 warning

**Status**: ☑ shipped (2026-05-11)

**Why**: SEO best practice is exactly one `<h1>` per page. With section cloning (G1), it's easy to accidentally end up with two — the cloned hero section duplicates the page's primary heading and nothing surfaces the problem. Surfacing it should be a routine part of editing, not something the user notices weeks later in Search Console.

**Behaviour**:
- After every `renderFields()` (i.e. on page load, after section ops, after save), `validation.js` runs `checkPage(state.fields)` and counts fields where `tag === 'h1'`.
- If the count is `≤ 1`: no UI surfaces.
- If the count is `≥ 2`:
  - A persistent **SEO warning card** is inserted at the top of the sidebar (just above the Sections group). It lists each h1 with its text preview and section context (e.g. *"Close to The Mall…" in hero-content*), numbered.
  - Clicking any item scrolls the matching sidebar input into view, focuses it, and pulses the field card so it's obvious where you landed.
  - A toast fires *once* per page transition: *"N H1 tags found — see SEO panel in sidebar."* The toast follows the existing 3-second auto-dismiss for `info` severity.
  - The toast re-fires when the issue signature changes (e.g. a second clone bumps the count from 2 to 3) so the user knows something just changed.

**Per-page toast memory.** A `lastToastCount` Map keyed by `pagePath` stores the issue signature we last toasted. `cms:page-changed` clears the entry for the page being navigated to, so coming back to a problem page after fixing it elsewhere will re-toast if the issue is still present.

**Why use `state.fields` instead of scanning the iframe.** The fields manifest already filters out `<h1>`s inside excluded ancestors (`<nav>`, `<footer>`, `<form>`, `<script>`, inline SVGs). Those are structural, not editable content — counting them as SEO issues would be noise. If a future check needs raw DOM, we can layer in an iframe scan.

**Extensibility shape.** `checkPage(fields)` returns an array of `{ code, severity, message, toast?, items? }` issue objects. Adding new rules (meta description length, missing alt text, title length, etc.) is a one-function addition next to `checkH1`. The render and click-to-jump pipelines are issue-agnostic.

**Files**:
- `src/editor/validation.js` (new) — single-file IIFE, exposes `window.cmsValidation = { render, checkPage }`.
- `src/editor/index.html` — `<script src="validation.js">`.
- `src/editor/editor.css` — `.seo-card` / `.seo-issue` / `.seo-list` / `.seo-item-jump` blocks + `.field.field-flash` pulse animation; respects `prefers-reduced-motion`.
- `src/editor/editor.js` — one line at the end of `renderFields()`: `if (window.cmsValidation) window.cmsValidation.render(state.currentPage, fields);`.

**Verified by**: 4 Puppeteer acceptance tests:
1. Page with 1 h1 → no `#seoCard`, no toast.
2. Clone the hero section (containing the h1) → 2 h1s → card with 2 list items renders + toast fires with "2 H1 tags found".
3. Click the first SEO list item → matching sidebar textarea gains focus and the field card flashes.
4. Undo the clone → back to 1 h1 → card disappears.

---

## 6 · Suggested ship order

The order below assumes "biggest perceived impact first":

1. A1 — Collapsible sidebar
2. A2 — Resizable sidebar
3. A3 — Friendlier group names
4. A4 — Friendlier field labels (Headings + Body)
5. C1 — Empty-state welcome card
6. D1 — Toast-based status messages
7. D2 — Save button pending count + ⌘S hint
8. C4 — Save success animation
9. B1 — Sticky header
10. B2 — Bigger inputs
11. B3 — Card-style field rows
12. B4 — Larger thumbnails
13. B5 — Reorder groups by edit-frequency
14. E1 — Git panel compact mode
15. E2 — Plain-English Git pill labels
16. E3 — Verb-first Git button labels
17. C2 — First-visit toast tip
18. C3 — `?` shortcuts cheat-sheet
19. D3 — Loading skeletons
20. F1–F5 — Micro polish (one batch)

After step 4 we'll have ~80 % of the perceived improvement.

---

## 7 · Risks & open questions

- **Group renames (A3)** could break if any user code (none today) relied on the literal group string. Reviewed — no callers; safe.
- **Resizable sidebar (A2)** must clamp to a min width — below 280 px the field labels overflow. Set min to 300 px.
- **Toasts (D1)** stack — cap at 4 visible at once.
- **Compact Git panel (E1)** — make sure the "Commit" inline message field stays usable when collapsed.
- **Reduced motion**: every animation in this roadmap should respect `@media (prefers-reduced-motion: reduce)`. Add a checklist gate per item.
- **Provider detection (E3)** — what if origin URL is `git@gitea.example.com:user/repo.git`? Default to `Send to remote`. Acceptable.

---

## 8 · Conventions for ship-time

When shipping a phase:

- Keep PRs (or commits) small and titled: `[ui] A1: collapsible sidebar`.
- Update this file: change `☐` → `▶` when starting; `▶` → `☑` when done; add a Done log entry below.
- Restart the cms-static server and refresh the editor in the browser.
- Eyeball the diff against the screenshot baseline (capture a fresh one after each phase).
- Run a visual smoke pass: pick a page → see fields → toggle sidebar → save → commit → push (no functionality should regress).

---

## 9 · Done log

A short append-only log of what shipped, when, and any notes. (Latest first.)

```
yyyy-mm-dd  Item        Notes
──────────  ──────────  ─────────────────────────────────────────
2026-05-06  A1+A2       Collapsible sidebar (chevron · Ctrl/⌘B · 200 ms transition).
                        Resizable handle on the right edge (300–600 px clamp;
                        double-click resets to 380 px). Both states persisted in
                        localStorage. Hidden cleanly when collapsed.
2026-05-06  A3          Friendlier group names: "Page details (SEO)" / "Business info"
                        / "Page content" / "Photos". Centralised in GROUP_NAMES +
                        SCHEMA_TYPE_FRIENDLY in extractor.js. Schema for unknown
                        @types falls back to "Schema — <Type>".
2026-05-06  A4          Heading + Body fields now show "Heading 1" / "Paragraph"
                        as the label, with a small muted hint ("in hero-content")
                        below the input. Selector + legacy long label kept on
                        hover via title=. SEO/Schema fields untouched (no tag).
2026-05-06  A1+A2 fix   Fixed: resize-then-collapse didn't work because both
                        wrote to --sidebar-width. Split into --user-sidebar-width
                        (resize writes) + --sidebar-width (effective; class
                        overrides). Reload-survival also fixed.
2026-05-06  Batch 1     C1 welcome card (no-page state). D1 toast notifications
                        bottom-right (info/success/error, 3 s auto-dismiss except
                        errors, max 4). D2 Save button: "Save 3 changes" count +
                        ⌘ S kbd hint + saving/saved phases. C4 Save success
                        green pulse + "✓ Saved" flip for 900 ms. setStatus is
                        now a thin wrapper over toast() for legacy callers.
2026-05-06  Batch 2     B1 sticky header (already in effect via flex-column;
                        confirmed). B2 bigger inputs (font 14, padding 10×12,
                        textarea min-height 72, focus ring α 0.22). B3 card-style
                        rows with hover bg + dirty left-border accent (rolls F3).
                        B4 80×80 thumbs that scale to 1.18× on hover. B5 group
                        order in renderFields(): Headings → Page content →
                        Photos → Page details (SEO) → everything else.
2026-05-06  Batch 3     E1 Git panel compact-by-default — branch + pills + commit
                        form + push always visible; remote URL, auto-commit
                        toggle, recent log behind ▾ More (persisted under
                        cms-static.git.expanded). E2 plain-English pills:
                        "● 2 unsaved files", "↑ 3 ready to push", "↓ 1 update
                        from team", "✓ Up to date". E3 verb-first buttons:
                        "Save to history" + "Send to GitHub" / Bitbucket /
                        GitLab / Gitea / Codeberg / Azure DevOps based on
                        remote URL. Remote URL shows "user/repo" form.
2026-05-06  Batch 4     C2 first-visit toast tip (dismissed-once via
                        cms-static.firstVisitTip.dismissed). C3 keyboard
                        cheat-sheet — "?" floating button bottom-left (hidden
                        when sidebar collapsed) + ? key opens a <dialog> listing
                        ⌘S, ⌘B, ?, Esc with kbd-styled keys.
2026-05-06  Batch 5     D3 skeleton loaders (6 shimmer rows during /api/fields).
                        F1 sticky save bar with subtle top shadow when content
                        scrolls under it. F3 left-border accent on dirty fields
                        (shipped with B3). F4 label/baseline tweaks (rolled
                        into A4). F5 stronger focus ring (rolled into B2).
                        F2 rejected — native <select> can't style per-segment.
2026-05-07  G1          Clone-section. New cloner.js module + /api/clone-section
                        route + Sections group at top of sidebar with 📋 Clone
                        button per section. -copy/-copy-2/-copy-3 suffix with
                        stem-strip when cloning a clone (story-copy → next is
                        story-copy-2, not story-copy-copy). Inner id + aria-*
                        + <label for> + href="#…" + <use href="#…"> all
                        suffixed when target is inside the clone. Refuses
                        if unsaved edits. Smoke-verified on #story (4 clones)
                        and #book (inner-id rewrite confirmed on enqName/email).
2026-05-07  G2+G3+G4+G5 Delete + Reorder + Undo + form-warning. New section-ops.js
                        with deleteSection, moveSection, subtreeContainsForm,
                        plus per-page in-memory history stack (max 10, FIFO
                        eviction). Three new routes: /delete-section,
                        /move-section, /undo + /undo-state. Section row gets
                        ▲ ▼ 📋 🗑; Sections-group toolbar gets ↩ Undo. Native
                        confirm() before delete; refuses-on-unsaved for all.
                        Edge cases verified: empty undo stack → clean error;
                        moving first section up → clean error; cloned forms
                        trigger an extra info toast about JS rewiring.
2026-05-11  K1          SEO multiple-H1 warning. New validation.js IIFE runs
                        after every renderFields(): counts state.fields with
                        tag==='h1' and, when ≥2, renders a sticky warning
                        card at the top of the sidebar listing each h1 with
                        text preview + section context, and toasts once per
                        page-transition. Clicking a list item scrolls the
                        matching [data-input-id] into view, focuses it, and
                        pulses the field card. checkPage() returns an
                        extensible {code,severity,message,toast?,items?}
                        shape so future rules (meta-desc length, missing alt,
                        title length) drop in beside checkH1. Hook is a
                        single line at the end of renderFields(). 4/4
                        Puppeteer tests passed.
2026-05-11  J1+J2       Draft persistence + refresh guard. New drafts.js IIFE
                        mirrors state.changed + state.changedAlt to
                        localStorage (debounced 400ms; force-flushed on
                        beforeunload / visibilitychange). On loadPage, a
                        banner offers Restore / Discard if a draft exists for
                        the current page; on save success the draft is
                        cleared. Capture-phase keydown listener intercepts
                        F5 / ⌘R / Ctrl+R when state.changed is non-empty
                        and shows a <dialog> with Save & reload / Discard
                        & reload / Cancel; Save & reload runs window.save()
                        then location.reload(). Browser reload-button still
                        triggers native beforeunload but the localStorage
                        layer makes data loss survivable. 4/4 Puppeteer
                        tests passed.
2026-05-11  I1          Inline (in-preview) edit. New inline-edit.js single-file
                        IIFE walks window.cmsState.fields on every iframe load,
                        binds hover-outline + click-to-edit on every text field
                        whose selector resolves in the iframe DOM (skips
                        attribute-bound fields, JSON-LD, head-children, and
                        carousels/forms/[data-no-cms-edit] ancestors). Edit
                        writes through the matching sidebar [data-input-id]
                        via dispatched input events — existing change tracker,
                        Save, Undo, Build are untouched. Floating ✓ Done /
                        ✗ Cancel bar lives in the parent doc and follows the
                        element on iframe scroll. Sanitiser keeps em/strong/br,
                        normalises b→strong i→em, unwraps everything else
                        while preserving nested allowed tags. Paste is
                        text/plain only. Cancel reverts DOM + sidebar and
                        clears state.changed when reverting to the original
                        field value. 5/5 Puppeteer acceptance tests passed.
2026-05-10  H1–H5       AI chat agent (Gemini 2.5 Flash). New ai.js single-file
                        IIFE: ✨ AI button + slide-up chat panel + key dialog
                        (localStorage / sessionStorage), three-scope picker
                        (page-meta / section / whole-page) with per-turn
                        manifest rebuild from /api/fields, 10-tool whitelist
                        (read_*, update_field, clone/delete/move/undo,
                        lookup_field_id, find_text), agent loop with
                        16-iter / 8-call cap + 3-consecutive-fail abort,
                        approval card for multi-step / destructive plans
                        with per-item plan-buffer + ✓ Apply / ✗ Cancel,
                        scope-aware suggestion chips, full failure-path
                        mapping (401/403, 429, network, off-list tool).
                        No new server endpoints; all reuses existing
                        /__cms/api/*. Browser-side only — key never sent
                        to cms-static.
```

---

## 10 · Out-of-scope / parked ideas

These came up while planning but are explicitly **not** in scope for the styling-only effort.

- **Dark mode** — would need a full token review; defer to a separate roadmap.
- **Mobile / tablet layouts** — desktop is the only target; no responsive work.
- **Inline editing** in the iframe — substantial functionality work; explicitly out.
- **Internationalisation** of labels — single-language (English) until needed.
- **Theming per site** — too tightly coupled to functionality.

---

*Last revised: 2026-05-11 — Tier K SEO multiple-H1 warning shipped.*
