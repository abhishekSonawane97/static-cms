# cms-static

A **zero-config local CMS layer** for any static HTML/CSS/JS site folder.
Drop a folder in, get a browser-based editor, save your changes, get formatted + minified output.

> Built for developers who maintain plain static sites by hand and need a way to safely edit text, SEO metadata, JSON-LD schema, and images — without introducing a framework, build step, or hosted CMS account.

---

## Table of contents

- [What is this?](#what-is-this)
- [Why it exists](#why-it-exists)
- [Quick start (60 seconds)](#quick-start-60-seconds)
- [The 5-minute walkthrough](#the-5-minute-walkthrough)
- [Concepts](#concepts)
  - [Zero-config](#zero-config)
  - [Editable fields](#editable-fields)
  - [Field IDs are session-local](#field-ids-are-session-local)
- [What gets detected as editable](#what-gets-detected-as-editable)
- [What does NOT get edited](#what-does-not-get-edited)
- [The save round-trip](#the-save-round-trip)
- [Image upload + cropping](#image-upload--cropping)
- [The Build button — minified + formatted output](#the-build-button--minified--formatted-output)
- [Architecture](#architecture)
- [HTTP API reference](#http-api-reference)
- [How to run on a different site](#how-to-run-on-a-different-site)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Limitations (v1)](#limitations-v1)
- [Roadmap (v1.1, v2)](#roadmap-v11-v2)
- [How to extend](#how-to-extend)
- [Development](#development)
- [Frequently asked questions](#frequently-asked-questions)
- [Credits](#credits)

---

## What is this?

`cms-static` is a tiny Node.js CLI tool that **wraps any static site folder with a CMS-like editing UI**. You either **drop a folder into the browser** (drop mode) or **point it at a folder on disk** (classic mode) — a folder containing `.html`, `.css`, `.js`, and `images/` — and it:

1. Walks the folder, finds every `.html` page.
2. Auto-detects what's editable on each page using semantic HTML rules — no schema, no config files.
3. Serves a two-pane browser editor at `http://localhost:5174/__cms/`:
   - Sidebar form with grouped, labelled fields (SEO / Schema / Headings / Body / Images)
   - Live iframe preview of the actual page
4. On save, edits round-trip back into your **source files** via [`cheerio`](https://cheerio.js.org/) (HTML mutation) + [`js-beautify`](https://beautifier.io/) (pretty-print).
5. On **Build**, it produces:
   - `_minified/` — runs your site's existing `build.js` to emit a deployable, compressed copy
   - `_formatted/` — a parallel mirror of source files, pretty-printed via `js-beautify`
6. **AI chat (optional)**: bring an **NVIDIA API key** (hosted Gemma), click ✨ AI in the sidebar, and describe an edit in plain English. The agent only calls the same edit / clone / delete / move / undo endpoints the buttons do — multi-step or destructive plans surface an approval card before anything is written. See `design-flow.md §4.19` and [cost.md](./cost.md).
7. **Inline edit**: hover any text in the live preview → outline appears. Click → type. Floating Done / Cancel bar appears above the element. Changes flow through the same sidebar change-tracker; Save / Undo / Build are unaffected. Carousels, forms, and metadata still use the sidebar. See `design-flow.md §4.20`.
8. **Draft safety net**: every keystroke auto-saves to `localStorage`. Accidental refresh, tab close, or browser crash → reopen the editor and a banner offers to restore your unsaved edits. Pressing ⌘R / Ctrl+R / F5 with unsaved changes shows a Save & reload / Discard & reload / Cancel dialog instead of the generic browser prompt. See `design-flow.md §4.21`.
9. **SEO validation**: a page with 2+ `<h1>` tags surfaces a warning card listing each one with click-to-jump-to-sidebar, plus a toast on each transition. Extensible — drop a new `checkX(fields)` function in `validation.js` for additional rules. See `design-flow.md §4.22`.

It is **not**:

- A page builder. You can't drag-and-drop sections, change layout, or add new pages.
- A hosted SaaS. It runs locally on your machine. Nothing leaves your laptop.
- An opinionated framework. It edits files in place; bring your own version control.

---

## Why it exists

If you have a hand-written static site — say, a hotel chain marketing site with 30 HTML pages, JSON-LD schema, og:image meta, and ~300 image references — there are exactly three ways to update content today:

1. **Edit HTML/CSS/JS by hand.** Fast for a developer, slow and error-prone for anyone who isn't.
2. **Migrate to a real CMS** (WordPress, Sanity, Contentful, etc.). Throws away the static site's simplicity, requires schema and re-rendering.
3. **Use a Git-based CMS** (Decap, Tina, CloudCannon, Stackbit). All of these require either YAML schema files, content models, or a Git workflow.

`cms-static` fills the gap: **drop folder → edit in browser → save**. No accounts, no schema, no framework, no rebuilds. Source files stay as the single source of truth and remain diff-friendly in Git.

The market doesn't have anything that does this. So we built it as a small, focused tool — under 1,000 lines of code total.

---

## Quick start (60 seconds)

You need **Node.js ≥ 18** installed.

```bash
cd /home/abhishek/cms-static
npm install              # one time, installs deps + their tree
```

There are **two ways to run it.**

### Drop mode (default — no folder argument)

Start with no folder, then drag a site folder into the browser:

```bash
node bin/cli.js
```

```
  cms-static  v0.2
  --------------------------------------------------
  Site:    (none yet — drop a folder in the editor)
  Editor:  http://localhost:5174/__cms/
```

Open the **Editor** URL. You'll see a **drop zone** — drag a folder of static
HTML/CSS/JS onto it, click **Choose a folder…**, or upload a **.zip**. The app
holds a private working copy locally (never uploaded to the cloud, auto-wiped
when you close it), you edit, and when you're done you click **Export** to
download the final **minified** site as a `.zip`. `node_modules`, `.git`, and
build output are skipped automatically on upload.

### Classic mode (point at a folder on disk)

Edit a folder in place, exactly like before — this also unlocks the **Git panel**
(commit/push), since the folder is durable and yours:

```bash
node bin/cli.js /path/to/your/static/site
```

Different port (default `5174`) in either mode:

```bash
PORT=8080 node bin/cli.js
```

---

## The 5-minute walkthrough

After running the tool and opening [http://localhost:5174/__cms/](http://localhost:5174/__cms/):

```
┌─────────────────────────────┬────────────────────────────────┐
│                             │  cms-static · kavinhotels/dist │
│                             │  [akasa-dalhousie/index.html ▾]│
│                             │ ─────────────────────────────  │
│                             │  ▼ SEO                    8    │
│                             │    Page title  […]             │
│                             │    Meta desc   [……………………]     │
│                             │    OG image    [thumb][Replace]│
│                             │  ▼ Schema (LodgingBusiness) 19 │
│                             │    name        […]             │
│   live preview iframe       │    description [……………]         │
│                             │    address.streetAddress […]   │
│                             │  ▼ Headings                35  │
│                             │    H1 hero […]                 │
│                             │  ▼ Body                    92  │
│                             │    Hero sub […]                │
│                             │  ▼ Images                  21  │
│                             │    [thumb][Replace] alt:[…]    │
│                             │                                │
│                             │  [💾 Save] [⬇ Build]  ●unsaved │
└─────────────────────────────┴────────────────────────────────┘
```

### Step-by-step

**1. Pick a page.** From the dropdown at the top of the sidebar, pick any page (e.g. `akasa-dalhousie/index.html`). The right pane loads the actual page in an iframe; the sidebar populates with editable fields grouped into 5 sections.

**2. Edit a heading or body text.** Open the **Body text** or **Headings** group. Each field has a monospace label like `hero-content — h1 · "Close to The Mall…"` showing the parent section context and a text preview. Edit any value — the field background turns peach (it's "dirty"), the status bar shows `● unsaved`, and the **Save** button becomes enabled.

**3. Edit SEO metadata.** Open the **SEO** group. You'll find:
- Page title (`<title>`)
- Meta description
- OG title / OG description / OG image (image picker)
- Twitter title / Twitter description / Twitter image (image picker)

**4. Edit JSON-LD schema.** Open the **Schema (…)** group. Each `<script type="application/ld+json">` block is flattened into editable fields. For a typical `LodgingBusiness`:
- `name`
- `description`
- `url`
- `priceRange`
- `telephone`
- `address.streetAddress`
- `address.addressLocality`
- `address.postalCode`
- `geo.latitude` / `geo.longitude`
- … etc.

Number and boolean fields are coerced back to their original type on save (so `numberOfRooms: 5` stays a number, not `"5"`).

**5. Replace an image.** Open the **Images** group. For each `<img>` you'll see a thumbnail, the file path, an **alt text** input, and a **Replace…** button.
   - Click **Replace…** → file picker opens
   - Pick an image from your machine
   - The **Cropper.js modal** opens. The "Match original" aspect-ratio preset is auto-selected (locks the crop to whatever ratio the existing image is rendered at on the page).
   - Drag and resize the crop box. Switch the aspect dropdown if you want Free / 16:9 / 4:3 / 3:2 / 1:1 / 2:3.
   - Click **Save crop**. The thumbnail updates instantly; the new image is queued for upload.

**6. Save.** Click **💾 Save** (or `Cmd/Ctrl+S`). Three things happen:
   - Pending images are POSTed and re-encoded server-side via Sharp, written to disk under `/images/...` (overwriting the original path by default — bring Git).
   - All field changes (text, alt, JSON-LD) are sent as one payload.
   - The server re-parses the source HTML, applies changes via cheerio, pretty-prints with js-beautify, and writes the file back.
   - The preview iframe and field list refresh from disk to reflect the saved state.

**7. Build.** Click **⬇ Build**. This produces:
   - `_minified/` — your existing `build.js` runs and outputs a compressed deployable copy.
   - `_formatted/` — a parallel walk via `js-beautify` outputs a pretty-printed mirror of source files (HTML, CSS, JS).

Both are placed at the root of your site folder.

**8. Verify in Git.** Open a terminal:
```bash
cd /path/to/your/site
git diff
```
You'll see only the lines that changed. The rest of the file is untouched (subject to js-beautify's whole-file reformat — see [Limitations](#limitations-v1)).

---

## Concepts

### Zero-config

`cms-static` does not read any config files. There are **no** schema definitions, no front-matter, no `cms.config.js`, no markers in your HTML. The tool inspects each page semantically and figures out what's editable based on element types and context.

This is the trade-off vs. tools like Decap or Tina:

| | Schema-based CMS | `cms-static` |
|---|---|---|
| Setup | Define a YAML/TS schema for every content type | None |
| Field labels | Human-friendly (you write them) | Auto-derived from CSS class / id / nearest heading |
| Fine control | Total — you list exactly what's editable | Coarse — everything semantic is exposed |
| Works on any site | No — schema must match the site | Yes |
| Onboarding cost | Hours per site | Zero |

If you want fine control later, [add a config file](#configuration) — it's the natural v1.1 extension.

### Editable fields

A "field" is a single editable thing the CMS exposes. It's identified by:

- **`id`** — session-local string like `seo:1`, `h1:28`, `img:154`. Recomputed on every page load.
- **`group`** — UI category: `SEO`, `Schema (…)`, `Headings`, `Body text`, `Images`.
- **`type`** — UI control: `text`, `longtext` (textarea), or `image`.
- **`label`** — auto-derived human-readable label (e.g. `hero-content — h1 · "Close to The Mall…"`).
- **`selector`** — CSS path used to locate the element on save (e.g. `body > main#main > section:nth-of-type(1) > div:nth-of-type(2) > h1#heroHeading`).
- **`attr`** — what attribute to write back to (`text`, `html`, `content`, `src`).
- **`value`** — current value.
- **JSON-LD-only**: `scriptIndex`, `arrayIndex`, `jsonPath` — for editing inside `<script type="application/ld+json">`.
- **Image-only**: `altAttr`, `alt`, `width`, `height`.

You'll see the underlying field shape if you hit the [`/__cms/api/fields`](#http-api-reference) endpoint directly.

### Field IDs are session-local

A common CMS gotcha: how do you persist edits when the DOM might get restructured between sessions?

Most CMSes solve this by writing IDs into the source (`data-tina-id="…"`) or requiring a schema. Both are invasive.

`cms-static` **never writes IDs into source**. Each time a page loads in the editor:
1. Server walks the DOM, generates fresh IDs based on `(file path, selector path, occurrence)`.
2. Client sends edits keyed by those IDs.
3. Server applies edits in the same DOM tree it just generated IDs from.
4. Source file is written. IDs are thrown away.

The next session starts fresh. The trade-off: if you edit raw HTML in between sessions and shift element order, the field labels in the sidebar may shift too — but the data integrity is preserved (we always operate on freshly-extracted state).

---

## What gets detected as editable

For every HTML page, the extractor scans:

| Source | Group | Type | Notes |
|---|---|---|---|
| `head > title` | SEO | text | |
| `head > meta[name="description"]` | SEO | longtext | |
| `head > meta[property="og:title"]` | SEO | text | |
| `head > meta[property="og:description"]` | SEO | longtext | |
| `head > meta[property="og:image"]` | SEO | image | |
| `head > meta[name="twitter:title"]` | SEO | text | |
| `head > meta[name="twitter:description"]` | SEO | longtext | |
| `head > meta[name="twitter:image"]` | SEO | image | |
| `<script type="application/ld+json">` | Schema (`@type`) | text/longtext | Top-level scalar fields + 1 level of nested objects (e.g. `address.streetAddress`). Arrays are skipped in v1. |
| `main h1, h2, h3, h4` | Headings | longtext (HTML) | Inline tags like `<em>`, `<strong>`, `<a>` are preserved in the value so you can edit rich text. |
| `main p, li, blockquote, figcaption, dt, dd` | Body text | longtext (HTML) | Same — inline tags preserved. |
| `main img` | Images | image | Thumbnail, path, alt input, Replace button. |

If there's no `<main>` element, the extractor falls back to `<body>` (will pick up nav/footer items in that case — most modern sites have `<main>`).

## What does NOT get edited

The following are **explicitly excluded** to avoid editing structure or non-content:

- Elements inside `<nav>`, `<footer>`, `<header>`, `<svg>`, `<button>`, `<form>`, `<script>`, `<style>`
- Hyperlinks (`<a href>`) — link targets are structural, not content
- Class names, IDs, data attributes
- Inline SVG icons
- Form `<option>` lists (deferred to v2)
- JS data structures inside script files (`window.KAVIN_PROPERTIES` arrays etc.) — deferred to v2 (needs JS AST mutation)
- CSS files (color tokens, layout etc.) — out of scope
- File names, folder structure
- The `<meta http-equiv="refresh">` redirects (treated as structural)

If you need to edit something in this list, edit the file directly — `cms-static` will leave it alone.

---

## The save round-trip

When you click **Save**:

```
[browser]                                    [server]
   │
   │ Pending image uploads (1 per replaced image):
   ├─POST /__cms/api/upload-image──────────► sharp re-encode → write to /images/…
   │   (multipart: image blob + destPath)    return { ok, path, bytes, width, height }
   │◄──────────────────────────────────────────
   │
   │ Single batched edit POST:
   ├─POST /__cms/api/save ─────────────────►
   │   {                                     1. read source HTML
   │     "page": "akasa-dalhousie/index.html", 2. cheerio.load
   │     "changes": [                        3. for each change, .text() / .html() / .attr()
   │       { id, selector, attr, value },    4. for JSON-LD: parse → setNestedValue → stringify
   │       { id, scriptIndex, jsonPath, value }, 5. js-beautify the whole document
   │       …                                  6. fs.writeFileSync()
   │     ]
   │   }
   │◄──────────────────────────────── { ok: true, bytes: 61091 }
   │
   │ Editor refreshes preview + reloads fields
```

### Pretty-printing

After cheerio applies changes, the entire document goes through `js-beautify` with these settings:

```js
{
  indent_size: 2,
  indent_inner_html: false,
  wrap_attributes: 'auto',
  end_with_newline: true,
  preserve_newlines: false,
  max_preserve_newlines: 1,
  inline: ['em', 'strong', 'b', 'i', 'u', 'span', 'a', 'small', 'code', 'sub', 'sup', 'br'],
}
```

The "inline" list keeps inline tags from being broken onto their own lines. If you want to change the formatter style, edit [`src/applier.js`](./src/applier.js) — search for `beautify(` near the bottom of `applyChanges()`.

---

## Image upload + cropping

Image flow uses three pieces:

1. **Browser**: [Cropper.js](https://github.com/fengyuanchen/cropperjs) (loaded from CDN) provides the crop UI — drag, resize, rotate, aspect-ratio lock.
2. **HTTP**: Multipart POST with `image` (the Blob) and `destPath` (the target file path, relative to site root).
3. **Server**: [Sharp](https://sharp.pixelplumbing.com/) re-encodes the buffer based on file extension:
   - `.jpg` / `.jpeg` → progressive mozJPEG, quality 82
   - `.png` → compression level 9
   - `.webp` → quality 82
   - `.avif` → quality 50
   - anything else → fallback to JPEG quality 82

**Default destination**: same path as the original `<img src>`. If you replace `/images/akasa/cbeac70c.jpg`, the new image overwrites that exact file.

**To use a new filename**: in the sidebar, click into the path text under the thumbnail and edit it before clicking Save. (Implementation detail — currently the path field is shown as a label; user-edit on the path is a v1.1 enhancement.)

**If Sharp fails to install** (rare; happens on locked-down environments): the tool gracefully degrades — image bytes are written as-is without re-encoding. The `sharp: false` flag in the upload response tells you this happened.

**Output size cap**: Cropper.js renders the cropped canvas at most 2400×2400 pixels before sending the blob. Adjust in [`src/editor/cropper-modal.js`](./src/editor/cropper-modal.js) → `maxWidth` / `maxHeight`.

---

## The Build button — minified + formatted output

Clicking **⬇ Build** triggers `POST /__cms/api/build`. The server runs two independent pipelines:

### `_minified/`

If your site has a `build.js` at its root, the tool spawns `node build.js` as a child process inside the site folder. For the Kavin Hotels site, this uses:

- `html-minifier-terser` (compress HTML, inline CSS, inline JS)
- `terser` (compress standalone .js)
- `clean-css` (compress .css)

Output goes to `<site>/_minified/`. This is the deployable artifact.

If your site has no `build.js`, you'll see `"minified": { "ok": false, "error": "No build.js in site root; skipped minification." }` — the formatted pipeline still runs.

### `_formatted/`

Independent of the user's build, `cms-static` walks the site again and produces a pretty-printed mirror in `<site>/_formatted/`:

- `.html` → `js-beautify.html()` with the same settings as save
- `.css` → `js-beautify.css()`
- `.js` → `js-beautify.js()` with newlines preserved
- everything else → copied as-is

This is the "formatted version" output the user originally asked for. Useful when source files are minified and you want a human-readable copy without modifying source.

### Skip list

Both pipelines skip: `_minified`, `_formatted`, `node_modules`, `.git`, `.vscode`, `.idea`, `dist`, `build`, `build.js`, `package.json`, `package-lock.json`, plus all dotfiles.

---

## Architecture

```
cms-static/
├── package.json                # dependencies + bin entry
├── README.md                   # this file
├── bin/
│   └── cli.js                  # CLI entrypoint, sanity checks, server bootstrap
└── src/
    ├── server.js               # Express app; routes for pages/fields/save/upload/build
    ├── discovery.js            # Walks site dir, returns sorted list of HTML pages
    ├── extractor.js            # cheerio: HTML → field descriptor JSON
    ├── applier.js              # cheerio: apply changes → js-beautify pretty-print
    ├── image.js                # Sharp re-encode + write to disk
    ├── builder.js              # Spawn user's build.js + emit _formatted/ via js-beautify
    └── editor/                 # Static frontend, served from /__cms/
        ├── index.html          # Two-pane shell + crop dialog
        ├── editor.css          # Sidebar + form + crop dialog styles
        ├── editor.js           # Page picker, field renderer, save flow, status bar
        └── cropper-modal.js    # Cropper.js wrapper, aspect presets, blob upload
```

**No frontend framework.** The editor is plain DOM + `fetch()` — under 300 lines.

**Cropper.js is loaded from the CDN** (`unpkg.com`). For fully offline use, install `cropperjs` as a dep and serve from `node_modules` — see [How to extend](#how-to-extend).

### Data flow

```
[CLI: bin/cli.js]
    ↓
[Express: src/server.js]
    ↓ (routes)
    ├── GET /__cms/* ─────────► editor static files
    │
    ├── /__cms/api/pages ─────► discovery.js
    │
    ├── /__cms/api/fields ────► extractor.js
    │                              └──── cheerio
    │
    ├── /__cms/api/save ──────► applier.js
    │                              ├──── cheerio
    │                              └──── js-beautify
    │
    ├── /__cms/api/upload-image► image.js
    │                              └──── sharp
    │
    └── /__cms/api/build ─────► builder.js
                                   ├──── spawn(node build.js)
                                   └──── js-beautify (mirror walk)
```

---

## HTTP API reference

All endpoints are under `/__cms/api/`. They speak JSON unless noted.

### `GET /__cms/api/pages`

List every editable HTML page in the site folder.

**Response**:
```json
{
  "root": "/home/abhishek/kavinhotels/dist",
  "pages": [
    "akasa-dalhousie/about/index.html",
    "akasa-dalhousie/index.html",
    "collections.html",
    "index.html"
    /* ... */
  ]
}
```

### `GET /__cms/api/fields?page=<path>`

Extract editable fields from a single page. `page` is relative to site root.

**Response**:
```json
{
  "page": "akasa-dalhousie/index.html",
  "fields": [
    {
      "id": "seo:0",
      "group": "SEO",
      "type": "text",
      "label": "Page title",
      "selector": "head > title",
      "attr": "text",
      "value": "Akasa Dalhousie | …"
    },
    {
      "id": "img:154",
      "group": "Images",
      "type": "image",
      "label": "cbeac70c.jpg",
      "selector": "body > main#main > section:nth-of-type(1) > div:nth-of-type(1) > img",
      "attr": "src",
      "altAttr": "alt",
      "value": "/images/akasa/cbeac70c.jpg",
      "alt": "",
      "width": null,
      "height": null
    }
    /* ... */
  ]
}
```

### `POST /__cms/api/save`

Apply a batch of edits to one source file.

**Body**:
```json
{
  "page": "akasa-dalhousie/index.html",
  "changes": [
    {
      "selector": "head > meta[name=\"description\"]",
      "attr": "content",
      "value": "New meta description text"
    },
    {
      "scriptIndex": 0,
      "jsonPath": "address.postalCode",
      "value": "176304"
    },
    {
      "selector": "body > main#main > … > img",
      "attr": "src",
      "value": "/images/akasa/cbeac70c.jpg",
      "altAttr": "alt",
      "alt": "Pine forest at Akasa Dalhousie"
    }
  ]
}
```

Each change must include either `selector + attr` (DOM edit) **or** `scriptIndex + jsonPath` (JSON-LD edit).

**Response**: `{ "ok": true, "bytes": 61091 }`

### `POST /__cms/api/upload-image`

Multipart form upload. Fields:
- `image` (file): the cropped image blob
- `destPath` (string): target path relative to site root (`/images/akasa/cbeac70c.jpg`)

**Response**:
```json
{
  "ok": true,
  "path": "/images/akasa/cbeac70c.jpg",
  "bytes": 45821,
  "width": 1600,
  "height": 900,
  "sharp": true
}
```

`sharp: false` means Sharp wasn't available and the raw bytes were written.

### `POST /__cms/api/build`

Trigger both build pipelines.

**Response**:
```json
{
  "minified": { "ok": true, "log": "Minifying project…\n…" },
  "formatted": { "ok": true, "formatted": 55, "copied": 39 }
}
```

If `build.js` is absent: `minified: { ok: false, error: "No build.js in site root; skipped minification." }`.

### Static routes

- `GET /` — redirects to `/__cms/`
- `GET /__cms/*` — serves editor frontend assets
- `GET /<anything-else>` — serves the user's site as static files (`Cache-Control: no-store` so edits are instant)

---

## How to run on a different site

`cms-static` is folder-agnostic. Point it at any static-site folder:

```bash
node bin/cli.js /path/to/some-other-site
```

It will:
1. Refuse to start if the folder doesn't exist or doesn't contain HTML.
2. Refuse to start if `index.html` looks minified (single huge line, < 5 newlines, > 5 KB) — most likely you pointed at a build output.
3. Discover all pages and serve the editor.

Different port (default `5174`):
```bash
PORT=8080 node bin/cli.js /path/to/your/site
```

---

## Configuration

There is **no config file** in v1. The tool's behaviour is controlled entirely by:

1. The structure of your HTML (semantic tags, `<main>` element, `<script type="application/ld+json">`).
2. CLI args (`PORT` env var, site folder path).
3. Source-code constants in `src/extractor.js` if you want to fork the rules:
   - `EXCLUDED_ANCESTORS` — element types whose descendants are skipped.
   - `HEADING_TAGS` — what counts as a heading.
   - `BODY_TAGS` — what counts as body content.
   - `SEO_META` — which `<meta>` tags get exposed as SEO fields.

A v1.1 enhancement to read an optional `.cmsconfig.json` for per-site overrides is in the [Roadmap](#roadmap-v11-v2).

---

## Troubleshooting

### "Editor URL shows the user's site instead of the editor"

The `/` route should redirect to `/__cms/`. If it doesn't, you might be pointing at the wrong URL. The editor lives at **`http://localhost:5174/__cms/`**, not `/`.

### "Sidebar shows zero fields"

The page's HTML probably doesn't have `<main>` and your content is wrapped in `<body>` directly. Two options:
1. Add a `<main>` wrapper around your content (best practice anyway).
2. Edit `src/extractor.js` to remove the `main || body` fallback strictness.

### "My headings are missing from the sidebar but they're in the HTML"

Most likely they're inside an `EXCLUDED_ANCESTORS` element. Headings inside `<header>`, `<nav>`, `<footer>`, etc. are explicitly skipped. Check by viewing the page source — is the heading inside one of those?

### "Save fails with `Path escapes site root`"

You're trying to save a `page` parameter that resolves outside the site root (e.g. `../../../etc/passwd`). The server refuses these. Make sure the page path comes from the picker and isn't crafted by hand.

### "Image upload returns 500 / Sharp error"

Sharp may not have installed correctly (some musl-libc Linux distros, or restricted CI). Try:
```bash
cd cms-static
npm rebuild sharp
```
If that fails, the tool still works — it just won't re-encode the image; it writes the raw bytes you uploaded.

### "Build button: minified failed but formatted worked"

You either don't have a `build.js` in your site root (expected — `_formatted/` runs anyway), or `node build.js` failed. Check the `error` field in the response, then run `node build.js` manually inside your site folder to see the full error.

### "Diff after save is huge — every line changed"

`js-beautify` reformatted the whole file according to its settings, not just the lines you touched. Two options:
1. Run a one-time pre-format pass to align your source with `js-beautify`'s style — after that, future saves only show the actual content diff.
2. Tweak the settings in `src/applier.js` to better match your style (try `wrap_attributes: 'force-aligned'`, or different indent sizes).
3. Wait for v2's "minimal-touch" applier (Roadmap).

### "Cropper.js fails to load"

The CDN URL is `https://unpkg.com/cropperjs@1.6.1/dist/cropper.min.{js,css}`. If you have no internet access, see [How to extend → Offline Cropper.js](#how-to-extend).

### "Cmd+S does the browser save dialog"

The editor.js handler should be intercepting it. Check that the editor JS loaded correctly (open DevTools → Console). If you have a browser extension that overrides Cmd+S, disable it for `localhost`.

---

## Limitations (v1)

By design, v1 does NOT support:

| Limitation | Reason | Workaround |
|---|---|---|
| Editing JS data arrays (`window.KAVIN_PROPERTIES`) | Needs JS AST mutation (acorn/recast) | Edit the JS file directly |
| Editing CSS files (colour tokens, breakpoints) | Out of content scope | Edit CSS directly |
| CSS-file `background-image: url(…)` | Would need CSS parsing | Use inline `style="background-image:..."` instead, or wait for v2 |
| Adding new pages, sections, or images from scratch | Page-builder territory | Hand-create the HTML, then edit content via CMS |
| Reordering elements | Page-builder territory | Hand-edit |
| Editing form `<option>` lists | v2 (different field group needed) | Hand-edit |
| JSON-LD arrays (`amenityFeature: [...]`) | v1 only handles scalars + 1-level objects | Hand-edit |
| Multiple users editing concurrently | Local-only by design | Use Git for collaboration |
| Authentication | None — local only | Don't expose port `5174` publicly |
| Undo / history | None | Use Git |
| Live multi-page preview | Iframe only shows one page at a time | Use the page picker |

---

## Roadmap (v1.1, v2)

**v1.1** (small additions, no architecture changes):

- [ ] Optional `.cmsconfig.json` for per-site rules (extra excluded selectors, custom field labels, image folder location, default aspect ratios per image)
- [ ] Inline editing of the path text under image thumbnails (so you can save crops to a new filename)
- [ ] `--no-image-processing` flag to skip Sharp entirely
- [ ] `--watch` mode that hot-reloads the iframe when source files change externally
- [ ] Dark mode for the editor
- [ ] Vendored Cropper.js (no CDN dependency)
- [ ] Auto-generate `srcset` variants when an image is uploaded (off by default; on with `--responsive`)

**v2** (larger features):

- [ ] JS data-array editor — parse `window.KAVIN_PROPERTIES` etc. via acorn AST, surface as a structured table editor
- [ ] Form `<option>` list editor (group: "Forms")
- [ ] JSON-LD array support (`amenityFeature` etc.)
- [ ] CSS-file `background-image` swapping
- [ ] Multi-user / hosted deployment with simple auth (basic-auth or magic-link)
- [ ] "Minimal-touch" applier — only rewrite the changed line ranges, leave the rest of the file byte-stable
- [ ] Site-wide search & replace ("rename brand from X to Y across all pages")
- [ ] Snapshot/restore (lightweight history without Git)

---

## How to extend

### Add a new field type

1. In `src/extractor.js`, push new field descriptors with a custom `group` and `type` from your detection logic.
2. In `src/editor/editor.js`, extend `renderField()` to handle the new `type` string.
3. In `src/applier.js`, the existing logic uses `selector + attr` — most new types should work without changes.

### Vendor Cropper.js (offline)

```bash
cd cms-static
npm install cropperjs@1.6.1
mkdir -p src/editor/vendor
cp node_modules/cropperjs/dist/cropper.min.js src/editor/vendor/
cp node_modules/cropperjs/dist/cropper.min.css src/editor/vendor/
```

Then edit `src/editor/index.html`:
```html
<link rel="stylesheet" href="vendor/cropper.min.css">
…
<script src="vendor/cropper.min.js"></script>
```

### Customise the formatter

All `js-beautify` calls live in:
- `src/applier.js` (save flow)
- `src/builder.js` (Build → `_formatted/`)

Adjust `indent_size`, `wrap_attributes`, `preserve_newlines`, etc. See [the js-beautify options](https://github.com/beautifier/js-beautify#options).

### Skip more elements globally

Edit `EXCLUDED_ANCESTORS` in `src/extractor.js`. Anything inside those selectors will not be exposed as fields.

```js
const EXCLUDED_ANCESTORS = ['nav', 'footer', 'svg', 'button', 'form', 'script', 'style', 'header', '.no-cms'];
```

Add `.no-cms` and slap that class on any element you want to lock from editing.

---

## Development

### Layout

```
cms-static/
├── bin/cli.js            ← entrypoint
├── src/                  ← all logic
└── package.json
```

### Running locally during development

```bash
cd /home/abhishek/cms-static
node bin/cli.js /home/abhishek/kavinhotels/dist
```

There's no watch / reload of the cms-static code itself in v1. If you change `src/*.js`, restart the process.

For frontend changes (`src/editor/*`), just refresh the browser — those are served statically.

### Testing

There are no automated tests in v1. To smoke-test:

```bash
# Start the server
node bin/cli.js /home/abhishek/kavinhotels/dist &
sleep 1

# 1. Pages list
curl -s http://localhost:5174/__cms/api/pages | head -c 400

# 2. Field extraction
curl -s "http://localhost:5174/__cms/api/fields?page=akasa-dalhousie/index.html" \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); console.log('fields:', d.fields.length);"

# 3. Save round-trip
curl -s -X POST http://localhost:5174/__cms/api/save \
  -H 'content-type: application/json' \
  -d '{"page":"akasa-dalhousie/index.html","changes":[
    {"selector":"head > meta[name=\"description\"]","attr":"content","value":"test"}
  ]}'

# 4. Build
curl -s -X POST http://localhost:5174/__cms/api/build | head -c 200

# Stop the server
pkill -f "cms-static/bin/cli.js"
```

### Dependencies

| Package | Purpose | License |
|---|---|---|
| [express](https://expressjs.com/) | HTTP server | MIT |
| [cheerio](https://cheerio.js.org/) | Server-side HTML parsing & mutation | MIT |
| [sharp](https://sharp.pixelplumbing.com/) | Image resize / crop / re-encode | Apache-2.0 |
| [multer](https://github.com/expressjs/multer) | Multipart form parsing | MIT |
| [js-beautify](https://github.com/beautifier/js-beautify) | HTML/CSS/JS pretty-printing | MIT |
| [cropperjs](https://github.com/fengyuanchen/cropperjs) (CDN) | Browser-side image cropper | MIT |

All vendored dependencies are MIT or compatible.

---

## Frequently asked questions

**Q: Will it work on my hand-written PHP / Jinja / EJS templates?**
A: No. v1 only edits raw `.html` files. Templates that render HTML at request time are out of scope — once they output HTML, the CMS would edit the rendered output, not the template, which is the wrong layer.

**Q: Does it modify my Git history?**
A: No. The tool only edits files under your site folder. It doesn't `git add`, `git commit`, or anything similar. Use Git as you normally would.

**Q: Can I commit `_minified/` and `_formatted/`?**
A: Add them to `.gitignore`. They're generated artifacts. The single source of truth is your source HTML/CSS/JS files.

**Q: Is it safe to run on a folder I'm actively editing in VS Code?**
A: Yes — saves go through `fs.writeFileSync`. VS Code will detect the file change and offer to reload. Just be aware that simultaneous edits in both VS Code and the CMS could clobber each other (last write wins).

**Q: How big a site can it handle?**
A: Tested on 30 HTML pages with 175 fields per page. Field extraction is ~10ms per page; save is similar. Sites with thousands of pages will probably want a paginated page-list endpoint and lazy field extraction (defer to v2).

**Q: Can I use it as a hosted multi-user CMS?**
A: Not in v1. There's no auth, no concurrency, no audit trail. v2 might.

**Q: Why no React / Vue / Svelte for the editor frontend?**
A: It's under 300 lines of UI code. A framework would multiply the bundle size by 10× and add a build step that defeats the "tiny tool" goal.

**Q: Why cheerio over jsdom?**
A: cheerio is jQuery-shaped, fast, and doesn't simulate a browser. jsdom would let you run the page's scripts but adds 50× the install size and isn't needed for static HTML mutation.

**Q: Why Sharp over Jimp?**
A: Sharp is 10–30× faster, has prebuilt binaries for common platforms, and supports AVIF + WebP encoding out of the box. Jimp is pure-JS and slower; useful if Sharp's native binary won't install in your env.

---

## Credits

- [Cropper.js](https://github.com/fengyuanchen/cropperjs) by Chen Fengyuan
- [Sharp](https://github.com/lovell/sharp) by Lovell Fuller and contributors
- [cheerio](https://cheerio.js.org/) by Matt Mueller and contributors
- [js-beautify](https://beautifier.io/) by the Beautifier maintainers

Inspired by ideas from Tina CMS, Decap CMS, and the realisation that a 1,000-line tool can fill the gap they leave.

---

**License**: MIT (or whatever you want — pick one before publishing).

**Built**: April–May 2026 for the Kavin Hotels static site, then generalised.
