# cms-static — Design & Flow

A bird's-eye map of the entire system. Read this top-to-bottom and you'll know:

- Where every process starts and ends
- Which module owns which step
- What data flows between them
- What state lives where (browser, server, disk, git)
- How every user action becomes a sequence of events on disk

> Companion to `README.md`. README answers *"how do I use it?"*; this answers *"how does it work, end-to-end?"*

---

## Table of contents

- [0. How to read this document](#0-how-to-read-this-document)
- [1. System overview (bird's-eye)](#1-system-overview-birds-eye)
- [2. Module map](#2-module-map)
- [3. End-to-end lifecycle: from `node bin/cli.js` to a pushed commit](#3-end-to-end-lifecycle-from-node-bincli-js-to-a-pushed-commit)
- [4. Per-flow drill-downs](#4-per-flow-drill-downs) (4.1 bootstrap → 4.22 validation warnings)
- [5. State machines](#5-state-machines) (4 of them: edit, git, save-button, sidebar)
- [6. Data shapes](#6-data-shapes)
- [7. Error & failure paths](#7-error--failure-paths)
- [8. Glossary](#8-glossary)

---

## 0. How to read this document

Diagrams use these conventions:

```
┌───────┐                          ┐ A box is a module, file, or component.
│  src/ │                          │ Boxes contain the file or component name.
│ x.js  │
└───────┘

──────►  Synchronous call / data flow in the indicated direction.
◄ ─ ─ ─  Async response / callback / return value.

[disk]   Persistent storage (filesystem).
[net]    Network boundary (browser <-> localhost server, or push to remote).
[git]    Operations that shell out to the local `git` binary.

▶ STEP n  Numbered execution steps inside a flow.
```

When a flow says "step 5: server reads HTML", you'll find that line in the matching numbered list immediately below the diagram.

---

## 1. System overview (bird's-eye)

```
                              YOUR LAPTOP
   ┌────────────────────────────────────────────────────────────────────────┐
   │                                                                        │
   │  ┌─────────────────────┐                                               │
   │  │  Browser tab        │                                               │
   │  │  http://localhost:  │                                               │
   │  │       5174/__cms/   │                                               │
   │  │                     │                                               │
   │  │  ┌──────────────┐   │   /api/pages /api/fields                      │
   │  │  │ editor.js    │───┼───/api/save  /api/upload-image───┐            │
   │  │  │ git-panel.js │   │   /api/build /api/git/*          │            │
   │  │  │ cropper-     │   │                                  ▼            │
   │  │  │   modal.js   │   │   ┌────────────────────────────────────┐     │
   │  │  └──────────────┘   │   │  Express server                    │     │
   │  │  iframe (preview)   │   │  src/server.js                     │     │
   │  │  ┌──────────────┐   │   │                                    │     │
   │  │  │ user's       │◄──┼───┤  Static: editor + site folder      │     │
   │  │  │ static page  │   │   │                                    │     │
   │  │  └──────────────┘   │   │  ┌─────────────┐  ┌─────────────┐  │     │
   │  └─────────────────────┘   │  │ discovery   │  │ extractor   │  │     │
   │                            │  │ .js         │  │ .js         │  │     │
   │                            │  └─────────────┘  └─────────────┘  │     │
   │                            │  ┌─────────────┐  ┌─────────────┐  │     │
   │                            │  │ applier.js  │  │ image.js    │  │     │
   │                            │  └─────────────┘  └─────────────┘  │     │
   │                            │  ┌─────────────┐  ┌─────────────┐  │     │
   │                            │  │ builder.js  │  │ git.js      │  │     │
   │                            │  └─────────────┘  └─────────────┘  │     │
   │                            └─────────────────────┬──────────────┘     │
   │                                                  │                    │
   │   [disk]  YOUR_SITE/  (e.g. /home/abhishek/kavinhotels/final-dist-…)  │
   │   ────────────────────────────────────────────────┴───────────────    │
   │   index.html · akasa-dalhousie/index.html · images/ · build.js · …    │
   │                                                                       │
   │   [git]    YOUR_SITE/.git/                                            │
   │   ──────────────────────────────────────                              │
   │   commits, branches, refs, working tree                               │
   │                                                                       │
   └───────────────────────────────────────┬───────────────────────────────┘
                                           │ git push  (over network)
                                           ▼
                                ┌─────────────────────┐
                                │  Remote git host    │
                                │  (GitHub, Bitbucket,│
                                │   GitLab, etc.)     │
                                └─────────────────────┘
```

Three persistence layers, in order of authority:

1. **Disk** — your site source files. Single source of truth for content.
2. **Local git** — versioned snapshots of the disk state. CMS adds + commits via the `git` CLI.
3. **Remote git** — backup/sharing layer. CMS only writes to it via `git push`; never reads.

---

## 2. Module map

### 2.1 Server-side (Node, runs once per `node bin/cli.js`)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  bin/cli.js                                                                 │
│  ─────────────                                                              │
│  • Parses CLI args                                                          │
│  • Validates folder exists, isn't minified-looking                          │
│  • Calls startServer(siteRoot, port)                                        │
│  • Prints banner: site root + editor URL                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  src/server.js                                                              │
│  ──────────────                                                             │
│  • Constructs Express app                                                   │
│  • Mounts editor static at /__cms/                                          │
│  • Mounts site static at / (Cache-Control: no-store)                        │
│  • Wires API routes (calls into other modules)                              │
│  • safePath() — guards against path-traversal                               │
└─────────────────────────────────────────────────────────────────────────────┘
        │              │             │             │            │           │
        ▼              ▼             ▼             ▼            ▼           ▼
┌─────────────┐ ┌─────────────┐ ┌────────────┐ ┌──────────┐ ┌──────────┐ ┌────────┐
│ discovery   │ │ extractor   │ │ applier    │ │ image    │ │ builder  │ │ git    │
│ .js         │ │ .js         │ │ .js        │ │ .js      │ │ .js      │ │ .js    │
│             │ │             │ │            │ │          │ │          │ │        │
│ Walk folder │ │ HTML →      │ │ Changes →  │ │ Buffer → │ │ Spawn    │ │ Spawn  │
│ List .html  │ │  field      │ │  HTML      │ │  Sharp → │ │ build.js │ │ git    │
│ Skip _min/  │ │  descriptor │ │  → js-     │ │  disk    │ │ +        │ │ CLI    │
│   _fmt/     │ │  JSON       │ │  beautify  │ │          │ │ js-      │ │        │
│   etc.      │ │             │ │            │ │          │ │ beautify │ │        │
│             │ │ uses        │ │ uses       │ │ uses     │ │ mirror → │ │        │
│             │ │ cheerio     │ │ cheerio    │ │ sharp    │ │ _formatted│ │        │
└─────────────┘ └─────────────┘ └────────────┘ └──────────┘ └──────────┘ └────────┘
```

| Module | Pure / impure | Talks to disk? | Talks to network? |
|---|---|---|---|
| `discovery.js` | impure (fs.readdir) | reads | no |
| `extractor.js` | pure (string in → JSON out) | no | no |
| `applier.js` | pure (string + changes → string) | no | no |
| `image.js` | impure (fs.write + sharp) | writes | no |
| `builder.js` | impure (spawn + fs walk) | reads + writes | no |
| `git.js` | impure (spawn `git`) | via git only | only on `push` |
| `server.js` | impure (HTTP listener + fs) | reads + writes | listens locally |

The two pure modules (`extractor.js`, `applier.js`) are the easiest to test and reason about. The impure ones are isolated to their concerns.

### 2.2 Client-side (vanilla JS, runs in the browser tab)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  src/editor/index.html                                                      │
│  ──────────────────────                                                     │
│  Two-pane layout shell:                                                     │
│   ┌────────────────────┬─────────────────────┐                              │
│   │   .sidebar         │  .preview           │                              │
│   │   #pagePicker      │  <iframe id=preview>│                              │
│   │   #gitPanel        │                     │                              │
│   │   #fieldsBody      │                     │                              │
│   │   #saveBtn #buildBtn│                    │                              │
│   └────────────────────┴─────────────────────┘                              │
│  Plus two <dialog>s: #cropDialog, #gitOnboardDialog                         │
└─────────────────────────────────────────────────────────────────────────────┘
       │                            │                            │
       ▼                            ▼                            ▼
┌──────────────┐            ┌──────────────┐            ┌──────────────┐
│ editor.js    │            │ cropper-     │            │ git-panel.js │
│              │            │  modal.js    │            │              │
│ • boot       │            │              │            │ • boot       │
│ • loadPages  │            │ • openCropper│            │ • renderPanel│
│ • loadPage   │            │ • Cropper.js │            │ • commit/push│
│ • render-    │            │ • blob upload│            │ • onboarding │
│   Fields     │            │   (POST)     │            │ • onAfterSave│
│ • save()     │            │              │            │   hook       │
│ • build()    │            │              │            │              │
└──────────────┘            └──────────────┘            └──────────────┘
       │                            │                            │
       └─────────── shares state via ───────────────┘             │
                       window.cmsState                            │
                                                                  │
       ┌──────────────────────────────────────────────────────────┘
       │
       ▼ called after save() succeeds
   onAfterSave({ page, suggestedMessage })
```

Three scripts, one shared state object (`window.cmsState`), one shared status bar (`#statusBar`).

`window.cmsState` shape:
```js
{
  pages:         [],                  // discovered page paths
  currentPage:   null,                // selected path or null
  fields:        [],                  // field descriptors from /api/fields
  changed:       Map<id, value>,      // text/value edits not yet saved
  changedAlt:    Map<id, altText>,    // alt-text edits (image fields only)
  pendingImages: Map<id, { blob, destPath }>,  // queued for upload on Save
}
```

`window.cmsGit` (set by `git-panel.js`):
```js
{
  onAfterSave({ page, suggestedMessage }),  // called by editor.js
  refreshState(),
  isAutoCommitOn(),
}
```

`window.cmsToast` (set by `editor.js`, used by `git-panel.js` + `cropper-modal.js`):
```js
toast(message, kind)              // kind: 'info' | 'success' | 'error'
                                  // info/success auto-dismiss after 3 s,
                                  // error sticks until user clicks ×
                                  // stack capped at 4 visible toasts
```

`localStorage` keys owned by the editor (all under the `cms-static.*` namespace):

| Key | Owner | Purpose |
|---|---|---|
| `cms-static.sidebar.collapsed` | `editor.js` | "1" if the sidebar is collapsed |
| `cms-static.sidebar.width` | `editor.js` | numeric width in px (300–600) |
| `cms-static.firstVisitTip.dismissed` | `editor.js` | "1" once the welcome toast has shown |
| `cms-static.git.skipOnboarding` | `git-panel.js` | "1" if the user picked "Skip" in the modal |
| `cms-static.git.autoCommit` | `git-panel.js` | "1" if auto-commit-on-save is on |
| `cms-static.git.expanded` | `git-panel.js` | "1" if the Git panel "▾ More" section is open |
| `kavin-favorites` | site code (legacy) | unrelated to CMS — pre-existing favourite-property storage |

### 2.3 External services / libraries

| | Where | Purpose |
|---|---|---|
| `express` | server | HTTP listener + routing |
| `cheerio` | server (extractor, applier) | jQuery-style HTML parse + mutate |
| `sharp` | server (image.js) | re-encode JPEG/PNG/WebP/AVIF |
| `multer` | server (server.js) | multipart upload parser |
| `js-beautify` | server (applier, builder) | pretty-print HTML/CSS/JS |
| `child_process.spawn` | server (git.js, builder.js) | run `git`, run user's `build.js` |
| `Cropper.js` | browser (CDN) | image crop UI with aspect-ratio lock |
| `<dialog>` (HTML5) | browser | onboarding + crop modals |
| `localStorage` | browser | auto-commit toggle, skip-onboarding flag |

---

## 3. End-to-end lifecycle: from `node bin/cli.js` to a pushed commit

This is the macro narrative. Each phase has its own drill-down in §4.

```
                    ┌─ PHASE 1 ─────────────────────────┐
                    │  Bootstrap (CLI → Express up)     │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 2 ────▼────────────────────┐
                    │  Editor loads in browser          │
                    │  (HTML + 3 JS files + CSS)        │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 3 ────▼────────────────────┐
                    │  Git state probe                  │
                    │   ├─ no-repo → onboarding modal   │
                    │   └─ repo    → render Git panel   │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 4 ────▼────────────────────┐
                    │  User picks a page                │
                    │   ├─ iframe loads /page-path      │
                    │   └─ /api/fields → render sidebar │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 5 ────▼────────────────────┐
                    │  User edits fields                │
                    │   ├─ text input → state.changed   │
                    │   ├─ image replace → cropper      │
                    │   └─ field rows show as "dirty"   │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 6 ────▼────────────────────┐
                    │  Save (button or Cmd+S)           │
                    │   ├─ upload pending images        │
                    │   ├─ POST /api/save               │
                    │   ├─ server applies + writes      │
                    │   └─ refresh preview + fields     │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 7 ────▼────────────────────┐
                    │  Commit (auto or manual)          │
                    │   ├─ git add <file>               │
                    │   ├─ git commit -m "[cms] …"      │
                    │   └─ Git panel refreshes          │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 8 ────▼────────────────────┐
                    │  Push (manual button)             │
                    │   ├─ git push (sets upstream      │
                    │   │   on first push)              │
                    │   └─ ahead counter resets to 0    │
                    └──────────────┬────────────────────┘
                                   │
                    ┌─ PHASE 9 ────▼────────────────────┐
                    │  Build (manual button, optional)  │
                    │   ├─ spawn user's build.js        │
                    │   ├─ js-beautify mirror walk      │
                    │   └─ _minified/ + _formatted/     │
                    └───────────────────────────────────┘
```

Phases 5–7 form the inner loop: edit → save → commit. Phase 8 happens periodically. Phase 9 happens before deployment.

---

## 4. Per-flow drill-downs

### 4.1 Bootstrap (`node bin/cli.js <folder>`)

```
   user                    bin/cli.js              src/server.js          [disk]
    │                          │                          │                  │
    │ node bin/cli.js ./site   │                          │                  │
    ├─────────────────────────►│                          │                  │
    │                          │                          │                  │
    │                          ▼ STEP 1 — parse argv      │                  │
    │                          │ siteRoot=./site          │                  │
    │                          │                          │                  │
    │                          ▼ STEP 2 — guards          │                  │
    │                          │ exists? isDir?           │                  │
    │                          │ index.html minified?────►│ probe first 4 KB │
    │                          │                          │                  │
    │                          ▼ STEP 3 — startServer()   │                  │
    │                          ├──────────────────────────►                  │
    │                          │                          │                  │
    │                          │                          ▼ STEP 4           │
    │                          │                          │ build Express    │
    │                          │                          │ wire routes      │
    │                          │                          │ app.listen(5174) │
    │                          │                          │                  │
    │                          │ ◄────────── promise resolves                │
    │                          │                          │                  │
    │ ◄ banner printed         │                          │                  │
    │   "Editor: localhost:5174/__cms/"                                       │
```

Sanity guards in `bin/cli.js` (so we fail fast and friendly):

| Guard | Failure mode |
|---|---|
| Folder argument missing | "Usage: cms-static <site-folder>" + exit 1 |
| Folder doesn't exist | "[!] Folder does not exist: …" + exit 1 |
| Path is a file, not a dir | "[!] Not a directory: …" + exit 1 |
| `index.html` is single huge line | "[!] This folder looks minified. Point at SOURCE, not _minified/" + exit 1 |

### 4.2 Editor first load

```
   browser                          server (Express)                      [disk]
     │                                  │                                    │
     │  GET /__cms/                     │                                    │
     ├─────────────────────────────────►│ static handler resolves            │
     │                                  ├──────► reads editor/index.html ◄───┤
     │ ◄────────────── HTML with <script>×3                                  │
     │                                                                       │
     │  GET /__cms/editor.css                                                │
     │  GET /__cms/editor.js                                                 │
     │  GET /__cms/cropper-modal.js                                          │
     │  GET /__cms/git-panel.js                                              │
     ├─────────────────────────────────►│ static                             │
     │ ◄────────────── 4 files                                               │
     │                                                                       │
     │  GET https://unpkg.com/cropperjs@1.6.1/dist/...   (CDN)               │
     │  ─────────────────────────────────────────────►                       │
     │                                                                       │
     │  GET /__cms/api/pages          (editor.js boot())                     │
     ├─────────────────────────────────►│ discovery.listPages() ─► reads dir │
     │ ◄────────────── { root, pages: [...] }                                │
     │                                                                       │
     │  GET /__cms/api/git/state      (git-panel.js init())                  │
     ├─────────────────────────────────►│ git.fullState(siteRoot)            │
     │                                  │   spawn git rev-parse --show-      │
     │                                  │   toplevel, status, log, etc.      │
     │ ◄────────────── { installed, isRepo, branch, ahead, ... }             │
     │                                                                       │
     │ render page picker (21 options)                                       │
     │ render Git panel OR open onboarding modal                             │
```

Notice the **two parallel boot paths**:
- `editor.js` boots → `loadPages()` populates the page picker
- `git-panel.js` boots independently → fetches Git state → decides whether to open the modal

They communicate via the shared status bar (`#statusBar`) and the `window.cmsGit.onAfterSave` hook.

### 4.3 Discovery — `discovery.listPages(siteRoot)`

```
                 listPages(siteRoot)
                         │
                         ▼
                 walk(siteRoot, '', out)
                         │
            ┌────────────┴───────────────┐
            │                            │
   for each entry in dir:          recurse on dirs
            │                            │
            ▼                            ▼
  ┌──────────────────────┐      ┌─────────────────┐
  │ skip if:             │      │ walk(child, …)  │
  │  - dotfile           │      └─────────────────┘
  │  - in SKIP_DIRS      │
  │    (_minified,       │              │
  │     _formatted,      │              │
  │     node_modules,    │              │
  │     .git, .vscode,   │              │
  │     dist, build…)    │              │
  └──────────────────────┘              │
            │                            │
            ▼                            │
  ┌──────────────────────┐              │
  │ if .html file:       │              │
  │  - stat.size > 5 MB? │              │
  │       → skip         │              │
  │  - first 4 KB has    │              │
  │    < 3 newlines and  │              │
  │    > 3.5 KB?         │              │
  │       → minified,    │              │
  │         skip         │              │
  │  else: push to out[] │              │
  └──────────────────────┘              │
            │                            │
            └─────────► sort()  ◄────────┘
                          │
                          ▼
                   ['index.html',
                    'akasa-dalhousie/index.html',
                    'collections/index.html',
                     ...]
```

The minified-line heuristic protects against accidental editing of build outputs. Real source files always have many newlines in the first few KB.

### 4.4 Field extraction — `extractor.extractFields(html, pagePath)`

Per page, six passes over the cheerio-parsed DOM:

```
                ┌─────────────────────────────────────────────┐
                │  $ = cheerio.load(html, decodeEntities:false)│
                └─────────────────────────────────────────────┘
                                    │
       ┌────────────────┬───────────┼───────────────┬───────────────┐
       │                │           │               │               │
       ▼                ▼           ▼               ▼               ▼
  PASS 1: SEO     PASS 2: SEO   PASS 3:        PASS 4:         PASS 5:
  page title      meta tags     JSON-LD        Headings +      Images
  ───────────     ──────────    ───────         body text      ───────
  head > title    og:title,     <script         h1-h4, p, li,  main img
                  og:desc,      type="appli-    blockquote,    + src,
                  og:image,     cation/         figcaption,    + alt
                  twitter:*     ld+json">       dt, dd
                                flatten +
                                expose
                                scalars
       │                │           │               │               │
       └────────────────┴───────────┴───────────────┴───────────────┘
                                    │
                                    ▼
                       ┌─────────────────────────┐
                       │  fields[]               │
                       │  each item:             │
                       │  { id, group, type,     │
                       │    label, selector,     │
                       │    attr, value, ... }   │
                       └─────────────────────────┘
```

For each candidate element we check `hasExcludedAncestor()`:

```
   element  ───►  $(el).parents('nav, footer, svg, button, form,
                                 script, style, header').length > 0
                                                       │
                                                       ▼
                                         if true → skip (return early)
```

Selector building per element (`buildSelector`):

```
   start at element, walk up to <body>:
     ┌──────────────────────────┐
     │ if element has #id       │  →  use "tag#id"
     ├──────────────────────────┤
     │ else if siblings of same │  →  use "tag:nth-of-type(n)"
     │ tag exist                │
     ├──────────────────────────┤
     │ else                     │  →  use "tag"
     └──────────────────────────┘
   join parts with " > "
   → "body > main#main > section:nth-of-type(1) > div:nth-of-type(2) > h1#heroHeading"
```

This selector is later sent unchanged to the server during save and used by cheerio to relocate the element. Since IDs are session-local (we never write `data-cms-id` into source), the selector IS the ID.

### 4.5 Save round-trip

```
   editor.js                         server.js                    cheerio       js-beautify    [disk]
        │                                │                            │              │             │
        │ user clicks 💾 Save             │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 1 ─ upload images          │                            │              │             │
        │ for each pendingImage:         │                            │              │             │
        │  POST /api/upload-image ──────►│ multer parses multipart    │              │             │
        │       (multipart blob+path)    │ image.js handleImageUpload │              │             │
        │                                │ ├─ safePath check          │              │             │
        │                                │ ├─ sharp re-encode based   │              │             │
        │                                │ │   on extension           │              │             │
        │                                │ └─ fs.writeFileSync ────────────────────────────────────►│
        │ ◄─── { ok, path, bytes }       │                            │              │             │
        │ state.changed.set(id, newPath) │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 2 ─ build payload         │                            │              │             │
        │ collect every changed field    │                            │              │             │
        │ + changed alt                  │                            │              │             │
        │ → changes[] (each: { selector  │                            │              │             │
        │   or scriptIndex+jsonPath,     │                            │              │             │
        │   attr, value, … })            │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 3 ─ compute commit msg    │                            │              │             │
        │ buildCommitMessage(page, ch)   │                            │              │             │
        │ → "[cms] page · 1 SEO, 2 Body" │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 4 ─ POST /api/save        │                            │              │             │
        │ ──────────────────────────────►│                            │              │             │
        │                                │ STEP 5                     │              │             │
        │                                │ readFileSync(page) ─────────────────────────────────────►│
        │                                │                            │              │             │
        │                                │ STEP 6 — applyChanges()    │              │             │
        │                                ├───────────────────────────►│              │             │
        │                                │  cheerio.load              │              │             │
        │                                │                            │              │             │
        │                                │  for each DOM change:      │              │             │
        │                                │   $(selector).text/html/   │              │             │
        │                                │   attr(attr, value)        │              │             │
        │                                │                            │              │             │
        │                                │  for each JSON-LD change:  │              │             │
        │                                │   parse script text → JSON │              │             │
        │                                │   setNestedValue(jsonPath) │              │             │
        │                                │   $(script).text(JSON.str) │              │             │
        │                                │                            │              │             │
        │                                │  $.html() → full document  │              │             │
        │                                ◄────── string                              │             │
        │                                │                            │              │             │
        │                                │ STEP 7 — js-beautify       │              │             │
        │                                ├──────────────────────────────────────────►│             │
        │                                │  pretty-printed string ◄───────────────────              │
        │                                │                            │              │             │
        │                                │ STEP 8 — fs.writeFileSync ───────────────────────────────►│
        │                                │                            │              │             │
        │ ◄─── { ok: true, bytes }       │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 9 — UX cleanup            │                            │              │             │
        │ clear state.changed/Alt/imgs   │                            │              │             │
        │ status: "Saved ✓"              │                            │              │             │
        │ pre-fill #gitCommitMsg         │                            │              │             │
        │   with suggestedMessage        │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 10 — invoke git hook      │                            │              │             │
        │ window.cmsGit.onAfterSave(…)   │                            │              │             │
        │   → see §4.7                   │                            │              │             │
        │                                │                            │              │             │
        ▼ STEP 11 — refresh UI           │                            │              │             │
        │ iframe.src = '/' + page  ──────► (browser reloads preview from disk)                      │
        │                                │                            │              │             │
        │ GET /api/fields?page=…  ──────►│ extractor again            │              │             │
        │ ◄── fresh fields[]             │                            │              │             │
        │ renderFields(state.fields)     │                            │              │             │
```

Important invariant: the client never holds onto a saved field's value. After save, fields are re-extracted from disk so what's on screen always matches what's in the file. This is what lets us use session-local IDs safely — they don't need to survive across save cycles.

### 4.6 Edit a text/longtext field (in-session, before save)

```
   sidebar input/textarea          editor.js                   state
         │                              │                          │
         │ user types a character        │                          │
         ├─────────────────────────────►│                          │
         │                              │                          │
         │                              ▼ event handler            │
         │                              │ id = el.dataset.inputId  │
         │                              │ state.changed.set(id, v)─────►
         │                              │                          │ (Map)
         │                              │ closest('.field')       │
         │                              │   .classList.add(        │
         │                              │     'changed')           │
         │                              │ → peach background       │
         │                              │                          │
         │                              │ setStatus('● unsaved')  │
         │                              │ refreshSaveBtn() — enable│
```

No round-trip to server happens until Save. Edits are entirely browser-local until then.

### 4.7 Image edit (cropper) flow

```
   user        cropper-modal.js              Cropper.js          server
    │                │                          │                   │
    │ click Replace…│                          │                   │
    ├──────────────►│                          │                   │
    │                │ open hidden <input type=file>                │
    │                │                          │                   │
    │ pick file      │                          │                   │
    ├──────────────►│ URL.createObjectURL(file)│                   │
    │                │ img.src = blob:url       │                   │
    │                │ dlg.showModal()          │                   │
    │                │                          │                   │
    │                ▼ img.onload               │                   │
    │                │ originalAspect =         │                   │
    │                │   field.width/height OR  │                   │
    │                │   img.naturalW/H         │                   │
    │                │                          │                   │
    │                │ new Cropper(img, {        │                   │
    │                │   aspectRatio: original})│                   │
    │                ├─────────────────────────►│                   │
    │                │                          │  draws UI on img  │
    │                │                          │                   │
    │ drag/resize    │                          │                   │
    │ change aspect  │ aspectSel.onchange       │                   │
    │ dropdown       │ → cropper.setAspectRatio │                   │
    │                │                          │                   │
    │ click Save crop│                          │                   │
    ├──────────────►│ cropper.getCroppedCanvas │                   │
    │                │   ({ maxW: 2400 })       │                   │
    │                │ canvas.toBlob(jpeg, .9)  │                   │
    │                │                          │                   │
    │                ▼ window.applyCrop(id,blob,│                   │
    │                │   destPath=field.value)  │                   │
    │                │                          │                   │
    │                │ state.pendingImages.set( │                   │
    │                │   id, { blob, destPath })│                   │
    │                │ state.changed.set(       │                   │
    │                │   id, destPath)          │                   │
    │                │                          │                   │
    │                │ thumbnail src ←          │                   │
    │                │   URL.createObjectURL    │                   │
    │                │ field row → "changed"    │                   │
    │                │                          │                   │
    │                │ dlg.close()              │                   │
    │                │ destroyCropper()         │                   │
    │                │                          │                   │
    │ later: click 💾Save                       │                   │
    │                │ for each pendingImage:   │                   │
    │                │   POST upload-image ─────────────────────────►│
    │                │   (FormData: image+path) │                   ├─► sharp re-encode ─► fs.write
    │                │ ◄─── { ok, path }                            │
```

Image flow is two-stage by design:
- Stage 1 (in-session): cropper produces a Blob, stored in `state.pendingImages` keyed by field id
- Stage 2 (on Save): blobs upload, then the field's text value (the new path) goes into the regular `changes[]` payload

This means you can replace several images and keep editing text, and one Save commits everything.

### 4.8 Git onboarding flow

```
   first browser load                     git-panel.js                   server.js
          │                                    │                              │
          │ document DOMContentLoaded          │                              │
          ├───────────────────────────────────►│                              │
          │                                    ▼ refreshState()               │
          │                                    │ GET /api/git/state ──────────►│ git.fullState
          │                                    │                              │ ├─ isGitInstalled
          │                                    │                              │ ├─ repoRoot
          │                                    │                              │ ├─ currentBranch
          │                                    │                              │ ├─ aheadBehind
          │                                    │                              │ ├─ status
          │                                    │                              │ └─ log
          │                                    │ ◄── state                    │
          │                                    │                              │
          │                                    ▼ branch logic                 │
          │                                    │                              │
          │           ┌────────────────────────┼────────────────────────┐     │
          │           │                        │                        │     │
          │   installed=false           isRepo=true              isRepo=false  │
          │   render "git not          render Git panel        check         │
          │   installed" notice         (branch, ahead,         localStorage  │
          │                              dirty, log,            "skip" flag    │
          │                              auto-commit toggle,    │              │
          │                              commit form, push)     │              │
          │                                                     │              │
          │                                          ┌──────────┴──────────┐  │
          │                                          │                     │  │
          │                                   skipped earlier        not skipped │
          │                                   render "skipped"      open       │
          │                                   notice with           gitOnboard │
          │                                   "Set up Git"          Dialog     │
          │                                   button                .showModal │
          │                                                                   │
          │ user picks one of three options:                                  │
          │   ( ) Initialize a new local repo                                 │
          │   ( ) Initialize and connect to existing remote                   │
          │   ( ) Skip                                                        │
          │                                                                   │
          │ click "Set up Git"                                                │
          │                                    │                              │
          │                                    ▼ POST /api/git/init           │
          │                                    │   { remote, message } ───────►│ git.init()
          │                                    │                              │ ├─ git init -b main
          │                                    │                              │ ├─ write .gitignore
          │                                    │                              │ ├─ ensure user.name
          │                                    │                              │ │   user.email
          │                                    │                              │ ├─ git add -A
          │                                    │                              │ ├─ git commit -m
          │                                    │                              │ └─ if remote:
          │                                    │                              │     git remote add
          │                                    │                              │
          │                                    │ ◄── { ok, state }            │
          │                                    │                              │
          │                                    ▼ renderPanel() ── full panel  │
          │                                    │ start poll (every 8 s)       │
```

If the user picks **Skip**, `localStorage["cms-static.git.skipOnboarding"] = "1"` and the panel shows a small "Set up Git" button instead of the full panel. Clicking that button clears the flag and re-opens the modal.

### 4.9 Auto-commit hook (after a successful save)

```
   editor.js .save()                git-panel.js                  server.js
        │                                │                             │
        ▼ STEP 1 — save succeeds         │                             │
        │ window.cmsGit.onAfterSave(─────►│                            │
        │   { page, suggestedMessage })  │                             │
        │                                │                             │
        │                                ▼ STEP 2                      │
        │                                │ if !state.autoCommit:       │
        │                                │   refreshState() and return │
        │                                │                             │
        │                                ▼ STEP 3 — auto-commit on     │
        │                                │ POST /api/git/commit ──────►│ git.commit
        │                                │   { message:                │ ├─ git add -A
        │                                │     suggestedMessage }      │ └─ git commit -m
        │                                │                             │
        │                                │ ◄── { ok, state }           │
        │                                │                             │
        │                                ▼ STEP 4                      │
        │                                │ refreshState()              │
        │                                │ → ahead +1, dirty 0         │
        │                                │ renderPanel() — log shows   │
        │                                │   new commit on top         │
```

If auto-commit is OFF (default), step 3 is skipped, but the textarea in the Git panel is **pre-filled** with `suggestedMessage` so the user can hit "Commit" without typing.

### 4.10 Manual commit + push

```
   user → Git panel                git-panel.js                    server.js              [git]
       │                                │                              │                     │
       │ types/edits commit msg          │                              │                     │
       │ click "Commit"                  │                              │                     │
       ├────────────────────────────────►│                              │                     │
       │                                │ commitNow()                  │                     │
       │                                │ POST /api/git/commit ───────►│ git.commit          │
       │                                │   { message }                │ ├─ git add -A ──────►│
       │                                │                              │ └─ git commit -m ──►│
       │                                │                              │                     │
       │                                │ ◄── { ok, hash, state }      │                     │
       │                                │ msg textarea cleared          │                     │
       │                                │ panel re-renders              │                     │
       │                                │ status: "Committed ✓"        │                     │
       │                                │                              │                     │
       │ click ↑ Push                    │                              │                     │
       ├────────────────────────────────►│                              │                     │
       │                                │ pushNow()                    │                     │
       │                                │ POST /api/git/push ─────────►│ git.push            │
       │                                │                              │ ├─ check upstream   │
       │                                │                              │ ├─ if none:         │
       │                                │                              │ │   git push -u     │
       │                                │                              │ │     origin <br>   │
       │                                │                              │ └─ else: git push   │
       │                                │                              │                  ───┼──► remote
       │                                │                              │                     │
       │                                │ ◄── { ok, state } ON SUCCESS │                     │
       │                                │     ahead resets to 0         │                     │
       │                                │ status: "Pushed ✓"           │                     │
       │                                │                              │                     │
       │                                │ ◄── { error: stderr }         │                     │
       │                                │   ON FAILURE                  │                     │
       │                                │ status: "Push error: …"      │                     │
```

Push errors come through verbatim from `git push`'s stderr (auth failure, non-fast-forward, etc.). The panel surfaces them in the status bar.

### 4.11 Build pipeline

```
   user click ⬇ Build
        │
        ▼
   editor.js build()
        │
        ▼ POST /__cms/api/build
        │
        ▼
   server.js → builder.runBuild(siteRoot)
        │
        ├──── PIPELINE A: minified ────────────────────┐
        │                                              │
        │   ┌─ if siteRoot/build.js exists:            │
        │   │    spawn('node', ['build.js'],           │
        │   │           { cwd: siteRoot })             │
        │   │    inherits stdio                        │
        │   │    user's build.js runs:                 │
        │   │     html-minifier-terser, terser,        │
        │   │     clean-css                            │
        │   │    output → siteRoot/_minified/          │
        │   │                                          │
        │   └─ else: { ok: false, error: "no build.js"}│
        │                                              │
        ├──── PIPELINE B: formatted (always runs) ─────┤
        │                                              │
        │   rmSync(siteRoot/_formatted, recursive)     │
        │   walk(siteRoot, '', _formatted, …)          │
        │     for each file (skip _minified, _formatted, node_modules, .git, …):
        │       .html → js-beautify.html → write      │
        │       .css  → js-beautify.css  → write      │
        │       .js   → js-beautify.js   → write      │
        │       other → fs.copyFileSync               │
        │                                              │
        ▼ return { minified: {...}, formatted: {...} } ◄
        │
        ▼ to editor.js → status bar: "Built — 55 formatted, minified ✓"
```

The two pipelines are independent and run sequentially in the server (no parallelism for simplicity). On a 30-page site, total build time is ~3-5 seconds.

---

### 4.12 Sidebar collapse + resize

```
                        ┌──────────────────┐
                        │  editor.js       │
                        │  initSidebar     │
                        │  Layout()        │
                        └─────────┬────────┘
                                  │
       ┌──────────────────────────┼──────────────────────────┐
       │                          │                          │
       ▼ STEP 1: width restore    ▼ STEP 2: collapse restore │
       read localStorage          read localStorage         │
       cms-static.sidebar.width   cms-static.sidebar.       │
       (300–600 clamp)            collapsed                 │
       layout.style.set           layout.classList.add(    │
       Property(                  'is-collapsed') if "1"   │
       '--user-sidebar-width',                              │
        savedWidth + 'px')                                  │
                                                            │
                              ▼ STEP 3: wire toggle          │
                              #sidebarToggle.click          │
                              → toggleSidebar()             │
                              keyboard: Cmd/Ctrl+B          │
                                                            │
                              ▼ STEP 4: wire resizer        │
                              #sidebarResizer.pointerdown   │
                              → record startX + startWidth  │
                              document.pointermove          │
                              → setProperty(                │
                                  '--user-sidebar-width',   │
                                  clamped(w))               │
                              document.pointerup            │
                              → write localStorage          │
                              dblclick → reset to 380 px    │
```

**The two-variable trick.** Two CSS variables exist on `.layout`:

```css
.layout {
  --user-sidebar-width: 380px;          /* what the resize drag writes */
  --sidebar-width: var(--user-sidebar-width);   /* what the grid reads */
}
.layout.is-collapsed {
  --sidebar-width: 36px;                /* class-rule overrides the BASE
                                           rule's var() — without fighting
                                           the inline style on
                                           --user-sidebar-width */
}
```

The resize handler always writes to `--user-sidebar-width` (inline style on `.layout`). The collapse class always overrides `--sidebar-width` (the variable the grid actually consumes). Because they're different variables, the inline style and the class rule never collide. When you re-expand, your custom width returns automatically.

This is the "specificity collision" that bit us in the original A1+A2 ship — fixed by the variable split. Documented here so the trap is visible to anyone who later wants to add more width-controlling features.

---

### 4.13 Toast notifications + Save-button state machine

```
   user action            editor.js                            DOM
      │                      │                                  │
      │ click 💾 Save (or Cmd+S)                                 │
      ├─────────────────────►│                                  │
      │                      │                                  │
      │                      ▼ setSaveBtnState('saving')        │
      │                      │ ── #saveBtn:                     │
      │                      │      .classList.add('is-saving') │
      │                      │      .disabled = true            │
      │                      │      label → "Saving…"           │
      │                      │                                  │
      │                      ▼ POST /api/save (see §4.5)        │
      │                      │                                  │
      │             ┌────────┴──────────┐                       │
      │             │                   │                       │
      │     ON SUCCESS              ON ERROR                    │
      │             │                   │                       │
      │             ▼                   ▼                       │
      │     setSaveBtnState        toast(err.message,           │
      │       ('saved')              'error')                   │
      │     ── classList.add(      setSaveBtnState('idle')      │
      │          'is-saved')                                    │
      │     ── label → "✓ Saved"   ── refresh button to         │
      │     ── 700 ms green-pulse     dirty/clean state         │
      │        keyframe animation                                │
      │     ── 900 ms later:                                    │
      │        refreshSaveBtn()                                 │
      │                                                          │
      │     toast('Saved · 65 KB',                              │
      │            'success')                                   │
      │     ── 3 s auto-dismiss                                 │
```

**Toast lifecycle:**

```
   toast(msg, kind)
        │
        ▼
   #toastContainer.appendChild(<div class="toast toast-{kind}">…</div>)
        │
        ▼
   if container has 4 children: oldest is removed (cap)
        │
        ▼
   requestAnimationFrame → add .is-shown class → CSS fade-in (200 ms)
        │
        ▼
   if kind !== 'error': setTimeout(dismiss, 3000 ms)
        │
        ▼
   user click × → dismissToast() → remove .is-shown, add .is-hiding,
                                   then .remove() after 220 ms transition
```

**Why errors stick.** Info/success messages are confirmations of intent — they don't need to block the user. Error toasts indicate something is broken (save failed, push failed, image upload failed) and the user often needs to read the message before retrying. So errors are sticky-until-dismissed.

**Save-button label rules (D2):**

| Input state | Label | Class | Disabled? |
|---|---|---|---|
| `state.changed.size === 0` and pending images empty | `Save` | (none) | yes |
| 1 dirty field | `Save 1 change` | (none) | no |
| N dirty fields | `Save N changes` | (none) | no |
| Mid-save (post-click) | `Saving…` | `is-saving` | yes |
| Just saved | `✓ Saved` | `is-saved` | yes |
| ↳ 900 ms later | back to `Save` | (none) | yes |

The `is-saved` class triggers a 700 ms `save-pulse` keyframe (green ring + 1.02× scale). Honors `prefers-reduced-motion: reduce`.

`setStatus()` is now a thin compatibility wrapper: it routes `'ok'` → `toast(msg, 'success')`, `'error'` → `toast(msg, 'error')`, and silently no-ops for transient progress chatter (`Saving…`, `Loading…`) since the save button itself reflects those states now.

---

### 4.14 Git panel — compact mode (E1)

```
   first paint                git-panel.js                  state
       │                          │                            │
       │ refreshState()           │                            │
       ├─────────────────────────►│ GET /api/git/state         │
       │                          │ ◄─────  fullState           │
       │                          │                            │
       │                          ▼ renderPanel()              │
       │                          │ if !installed → notice     │
       │                          │ if !isRepo → onboarding    │
       │                          │ else → compact + details   │
       │                          │                            │
       │                          ┌─────────────────────────┐  │
       │                          │ ALWAYS VISIBLE          │  │
       │                          │  branch pill            │  │
       │                          │  unsaved/ahead/behind   │  │
       │                          │  commit message form    │  │
       │                          │  Save to history btn    │  │
       │                          │  Send to <provider> btn │  │
       │                          │  ▾ More toggle          │  │
       │                          └─────────────────────────┘  │
       │                          │                            │
       │                          │ <div class="git-details"   │
       │                          │      hidden={!expanded}>   │
       │                          │   remote URL              │
       │                          │   auto-commit toggle      │
       │                          │   recent log (5 commits)  │
       │                          │ </div>                    │
       │                          │                            │
       │ click ▾ More              │                            │
       ├─────────────────────────►│                            │
       │                          ▼ state.expanded = !expanded │
       │                          │ localStorage.setItem(      │
       │                          │   EXPANDED_KEY, '1'/'0')   │
       │                          │ renderPanel() (re-render   │
       │                          │   to flip details visible) │
```

**Provider detection** (E3) — verb-first push button label:

```
detectGitProvider(remoteUrl)
   ├─ 'github.com'    → "GitHub"
   ├─ 'bitbucket.org' → "Bitbucket"
   ├─ 'gitlab.com'    → "GitLab"
   ├─ 'gitea'         → "Gitea"
   ├─ 'codeberg.org'  → "Codeberg"
   ├─ 'dev.azure.com' → "Azure DevOps"
   └─ anything else   → "remote"

Used as:  "Send to <provider>"  → "↑ Send to GitHub"
```

**`shortenRemote()`** turns the full SSH/HTTPS URL into `user/repo`:

```
git@github.com:kavin-hotels/site.git    → kavin-hotels/site
https://gitlab.com/team/site.git        → team/site
unrecognised                            → returns url as-is
```

**Plain-English pill labels** (E2) — current → new:

| Old (Git terminology) | New (user-facing) |
|---|---|
| `● 2 uncommitted` | `● 2 unsaved files` |
| `↑ 3 ahead` | `↑ 3 ready to push` |
| `↓ 1 behind` | `↓ 1 update from team` |
| `✓ clean` | `✓ Up to date` |

These pills auto-pluralize (`1 file` vs `2 files`, `1 update` vs `3 updates`).

---

### 4.15 First-run UX

```
   editor boots (boot())
       │
       ▼ initSidebarLayout()  (§4.12)
       │
       ▼ initKbdHelp()
       │   wires #kbdHelpBtn (bottom-left floating "?") → openKbdHelp()
       │   wires #kbdHelpClose → dlg.close()
       │
       ▼ showFirstVisitTip()
       │   if localStorage[FIRST_VISIT_KEY] !== '1':
       │     setTimeout(700 ms, () => {
       │        toast('Tip: edits live in the sidebar.…', 'info');
       │        localStorage.setItem(FIRST_VISIT_KEY, '1');
       │     });
       │
       ▼ keydown listeners for ⌘S, ⌘B, '?'
           '?' key (only when activeElement is not an input/textarea):
              → openKbdHelp() → <dialog id="kbdHelpDialog">.showModal()
```

**Welcome card (C1)** — shown when no page is selected:

```
┌─────────────────────────────────────────┐
│              👋                          │
│        Welcome to cms-static             │
│                                          │
│        ↑ Pick a page above to begin      │
│                                          │
│     Edit any field on the left,          │
│     then hit Save. Your changes only     │
│     go live after Save.                  │
└─────────────────────────────────────────┘
```

This is rendered into `#fieldsBody` whenever `loadPage(null)` is called (server start, page picker reset).

**Keyboard cheat-sheet (C3)** — opened via the `?` key or the bottom-left `?` button (the button is hidden when the sidebar is collapsed). Lists `⌘ S` Save, `⌘ B` Toggle sidebar, `?` Show this list, `Esc` Close any dialog. Uses the native `<dialog>` element (no custom dialog code).

**First-visit tip (C2)** — runs exactly once per browser. The persistence key (`cms-static.firstVisitTip.dismissed`) is set on first display, not on dismissal, so refreshing without dismissing also counts as "shown" — by design. The tip is just a regular `info` toast, so it auto-dismisses after 3 s.

---

### 4.16 Loading skeletons (D3)

```
   user picks a page from #pagePicker
       │
       ▼ loadPage(pagePath)
       │
       ▼ STEP 1 — show skeletons immediately
       │ #fieldsBody.innerHTML = renderSkeletons(6)
       │
       │   <div class="skeleton-stack" aria-busy="true">
       │     [shimmering-bar label] [shimmering-input box] × 6
       │   </div>
       │
       ▼ STEP 2 — fire request
       │ GET /api/fields?page=…
       │
       ▼ STEP 3 — replace with real content
       │ state.fields = response.fields
       │ renderFields(state.fields)
       │   ↑ overwrites the skeleton stack with real groups + fields
```

The skeletons are visible for the full duration of the network round-trip; on a local request that's typically 30–80 ms — short enough that you'd see a flash either way, but with skeletons the flash *looks* like loading rather than a stale empty state.

CSS uses a 1.4 s `skel-shimmer` keyframe (linear-gradient `background-position` slide). Honors `prefers-reduced-motion: reduce` (animation skipped, static gray).

---

### 4.17 Clone-section flow (G1)

Lets the user duplicate a `<section>` direct child of `<main>` in place. The clone is inserted immediately after the original; its `id` (and any inner IDs/refs) get rewritten with a unique `-copy[-N]` suffix.

```
   browser editor                 server.js                    cheerio        [disk]
        │                             │                            │             │
        │ click 📋 Clone (in Sections │                            │             │
        │   group of the sidebar)     │                            │             │
        │                             │                            │             │
        ▼ STEP 1 — guard               │                            │             │
        │ if hasChanges():             │                            │             │
        │   toast('Save your edits     │                            │             │
        │     before cloning…',        │                            │             │
        │     'error')                 │                            │             │
        │   return                     │                            │             │
        │                             │                            │             │
        ▼ STEP 2 — POST                │                            │             │
        │ /__cms/api/clone-section     │                            │             │
        │ { page, selector } ─────────►│ STEP 3 — validate          │             │
        │                              │  selector regex:           │             │
        │                              │  ^body > main(#…)?         │             │
        │                              │       > section            │             │
        │                              │      (#…|:nth…)?$          │             │
        │                              │                            │             │
        │                              ▼ STEP 4 — read source       │             │
        │                              │ fs.readFileSync ─────────────────────────►│
        │                              │                            │             │
        │                              ▼ STEP 5 — cloneSection()    │             │
        │                              ├───────────────────────────►│             │
        │                              │  cheerio.load(html)        │             │
        │                              │  $section = $(selector)    │             │
        │                              │                            │             │
        │                              │  pickStem($section):       │             │
        │                              │   — id present?            │             │
        │                              │       strip trailing       │             │
        │                              │       '-copy[-N]' to get   │             │
        │                              │       base stem            │             │
        │                              │   — else first non-modifier │             │
        │                              │       class (skipping       │             │
        │                              │       container/reveal/etc) │             │
        │                              │   — else 'section'          │             │
        │                              │                            │             │
        │                              │  collectIds($) → Set        │             │
        │                              │                            │             │
        │                              │  pickAvailableSuffix(stem,  │             │
        │                              │    taken):                  │             │
        │                              │    try '<stem>-copy', then  │             │
        │                              │    '-copy-2', '-copy-3', …  │             │
        │                              │    until first not in taken │             │
        │                              │                            │             │
        │                              │  $clone = $section.clone() │             │
        │                              │  $clone.attr('id', newId)  │             │
        │                              │                            │             │
        │                              │  rewriteInnerIds($clone,    │             │
        │                              │    suffix):                 │             │
        │                              │   — every inner [id="X"]    │             │
        │                              │       → "X<suffix>"        │             │
        │                              │   — aria-labelledby /       │             │
        │                              │     -describedby /          │             │
        │                              │     -controls / -owns /     │             │
        │                              │     -flowto /               │             │
        │                              │     -activedescendant /     │             │
        │                              │     -details /              │             │
        │                              │     -errormessage           │             │
        │                              │       (each id-list token   │             │
        │                              │       suffixed only if it   │             │
        │                              │       resolves inside       │             │
        │                              │       the clone)            │             │
        │                              │   — <label for="X">         │             │
        │                              │   — <a href="#X">           │             │
        │                              │   — <use href="#X">,        │             │
        │                              │     xlink:href              │             │
        │                              │                            │             │
        │                              │  $section.after($clone)    │             │
        │                              ◄────── { html, newId,       │             │
        │                              │          suffix,            │             │
        │                              │          originalId }       │             │
        │                              │                            │             │
        │                              ▼ STEP 6 — pretty-print      │             │
        │                              │ js-beautify(html, …) ──────────────────────►
        │                              │                                          │
        │                              ▼ STEP 7 — write back        │             │
        │                              │ fs.writeFileSync ──────────────────────────►
        │                              │                            │             │
        │                              ▼ STEP 8 — re-extract        │             │
        │                              │ extractSections(pretty)    │             │
        │                              │                            │             │
        │ ◄────── { ok, newId, suffix, originalId, sections }       │             │
        │                                                                          │
        ▼ STEP 9 — UX response                                                    │
        │ toast(`Cloned · new id: #${newId}`, 'success')                          │
        │ iframe.src = '/' + page  (preview reloads from disk)                    │
        │ refetch /api/fields → renderFields() (Sections group + content groups)  │
```

**Stem-strip rule (worth noting).** When you clone a section that is *itself already a clone*, the cloner strips the trailing `-copy[-N]` from the source id before deriving the new name. This keeps names tidy:

| Source section's id | New clone's id (no collision) |
|---|---|
| `story` | `story-copy` |
| `story-copy` | `story-copy-2` (NOT `story-copy-copy`) |
| `story-copy-2` | `story-copy-3` |
| `about-us-copy-7` | `about-us-copy-8` |
| `card-copy-here` | `card-copy-here-copy` (only a trailing `-copy` is stripped) |

**Collision-skip example.** If you've manually edited the file so `#story-copy` and `#story-copy-2` already exist, then click Clone on `#story`, the next free name is `#story-copy-3`. The algorithm scans the entire document's ids (not just sibling ids) before choosing.

**Refs that point outside the clone.** Are intentionally **not** rewritten — they keep pointing at their original target. Only refs whose target is itself inside the cloned subtree get suffixed.

**Cloned forms.** If the cloned subtree contains a `<form>`, the response includes `formInside: true` and the editor surfaces a follow-up info toast: *"Note: the cloned section contains a form — JS hooks won't fire on the copy until rewired."* This is the trade-off we explicitly accept: the form's `id` and inner ids get suffixed (so HTML stays valid), but JS keyed off the original id (e.g. `e("#enquiryForm")` in `script-akasa.js`) won't bind to the clone. The user can either delete the form from the clone, rewire JS, or accept it as a static decorative duplicate.

**Out-of-scope for v1.18:** rename a section's id from the CMS, clone across pages, clone non-section blocks (article, aside, divs).

---

### 4.18 Delete / Move / Undo flow (G2 + G3 + G4)

```
   browser editor                  server.js                          [disk]    [history stack]
        │                              │                                │              │
        │ click ▲ / ▼ / 📋 / 🗑          │                                │              │
        │ (in a section-row)            │                                │              │
        │                              │                                │              │
        ▼ STEP 1 — guards               │                                │              │
        │ if hasChanges():              │                                │              │
        │   toast('Save your edits      │                                │              │
        │      first…', 'error')        │                                │              │
        │   return                      │                                │              │
        │ if kind === 'delete':         │                                │              │
        │   window.confirm('Delete X?') │                                │              │
        │   if cancelled, return        │                                │              │
        │                              │                                │              │
        ▼ STEP 2 — POST                 │                                │              │
        │ /__cms/api/                  │                                │              │
        │   {clone-section,            │                                │              │
        │    delete-section,           │                                │              │
        │    move-section,             │                                │              │
        │    undo}-section             │                                │              │
        │ ─────────────────────────────►│                                │              │
        │                              ▼ STEP 3 — read source            │              │
        │                              │ readFileSync ─────────────────────►            │
        │                              │                                │              │
        │                              ▼ STEP 4 — push history           │              │
        │                              │ pushHistory(page, html, action) ───────────────►
        │                              │ (cap: 10 per page; older        │              │
        │                              │  entries shift off the front)   │              │
        │                              │                                │              │
        │                              ▼ STEP 5 — apply op               │              │
        │                              │ cloner.cloneSection / OR        │              │
        │                              │ sectionOps.deleteSection / OR   │              │
        │                              │ sectionOps.moveSection          │              │
        │                              │                                │              │
        │                              ▼ STEP 6 — pretty-print           │              │
        │                              │ js-beautify(html, OPTS)         │              │
        │                              │                                │              │
        │                              ▼ STEP 7 — write back             │              │
        │                              │ writeFileSync ─────────────────────►            │
        │                              │                                │              │
        │                              ▼ STEP 8 — re-extract             │              │
        │                              │ extractSections(pretty)         │              │
        │                              │                                │              │
        │ ◄────── { ok, sections, undoAvailable, …action-specific }                    │
        │                                                                                │
        ▼ STEP 9 — UX response                                                          │
        │ toast(success message, 'success')                                              │
        │ if formInside (clone only): extra info toast                                   │
        │ refreshFromServer():                                                           │
        │   - reload preview iframe                                                      │
        │   - re-fetch /api/fields (fields + sections + undoAvailable)                   │
        │   - re-render sidebar with new section list + Undo button state                │
```

**Undo flow specifically.** The Undo button at the top of the Sections group POSTs to `/__cms/api/undo`. The server pops the most recent entry from this page's stack and writes the previous HTML back to disk verbatim:

```
   POST /__cms/api/undo  { page }
        │
        ▼
   sectionOps.popHistory(page) → { html, action } | null
        │
        ▼ if null:  400 "nothing to undo for this page"
        │ if entry: writeFileSync(filePath, entry.html)
        │
        ▼
   200 { ok: true, action, sections, undoAvailable }
```

**History store characteristics:**

- **Per-page**: `Map<pagePath, [{ html, action, timestamp }]>`.
- **In-memory only**: cleared when the server restarts. Git remains the durable backup. (Confirmed: undo is one click, but `git revert` is the resilient long-term safety net.)
- **Cap**: 10 entries per page. The 11th push silently drops the oldest. Acceptable for a developer tool.
- **No cross-page undo**: each page has its own stack. Switching pages doesn't drain another page's history.
- **No redo**: a popped entry is gone. Once you Undo, the action it reversed is the only path forward.

**Move-section bounds:** the cloner is permissive (any `<section>` in `<main>`); the mover throws if there's no section sibling in the requested direction. The frontend disables the ▲ button on the first row and the ▼ button on the last, but the server validates defensively in case of stale state.

**Confirm-on-delete:** a native `window.confirm()` dialog ("Delete #book? You can Undo immediately if needed."). The Undo button is the primary safety net; the dialog is light friction that prevents reflex-clicks.

---

### 4.19 AI chat flow (Tier H)

The ✨ AI button in the sidebar footer opens a chat panel that lets the user describe an edit in natural language. The browser orchestrates a Gemini 2.5 Flash agent loop, calls existing CMS endpoints as "tools," and ships either an auto-applied single edit or an approval card for multi-step / destructive plans. No new server endpoints are added.

```
   browser editor                     Gemini API                       /__cms/api/*
        │                                  │                                │
        │ user types in #chatInput         │                                │
        │ click Send (or Enter)            │                                │
        │                                  │                                │
        ▼ STEP 1 — guards                  │                                │
        │ if !apiKey: openKeyDialog();     │                                │
        │   return                         │                                │
        │ if window.hasChanges():          │                                │
        │   bubble('Save your edits        │                                │
        │      first…')                    │                                │
        │   return                         │                                │
        │                                  │                                │
        ▼ STEP 2 — fresh fetch             │                                │
        │ buildScopeContext():             │                                │
        │   GET /__cms/api/fields ──────────────────────────────────────────►
        │   ← { fields, sections }                                          │
        │   build a compact text manifest                                   │
        │   scoped to chat.scope                                            │
        │   (page-meta | section | whole-page)                              │
        │                                  │                                │
        ▼ STEP 3 — agent loop (max 16 iter, 8 tool calls/turn)              │
        │ POST generateContent ───────────►│                                │
        │   { systemInstruction,           │                                │
        │     contents,                    │                                │
        │     tools: TOOL_SCHEMAS (10) }   │                                │
        │ ◄──────── candidate.parts        │                                │
        │   • text → final answer          │                                │
        │   • functionCall(s) → tools to   │                                │
        │     run                          │                                │
        │                                  │                                │
        │ for each functionCall:           │                                │
        │   if read tool:                  │                                │
        │     callTool() ──────────────────────────────────────────────────►│
        │     ← { ok, …data } | { error }                                   │
        │     feed back as functionResponse│                                │
        │   if update_field / clone /      │                                │
        │      delete / move / undo:       │                                │
        │     buffer into chat.pendingPlan │                                │
        │     respond { ok: true,          │                                │
        │       deferred: true } so the AI │                                │
        │     can keep planning            │                                │
        │                                  │                                │
        │ (loop until model returns text)  │                                │
        │                                  │                                │
        ▼ STEP 4 — decide                  │                                │
        │ if pendingPlan empty:            │                                │
        │   render text bubble; done.      │                                │
        │ if pendingPlan = [single         │                                │
        │   update_field]:                 │                                │
        │   applyPlan() → POST /api/save ──────────────────────────────────►│
        │   show "tool" log line           │                                │
        │ else:                            │                                │
        │   push { role:'plan', plan } to  │                                │
        │   chat.history → render approval │                                │
        │   card in sidebar                │                                │
        │                                  │                                │
        ▼ STEP 5 — approval-card click                                      │
        │ Apply  → applyPlan() runs each   │                                │
        │   call sequentially through      │                                │
        │   callTool(), stops on first     │                                │
        │   error, then refreshFromServer()│                                │
        │ Cancel → mark cancelled,         │                                │
        │   nothing changes on disk        │                                │
```

**Three scopes** the user can pick from in the panel header:

| Scope | What's in the manifest | Default for |
|---|---|---|
| `page-meta` | title, meta description, og/twitter tags, canonical, JSON-LD top level | pages with no `<section>` |
| `section` | All fields with selectors inside the chosen `<section>`, plus its label | first section, on page open |
| `whole-page` | Section labels + counts only (no inner fields) | manual switch |

**Why scope matters.** The system prompt + manifest are rebuilt every turn — keeping the prompt small and auditable. A section-scoped chat sees ~5–20 fields; whole-page sees just a section list. The AI uses `read_page_fields(scope)` to drill in if it needs more.

**Tool whitelist (10):** `list_pages`, `read_page_fields`, `read_section`, `update_field`, `clone_section`, `delete_section`, `move_section`, `undo`, `lookup_field_id`, `find_text`. The dispatcher rejects unknown names with `{ error: 'unknown tool: …' }` so an off-list call simply feeds back as a tool failure.

**Three-way auto vs approval decision:**

1. AI replied with text only → just render the text bubble.
2. AI queued exactly one `update_field` → auto-apply (no card).
3. Anything else (multi-edit OR any clone/delete/move/undo) → render the approval card; user clicks ✓ Apply or ✗ Cancel.

**Failure paths:**

- Missing key → opens `aiKeyDialog`; nothing sent.
- HTTP 401/403 → "Your Gemini API key was rejected. Click ⚙ to update it."
- HTTP 429 → "Rate-limited by Gemini. Wait a moment and retry."
- Network error → "Could not reach Gemini (network error)."
- AI calls a non-whitelisted tool → returns `{ error }`; AI sees it next turn and either retries or gives up.
- 3 consecutive tool errors in one turn → loop aborts with an error bubble.
- Iteration cap (16) → safety bubble: "AI didn't finish in time. Try a smaller, more specific ask."

**Per-page chat history.** `chat.history` is wiped when `cms:page-changed` fires. There is no on-disk transcript; this is a working chat, not a log.

**API key storage.** `localStorage` if the user ticks "Remember on this browser," otherwise `sessionStorage`. Setting one clears the other. Never sent to the cms-static server.

---

### 4.20 Inline (in-preview) edit (Tier I)

The preview iframe is no longer read-only. Hover any text element whose selector matches a sidebar field → outline. Click → the element becomes `contentEditable` and a floating Done / Cancel bar appears in the parent document. Typing flows through the sidebar's existing change tracker; Save / Undo / Build are unchanged.

```
   browser editor                 preview iframe                    /__cms/api/*
        │                                │                                │
        │ user picks page                │                                │
        ├──── /api/fields ──────────────────────────────────────────────►│
        │ ◄────────────── { fields, sections } ──────────────────────────│
        │                                │                                │
        │ iframe.src = previewUrl ──────►│                                │
        │                                │ ▼ load                         │
        │                                │ inline-edit.js setupIframe():  │
        │                                │  • inject hover/active CSS     │
        │                                │  • for each text-mode field:   │
        │                                │      el = doc.querySelector(   │
        │                                │            f.selector)         │
        │                                │      if el && not in           │
        │                                │         readonly-ancestor:     │
        │                                │        el.dataset.cmsBound='1' │
        │                                │        el.dataset.cmsFieldId=  │
        │                                │            f.id                │
        │                                │        attach mouseenter,      │
        │                                │            mouseleave,         │
        │                                │            click (capture)     │
        │                                │                                │
        │                       ▼ user hovers an element                  │
        │                       │ outline via .cms-edit-hover             │
        │                       │                                         │
        │                       ▼ user clicks (capture beats site JS)     │
        │                       │ e.preventDefault, stopPropagation       │
        │                       │ el.contentEditable = "true"  (or        │
        │                       │   "plaintext-only" for text-mode)       │
        │                       │ selectAll(el), focus()                  │
        │                       │                                         │
        ▼ parent doc creates floating bar                                  │
        │ <div class="cms-edit-bar">[label] [Cancel] [Done]</div>          │
        │ positioned via iframe.getBoundingClientRect()                    │
        │                       │                                         │
        │                       ▼ user types                               │
        │                       │ input event fires →                     │
        │                       │  value = mode==='text'                  │
        │                       │    ? el.textContent                     │
        │                       │    : sanitise(el.innerHTML)             │
        │                       │ find sidebar:                           │
        │ ◄─────────────────────┤  document.querySelector(                │
        │                          '[data-input-id="<fieldId>"]')         │
        │ sidebar.value = value                                           │
        │ sidebar.dispatchEvent(new Event('input'))                       │
        │  → existing handler sets state.changed,                         │
        │    flips dirty class, lights Save button                        │
        │                                                                  │
        ▼ user clicks Done (or ⌘/Ctrl+Enter)                              │
        │ final sanitise pass on el.innerHTML                              │
        │ remove contenteditable, remove bar                               │
        │ state.changed already has the value from input events            │
        │                                                                  │
        ▼ OR user clicks Cancel (or Esc)                                  │
        │ el.innerHTML = saved originalHTML                                │
        │ sidebar.value = saved originalSidebarValue                       │
        │ dispatch input                                                    │
        │ if originalSidebarValue === f.value:                             │
        │   state.changed.delete(fieldId)                                  │
        │   remove .changed class on the field card                        │
        │   refreshSaveBtn(); setStatus('','') if no other dirties         │
        │                                                                  │
        ▼ later: user clicks Save                                         │
        │ POST /api/save with state.changed serialised the same way        │
        │ a sidebar-only edit would. Server doesn't know or care that the  │
        │ value came from inline editing.                                  │
```

**What's bound vs skipped:**

| Field | Bound? |
|---|---|
| `<h1>` / `<h2>` / `<h3>` / `<p>` / `<li>` / `<blockquote>` / `<figcaption>` (extractor-recognised body text) | ✓ |
| Page title — `<title>` (inside `<head>`, no offsetParent) | ✗ — sidebar only |
| Meta description, OG/Twitter tags (real HTML attribute on `<meta>`) | ✗ — sidebar only |
| JSON-LD inside `<script type="application/ld+json">` | ✗ — sidebar only |
| Image `<img>` src / alt | ✗ — sidebar (image cropper) |
| Anything inside `.swiper` / `.slick` / `.tns-*` (carousels) | ✗ — sidebar only |
| Anything inside `<form>` / `<button>` / `<a role="button">` | ✗ — sidebar only |
| Anything with `[data-no-cms-edit]` ancestor (opt-out) | ✗ — sidebar only |

**Why the sidebar stays the source of truth.** Inline edit is an *input surface*, not a state store. Every keystroke flows through the same sidebar `<textarea>` → `state.changed` path. If you save while in edit mode, the change is captured (it was queued on the first keystroke). If you cancel, the queue is rolled back. There is no second representation of the edit state to keep in sync — by design.

**Sanitiser rules.** On every `input` event and again on Done:
- Allow `<em>`, `<strong>`, `<br>` only. Attributes stripped.
- Normalise `<b>` → `<strong>`, `<i>` → `<em>`.
- Unwrap any other element: move its children up to its parent (preserving nested allowed tags), then drop the wrapper.
- Paste is intercepted at the source: `clipboardData.getData('text/plain')` only, so Word / Docs markup never enters the DOM.

**Re-attach on every iframe load.** The `load` listener fires on the initial page select, every section op (clone / delete / move / undo), and the user's `⟳ Refresh` click. Each fire calls `setupIframe()` 150 ms later (giving editor.js time to refresh `state.fields`); already-bound elements (`dataset.cmsBound === '1'`) are skipped on the second pass, so re-attaching is idempotent.

---

### 4.21 Draft persistence + refresh guard (Tier J)

Three layers of protection against accidental reload data loss:

1. Auto-save drafts to `localStorage` on every change.
2. Hijack `⌘R / Ctrl+R / F5` and show an in-app confirm dialog.
3. Existing native `beforeunload` prompt remains as the catch-all.

```
   editor.js                      drafts.js                       localStorage
       │                              │                                │
       │ user types in a sidebar      │                                │
       │ field                        │                                │
       │ state.changed.set(id, val)   │                                │
       │ window.cmsDrafts.persist() ──►│                                │
       │                              │ debounce 400ms ─────► persistNow│
       │                              │   { changed:[…], changedAlt:[…],
       │                              │     savedAt: ISO,              │
       │                              │     pendingImagesCount: N } ───►│
       │                              │                                │ (kept until
       │                              │                                │  successful save
       │                              │                                │  or Discard)
       │                              │                                │
       │ user reloads ─────────────────────────────────────────────────►│
       │ (any path: keyboard, button,                                   │
       │  tab close, crash)                                             │
       │                                                                │
       │ ── editor reloads ────────                                     │
       │                              │                                │
       │ loadPage(p) → state.fields   │                                │
       │ window.cmsDrafts.maybeRestore(p) ──►                           │
       │                              │ readDraft(p) ─────────────────►│
       │                              │ ◄──── { changed, changedAlt, …}│
       │                              │ render <div class="draft-banner">
       │                              │   "N unsaved edits from your    
       │                              │    last session — Restore / Discard"
       │                              │                                │
       │ user clicks Restore          │                                │
       │ ◄── applyDraft: state.changed.set(…) for each entry,           │
       │      renderFields(), refreshSaveBtn(), setStatus('unsaved restored')
       │                              │                                │
       │ user clicks Save             │                                │
       │ POST /api/save → ok          │                                │
       │ state.changed.clear()        │                                │
       │ window.cmsDrafts.clear(p) ───►│ removeItem ───────────────────►│ (gone)
       │                              │                                │
       │                              │                                │
   ⌘R / Ctrl+R / F5 hijack            │                                │
   ─────────────────────              │                                │
   document.keydown (capture):        │                                │
     if isRefreshKey && hasUnsaved:   │                                │
       e.preventDefault()             │                                │
       show <dialog id=refreshConfirmDialog>:                          │
         ✗ Cancel                                                       │
         Discard & reload → clear state.changed; clearDraft(); reload()│
         ✓ Save & reload  → await window.save(); reload()              │
```

**Storage key.** `cms-static.draft.<pagePath>`, e.g. `cms-static.draft.akasa-dalhousie/index.html`. Scoped per-origin by the browser, so two cms-static instances on different ports don't collide.

**Debounce + flush.** Every `state.changed.set` schedules a 400 ms debounced write. A keydown listener for `beforeunload` and a `visibilitychange → hidden` listener call `persistNow()` immediately, so the latest keystroke is never lost to the debounce window.

**What is NOT persisted.** `state.pendingImages` contains live `Blob` references that don't survive a JSON round-trip. The banner says "(image crops were lost)" if `pendingImagesCount > 0` so the user knows to re-crop.

**Refresh dialog vs native `beforeunload`.**

| Refresh path | What fires |
|---|---|
| ⌘R / Ctrl+R / F5 (any modifier combination) | Our `<dialog>` with three options |
| Browser toolbar reload button | Native `beforeunload` ("Leave / Stay") — drafts survive in localStorage |
| Close tab from title bar / ⌘W / Ctrl+W | Native `beforeunload` — drafts survive |
| Browser / OS crash, force-quit | No prompt — drafts survive |

In all cases, the localStorage draft is the actual safety. The dialog (J2) is polish for the most common case.

---

### 4.22 SEO / content validation warnings (Tier K)

A lightweight, extensible rule engine that surfaces content-quality issues as the user edits. v1 covers exactly one rule (multiple `<h1>` per page); the pipeline below is the contract every future rule slots into.

```
   editor.js                              validation.js                            sidebar DOM
       │                                       │                                        │
       │ renderFields(fields) at end:          │                                        │
       │ window.cmsValidation.render(          │                                        │
       │   state.currentPage, fields) ────────►│                                        │
       │                                       │ checkPage(fields):                     │
       │                                       │   issues = []                          │
       │                                       │   h1s = fields.filter(                 │
       │                                       │     f => f.tag === 'h1')               │
       │                                       │   if h1s.length > 1:                   │
       │                                       │     issues.push({                      │
       │                                       │       code:'multiple-h1',              │
       │                                       │       severity:'warn',                 │
       │                                       │       message:'N <h1> on this page…',  │
       │                                       │       toast:'N H1 tags found …',       │
       │                                       │       items: h1s.map(f → {             │
       │                                       │         id, label:preview(f.value),    │
       │                                       │         context: f.context }) })       │
       │                                       │                                        │
       │                                       │ renderCard(issues):                    │
       │                                       │   if !issues.length:                   │
       │                                       │     remove #seoCard if present         │
       │                                       │     return                             │
       │                                       │   ensure #seoCard exists as a sibling  │
       │                                       │   before #fieldsBody ────────────────►│ <div id="seoCard">
       │                                       │   #seoCard.innerHTML = issues          │   <div class="seo-issue">
       │                                       │     .map(renderIssue).join('')         │     ⚠ N <h1> tags …
       │                                       │                                        │     <ol class="seo-list">
       │                                       │                                        │       <li><button class="seo-item-jump"
       │                                       │                                        │           data-fid="…">label</button>
       │                                       │                                        │           in <context></li>
       │                                       │                                        │       …
       │                                       │                                        │     </ol>
       │                                       │                                        │   </div>
       │                                       │                                        │ </div>
       │                                       │                                        │
       │                                       │ toastIfNew(pagePath, issues):          │
       │                                       │   sig = issues w/ toast → "code:N"     │
       │                                       │   if sig === lastToastCount[page]:     │
       │                                       │     return  (don't re-toast)           │
       │                                       │   lastToastCount[page] = sig           │
       │                                       │   for each issue with .toast:          │
       │                                       │     window.cmsToast(issue.toast,'info')─►│ → 3s auto-dismiss toast bottom-right
       │                                       │                                        │
       │ user clicks ".seo-item-jump"          │                                        │
       │ (delegated handler in validation.js)  │                                        │
       │                                       │ input = querySelector(                 │
       │                                       │   '[data-input-id="<fieldId>"]')       │
       │                                       │ input.scrollIntoView({behavior:smooth})│
       │                                       │ setTimeout focus + field.flash 320ms ─►│ .field.field-flash pulse 1.1s
       │                                       │                                        │
   user navigates to a different page          │                                        │
       │ cms:page-changed event ──────────────►│ lastToastCount.delete(newPage)         │
       │                                       │ (so a re-toast can fire when           │
       │                                       │  re-entering a problem page)           │
```

**Why state.fields and not iframe DOM.** The fields manifest already filters out `<h1>`s inside excluded ancestors (`<nav>`, `<footer>`, `<form>`, `<script>`, inline SVGs). Those are structural, not editable content — counting them as SEO issues would be noise. Future checks that need raw DOM can read `iframe.contentDocument` directly.

**Toast vs card.** The toast is a *transition signal* — "this just changed." The card is *state* — "this is currently true." Both surfaces exist because users sometimes miss the toast (3-second window) and need the issue to remain visible until acted on.

**Per-page toast memory.** A `Map<pagePath, signature>` of last-toasted signatures stops re-toasting on every refetch of fields within the same page session. The signature is `<code>:<count>` per issue, so a second clone (2→3 h1) re-toasts because the signature changed.

**Adding new rules.** Drop a `checkX(fields)` function next to `checkH1` in `validation.js`, return matching items, push an issue object into `checkPage`'s array. Pipeline below it (render card, toast on new, click-to-jump) is rule-agnostic. Candidates: meta description length (>160 char warn, missing error), page title length (>60 char warn), missing alt text on images, two fields with identical value, etc.

---

## 5. State machines

### 5.1 Per-page edit state

```
                       ┌──────────┐
                       │  CLEAN   │  ← pageLoad / pageSwitch / saveSuccess
                       │  ────    │
                       │  Save    │
                       │  button  │
                       │  disabled│
                       └────┬─────┘
                            │ user types into a field
                            │ OR replaces an image
                            ▼
                       ┌──────────┐
                       │  DIRTY   │  state.changed.size > 0
                       │  ────    │  OR state.changedAlt.size > 0
                       │  status: │  OR state.pendingImages.size > 0
                       │  "● un-  │
                       │  saved"  │
                       │  Save    │
                       │  button  │
                       │  enabled │
                       └────┬─────┘
                            │ user clicks Save / Cmd+S
                            ▼
                       ┌──────────┐
                       │  SAVING  │  request in-flight
                       │  ────    │
                       │  status: │
                       │  "Saving │
                       │   …"     │
                       └────┬─────┘
                            │
              ┌─────────────┼─────────────┐
              │ success                   │ failure
              ▼                           ▼
      ┌──────────────┐            ┌──────────────┐
      │  SAVED       │            │  ERROR       │
      │  state map   │            │  status:     │
      │  cleared,    │            │  "Save error:│
      │  fields      │            │   …"         │
      │  reloaded,   │            │  state still │
      │  iframe      │            │  DIRTY       │
      │  refreshed   │            └──────┬───────┘
      └──────┬───────┘                   │ user retries
             │ → CLEAN                   │
             └───────► back to top       └────► back to SAVING
```

Browser's `beforeunload` listener prevents accidental tab close while in DIRTY state.

### 5.2 Git lifecycle state

```
                        ┌──────────────────────────┐
                        │  NO_GIT                  │
                        │  git not installed       │
                        │  → notice in panel       │
                        └──────────────────────────┘

                        ┌──────────────────────────┐
                        │  NO_REPO                 │  ← startup if .git absent
                        │  Git installed           │
                        │  Folder isn't a repo     │
                        └────┬───────────────┬─────┘
                             │               │
                  user picks │               │ user picks
                  "Skip"     │               │ "Init local" or "Init + remote"
                             ▼               ▼
                  ┌──────────────────┐   ┌──────────────────┐
                  │  SKIPPED         │   │  INIT'ING        │
                  │  flag in         │   │  POST /api/git/  │
                  │  localStorage    │   │       init       │
                  │                  │   └────────┬─────────┘
                  │  panel shows     │            │
                  │  "Skipped"       │            │ success / fail
                  │  + "Set up Git"  │            ▼
                  │   button         │   ┌──────────────────┐
                  └────────┬─────────┘   │  REPO_CLEAN      │
                           │             │  isRepo: true    │
                  user clicks            │  dirty: 0        │
                  "Set up Git"           │  ahead: 0 or N   │
                           ▼             └────┬─────────────┘
                  back to NO_REPO →           │
                                              │ user saves a CMS edit
                                              ▼
                                    ┌──────────────────┐
                                    │  REPO_DIRTY      │
                                    │  dirty: 1+       │
                                    │  Commit btn      │
                                    │  enabled         │
                                    └────┬─────────────┘
                                         │ user (or auto-commit) commits
                                         ▼
                                    ┌──────────────────┐
                                    │  REPO_AHEAD      │
                                    │  dirty: 0        │
                                    │  ahead: N+1      │
                                    │  Push btn        │
                                    │  enabled (if has │
                                    │  remote)         │
                                    └────┬─────────────┘
                                         │ user pushes
                                         ▼
                                    ┌──────────────────┐
                                    │  REPO_SYNCED     │
                                    │  ahead: 0        │
                                    │  behind: 0       │
                                    └──────────────────┘
                                         │ user edits more
                                         └──► back to REPO_DIRTY
```

The state object is refreshed every 8 seconds (poll) and on every Save / Commit / Push so the panel never drifts from disk reality.

### 5.3 Save-button state machine (D2 + C4)

The Save button has its own dedicated state — separate from the per-page edit state — because the visual feedback must persist briefly across an async server round-trip.

```
   ┌─────────────────────────────┐
   │  CLEAN                       │
   │  ─────                       │
   │  label: "Save"               │   ← state.changed.size === 0
   │  disabled: yes               │      AND state.pendingImages empty
   │  classes: (none)             │
   └─────────┬───────────────────┘
             │ user types in a field /
             │ replaces an image
             ▼
   ┌─────────────────────────────┐
   │  DIRTY                       │
   │  ─────                       │
   │  label: "Save N changes"     │  ← N = unique field-id count
   │  disabled: no                │     across changed + changedAlt
   │  classes: (none)             │     + pendingImages
   └─────────┬───────────────────┘
             │ user clicks Save
             │ or hits ⌘S
             ▼
   ┌─────────────────────────────┐
   │  SAVING                      │
   │  ─────                       │
   │  label: "Saving…"            │
   │  disabled: yes               │
   │  classes: is-saving          │
   └─────────┬───────────────────┘
             │
       ┌─────┴────────┐
       │              │
   on success    on error
       │              │
       ▼              ▼
   ┌─────────────┐ ┌───────────────────────┐
   │  SAVED       │ │  ERROR                 │
   │  ─────       │ │  ─────                 │
   │  label:      │ │  toast(err, 'error')   │
   │  "✓ Saved"   │ │  setSaveBtnState(      │
   │  disabled:yes│ │    'idle') → goes back │
   │  classes:    │ │    to CLEAN/DIRTY      │
   │   is-saved   │ └───────┬───────────────┘
   │   (700 ms    │         │
   │    pulse)    │         │
   │              │         │
   │  toast(      │         │
   │   'Saved · X │         │
   │    KB',      │         │
   │   'success') │         │
   └──────┬──────┘          │
          │ 900 ms after     │
          │ 'Saved' shown    │
          ▼                  │
   refreshSaveBtn()  ◄───────┘
   ↑ goes back to CLEAN (since Save just cleared the dirty maps)
```

### 5.4 Sidebar layout state

Two orthogonal axes, each persisted independently:

```
           collapsed=false                 collapsed=true
           ─────────────                   ─────────────
           ┌────────────┐                  ┌─┬────────────┐
   width   │            │                  │⤴│            │
   = 380   │   sidebar  │                  │ │   preview  │
           │   contents │                  │ │   only     │
           │   visible  │                  │ │            │
           └────────────┘                  └─┴────────────┘

   ┌──────────────────┐                    ┌─┬─────────────┐
   width │              │                  │⤴│             │
   = 600 │   wider      │                  │ │   preview   │
        │   sidebar    │                  │ │   only      │
        │   (drag)     │                  │ │             │
        └──────────────┘                    └─┴─────────────┘

   width:    300 ←────── 600 px            (width is preserved
              clamped on drag                regardless of
                                            collapsed state)
```

**Two independent CSS variables** make the matrix work without conflicts:
- `--user-sidebar-width` — written by the resize handle, read on expand
- `--sidebar-width` — what the grid actually consumes; `:not(.is-collapsed)` reads from `--user-sidebar-width`, `.is-collapsed` overrides to 36 px

Both `localStorage` keys (`cms-static.sidebar.collapsed` and `cms-static.sidebar.width`) restore on each editor load. Resize while collapsed is a no-op (the resizer's `pointerdown` early-returns).

---

## 6. Data shapes

### 6.1 Field descriptor (returned by `/api/fields`)

```js
{
  id:         "h1:28",                   // session-local; (tag-name : sequential index)
  group:      "Headings",                // UI section: "Page details (SEO)" | "Business info" |
                                         //   "Headings" | "Page content" | "Photos" | "Schema — X"
  type:       "text" | "longtext" | "image",
  label:      "hero-content — h1 · \"Close to The Mall…\"",  // legacy long form, used as title= tooltip
  selector:   "body > main#main > section:nth-of-type(1) > div:nth-of-type(2) > h1#heroHeading",
  attr:       "text" | "html" | "content" | "src",  // how to write the value back
  value:      "Close to The Mall. <em>Far from the noise.</em>",

  // headings + body-text only (used by editor.js to render friendly labels):
  tag:        "h1" | "h2" | "h3" | "h4" | "p" | "li" | "blockquote" |
              "figcaption" | "dt" | "dd",
  context:    "hero-content",            // section/class/id the element lives under;
                                         // rendered as small muted hint "in hero-content"

  // image-only:
  altAttr:    "alt",
  alt:        "Hero photo of the homestay",
  width:      null,
  height:     null,

  // JSON-LD-only:
  scriptIndex: 0,        // which <script type="application/ld+json"> block
  arrayIndex:  null,     // if the script's value is an array, which item
  jsonPath:    "address.streetAddress",
}
```

**Friendly group names** (set in `extractor.js`):

| Source | `group` value |
|---|---|
| `<title>`, meta description, og/twitter meta | `Page details (SEO)` |
| JSON-LD `LodgingBusiness` | `Business info` |
| JSON-LD `Hotel` | `Hotel info` |
| JSON-LD `Restaurant` | `Restaurant info` |
| JSON-LD `Organization` / `LocalBusiness` | `Business info` |
| JSON-LD `Product` | `Product info` |
| JSON-LD `Article` | `Article info` |
| JSON-LD `WebSite` / `WebPage` | `Site info` / `Page info` |
| JSON-LD any other `@type` | `Schema — <Type>` (kept dev-y as a fallback) |
| `h1`–`h4` inside `<main>` | `Headings` |
| `p`/`li`/`blockquote`/etc inside `<main>` | `Page content` |
| `<img>` inside `<main>` | `Photos` |

**Friendly tag labels** (rendered client-side in `editor.js` from `f.tag`):

| `tag` | Display label |
|---|---|
| `h1` | Heading 1 |
| `h2` | Heading 2 |
| `h3` | Heading 3 |
| `h4` | Heading 4 |
| `p` | Paragraph |
| `li` | List item |
| `blockquote` | Quote |
| `figcaption` | Caption |
| `dt` | Term |
| `dd` | Description |

**Group display order** in the sidebar (set in `editor.js → GROUP_ORDER`):

```
1. Headings
2. Page content
3. Photos
4. Page details (SEO)
5. anything else (Business info, Schema — X, …) in original order
```

Items not in `GROUP_ORDER` keep their original insertion order at the end. Server returns groups in extraction order; client re-sorts in `renderFields()`.

### 6.2 Save payload (`POST /api/save` body)

```js
{
  "page": "akasa-dalhousie/index.html",
  "changes": [
    // DOM-targeted change:
    {
      "selector": "head > meta[name=\"description\"]",
      "attr": "content",
      "value": "New meta description text"
    },
    // Image-targeted change (note altAttr + alt):
    {
      "selector": "body > main#main > … > img",
      "attr": "src",
      "value": "/images/akasa/cbeac70c.jpg",
      "altAttr": "alt",
      "alt": "Hero photo of the homestay"
    },
    // JSON-LD change:
    {
      "scriptIndex": 0,
      "arrayIndex": null,
      "jsonPath": "address.postalCode",
      "value": "176304"
    }
  ]
}
```

### 6.3 Git state object (returned by `/api/git/state`)

```js
{
  installed:   true,             // is the `git` binary on PATH?
  isRepo:      true,             // is the site folder inside a git repo?
  repoRoot:    "/path/to/repo",  // absolute path to repo top-level (may differ from siteRoot)
  hasRemote:   true,             // does origin exist?
  remoteUrl:   "git@github.com:user/repo.git",
  branch:      "main",
  ahead:       3,                // commits on local that aren't on origin
  behind:      0,                // commits on origin that aren't on local
  hasUpstream: true,             // is the branch tracking origin/<branch>?
  upstream:    "origin/main",
  dirty:       2,                // count of uncommitted files (modified/new)
  log: [
    { hash: "1486940c", full: "1486940c…", subject: "[cms] …", when: "5 minutes ago" },
    …
  ]
}
```

### 6.4 Build report (returned by `/api/build`)

```js
{
  minified: {
    ok: true,
    log: "Minifying project to _minified/ ...\n\nMinified 55 files:…"
  },
  formatted: {
    ok: true,
    formatted: 55,    // count of files written by js-beautify
    copied: 39        // count of non-text files copied as-is
  }
}
```

---

## 7. Error & failure paths

| Failure | Surfaced as | Recovery |
|---|---|---|
| Site folder doesn't exist | CLI exits 1 with a message | Provide a valid path |
| `index.html` looks minified | CLI exits 1 with a message | Point at source, not `_minified/` |
| Port 5174 already in use | CLI exits 1 with `EADDRINUSE` | `PORT=…` env var, or kill the other process |
| Sharp install failed | Image upload still works (raw bytes) | `npm rebuild sharp`, or accept degraded mode |
| `cheerio` mutation throws | `/api/save` returns 500 with `error` | Check selector; fix bad input |
| `js-beautify` chokes | Save still writes the cheerio output without pretty-print | Inspect the file; rare |
| `build.js` exits non-zero | `/api/build` returns minified.ok=false; formatted still runs | `node build.js` manually to see error |
| `git` not installed | Git panel shows notice; no Git features | Install Git |
| `git init` fails | Onboarding modal shows `"Init failed: …"` | Fix the reported issue |
| `git push` rejected | Push button → status bar `"Push error: <stderr>"` | Pull/rebase, fix auth, force-push if intentional |
| Auto-commit fails silently | Next refreshState() reveals dirty count > 0 | Click Commit manually |
| User picks Skip onboarding | Panel shows "Skipped" + "Set up Git" button | Click "Set up Git" anytime |

The save endpoint is **all-or-nothing per request**: if cheerio fails on any change, the entire save aborts before writing to disk. This avoids partial-write corruption.

---

## 8. Glossary

**Field** — a single editable thing (text node, attribute, JSON-LD value, image src). Discovered automatically from semantic HTML.

**Field ID** — a session-local string that uniquely identifies a field within a single page-load. Format: `<tag>:<sequential-number>`. Recomputed each time the page is loaded in the editor; never written into source files.

**Selector** — a CSS path from `<html>` to the element, used by the server to relocate the element on save. Built from tag names + `#id` + `:nth-of-type()` as needed.

**Group** — the UI category a field belongs to. One of: SEO, Schema (X), Headings, Body text, Images.

**Site root** — the folder you passed to `bin/cli.js`. Everything under it is editable; nothing above it is touched.

**Repo root** — the folder containing `.git/`. Often equal to site root, but if you `git init` at a parent folder, repo root is the parent. The Git module always operates on repo root, while content edits operate on site root.

**Onboarding** — the one-time modal shown when the editor opens on a folder that isn't yet a Git repo. Three options: init local, init + connect remote, skip.

**Auto-commit** — toggle in the Git panel. When ON, every successful Save also runs `git add + git commit` with an auto-generated message. Stored in `localStorage`.

**Dirty count** — `git status --porcelain` line count. Visible as a pill in the Git panel.

**Ahead / behind** — number of commits on the local branch not on the remote / vice versa. Visible as pills in the Git panel.

**Pending image** — a cropped image blob held in `state.pendingImages` until the user clicks Save, at which point it's POSTed to `/api/upload-image`.

**Suggested message** — the commit message auto-generated from a save's changes. Format: `[cms] <page> · <count> <group>, <count> <group>…`.

**Toast** — a notification that appears bottom-right of the viewport. Three kinds: `info` (blue), `success` (green), `error` (red). Info/success auto-dismiss after 3 s; errors stick until clicked. Stack capped at 4 visible. Used for save success, build done, push errors, etc.

**Save-button states** — five-state visual machine the Save button cycles through: CLEAN → DIRTY → SAVING → (SAVED | ERROR) → back to CLEAN. See §5.3.

**Welcome card** — the friendly placeholder shown in `#fieldsBody` when no page is selected. Replaces the original "Pick a page above to start editing." line.

**First-visit tip** — a one-time `info` toast shown ~700 ms after the editor first loads in a new browser. Persisted via `cms-static.firstVisitTip.dismissed`.

**Cheat-sheet** — the keyboard-shortcuts modal (`<dialog>`). Opened via the `?` key (when not in an input) or the floating `?` button at bottom-left of the viewport. Lists `⌘ S`, `⌘ B`, `?`, and `Esc`.

**Skeleton** — a shimmering grey placeholder shown while `/api/fields` is loading. Six rows. Replaces the older "Loading fields…" text.

**Compact mode (Git)** — the default rendering of the Git panel: branch + pills + commit form + push always visible; remote URL, auto-commit toggle, and recent log behind a `▾ More` toggle. Persisted via `cms-static.git.expanded`.

**Provider** — the friendly host name derived from a remote URL (GitHub / Bitbucket / GitLab / Gitea / Codeberg / Azure DevOps / "remote"). Used in the verb-first push button label "Send to <provider>".

**Clone (section)** — duplicates a `<section>` direct child of `<main>` in place, immediately after the original. The new section gets a unique `-copy[-N]` id; inner element IDs and any references to them (aria-*, `<label for>`, anchor `href="#…"`, `<use href="#…">`) are also suffixed so the document stays free of duplicate IDs and broken cross-references. See §4.17.

**Stem (cloning)** — the base portion of a section's id used when generating the new clone's id. Derived from: the section's existing id (with any trailing `-copy[-N]` stripped) → first non-modifier class → fallback "section". Lives in `pickStem()` in `cloner.js`.

**Section history stack** — per-page in-memory list of pre-action HTML snapshots, used by the Undo button. Lives in `section-ops.js → history` Map. Capped at 10 entries per page; cleared on server restart. Supports clone, delete, move-up, move-down. See §4.18.

**`formInside` flag** — included in the clone-section response when the cloned subtree contains a `<form>`. Triggers a follow-up info toast warning the user that JS hooks won't fire on the cloned form.

**`--user-sidebar-width`** — CSS variable holding the user's chosen sidebar width (in px) regardless of collapsed state. Persisted in `localStorage`. Distinct from `--sidebar-width`, which is what the layout grid actually consumes; the `.is-collapsed` class overrides only `--sidebar-width`. The split avoids the inline-style-vs-class-rule specificity collision documented in §4.12.

**Chat scope** — the slice of the current page the AI sees this turn: `page-meta` (head + JSON-LD), `section` (one chosen `<section>` plus its label), or `whole-page` (a section list only). Set per chat by the dropdown in the panel header; rebuilt fresh every turn from `/__cms/api/fields`. See §4.19.

**Tool whitelist (AI)** — the 10 named functions Gemini is allowed to call from the chat: `list_pages`, `read_page_fields`, `read_section`, `update_field`, `clone_section`, `delete_section`, `move_section`, `undo`, `lookup_field_id`, `find_text`. Lives in `ai.js → ALLOWED_TOOLS`. Out-of-list calls return `{ error }` to the model, never reach disk. See §4.19.

**Approval card** — chat bubble surfaced when the AI queues two-or-more edits, or any clone/delete/move/undo. Lists each pending action in plain English with ✓ Apply / ✗ Cancel. Only a *single* `update_field` is auto-applied without a card — that's the safe-edit fast path. See §4.19.

**Pending plan** — `chat.pendingPlan: ToolCall[]` in `ai.js`. Buffer for tool calls the AI made this turn that we haven't yet executed (write tools only). Drained at end-of-turn into either an immediate apply or an approval card.

**Inline-edit binding** — a DOM element in the preview iframe annotated with `data-cms-bound="1"`, `data-cms-field-id="<id>"`, and `data-cms-mode="text"|"html"`. Applied by `inline-edit.js → setupIframe()` on every iframe load for elements whose field selector resolves and passes the read-only-ancestor blocklist. The element is a *handle* for the matching sidebar field; the field remains the source of truth. See §4.20.

**Inline-edit mode** — either `text` (`attr === 'text'` on the field → `contentEditable="plaintext-only"`, value is `el.textContent`) or `html` (`attr === 'html'` or empty → `contentEditable="true"`, value is `sanitise(el.innerHTML)`). The mode is decided once per element at attach time and stored as `data-cms-mode`.

**Inline-edit sanitiser** — `walkAndClean()` in `inline-edit.js`. Post-order walk over a parsed template fragment that (a) keeps only `<em>`, `<strong>`, `<br>`, (b) remaps `<b>`→`<strong>` and `<i>`→`<em>`, (c) unwraps any other element by moving its children up before removing the wrapper, so nested allowed tags survive. Idempotent: running on already-clean HTML is a no-op.

**Draft** — a serialised snapshot of `state.changed` + `state.changedAlt` for one page, written to `localStorage` under `cms-static.draft.<pagePath>` by `drafts.js`. Survives reload / tab close / crash. Cleared on successful save or explicit Discard. Does *not* include `state.pendingImages` (blobs aren't JSON-serialisable). See §4.21.

**Refresh-confirm dialog** — `<dialog id="refreshConfirmDialog">` in index.html, shown when the user presses `⌘R / Ctrl+R / F5` with unsaved changes. Three buttons: Cancel, Discard & reload, Save & reload. Triggered by a capture-phase `keydown` listener in `drafts.js`; the browser's native `beforeunload` prompt still fires for paths we can't intercept (reload button, tab close).

**Validation issue** — `{ code, severity, message, toast?, items? }`. Returned by `checkPage()` in `validation.js`. `code` is a stable identifier (e.g. `multiple-h1`); `severity` is `warn` for v1; `message` goes on the sidebar card; `toast` (optional) is the auto-dismissing transition signal; `items` (optional) is the clickable list of offending fields. The pipeline that renders cards and toasts is rule-agnostic — adding a new rule is just adding a `checkX` and pushing into the array. See §4.22.

**SEO warning card** — `<div id="seoCard">` inserted as a sibling of `#fieldsBody`, before it. Replaced wholesale on every `render()` call; removed entirely when there are no issues. Click handler is delegated, so re-renders don't need to re-wire buttons.

---

*Last revised: 2026-05-11 · cms-static v0.2.3 (Tier K — SEO multiple-H1 warning).*
