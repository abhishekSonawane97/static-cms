# cms-static — AI Integration Plan (v1)

A plan-of-record for integrating Gemini 2.5 Flash as an AI assistant into the CMS. Designed to be pickable up by anyone on the team in any future session: every decision is explicit, every step is small enough to ship in one sitting, and every config knob is named.

> Companion to `README.md`, `design-flow.md`, and `ui-roadmap.md`. This file owns "how the AI feature is built and why each call was made". When the work is shipped, mark phases as `☑` here and add a Done log entry at the bottom.

---

## Table of contents

- [1. Why / what this delivers](#1--why--what-this-delivers)
- [2. Final decisions (locked in)](#2--final-decisions-locked-in)
- [3. Architecture at a glance](#3--architecture-at-a-glance)
- [4. The 10 tools the AI gets](#4--the-10-tools-the-ai-gets)
- [5. System prompt + refusal contract](#5--system-prompt--refusal-contract)
- [6. UX surfaces](#6--ux-surfaces)
- [7. Implementation phases (tiny steps)](#7--implementation-phases-tiny-steps)
- [8. File-by-file plan](#8--file-by-file-plan)
- [9. Configuration & storage keys](#9--configuration--storage-keys)
- [10. Failure paths](#10--failure-paths)
- [11. Test checklist](#11--test-checklist)
- [12. Out of scope / parked](#12--out-of-scope--parked)
- [13. Future enhancements](#13--future-enhancements)
- [14. Glossary](#14--glossary)
- [15. Done log](#15--done-log)

---

## 1 · Why / what this delivers

`cms-static` already gives a developer (or a non-technical hotelier) point-and-click control over text, images, JSON-LD, SEO meta, and section structure. The AI integration adds a **chat panel** that turns plain English into the same operations.

The hard constraint: **the AI cannot do anything that the user can't already do via the existing UI**. If a user asks for something out-of-scope (write CSS, add a new component, rewrite layout), the AI refuses with a clear template message and offers in-scope alternatives.

Concretely, after this ships the user can type:

| Plain-English ask | AI behaviour |
|---|---|
| *"Shorten the hero subtitle"* | Auto-applies; success toast |
| *"Make all H2s sentence case"* | Plans the edits, shows approval card, applies on click |
| *"Clone the offers section and put it after Story"* | Clone + Move bundled into one approval card |
| *"Translate the page to French"* | **Refuses**: "I can edit existing field text but I can't translate. Try copy-pasting translated text into a specific field." |
| *"Add a new contact form"* | **Refuses**: "I can clone existing sections but can't generate new ones." |
| *"Change the brand colour to blue"* | **Refuses**: "I can't edit CSS." |

The bar: predictable, bounded, safe-by-default.

---

## 2 · Final decisions (locked in)

All decisions are made. Anyone implementing this should follow them; if you want to deviate, propose an amendment to this file first.

### 2.1 Architecture

| Decision | Choice | Why |
|---|---|---|
| API key location | **Browser localStorage** (or sessionStorage if user unchecks "Remember") | Per user direction. Trade-off: visible in DevTools. Acceptable for local-only tool. |
| Orchestration | **Browser-side loop** | Aligns with browser-side key. Server stays unchanged — its existing HTTP endpoints are the AI's toolbox. |
| AI SDK | **Direct `fetch()` to Gemini REST API** — no SDK | "Don't use heavy libraries." Gemini's `generateContent` REST endpoint is straightforward. |
| Model | **`gemini-2.5-flash`** | Per user direction. Fast, supports function calling, generous free tier. |
| Streaming | **Non-streaming for v1** | Simpler. Add SSE in v1.1 if perceived latency complaints surface. |
| Visual context | **None for v1** — text-only field manifests | Avoids the html2canvas dependency. Gemini's reasoning over field text is sufficient for v1 asks. |
| Refresh strategy | **Re-fetch fields on every turn** | Prevents stale-state bugs. Cost: one extra `/api/fields` per turn. Optimise later if it bites. |

### 2.2 UX

| Decision | Choice |
|---|---|
| Entry point | Floating **✨ AI** button in sidebar footer (right of Save/Build). Hidden when no key is set. Tooltip: *"AI assistant"*. |
| Open / close | Click the button → chat panel slides up from the bottom of the sidebar (250 ms). Click ✕ or press Esc → close. |
| Scope picker | Native `<select>` dropdown at the top of the chat panel. Three options: **Page metadata** · **Single section** (one entry per `<section>` direct child of `<main>`) · **Whole page text**. |
| Default scope | **Single section** of whichever section the user clicked on most recently in the Sections group. Falls back to first section if none. |
| Suggestion chips | 3 chips below the greeting on first open. Generated from the active scope's content (e.g. for `#hero`: "Make the headline punchier", "Shorten the subtitle", "Replace the hero image"). Click = prefill input; user can edit before sending. |
| Auto-execute threshold | Single field edit ⇒ auto-apply, success toast in chat. Two-or-more edits, OR any section op (clone/delete/move/undo) ⇒ **approval card** in chat with `[✓ Apply all] [✗ Cancel]`. |
| Approval card | All-or-nothing for v1 (no per-action checkbox). User can iterate via the next chat message if AI overshoots. |
| Tool surface in chat | Hide tool names. Show human summaries: *"✓ Updated meta description"*, *"✓ Cloned section #offers"*. Mode toggle to "developer view" parked for v1.1. |
| Chat history | Per-page in-memory only. Cleared on page switch or tab close. No persistence. (Long conversations are rare; complexity not worth it.) |
| Race conditions | If user has unsaved field edits, **refuse with toast**: *"Save your edits first. AI changes rewrite the file."* (Same pattern as Clone / Delete / Move.) |
| Cap on agentic depth | **Max 8 tool calls per user message.** After 8 calls without a final answer, force a summary turn. |
| Privacy disclosure | One-line note inside the API-key setup modal: *"Editing with AI sends the field text + your message to Google's Gemini API. Your API key is stored only in this browser."* |

### 2.3 Tool surface

| Decision | Choice |
|---|---|
| Number of tools | **10**: `list_pages`, `get_page_fields`, `read_field`, `find_fields`, `get_section_list`, `update_field`, `clone_section`, `delete_section`, `move_section`, `undo`. |
| `commit` (Git) | **Excluded.** AI never touches Git. It can suggest a commit message in chat (user copies into Git panel manually). |
| `push` (Git) | **Excluded.** Always a deliberate user action. |
| `build` | **Excluded.** Always user-driven. |
| `upload_image` | **Excluded** for v1. AI can update an `<img src>` to a URL via `update_field`. File uploads stay UI-only. |

---

## 3 · Architecture at a glance

```
┌───────────────────────── Browser ──────────────────────────┐
│                                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │ Chat panel (chat.js)                                │   │
│  │  ┌────────────────────────────────────────────┐    │   │
│  │  │ Orchestration loop                         │    │   │
│  │  │  1. Build messages (system + history +     │    │   │
│  │  │     scope context + new user msg)          │    │   │
│  │  │  2. POST → Gemini                           │    │   │
│  │  │  3. If response = tool_call:                │    │   │
│  │  │     → tools.js dispatch → /__cms/api/* ──┐  │    │   │
│  │  │     → result back as new message         │  │    │   │
│  │  │     → loop (cap 8 tool calls)            │  │    │   │
│  │  │  4. If response = text:                  │  │    │   │
│  │  │     → render bubble in chat              │  │    │   │
│  │  └──────────────────────────────────────────│──┘    │   │
│  │                          │                  │        │   │
│  └──────────────────────────│──────────────────│────────┘   │
│                             │                  │             │
│                             ▼                  ▼             │
│  ┌──────────────────────────────────┐  ┌──────────────────┐ │
│  │ Gemini REST API                   │  │ /__cms/api/*    │ │
│  │ generativelanguage.googleapis.com │  │ (existing)      │ │
│  │ /v1beta/models/                   │  │                  │ │
│  │   gemini-2.5-flash:generateContent│  │ list_pages →    │ │
│  │                                   │  │   /api/pages    │ │
│  │ API key in URL header             │  │ update_field →  │ │
│  │ (read from localStorage)          │  │   /api/save     │ │
│  └──────────────────────────────────┘  │ clone_section → │ │
│                                          │   /api/clone-…  │ │
│                                          │ ...             │ │
│                                          └──────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

**No server changes.** Every new line of code lives in `src/editor/`. The CMS server stays oblivious to the AI feature.

---

## 4 · The 10 tools the AI gets

Each tool is declared with a name, description, and JSON Schema parameters. Gemini's function-calling API uses these declarations to constrain what the model can request.

### 4.1 Read tools

| Tool | Parameters | Returns |
|---|---|---|
| `list_pages` | none | `[{ path, label, group }]` from `/api/pages` |
| `get_page_fields` | `{ page: string }` | `{ fields: [...], sections: [...] }` from `/api/fields?page=…`. Each field includes id, group, type, label, **first 40 chars** of value (full value via `read_field`). |
| `read_field` | `{ page: string, fieldId: string }` | `{ value: string, alt?: string }` — full value of a single field. |
| `find_fields` | `{ page: string, query: string }` | `{ matches: [{ id, label, snippet }] }` — fields whose value contains `query` (case-insensitive). For cross-cutting asks. |
| `get_section_list` | `{ page: string }` | `[{ selector, label, id, hasId }]` (subset of `/api/fields` response). |

### 4.2 Write tools

| Tool | Parameters | Maps to | Auto-execute? |
|---|---|---|---|
| `update_field` | `{ page, fieldId, value, alt? }` | `POST /api/save` (single change) | **Yes** (single edit) |
| `clone_section` | `{ page, selector }` | `POST /api/clone-section` | **No** — approval card |
| `delete_section` | `{ page, selector }` | `POST /api/delete-section` | **No** — approval card |
| `move_section` | `{ page, selector, direction }` | `POST /api/move-section` | **No** — approval card |
| `undo` | `{ page }` | `POST /api/undo` | **No** — approval card |

**Auto-execute rule:**
- If the AI's plan contains exactly **one `update_field`** and nothing else → auto-apply, success toast.
- If the plan contains **anything destructive** (clone/delete/move/undo) **or two-or-more `update_field` calls** → render approval card, wait for user click.

### 4.3 Tool schema example (Gemini function-calling format)

```js
{
  name: "update_field",
  description: "Update the value of a single editable field on a page. Use this for text, longtext, and image-URL fields.",
  parameters: {
    type: "object",
    properties: {
      page: { type: "string", description: "Page path, e.g. 'akasa-dalhousie/index.html'" },
      fieldId: { type: "string", description: "Field id from get_page_fields, e.g. 'h1:28'" },
      value: { type: "string", description: "New value. For HTML fields, may include inline tags (em, strong, a)." },
      alt: { type: "string", description: "(Optional) For image fields, new alt text." }
    },
    required: ["page", "fieldId", "value"]
  }
}
```

All 10 schemas live in `src/editor/ai/tools.js`.

---

## 5 · System prompt + refusal contract

### 5.1 System prompt template (literal)

```
You are the cms-static assistant. You help a user edit a static HTML site
through a small set of structural tools.

You can ONLY perform these operations:
  • Read content: list_pages, get_page_fields, read_field, find_fields,
    get_section_list
  • Edit content: update_field
  • Reorganise content: clone_section, delete_section, move_section, undo

You CANNOT:
  • Write or modify HTML, CSS, or JavaScript directly
  • Add new sections, components, or pages from scratch
  • Generate images, translate text, or fetch external data
  • Run scripts, builds, or Git commands
  • Edit files outside the current page

If the user asks for anything outside your tools, respond with this template:

  "I can't do that — it's outside what I'm allowed to change. I can only:
  edit existing field values, clone/delete/move sections, and undo recent
  changes.

  For your request, you might try: <2-3 in-scope alternatives, specific
  to what they asked for>."

Always:
  • Think before calling tools.
  • Use field IDs and selectors exactly as returned by get_page_fields.
  • Never invent IDs or fields that aren't in the manifest.
  • If you propose two-or-more changes, list them clearly so the user
    can review before applying.
  • Speak plainly. Don't mention tool names; describe what you're doing
    ("I'll update the meta description" not "I'll call update_field").

Current page: {{currentPage}}
Current scope: {{scope}}     (page-meta | section-#hero | whole-page)
{{contextManifest}}            (compact field list relevant to scope)
```

The orchestrator interpolates `{{currentPage}}`, `{{scope}}`, and `{{contextManifest}}` per turn from the latest `/api/fields` fetch.

### 5.2 Out-of-scope refusal — backed by code

The system prompt instructs the AI to refuse, but we also enforce in the orchestrator:
- Any tool call to a name not in the whitelist → return `{ error: "unknown tool" }` to the AI.
- Any tool call with malformed parameters → return `{ error: "invalid args: <details>" }`.
- The AI re-plans or apologises with the refusal template.

This is defence in depth: prompt-level refusal first, code-level whitelist as the safety net.

### 5.3 Suggestion chips

Generated client-side from the current scope's fields. Logic in `src/editor/ai/prompt.js`:

```
For scope "Single section #hero":
  - if has h1: "Make the headline more concise"
  - if has long p: "Shorten the subtitle"
  - if has img: "Replace the hero image with a new URL"

For scope "Page metadata":
  - "Improve the meta description"
  - "Make the page title more search-friendly"
  - "Update the OG image alt text"

For scope "Whole page text":
  - "Find and shorten any paragraphs over 200 chars"
  - "Make all H2s start with a verb"
  - "Standardise capitalisation across headings"
```

All chips are templates; final wording is computed in code so they're always actionable on the actual fields present.

---

## 6 · UX surfaces

### 6.1 The ✨ AI button

```
SIDEBAR FOOTER (today):                AFTER AI lands:
┌─────────────────────────────────┐   ┌─────────────────────────────────┐
│ [💾 Save] [⬇ Build]   ● status   │   │ [💾 Save] [⬇ Build] [✨ AI] ●    │
└─────────────────────────────────┘   └─────────────────────────────────┘
                                       (✨ AI hidden if no key set)
```

Hover: tooltip *"AI assistant — chat to edit"*. Click: opens chat panel OR opens API-key setup modal if no key yet.

### 6.2 The chat panel (slides up over bottom half of sidebar)

```
┌─────────────────────────────────────────────┐
│ ✨ AI Assistant                            ✕│
├─────────────────────────────────────────────┤
│ Working on: [▼ Single section: #hero]    ⚙ │
│ ─────────────────────────────────────────── │
│                                              │
│  Hi 👋 I can edit text, swap images, or    │
│  clone/move/delete sections on this page.   │
│  What would you like to change?             │
│                                              │
│  Try one of these:                          │
│  ┌───────────────────────────────────────┐ │
│  │ Make the headline more concise        │ │
│  └───────────────────────────────────────┘ │
│  ┌───────────────────────────────────────┐ │
│  │ Shorten the subtitle                  │ │
│  └───────────────────────────────────────┘ │
│  ┌───────────────────────────────────────┐ │
│  │ Replace the hero image with a URL     │ │
│  └───────────────────────────────────────┘ │
│                                              │
├─────────────────────────────────────────────┤
│ ┌─────────────────────────────────┐ [Send] │
│ │ Type a message…                  │        │
│ └─────────────────────────────────┘        │
└─────────────────────────────────────────────┘
```

### 6.3 Approval card example

When the AI proposes ≥ 2 actions or any section op:

```
┌───────────────────────────────────────────┐
│ I'll do these 3 things:                   │
│                                            │
│  1. Update hero H1 to:                    │
│     "Stay close to the mountains. Far     │
│     from the noise."                       │
│                                            │
│  2. Clone section #offers                  │
│                                            │
│  3. Move #offers-copy below #story         │
│                                            │
│  [ ✓ Apply all ]   [ ✗ Cancel ]            │
└───────────────────────────────────────────┘
```

After Apply: each action runs sequentially; chat shows step results inline ("✓ Updated hero H1", "✓ Cloned #offers", "✓ Moved #offers-copy"). On any failure, remaining actions are skipped and an error bubble explains what failed.

### 6.4 API-key setup modal

```
┌──────────────────────────────────────────────┐
│  Connect your Gemini API key                 │
│                                              │
│  Paste your key from                         │
│  https://aistudio.google.com/apikey          │
│                                              │
│  ┌────────────────────────────────────┐     │
│  │ AIza…                              │     │
│  └────────────────────────────────────┘     │
│                                              │
│  ☑ Remember on this browser                  │
│                                              │
│  Editing with AI sends the field text +      │
│  your message to Google's Gemini API.        │
│  Your key is stored only in this browser.    │
│                                              │
│  [ Cancel ]  [ Save & continue ]            │
└──────────────────────────────────────────────┘
```

---

## 7 · Implementation phases (tiny steps)

Ordered so each phase ships independently. After each, you can pause and ship.

### Phase 1 — API-key plumbing & feature flag ☑

> Goal: nothing AI-related runs without a stored key.

- 1.1 Add localStorage utility in `src/editor/ai/key.js`: `getKey()`, `setKey(key, remember)`, `clearKey()`. Reads from localStorage **or** sessionStorage based on the `cms-static.gemini.rememberKey` flag.
- 1.2 Add `<dialog id="apiKeyDialog">` to `index.html` (markup only; no behaviour yet).
- 1.3 Add CSS for the modal.
- 1.4 Add `<button class="ai-fab" id="aiFab" hidden>` to the sidebar footer.
- 1.5 On editor load, call `getKey()`. If non-empty, unhide `#aiFab`. Else hide.
- 1.6 Wire `#aiFab` click: if no key, open `apiKeyDialog`; else (placeholder) toast "AI panel coming soon".
- 1.7 Wire dialog Save: validate non-empty, call `setKey(value, rememberCheckbox.checked)`, close, unhide `#aiFab`, toast "AI ready".
- 1.8 Add a ⚙ button (hidden initially) inside the chat panel that re-opens the dialog with the current key prefilled.

**Done when**: refreshing with a stored key shows the ✨ AI button; clicking opens a placeholder; refreshing without a key hides the button.

---

### Phase 2 — Chat panel shell (no AI yet) ☑

> Goal: the chat UI exists and slides up/down. No real messages flow.

- 2.1 Add `<div class="chat-panel" id="chatPanel" hidden>…</div>` to `index.html`. Children: header (✨ title + ✕), scope picker, message list, input + send button.
- 2.2 Style the panel: position absolute inside the sidebar, height 50% of sidebar, slide via `transform: translateY(100%)` → `0`.
- 2.3 Wire ✨ AI button click → toggle `.is-open` class; ✕ closes; `Esc` closes when open.
- 2.4 Render the empty state: greeting + 3 dummy chips ("hello", "test", "echo me").
- 2.5 Wire the send button: append the user's text as a chat bubble, then echo it back as a fake AI bubble. (This proves the rendering pipeline before plugging Gemini.)
- 2.6 Wire chip clicks → prefill the input.
- 2.7 Persist nothing yet. Closing the panel clears messages.

**Done when**: button toggles a panel that visually behaves like a chat with echo behaviour.

---

### Phase 3 — Tool implementations (no AI yet) ☑

> Goal: every "tool" the AI will eventually call is callable from JS as a simple async function.

- 3.1 Create `src/editor/ai/tools.js`. Export `TOOL_SCHEMAS` (Gemini function declarations for all 10) and `TOOL_DISPATCH` (map of name → async function).
- 3.2 Implement each dispatch function as a thin `fetch()` wrapper:
   - `list_pages()` → `fetch('/__cms/api/pages')`
   - `get_page_fields({page})` → `fetch('/api/fields?page=…')`
   - `read_field({page, fieldId})` → reuse `get_page_fields` and pluck the matching field's full value (no new endpoint).
   - `find_fields({page, query})` → reuse `get_page_fields`, filter client-side. Returns first 20 matches.
   - `get_section_list({page})` → reuse `get_page_fields` and return only `r.sections`.
   - `update_field({page, fieldId, value, alt})` → `POST /api/save` with a one-element `changes` array.
   - `clone_section({page, selector})` → `POST /api/clone-section`.
   - `delete_section({page, selector})` → `POST /api/delete-section`.
   - `move_section({page, selector, direction})` → `POST /api/move-section`.
   - `undo({page})` → `POST /api/undo`.
- 3.3 Each function returns `{ ok: true, ...response }` or `{ ok: false, error: string }` — never throws. The orchestrator handles errors uniformly.
- 3.4 Add a tiny test page (`window.__testTools = TOOL_DISPATCH`) so you can `await window.__testTools.list_pages()` from the browser console to verify each tool.

**Done when**: from the browser console, every tool returns expected shape on the live editor.

---

### Phase 4 — Gemini API client ☑

> Goal: send a message to Gemini, get a response. No tools yet.

- 4.1 Create `src/editor/ai/client.js`. Single export: `async callGemini(messages, tools?)`.
- 4.2 Read API key via `getKey()`; throw if missing.
- 4.3 Build the request body per Gemini's `generateContent` schema: `{ contents: messages, tools: tools ? [{ functionDeclarations: tools }] : undefined, generationConfig: { temperature: 0.4 } }`.
- 4.4 `POST` to `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=<KEY>`.
- 4.5 Parse response. The interesting parts:
   - `candidates[0].content.parts[]` — array; each part is either `{ text: string }` or `{ functionCall: { name, args } }`.
   - Return `{ text?: string, toolCall?: { name, args } }` (first non-empty part wins for v1).
- 4.6 Surface clear errors: 400 → "invalid request", 401/403 → "invalid API key", 429 → "rate-limited; try in a minute", network failure → "couldn't reach Gemini".
- 4.7 Console-test from the browser: send `[{ role: "user", parts: [{ text: "hello" }] }]`, get back a text response.

**Done when**: a console call to `callGemini([{role:'user', parts:[{text:'say hi'}]}])` returns `{ text: "Hi!..." }`.

---

### Phase 5 — Orchestration loop (the heart) ☑

> Goal: send a user message, let the AI call tools, render the final answer.

- 5.1 Create `src/editor/ai/chat.js`. State: `{ history: [], scope: {kind, ref}, currentPage }`.
- 5.2 On user send:
   - Append `{ role: "user", parts: [{ text: msg }] }` to history.
   - Build the context manifest based on current scope:
     - **Page metadata** scope: SEO + Schema fields, full values
     - **Single section** scope: that section's fields, full values
     - **Whole page text** scope: all fields, **first 60 chars** only (compact)
   - Build the prompt: system prompt + manifest + history.
- 5.3 Call `callGemini(messages, TOOL_SCHEMAS)`.
- 5.4 If response has `text`, render as an assistant bubble. Done.
- 5.5 If response has `toolCall`, dispatch via `TOOL_DISPATCH[name](args)`. Append a model message + a function-result message to history. Loop back to step 5.3.
- 5.6 Cap: max 8 tool calls per user message. After 8, force-inject a system message: "You have reached the action limit for this turn. Summarise progress."
- 5.7 Refresh-per-turn: before step 5.3, re-fetch `/api/fields` for the current page so the manifest is fresh.
- 5.8 Race-condition guard: if `hasChanges()` (existing helper from `editor.js`), refuse with toast and don't enter the loop.

**Done when**: typing "shorten the hero subtitle" makes the AI call `update_field` and the page actually updates.

---

### Phase 6 — Approval card for multi-action plans ☑

> Goal: when AI proposes ≥ 2 actions or any section op, user reviews before applying.

- 6.1 Modify the orchestration loop: when AI returns a tool call, check whether the call is "deferred" (any of: `clone_section`, `delete_section`, `move_section`, `undo`, OR if a previous `update_field` already executed in this turn).
- 6.2 If deferred, **don't execute** — buffer the call into `pendingPlan = [...]` and return control to the AI: feed back `{ ok: true, deferred: true }` so the AI can keep planning.
- 6.3 When the AI eventually returns text (its summary), render the approval card from `pendingPlan` in the chat: list each action in human-readable form, plus `[Apply] [Cancel]` buttons.
- 6.4 Apply: execute each pendingPlan entry sequentially, render `✓ <summary>` after each. On any error, halt remaining and show error.
- 6.5 Cancel: clear the buffer; render *"Cancelled — nothing changed."*; let user continue chatting.
- 6.6 Single `update_field` (no others) bypasses the buffer and auto-applies as before.

**Done when**: asking "clone the offers section and shorten the hero" shows a 2-action approval card.

---

### Phase 7 — Suggestion chips ☑

> Goal: useful chips on first chat-open, regenerated on scope change.

- 7.1 Add `src/editor/ai/prompt.js` with `buildSuggestions(scope, fields, sections)` returning an array of 3 strings.
- 7.2 Logic:
   - For Page metadata: 3 fixed templates ("Improve the meta description", "Make the page title more search-friendly", "Update the OG image alt").
   - For Single section: detect H1/H2/p/img and pick the corresponding chip.
   - For Whole page text: 3 fixed cross-cutting templates.
- 7.3 Render chips below the greeting; clear on first user message; regenerate on scope change.

**Done when**: changing scope from "#hero" to "Page metadata" swaps the chip set.

---

### Phase 8 — Polish + visible failure paths ☑

> Goal: every reachable error has a sensible UI.

- 8.1 Invalid key: show inline message in chat with "Update key →" button reopening the setup modal.
- 8.2 Rate limit (429): show inline message with retry button (no auto-retry).
- 8.3 Network failure: same pattern.
- 8.4 Tool whitelist: AI calls a non-existent tool → orchestrator returns error to AI; if AI re-tries 3 times in a row, abort with a friendly "I'm stuck — please rephrase".
- 8.5 ⚙ key-update button in chat panel.
- 8.6 Privacy disclosure line in setup modal.
- 8.7 `Esc` closes chat panel when input is unfocused (doesn't fight typing).

**Done when**: every failure path has been clicked through and shows something readable.

---

### Phase 9 — Documentation ☑

- 9.1 Update `design-flow.md` with §4.19 "AI chat flow".
- 9.2 Update `design-flow.md` glossary with: AI panel, scope, manifest, approval card, agentic cap, refusal template.
- 9.3 Update `ui-roadmap.md` Tier H entries (H1–H5) flipped to ☑.
- 9.4 Update `README.md` with a short "AI" section: how to enable, what it can/can't do, link to this plan.
- 9.5 Mark this file's phases as ☑ as they ship; append Done log entries.

---

## 8 · File-by-file plan

| File | New / Edit | Lines added (estimate) | Purpose |
|---|---|---|---|
| **NEW** `src/editor/ai/key.js` | new | ~40 | API key get/set/clear (localStorage + sessionStorage) |
| **NEW** `src/editor/ai/tools.js` | new | ~180 | TOOL_SCHEMAS + TOOL_DISPATCH (10 tools) |
| **NEW** `src/editor/ai/client.js` | new | ~80 | Gemini REST client (single `callGemini` export) |
| **NEW** `src/editor/ai/prompt.js` | new | ~70 | System prompt template + suggestion-chip generator |
| **NEW** `src/editor/ai/chat.js` | new | ~250 | Chat panel state, render, orchestration loop, approval card |
| `src/editor/index.html` | edit | +50 | Chat panel markup, ✨ AI button, API-key dialog |
| `src/editor/editor.css` | edit | +200 | Chat panel, bubbles, chips, approval card, dialog, fab |
| `src/editor/editor.js` | edit | +20 | Wire ✨ AI button (initial visibility from key), expose `state.currentPage` and `hasChanges()` to chat.js |
| `design-flow.md` | edit | +200 | §4.19 + glossary |
| `ui-roadmap.md` | edit | +120 | Tier H + done log |
| `README.md` | edit | +25 | Brief AI section |

**Total: ~1,235 lines** of new code and docs. ~2 days of focused work.

**Server: untouched.** No new dependencies on Node side. No new routes. No new modules.

---

## 9 · Configuration & storage keys

All new state lives client-side. Keys are namespaced under `cms-static.gemini.*` and `cms-static.ai.*`.

| Key | Storage | Default | What it holds |
|---|---|---|---|
| `cms-static.gemini.apiKey` | localStorage **or** sessionStorage (depending on rememberKey) | (unset) | The Gemini API key. Editor checks this on load to decide whether to show the ✨ AI button. |
| `cms-static.gemini.rememberKey` | localStorage | `"1"` (true) | If `"1"`, key is stored in localStorage (persists across browser restarts). If `"0"`, sessionStorage (cleared on tab close). |
| `cms-static.ai.lastScope.<page>` | sessionStorage | (unset) | Per-page last-picked scope so reopening the chat lands on the same scope. Cleared on tab close. |

No environment variables. No `.env` file. No CLI flags. The key is entered once via the setup modal and remembered (or not) at the user's choice.

### Programmatic API (for chat.js to use)

```js
import { getKey, setKey, clearKey, isRemembered } from './ai/key.js';

getKey()              // → string | null
setKey(value, remember /* boolean */)
clearKey()            // wipes both localStorage and sessionStorage
isRemembered()        // → boolean
```

---

## 10 · Failure paths

Every reachable failure has a designed UI response. Listed in priority order.

| Failure | Surfaced as | Recovery |
|---|---|---|
| No API key set | ✨ AI button hidden in sidebar; key-setup modal opens on first click | Paste key, click Save |
| Key rejected by Gemini (401/403) | Inline AI message: *"Your Gemini key was rejected. [Update →]"* | Click Update, paste new key |
| Rate-limited (429) | Inline AI message: *"Hit the rate limit. Wait a minute and try again."* with `[Retry]` button | Click Retry after waiting |
| Network error | Inline AI message: *"Can't reach Gemini. Check your connection."* with `[Retry]` button | Retry |
| AI calls a non-whitelisted tool | Orchestrator silently returns `{ error: "unknown tool" }`; AI re-plans | (transparent) |
| AI calls a tool with bad arguments | Orchestrator returns `{ error: "invalid args: …" }`; AI re-plans | (transparent) |
| Tool execution fails (e.g. clone returns 500) | Tool result includes the error; AI explains in chat: *"Couldn't clone — the page may have changed. Want me to retry?"* | User decides |
| User has unsaved field edits | Chat refuses with toast: *"Save your edits first…"* | User saves, retries |
| Agentic cap (8 tool calls) hit | Orchestrator forces a summary turn: AI sees a system-injected message | AI summarises; user iterates with smaller asks |
| Three consecutive whitelist rejections | Orchestrator aborts: *"I'm stuck — could you rephrase?"* | User rephrases |
| AI returns no text and no tool call | Treated as completion; render *"(no response)"* | (rare; just retry) |

---

## 11 · Test checklist

Run through all of these manually after Phase 8. Each should produce the expected behaviour without console errors.

### Setup
- [ ] Open editor with no key → ✨ AI button hidden.
- [ ] Click anywhere expecting AI → still hidden (no error).
- [ ] Set a valid key via the modal → ✨ button appears.
- [ ] Set an invalid key → first chat fails with "key rejected"; click Update; paste correct key; chat works.
- [ ] Uncheck "Remember" → key is in sessionStorage; close + reopen tab → ✨ button hidden again.
- [ ] Re-check "Remember" → persists across browser restart.

### Read-only flows
- [ ] *"What pages can I edit?"* → AI calls `list_pages`, summarises in chat.
- [ ] *"What can I change on this page?"* → AI calls `get_page_fields`, summarises by group counts.
- [ ] *"Find every paragraph longer than 200 characters."* → AI uses `find_fields` or filters from `get_page_fields`.

### Single-edit auto-apply
- [ ] *"Shorten the hero subtitle to one sentence."* → auto-applies, success toast, preview iframe updates.
- [ ] *"Change the meta description to 'A luxury homestay near The Mall, Dalhousie.'"* → auto-applies.

### Approval card
- [ ] *"Make all H2s on this page sentence case."* → approval card lists each H2 to update; Apply runs them sequentially.
- [ ] *"Clone the offers section and move it below story."* → approval card with 2 actions; Apply runs them.
- [ ] Cancel works (no disk writes).

### Refusal
- [ ] *"Change the brand colour to blue."* → refuses with template.
- [ ] *"Add a new pricing section."* → refuses; suggests cloning an existing section.
- [ ] *"Translate the page to French."* → refuses; suggests editing specific fields.

### Race conditions
- [ ] Edit a field manually (don't save) → ask AI to do anything → refused with toast.

### Failure handling
- [ ] Disable network → send a message → "can't reach Gemini" with retry.
- [ ] Spam-send 20 messages on free tier → 429 → retry button works after waiting.

### Scope picker
- [ ] Switch scope from `#hero` to `Page metadata` → suggestion chips change.
- [ ] Switch scope mid-conversation → history continues; manifest updates.

### Cap
- [ ] Ask something that would require 20 tool calls (*"List every field on every page"*) → AI hits the cap, summarises.

---

## 12 · Out of scope / parked

Listed explicitly so future contributors know these were considered and deliberately excluded for v1.

- **Visual context (screenshots).** Skipped to avoid the html2canvas dependency. Text-based field manifests work for v1. Add when (a) we have a real ask the AI can't handle without vision, (b) we're ready to vendor html2canvas.
- **Streaming token rendering.** Non-streaming response in v1. Add SSE-based streaming if perceived latency becomes a complaint.
- **Per-action checkboxes on approval cards.** All-or-nothing in v1.
- **Persistent chat history.** Per-page in-memory only. Add localStorage persistence if users start asking for it.
- **Multi-page bulk operations.** AI works on one page at a time. Cross-page asks like "update the meta description on every property page" need a separate "batch" affordance.
- **Image generation / replacement via prompt.** AI can update an `<img src>` to an existing URL but can't generate new images.
- **Translation.** Out of scope; the user pastes translated text manually.
- **Git operations** (commit, push). AI never touches Git directly. It can suggest a commit message in chat (user copies it).
- **Build trigger.** AI can't run `node build.js`.
- **Custom prompt templates per user / per site.** v1 ships one system prompt. v1.1 could read `.cms-ai.md` if users want to customise.

---

## 13 · Future enhancements (post-v1, not committed)

Roughly ranked by likely value:

1. **Visual context for sections** (screenshot via html2canvas, attached to scope context). Helps with "this heading feels too long" / "image looks blurry" asks.
2. **Streaming responses.** Tokens render as they arrive — drop perceived latency.
3. **Per-action checkboxes on approval cards.**
4. **Cross-page batch operations** ("update meta description across all property pages").
5. **AI commit-message generator** (one button: "suggest a commit message" in the Git panel; uses the same key).
6. **Session memory across tabs** (cloud-synced, optional, requires hosted backend).
7. **Multi-model support** — let user pick Gemini / Claude / GPT — same tool-use protocol.
8. **Custom system prompt** read from a `.cms-ai.md` file in the site root.
9. **Tool surface dev-toggle** — show raw tool calls + JSON for debugging.
10. **Cost estimation per turn** ("this used ~2 KB of tokens").

---

## 14 · Glossary

**AI panel** — the floating chat UI that slides up from the bottom of the sidebar.

**Scope** — the slice of the page the chat is working on. Three values: `page-meta`, `section-<id>`, `whole-page`. Picked via dropdown at the top of the chat.

**Manifest** — the compact, JSON-shaped summary of fields/sections sent to Gemini each turn as part of the system prompt context. Built from `/api/fields` results, trimmed per scope.

**Approval card** — the in-chat block listing pending actions with `[Apply] [Cancel]` buttons. Shown for any plan with ≥ 2 actions or any section op.

**Auto-execute** — single `update_field` calls bypass the approval card and write to disk immediately, surfacing only a success toast.

**Refusal template** — the canned response the AI uses when asked for something out-of-scope. Defined in the system prompt.

**Agentic cap** — hard limit of 8 tool calls per user message. After the cap, the orchestrator injects a "summarise" instruction to bound runaway loops.

**Tool whitelist** — the 10 tool names the orchestrator will dispatch; any other name returns `{ error: "unknown tool" }` to the AI for self-correction.

**Race-condition guard** — refuse to run AI flows when the user has unsaved field edits. Same pattern as Clone / Delete / Move / Undo.

---

## 15 · Done log

Append-only ledger of what's been shipped. Latest first.

```
yyyy-mm-dd  Phase            Notes
──────────  ──────────────   ─────────────────────────────────────────
2026-05-10  Phases 1–9       Tier H shipped end-to-end. ai.js consolidated
                              into a single IIFE (deviates from §8's 5-file
                              split for v1 simplicity, matching git-panel.js /
                              cropper-modal.js codebase pattern). Approval
                              card auto-applies for single update_field;
                              multi-edit / destructive plans render the card.
                              Three-scope picker (page-meta / section /
                              whole-page) with per-turn manifest from
                              /api/fields. 10-tool whitelist enforced at
                              dispatcher. 16-iter loop cap + 8 calls/turn +
                              3-consecutive-fail abort. Failure mapping
                              wired (401/403 → ⚙ prompt, 429 → wait msg,
                              network → reachability msg, off-list tool →
                              {error}). Suggestion chips computed per scope.
                              Esc-close + page-change history reset.
                              Docs: design-flow.md §4.19 + 4 glossary
                              entries; ui-roadmap.md §5.8 Tier H H1–H5 +
                              Done log batch entry; README.md feature
                              list bullet 6.
```

---

*Plan revision: 2026-05-10 v1.1 — implementation complete. Original v1.0 (2026-05-07) captured pre-code discussion; this revision adds the Done log entry.*
