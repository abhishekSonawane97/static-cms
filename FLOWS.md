# cms-static — Flows (end-to-end)

This document walks through **every runtime flow** in cms-static: what triggers it,
which files and HTTP endpoints participate, the exact order of operations, and the
failure paths. It is the "how it actually works" companion to `README.md` (the what)
and `design-flow.md` / `ui-roadmap.md` / `ai-integration-plan.md` (the design history).

If you only read one section, read **[2. Field extraction](#2-field-extraction-the-core-model)** —
it is the model everything else is built on.

---

## Table of contents

1. [Startup / boot](#1-startup--boot)
2. [Field extraction (the core model)](#2-field-extraction-the-core-model)
3. [Page discovery & the page picker](#3-page-discovery--the-page-picker)
4. [Loading a page in the editor](#4-loading-a-page-in-the-editor)
5. [Editing a field (sidebar)](#5-editing-a-field-sidebar)
6. [Inline editing (in the preview)](#6-inline-editing-in-the-preview)
7. [The save round-trip](#7-the-save-round-trip)
8. [Image replace (file → crop → upload)](#8-image-replace-file--crop--upload)
9. [Crop an existing image (+ image proxy)](#9-crop-an-existing-image--image-proxy)
10. [Section operations: clone / delete / move / undo](#10-section-operations-clone--delete--move--undo)
11. [Build (minified + formatted)](#11-build-minified--formatted)
12. [Git flows](#12-git-flows)
13. [AI assistant](#13-ai-assistant)
14. [Draft persistence + reload guard](#14-draft-persistence--reload-guard)
15. [SEO / content validation](#15-seo--content-validation)
16. [Cross-cutting: security & safety](#16-cross-cutting-security--safety)
17. [HTTP endpoint → flow map](#17-http-endpoint--flow-map)

---

> **v0.2 — drop mode.** The tool now runs in two modes. With **no argument**
> (`node bin/cli.js`) it starts with *no site*; the user uploads a folder in the
> browser, which is held in an app-managed temp **workspace**, edited, and
> exported as a zip. With a **folder argument** (`node bin/cli.js <folder>`) it
> behaves as before ("classic mode"), pinning that folder as the workspace and
> enabling the Git panel. The new flows are documented in
> **[§18 Workspace lifecycle](#18-workspace-lifecycle-drop-mode)**,
> **[§19 Folder ingestion](#19-folder-ingestion-drop-mode)**, and
> **[§20 Export](#20-export)**. The sections below describe the shared editing
> engine, which is identical in both modes once a workspace is active.

## 1. Startup / boot

**Trigger:** `node bin/cli.js` (drop mode) **or** `node bin/cli.js <site-folder>` (classic mode).

**Files:** [bin/cli.js](./bin/cli.js) → [src/server.js](./src/server.js) → [src/workspace.js](./src/workspace.js)

In **classic mode** cli.js validates the folder (exists, is a directory, not
minified) and calls `startServer(port, { initialRoot })`, which pins it via
`workspace.pin()`. In **drop mode** there is no folder — `startServer(port, {})`
starts with `workspace.getRoot() === null`, and every site route returns
`409 { code:'NO_WORKSPACE' }` until an upload completes. `express.static` is now
a **dynamic wrapper** that rebuilds its instance whenever the active root
changes (see [§18](#18-workspace-lifecycle-drop-mode)). The rest of boot
(below) is unchanged.

```
node bin/cli.js /path/to/site
        │
        ├─ resolve siteRoot = path.resolve(cwd, arg)
        ├─ exists? isDirectory?                      ──no──► print error, exit(1)
        ├─ looksMinified(<siteRoot>/index.html)?     ──yes─► "point at SOURCE", exit(1)
        │     (heuristic: <5 lines AND >5000 chars)
        ├─ port = PORT env || 5174
        └─ startServer(siteRoot, port)
                │
                ├─ express app, express.json({ limit: '20mb' })
                ├─ multer memoryStorage, 25 MB file cap
                ├─ mount static editor at /__cms
                ├─ register all /__cms/api/* routes
                ├─ GET /            → redirect to /__cms/      (BEFORE static!)
                └─ express.static(siteRoot, { extensions:['html'], Cache-Control:no-store })
```

**Why the order matters:** the `GET /` redirect is registered *before* `express.static(siteRoot)`.
If it weren't, the static middleware would serve `siteRoot/index.html` at `/` and the user
would never reach the editor.

**Why `Cache-Control: no-store` on the site static:** the preview iframe must reflect saved
edits instantly. Caching would show stale content after a Save.

**Failure paths:** non-existent folder, not a directory, or a minified `index.html` all
`exit(1)` with a message. A port already in use rejects the `app.listen` promise → cli prints
`[!] Server failed to start`.

---

## 2. Field extraction (the core model)

**Trigger:** any `GET /__cms/api/fields?page=<path>` (page load, save refresh, AI manifest, etc.).

**File:** [src/extractor.js](./src/extractor.js) (`extractFields`, `extractSections`)

This is the heart of the "zero-config" promise. There is **no schema and no markup in the
source**. The extractor reads semantic HTML and emits a flat list of **field descriptors**.

### What becomes a field

| Source | Group | `type` | `attr` | Notes |
|---|---|---|---|---|
| `head > title` | Page details (SEO) | text | `text` | |
| SEO `<meta>` (description, og:*, twitter:*) | Page details (SEO) | text/longtext/image | `content` | fixed list in `SEO_META` |
| `<script type="application/ld+json">` | friendly schema name | text/longtext | — | flattened scalars + 1-level nested objects; **arrays skipped** |
| `main h1–h4` | Headings | longtext | `html` | inline tags (`em/strong/a/…`) preserved |
| `main p, li, blockquote, figcaption, dt, dd` | Page content | longtext | `html` | same |
| `main img` | Photos | image | `src` (+ `alt`) | thumbnail + URL + alt + replace/crop |

### Key mechanics

- **Scope:** everything below `<main>` (first one). If there is no `<main>`, it falls back to
  `<body>` — which will pick up nav/footer junk, so a `<main>` wrapper is strongly recommended.
- **Exclusions:** `EXCLUDED_ANCESTORS = nav, footer, svg, button, form, script, style, header, aside.cms-noedit`.
  Any element with one of these as an ancestor is skipped (`hasExcludedAncestor`).
- **"Only text" guard:** a body element is only emitted if its children are text or whitelisted
  inline tags. `<p><img></p>` is skipped (it is structural, not prose).
- **Selectors:** `buildSelector(el)` builds a path from `<html>` down, using `tag#id` when an id
  exists, else `tag:nth-of-type(n)` for ambiguous siblings. This selector is how the save step
  re-finds the element.
- **Session-local IDs:** `nextId(prefix)` produces `seo:0`, `jsonld:3`, `h1:12`, `img:40`…
  monotonically per extraction. **IDs are never written to disk** — they are regenerated on every
  call. The client keys its edits by these ids; the server applies them in the same freshly-parsed
  tree. Edit raw HTML between sessions and the ids shift, but integrity holds because every
  operation re-extracts first.
- **JSON-LD flattening:** `flattenJsonLd` walks one object, skips `@`-keys, emits scalars
  (`name`, `priceRange`, …) and recurses **one level** into nested objects (`address.streetAddress`).
  Arrays (`amenityFeature: [...]`) are intentionally skipped in v1. Each field carries
  `scriptIndex`, `arrayIndex`, `jsonPath` so the applier can write it back.

### `extractSections`

Separately, `extractSections(html)` lists the **direct `<section>` children of `<main>`** with
`{ selector, label, id, hasId, index }`. The label prefers `id` → first heading text → first
meaningful class → `Section N`. This list drives the Sections toolbar and all clone/delete/move
operations.

---

## 3. Page discovery & the page picker

**Trigger:** editor boot → `GET /__cms/api/pages`.

**Files:** [src/discovery.js](./src/discovery.js) (`listPages`) → [editor.js](./src/editor/editor.js) (`loadPages`)

```
walk(siteRoot)                      recursive readdir
   skip: dotfiles, node_modules, _minified, _formatted, .git, .vscode, .idea, dist, build
   skip .html if: size > 5 MB, OR first 4 KB has <3 newlines AND ≥3500 chars (minified)
        │
   raw = ["index.html", "akasa-dalhousie/index.html", "akasa-dalhousie/about/index.html", ...]
        │
   Pass 1: score each top-level segment. A nested page (>1 segment) scores 10; a shallow one
           scores 1. Segments scoring ≥10 are "promoted" to their own <optgroup>.
   Pass 2: each page → { path, label (breadcrumb), group }
        │
   sort: Top-level group first, then alphabetical groups; within a group by depth then label
```

The client groups the array into `<optgroup>`s and renders the dropdown. `index.html` becomes
"Home"; `akasa-dalhousie/about/index.html` becomes "Akasa Dalhousie › About" under the
"Akasa Dalhousie" optgroup. (Legacy plain-string page entries are tolerated.)

---

## 4. Loading a page in the editor

**Trigger:** user picks a page from the dropdown → `loadPage(path)`.

**File:** [editor.js](./src/editor/editor.js)

```
loadPage(path)
  ├─ clear state.changed / changedAlt / pendingImages
  ├─ dispatch 'cms:page-changed'  → ai.js clears chat, inline-edit.js re-arms, validation.js resets
  ├─ iframe.src = '/' + path        (live preview, served by express.static)
  ├─ render 6 skeleton rows
  ├─ GET /__cms/api/fields?page=…   → state.fields, state.sections
  ├─ GET /__cms/api/undo-state?page=… → state.undoAvailable
  ├─ renderFields()
  │     ├─ Sections group (top) with ▲ ▼ 📋 🗑 + Undo toolbar
  │     ├─ field groups ordered by GROUP_ORDER (Headings, Page content, Photos, SEO, then rest)
  │     ├─ wireFieldEvents() + wireSectionEvents()
  │     └─ cmsValidation.render()   → SEO warning card if any
  └─ cmsDrafts.maybeRestore(path)   → offer to restore unsaved edits from localStorage
```

Empty-selection shows a welcome card and blanks the preview.

---

## 5. Editing a field (sidebar)

**Trigger:** typing in a sidebar `<input>` / `<textarea>`, or editing an image URL / alt.

**File:** [editor.js](./src/editor/editor.js) (`wireFieldEvents`)

Every input fires an `input` handler that:

1. Writes the new value into `state.changed` (text/URL) or `state.changedAlt` (alt).
2. Adds the `.changed` (peach) class to the field card.
3. Refreshes the Save button label → "Save N changes" and enables it.
4. Calls `cmsDrafts.persist()` (debounced localStorage write).

Editing an **image URL** also clears any pending cropped blob for that field (the URL is now the
source of truth) and live-updates the thumbnail. The **↻ Reset** button per image field discards
that field's pending text/alt/blob and restores the original in place (no full re-render, so
scroll position is kept).

`hasChanges()` = `changed.size || changedAlt.size || pendingImages.size`. It gates Save, section
ops, AI sends, and the `beforeunload` warning.

---

## 6. Inline editing (in the preview)

**Trigger:** hover → click a text element inside the preview iframe.

**File:** [src/editor/inline-edit.js](./src/editor/inline-edit.js)

```
iframe 'load' (or 'cms:page-changed')  → setupIframe()
   inject CSS into iframe doc (hover outline / active dashed outline)
   for each state.field that is text/longtext AND maps to el content (attr text|html):
       skip if inside .swiper/.slick/.tns/form/button/[data-no-cms-edit]
       skip if invisible (no offsetParent)
       tag el with data-cms-bound / data-cms-field-id / data-cms-mode
       wire mouseenter / mouseleave / click(capture)

click → enterEdit(el, field)
   contenteditable = plaintext-only (text) | true (html)
   select all, show floating Done/Cancel bar in PARENT doc (positioned over the element)
   on input → push value into the matching sidebar input + dispatch 'input'
              (so the normal sidebar bookkeeping runs — single source of truth)
   sanitise html-mode: keep em/strong/br, remap b→strong i→em, strip everything else
   paste → forced text/plain (no Word/Docs markup)
   Esc = Cancel (restore original HTML + revert sidebar) · Cmd/Ctrl+Enter = Done
```

Inline edit **never touches state directly** — it drives the sidebar input, which owns
`state.changed`, dirty marks, and Save. Image / SEO meta / JSON-LD fields have no clickable text
and remain sidebar-only.

---

## 7. The save round-trip

**Trigger:** Save button or ⌘/Ctrl+S (only when `hasChanges()`).

**Files:** [editor.js](./src/editor/editor.js) `save()` → [src/server.js](./src/server.js) `/api/save` → [src/applier.js](./src/applier.js)

```
[browser]                                        [server]
 save()
  ├─ for each pendingImage:
  │    POST /__cms/api/upload-image (multipart) ──► image.js (Sharp re-encode, write)
  │    on success: state.changed.set(id, returnedPath)
  │
  ├─ build changes[] from changed + changedAlt   (each carries id, selector, attr,
  │                                                 altAttr, scriptIndex, arrayIndex, jsonPath, value)
  ├─ compute suggested commit message
  │
  └─ POST /__cms/api/save { page, changes } ─────► read source file
                                                    applyChanges():
                                                      cheerio.load
                                                      DOM changes: .text()/.html()/.attr(); alt too
                                                      JSON-LD: parse → setNestedValue (type-coerced) → re-stringify
                                                      js-beautify whole doc (shared BEAUTIFY_OPTS)
                                                    fs.writeFileSync
                                                  ◄── { ok, bytes }
  ├─ clear state, cmsDrafts.clear()
  ├─ Save button → "✓ Saved", toast "Saved · N KB"
  ├─ cmsGit.onAfterSave() → auto-commit (if enabled) + refresh git panel; pre-fill commit msg
  └─ reload iframe + re-fetch fields (so ids/values reflect disk)
```

**Type coercion** in `setNestedValue`: if the original JSON-LD value was a number/boolean, the
new value is coerced back (`numberOfRooms: 5` stays a number). **Whole-file reformat:** js-beautify
rewrites the entire document, so the first save against an un-beautified file produces a large
diff; subsequent saves diff cleanly. **Image upload failure** aborts the save and resets the
button (changes stay dirty). **DOM change with a no-longer-matching selector** is silently skipped
(`if (!$el.length) continue`).

---

## 8. Image replace (file → crop → upload)

**Trigger:** 📁 **Replace file…** on an image field.

**Files:** [cropper-modal.js](./src/editor/cropper-modal.js) → [editor.js](./src/editor/editor.js) `applyCrop` → save → [src/image.js](./src/image.js)

```
openCropperFor(fieldId)
  hidden <input type=file accept=image/*> → user picks a file
  img.src = objectURL(file)
  on load: originalAspect = field.width/height || naturalW/naturalH
           new Cropper(viewMode 1, autoCropArea .95), aspect = "Match original"
  Save crop → getCroppedCanvas({ maxWidth:2400, maxHeight:2400 }) → toBlob(mime by ext, .9)
            → window.applyCrop(fieldId, blob, destPath)
                state.pendingImages.set(id, { blob, destPath })   destPath = current URL/path
                state.changed.set(id, destPath)
                thumbnail → objectURL(blob); field marked dirty
```

The blob is **not uploaded yet** — it waits for the next **Save**, which POSTs it to
`/api/upload-image`. Server-side ([image.js](./src/image.js)):

- `destPath` is sanitised and confined to the site root (path-escape guard).
- If `destPath` is an **external URL**, a local path is generated:
  `/images/cropped/<basename>-<6charSHA1>.jpg`, and *that* path is written into the HTML.
- Sharp re-encodes by extension: jpg→mozJPEG q82 progressive, png→level 9, webp→q82, avif→q50,
  else JPEG q82. If Sharp is unavailable, raw bytes are written and `sharp:false` is returned.

---

## 9. Crop an existing image (+ image proxy)

**Trigger:** ✂ **Crop** on an image field (crop the current image without choosing a new file).

**Files:** [cropper-modal.js](./src/editor/cropper-modal.js) `openCropperForExisting` → [src/image-proxy.js](./src/image-proxy.js)

- **Local path** (`/images/...`): loaded directly into the cropper `<img>`.
- **External URL** (`http(s)://...`): loaded via `GET /__cms/api/image-proxy?url=…`. The browser
  cannot read a cross-origin image's pixels into a canvas (CORS taint), so the server fetches it
  and streams it back same-origin. Guards: http(s) only, 8 s timeout, 10 MB cap (both
  Content-Length and a running byte counter), content-type must be `image/*`, else `502`.

From there it joins the same crop → blob → pending → Save → upload path as flow 8. On upload, an
external-URL source is rewritten to a local `/images/cropped/...` file.

---

## 10. Section operations: clone / delete / move / undo

**Trigger:** the ▲ ▼ 📋 🗑 buttons or ↩ Undo in the Sections group (also callable by the AI).

**Files:** [editor.js](./src/editor/editor.js) `sectionAction` → [src/server.js](./src/server.js) → [src/cloner.js](./src/cloner.js) / [src/section-ops.js](./src/section-ops.js)

**Shared preconditions (server):** every endpoint validates the selector against
`SECTION_SELECTOR_RE` — it must be a `<section>` **direct child of `<main>`**. Anything else is
`400`. **Client preconditions:** `sectionAction` refuses if `hasChanges()` (these ops rewrite the
file, so unsaved field edits must be saved first); delete shows a native confirm.

```
clone  POST /api/clone-section   cloner.cloneSection: deep-clone, pick "<stem>-copy[-N]" id,
                                  rewrite inner ids + aria-*/label[for]/href#/use#xlink refs,
                                  insert after original. Warns if a <form> is inside.
delete POST /api/delete-section  section-ops.deleteSection: remove the <section>.
move   POST /api/move-section    section-ops.moveSection: swap with prev/next <section> sibling.
undo   POST /api/undo            restore the pre-action HTML snapshot.

Every clone/delete/move:
  1. pushHistory(page, htmlBeforeWrite, action)   in-memory stack, depth 10, per page
  2. beautify(result.html) → fs.writeFileSync
  3. respond with fresh sections[] + undoAvailable
Undo: popHistory(page) → write the snapshot verbatim (already beautified when pushed).
```

After any op, the client toasts the result and calls `refreshFromServer()` (reload iframe +
re-fetch fields/sections/undo-state). **The undo stack is in-memory and per-process** — it is lost
on server restart, and it tracks only structural ops (not field saves; use Git for those).

---

## 11. Build (minified + formatted)

**Trigger:** ⬇ Build → `POST /__cms/api/build`.

**File:** [src/builder.js](./src/builder.js)

Two independent pipelines, both rooted at the site folder:

> **v0.2:** the minifier is now **built in** — it no longer spawns the site's own
> `build.js` (arbitrary code execution on uploaded folders, and dead in practice
> since the real site uses `build.mjs`). Deps: `html-minifier-terser`, `terser`,
> `clean-css`.

```
runBuild(siteRoot)
  ├─ _minified/  : built-in generateMinified() — wipe + recreate, walk (shared SKIP set)
  │                .html → html-minifier-terser (+ ?v= sha256-10 cache-bust rewrite)
  │                .js   → terser {compress passes:2, mangle}  (skips *.min.*)
  │                .css  → clean-css level 1 · else copy · per-file copy-as-is fallback
  │                returns { ok, files, html, css, js, other, bytesIn, bytesOut, failures }
  └─ _formatted/ : wipe + recreate, recursive walk, shared SKIP set
                   .html → beautify.html · .css → beautify.css · .js → beautify.js · else copy
                   returns { ok, formatted, copied }
```

`_minified/` is your deployable artifact and what **Export** ([§20](#20-export))
ships. `_formatted/` is a pretty-printed mirror of source. Both are inside the
workspace and excluded from source exports; both should be `.gitignore`d in
classic mode.

---

## 12. Git flows

**Files:** [src/git.js](./src/git.js) (CLI wrapper) ↔ [src/server.js](./src/server.js) `/api/git/*` ↔ [src/editor/git-panel.js](./src/editor/git-panel.js)

Git is a **thin wrapper around the local `git` CLI** (no PAT/API; uses your existing SSH/helper
creds; provider-agnostic). `run(args, cwd)` never throws on non-zero exit — callers inspect `code`.

### State poll
`GET /api/git/state` → `git.fullState`: installed? isRepo? branch, remote URL, ahead/behind vs
upstream, dirty count, last 5 commits. The panel polls this every **8 s** while open.

### Onboarding / init
On first run, if installed but not a repo (and not skipped), the onboarding modal opens. Choices:
**local** (`git init -b main`), **remote** (init + `remote add origin <url>`), or **skip** (sets a
localStorage flag). `init` also writes a default `.gitignore` (`_minified/`, `_formatted/`,
`node_modules/`, …), sets local `user.name`/`user.email` if absent, and makes the first commit.

### Commit
`POST /api/git/commit { message, files? }` → `git add` (specific files or `-A`) then `git commit`.
"nothing to commit" is treated as a non-error empty result.

### Push
`POST /api/git/push` → push current branch; first push uses `-u origin <branch>` to set upstream.
Requires an `origin` remote.

### Auto-commit
If the user enables "Auto-save to history on every Save", `cmsGit.onAfterSave` commits with the
auto-suggested message (`[cms] <page> · 1 Headings, 2 Page content, …`) after each editor Save.

**Note:** there is **no `/api/git/*` for pull/merge** — incoming "behind" changes are surfaced as
a pill but resolved by the user in a terminal. There is no auth on these endpoints (see flow 16).

---

## 13. AI assistant

**Files:** [src/editor/ai.js](./src/editor/ai.js) (agent) ↔ [src/server.js](./src/server.js) `/api/llm` (proxy)

> **Provider note:** the live implementation uses **NVIDIA-hosted Gemma**
> (`google/gemma-4-31b-it` via `integrate.api.nvidia.com`), proxied through the local server.
> (`README.md` §6 says "Gemini" — that is stale wording; the key dialog and code both say NVIDIA.)
> See [cost.md](./cost.md) for the token economics of this flow.

### Key plumbing
`getKey/setKey/clearKey` store the API key in `localStorage` (if "Remember") or `sessionStorage`
(otherwise) — never both. The ✨ AI button opens the key dialog if no key, else toggles the chat.

### The proxy (why it exists)
`POST /__cms/api/llm` reads the key from the `x-llm-key` header **only** to set `Authorization`
on a forwarded request to NVIDIA, then pipes the response back. It does **not** log or cache the
key. The proxy exists because `integrate.api.nvidia.com` sends no CORS headers, so a direct
browser fetch is blocked.

### The orchestration loop (`runAgent`)
```
onSend()
  refuse if hasChanges() (AI writes rewrite the file)
  push user msg, isThinking=true
  runAgent():
    buildScopeContext()   ── fresh GET /api/fields → manifest scoped to page-meta | section | whole-page
    system = SYSTEM_PROMPT_HEAD + page + manifest
    messages = [system, ...history(user/assistant only)]
    loop ≤16 iters:
      callLLM({ messages, tools: TOOL_SCHEMAS })   → text and/or toolCalls
      no toolCalls → final:
          render assistant text
          pendingPlan: exactly 1 update_field → AUTO-APPLY
                       else (≥2 edits, or any clone/delete/move/undo) → APPROVAL CARD
          return
      else: append assistant msg verbatim (preserves tool_call_ids)
            cap: if total > AI_MAX_TOOL_CALLS(8) → feed "limit reached" tool results + nudge to stop
            per call:
              parse error           → tool result {ok:false}, failures++
              update_field / DEFERRED(clone/delete/move/undo) → buffer into pendingPlan,
                                       reply {ok:true, deferred:true} so model keeps planning
              read tool              → execute now, feed JSON result back
            3 consecutive tool failures → abort with error
```

### Tools (10)
Read: `list_pages`, `get_page_fields`, `read_field`, `find_fields`, `get_section_list`.
Write: `update_field` (→ /api/save), `clone_section`, `delete_section`, `move_section`, `undo`.
Each dispatch is a thin fetch around an existing `/__cms/api/*` endpoint; `callTool` enforces a
whitelist and serialises thrown errors so the model can read them.

### Approval card
A buffered plan renders as a human-readable list (`humanizePlanItem`) with **Apply N / Cancel**.
`applyPlan` runs calls in order, stops on first error (reports the remainder as not applied), logs
each as a chat line, and calls `refreshFromServer()` so the sidebar re-syncs.

### Guardrails recap
Refuses out-of-scope asks (no raw HTML/CSS/JS, no new pages, no images/translation/builds);
8 tool calls/turn cap; 16-iteration safety net; manifest scoping + value truncation keep tokens
down; destructive/multi-step plans always require human approval. Error codes from `callLLM`
(`BAD_KEY`, `RATE_LIMIT`, `NETWORK`, …) surface as friendly chat errors.

---

## 14. Draft persistence + reload guard

**File:** [src/editor/drafts.js](./src/editor/drafts.js)

Three layers against accidental data loss:

1. **Auto-save:** every keystroke (via the sidebar `input` handler) debounces a 400 ms write of
   `state.changed` + `state.changedAlt` to `localStorage` under `cms-static.draft.<page>`. On the
   next load of that page, `maybeRestore` shows a banner: **Restore / Discard**. (Image crop blobs
   can't be serialised — the banner notes if crops were lost.)
2. **⌘R / Ctrl+R / F5 hijack:** with unsaved changes, the keystroke is intercepted and an in-app
   dialog offers **Save & reload / Discard & reload / Cancel** (richer than the native prompt).
3. **Native `beforeunload`:** the catch-all for the browser's own reload button / tab close. A
   `visibilitychange→hidden` and `beforeunload` flush also persist the latest draft synchronously.

Drafts are cleared on successful Save (`cmsDrafts.clear(page)`).

---

## 15. SEO / content validation

**File:** [src/editor/validation.js](./src/editor/validation.js)

After every `renderFields`, `cmsValidation.render(page, fields)` runs `checkPage`. v1 ships one
rule — **multiple `<h1>`**: if 2+ headings have `tag === 'h1'`, it renders a persistent warning
card at the top of the sidebar listing each h1 (text + section context) with click-to-jump (scroll
+ focus + flash the field), and toasts **once per transition** (signature-deduped, not per
re-render). It is built to extend: add a `checkX(fields)` returning the same
`{ code, severity, message, toast?, items? }` shape beside `checkH1`.

---

## 16. Cross-cutting: security & safety

- **Path traversal:** `safePath(siteRoot, rel)` (server) and the equivalent guard in
  [image.js](./src/image.js) resolve and assert the target stays under `siteRoot`; `..` escapes
  throw `Path escapes site root`. Applies to `/api/fields`, `/api/save`, all section ops, uploads.
- **Selector confinement:** section ops only accept `<section>` direct children of `<main>`
  (`SECTION_SELECTOR_RE`).
- **SSRF guard (image proxy):** http(s) only, 8 s timeout, 10 MB cap, image content-type required.
- **AI key handling:** stored client-side only; passed through the proxy via `x-llm-key`; never
  logged (`/api/llm` error path explicitly omits the key).
- **Upload limits:** multer 25 MB; cropper caps output at 2400 px and re-encodes.
- **No auth, no concurrency control.** This is a **local, single-user tool**. Do not expose port
  5174 publicly. Last write wins if you edit the same file in VS Code and the CMS simultaneously.
- **No server-side undo durability:** the section-op history is in-memory; restart loses it. Git
  is the real safety net — bring version control.

---

## 17. HTTP endpoint → flow map

| Method & path | Flow | Source |
|---|---|---|
| `GET /` | redirect to editor | server.js |
| `GET /__cms/*` | editor static assets | server.js / editor/* |
| `GET /__cms/api/workspace` | [18](#18-workspace-lifecycle-drop-mode) | workspace.js |
| `DELETE /__cms/api/workspace` | [18](#18-workspace-lifecycle-drop-mode) (Start over) | workspace.js |
| `POST /__cms/api/ingest/begin\|batch\|finish\|abort` | [19](#19-folder-ingestion-drop-mode) | ingest.js |
| `GET /__cms/api/export?variant=` | [20](#20-export) | exporter.js |
| `GET /__cms/api/pages` | [3](#3-page-discovery--the-page-picker) | discovery.js |
| `GET /__cms/api/fields?page=` | [2](#2-field-extraction-the-core-model) / [4](#4-loading-a-page-in-the-editor) | extractor.js |
| `POST /__cms/api/save` | [7](#7-the-save-round-trip) | applier.js |
| `POST /__cms/api/upload-image` | [8](#8-image-replace-file--crop--upload) | image.js |
| `GET /__cms/api/image-proxy?url=` | [9](#9-crop-an-existing-image--image-proxy) | image-proxy.js |
| `POST /__cms/api/clone-section` | [10](#10-section-operations-clone--delete--move--undo) | cloner.js |
| `POST /__cms/api/delete-section` | [10](#10-section-operations-clone--delete--move--undo) | section-ops.js |
| `POST /__cms/api/move-section` | [10](#10-section-operations-clone--delete--move--undo) | section-ops.js |
| `POST /__cms/api/undo` | [10](#10-section-operations-clone--delete--move--undo) | section-ops.js |
| `GET /__cms/api/undo-state?page=` | [4](#4-loading-a-page-in-the-editor) / [10](#10-section-operations-clone--delete--move--undo) | section-ops.js |
| `POST /__cms/api/build` | [11](#11-build-minified--formatted) | builder.js |
| `POST /__cms/api/llm` | [13](#13-ai-assistant) | server.js (proxy) |
| `GET /__cms/api/git/state` | [12](#12-git-flows) | git.js |
| `POST /__cms/api/git/init` | [12](#12-git-flows) | git.js |
| `POST /__cms/api/git/commit` | [12](#12-git-flows) | git.js |
| `POST /__cms/api/git/push` | [12](#12-git-flows) | git.js |
| `GET /<anything>` | static site (preview), `Cache-Control: no-store` | server.js |
</content>
</invoke>

---

## 18. Workspace lifecycle (drop mode)

**File:** [src/workspace.js](./src/workspace.js) ↔ [src/server.js](./src/server.js)

There is **one active workspace** at a time (local single-user tool). It is the
single seam every site route resolves through — routes read `req.siteRoot`,
which `requireWorkspace` sets from `workspace.getRoot()` (and freezes per-request
so a mid-request swap can't mix two roots).

```
os.tmpdir()/cms-static/                      (mode 0700, created on init)
   ws-<hex16>/            ← a promoted (active) drop workspace
      .cms-workspace.json ← { id, name, createdAt, lastAccess }  (dot-prefixed → invisible to discovery/build/export)
   ws-<hex16>-staging/    ← an in-progress ingest (see §19); renamed → ws-<hex16> on finish
```

- **classic mode:** `workspace.pin(dir)` marks the user's own folder active with
  `pinned:true, mode:'classic'` — **never swept, never deleted**.
- **drop mode:** ingest `finish` calls `workspace.activate({root, id, name})` with
  `mode:'drop'`. Activating a new workspace first **discards the previous drop
  workspace** (rm) and calls `sectionOps.clearAll()` so undo history can't leak
  across folders.
- **Dynamic static:** `express.static` binds its root at creation, so the server
  memoizes one instance per root string and rebuilds it only when the root
  changes; `Cache-Control: no-store` neutralises stale-after-swap.
- **TTL sweep:** on start + hourly (`unref`'d), drop workspaces with
  `lastAccess > 24h` and orphaned staging dirs `> 1h` are removed. `bumpMutation`
  touches `lastAccess` on every write so an actively-edited site is never swept.
- **Exit cleanup:** `SIGINT`/`SIGTERM`/`exit` remove the active *drop* workspace
  (pinned classic dirs are spared). A hard `kill -9` is covered by the next
  start's sweep.
- **Reset:** `DELETE /__cms/api/workspace` (Start over) discards the active drop
  workspace and returns the editor to the drop zone; `GET /__cms/api/workspace`
  reports `{ loaded, id, name, mode, pageCount }` (the absolute path is hidden in
  drop mode).

## 19. Folder ingestion (drop mode)

**Files:** [src/editor/ingest.js](./src/editor/ingest.js) (client) ↔ [src/ingest.js](./src/ingest.js) (server)

The browser can't hand the server a directory, so the client walks the folder
and streams files in capped multipart batches. **Three collectors** normalise to
one stream of `{ relPath, file }`:

1. **Folder picker** — `<input webkitdirectory>`; strip the picked folder name
   (the shared common-root) — that name becomes the workspace name.
2. **Drag-and-drop** — `webkitGetAsEntry` (entries grabbed *synchronously* before
   any await), recursive traversal with the **`readEntries`-until-empty loop**
   (Chromium returns ≤100/call), pruning skip-dirs *before* descending so
   `node_modules` is never enumerated.
3. **.zip** — unpacked **client-side** with vendored `fflate`, skip-filtered
   before inflate, `__MACOSX/` and directory entries dropped.

A shared filter skips `node_modules/.git/_minified/_formatted/.vscode/.idea`,
dot-entries, `Thumbs.db/desktop.ini`, and files > 25 MB (with a visible
skipped-list). Then the **uploader**:

```
POST /ingest/begin   {name,totalFiles,totalBytes}  → {uploadId}    (413 if >5000 files / >500MB)
     server mkdirs ws-<uploadId>-staging, records an in-memory session (30-min TTL)
POST /ingest/batch × N  (pool of 3 XHRs, batch = 40 files or 8MB)
     multipart: files[] + uploadId + paths(JSON, index-aligned & authoritative)
     dedicated multer instance (memoryStorage, fileSize 25MB, files 64)
     each file → resolveInRoot(staging, relPath) + server-side skip re-check → write; record in `received`
     xhr.upload.onprogress drives a byte-accurate progress bar; per-batch 3 retries w/ backoff
POST /ingest/finish  {uploadId, manifest:[{path,size}]}
     diff manifest vs received → missing? 409 {missing:[…]} (client re-uploads just those)
     complete → ATOMIC rename staging → ws-<uploadId>, workspace.activate(), clearAll history
                warn if 0 pages or index.html looks minified → {ok, name, pageCount, warnings}
POST /ingest/abort   {uploadId}  → rm staging
```

Nothing is promoted out of staging until `finish` confirms every manifest file
arrived, so an abandoned upload never corrupts an active workspace. On success
the client calls `refreshWorkspaceState()` and the editor swaps from the drop
zone to the normal two-pane view.

## 20. Export

**Files:** [src/exporter.js](./src/exporter.js) ↔ [src/server.js](./src/server.js) `/api/export`

**Trigger:** ⤓ Export → the browser navigates to
`GET /__cms/api/export?variant=minified` via a hidden `<a download>`.

```
export?variant=minified
  ├─ dirty check (O(1), no mtime scan): rebuild iff
  │     builtForId !== current workspace id   (new site since last build)
  │     OR lastMutationAt > lastBuildAt         (edited since last build)
  │     OR _minified/ missing
  ├─ archiver('zip', level 6) streamed to res (flat RSS even at 200MB sites)
  │     manual SKIP-aware walk (never ships node_modules/.git/_formatted/_minified-nesting)
  │     store:true for jpg/png/webp/gif/avif/mp4/woff/woff2/pdf (already compressed)
  │     symlinks skipped (never archived)
  │     entries under "<siteName>-minified/" root prefix
  │     Content-Disposition: attachment; filename="<siteName>-minified.zip" (+ RFC5987)
  └─ res.on('close') → archive.abort()  ·  error → destroy response
```

`variant` is parametric internally (`minified` | `formatted` | `source`), but the
UI only exposes **minified** — the deployable artifact. `siteName` comes from the
workspace metadata (the dropped folder's name), `path.basename(root)` in classic
mode.
