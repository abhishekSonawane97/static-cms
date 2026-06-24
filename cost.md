# cost.md — AI / LLM running cost

This document covers the **only component of cms-static that can cost money to run**: the AI
assistant. Everything else — the server, the editor, page extraction, saves, image processing,
Git, builds — runs locally on your machine and costs nothing beyond your own electricity.

> **Scope:** AI/LLM running cost only. For how the AI flow works mechanically, see
> [FLOWS.md §13](./FLOWS.md#13-ai-assistant).

---

## TL;DR

- The AI feature calls **NVIDIA-hosted Gemma** (`google/gemma-4-31b-it`) through a local
  pass-through proxy. You bring your own NVIDIA API key.
- You are billed (or you burn free credits) **per token**, on **every LLM round-trip**.
- A **single simple edit** ("shorten the meta description") costs on the order of
  **~2–6k tokens** total.
- A **complex multi-tool turn** (the agent reads, plans, you approve) can cost
  **~15–40k+ tokens**, because the agent loop **re-sends the growing context on each iteration**.
- The code already includes several **hard cost ceilings** (8 tool calls/turn, 16-iteration loop
  cap, scoped manifests, value truncation, no streaming). See
  [§5](#5-cost-controls-already-in-the-code).
- If you never click the ✨ AI button, **your AI cost is exactly $0**. The feature is opt-in and
  requires a key.

---

## 1. What actually incurs cost

Cost is incurred **only** inside `callLLM(...)` in [ai.js](./src/editor/ai.js), which POSTs to the
local proxy `/__cms/api/llm`, which forwards to `https://integrate.api.nvidia.com/v1/chat/completions`.
The proxy itself ([server.js](./src/server.js)) adds **zero** cost — it is a header-swap and pipe,
with no logging or caching.

Each POST is one **billable round-trip**: you pay for the **input tokens** (everything in the
`messages` array + the `tools` schemas) and the **output tokens** (the model's reply, including any
tool-call JSON).

Request parameters that affect cost ([ai.js](./src/editor/ai.js) `callLLM`):

| Param | Value | Cost effect |
|---|---|---|
| `model` | `google/gemma-4-31b-it` | sets the per-token rate |
| `max_tokens` | `4096` | **ceiling** on output tokens per call (you pay for what's generated, not the ceiling) |
| `temperature` | `0.4` | none |
| `stream` | `false` | none on price; affects latency only |
| `tools` | 10 schemas | **fixed input overhead on every call** (see §3) |

---

## 2. The agent-loop multiplier (read this first)

A "turn" (one user message) is **not** one LLM call. `runAgent()` runs a loop
([ai.js](./src/editor/ai.js)): each time the model returns tool calls, the host appends the
assistant message + tool results and **calls the model again** with the *whole growing array*.

```
turn = user message
  call 1: system + history + tools                         → model asks to read fields
  call 2: system + history + tools + (assistant + tool result)  → model asks to read another
  call 3: ...                                              → model emits update_field(s) + summary
```

Implications for cost:

- **Input tokens grow each iteration** because the prior assistant/tool messages are re-sent. This
  is the classic agent-loop cost shape: a 3-call turn costs **more than 3×** a single call.
- The number of calls is bounded by the **16-iteration loop cap** and the **8 tool-call cap**
  (`AI_MAX_TOOL_CALLS`). These are the hard ceilings that stop a turn from running away.
- Read tools (`get_page_fields`, `read_field`, `find_fields`, …) are the main context inflators:
  each returns a JSON blob (a field manifest can be a few KB) that becomes input on the next call.

---

## 3. Token anatomy of one LLM call

Every call sends these input components. Estimates are rough (≈ 4 chars/token) and will vary with
your page size and conversation length.

| Component | What it is | Approx input tokens |
|---|---|---|
| System prompt head | `SYSTEM_PROMPT_HEAD` (the rules/refusal contract) | ~350–450 |
| Tool schemas | 10 tool definitions with descriptions (`TOOL_SCHEMAS`) | ~700–1,000 |
| Scope manifest | scoped field list (`buildScopeContext`) — varies a lot | ~150 (page-meta) → ~2,500 (whole-page) |
| Chat history | prior user + assistant turns only (tool/plan/error are UI-only, not sent) | grows with the conversation |
| Accumulated tool I/O | this turn's assistant tool-calls + tool-result JSON | grows each loop iteration |
| **Output** | the model's reply (text and/or tool-call JSON), capped at `max_tokens=4096` | ~50–800 typical |

**Manifest scoping is the biggest single lever you control at send time.** The chat "Working on:"
dropdown sets `chat.scope`:

- **Page metadata** → only SEO + Schema fields → smallest manifest.
- **Section** → only fields whose selector is under that section → small/medium.
- **Whole page text** → all fields (values truncated to 60 chars each) → largest.

Picking a narrow scope is the easiest way to cut per-call input tokens.

---

## 4. Cost per turn — worked estimates

Token totals are the sum of input across all calls in the turn, plus output. Treat these as
**order-of-magnitude**, not guarantees.

| Scenario | LLM calls | ≈ Total tokens (in+out) |
|---|---|---|
| Refused out-of-scope ask (no tools) | 1 | ~1.5–3k |
| Single field edit, page-meta scope (auto-apply) | 1–2 | ~2–6k |
| Single edit needing 1 read first | 2–3 | ~5–10k |
| Multi-edit plan (e.g. "tighten 3 paragraphs"), whole-page scope | 3–5 | ~15–30k |
| Complex reorganise (read sections + clone/move + summary) hitting several tool calls | 4–8 | ~25–45k |

### Converting tokens → dollars

NVIDIA's per-token rate for a given model is published on **[build.nvidia.com](https://build.nvidia.com/)**
and changes over time; **verify the current number there** rather than trusting a figure here.
Use this formula:

```
cost_per_turn ($) = (input_tokens / 1e6) × price_in  +  (output_tokens / 1e6) × price_out
```

**Worked example with an explicitly assumed placeholder rate of $0.20 / 1M tokens (both
directions) — replace with NVIDIA's actual published rate:**

| Scenario | ≈ tokens | ≈ cost @ $0.20/1M |
|---|---|---|
| Single simple edit | 4,000 | **$0.0008** (~0.08¢) |
| Multi-edit plan | 22,000 | **$0.0044** (~0.44¢) |
| Complex reorganise | 35,000 | **$0.007** (~0.7¢) |

At this assumed rate, **even heavy AI use is sub-cent per turn**. The headline risk is not unit
price; it's **volume** (many turns/day) and **context bloat** (whole-page scope + long chats).

> **Free credits:** NVIDIA's build platform typically grants free credits / free preview access to
> hosted NIM models. While those apply, marginal cost is **$0** until credits run out. Confirm your
> account's current credit balance and the model's billing status on build.nvidia.com.

---

## 5. Cost controls already in the code

These are implemented today and bound the worst case:

| Control | Where | Effect |
|---|---|---|
| 8 tool calls / turn (`AI_MAX_TOOL_CALLS`) | [ai.js](./src/editor/ai.js) | caps the number of write/read actions, so the loop can't fan out indefinitely |
| 16-iteration loop cap | `runAgent` | hard stop on the model→tool→model cycle |
| 3-consecutive-failure abort | `runAgent` | kills a turn that keeps calling broken tools (no infinite retry billing) |
| Scoped manifest | `buildScopeContext` | sends only in-scope fields, not the whole site |
| Value truncation (~60 chars in manifests, 120 in `find_fields`) | `compactFields`, `truncateValue` | keeps each field cheap to describe |
| Tool/plan/error messages **not** sent to the LLM | `chatHistoryToMessages` | UI log lines don't re-enter the context |
| History reset on page switch | `cms:page-changed` handler | a new page starts a fresh, small context |
| `stream:false`, single request | `callLLM` | predictable, no partial-billing surprises |
| Opt-in + key required | `initFab` / key plumbing | no key, no calls, no cost |

---

## 6. Recommendations to keep cost low

1. **Use the narrowest scope** that fits the task (page-meta or a single section beats whole-page).
2. **Keep chats short.** Long back-and-forth re-sends history on every call. Start a fresh chat
   (switch page or close/reopen) once a task is done.
3. **Prefer the sidebar / inline edit for trivial one-off changes** — they cost $0. Reserve the AI
   for asks that genuinely need language work or multi-step planning.
4. **Batch related edits in one message** rather than many turns — fewer turns means the fixed
   system+tools overhead is amortised over more work.
5. If you want a tighter ceiling, lower `max_tokens` in `callLLM` (4096 is generous for short edits)
   or trim tool descriptions in `TOOL_SCHEMAS_RAW`.

---

## 7. Zero-marginal-cost alternative: self-host the model

Because the client speaks the **OpenAI-compatible** wire format and only the **host** is
NVIDIA-specific, you can point it at any OpenAI-compatible endpoint (a local Ollama / vLLM /
llama.cpp server, etc.) by changing `LLM_URL` / `LLM_MODEL` in [ai.js](./src/editor/ai.js) (and
adjusting or bypassing the `/api/llm` proxy in [server.js](./src/server.js)). Self-hosting moves
the cost from per-token API billing to your own hardware/electricity — **$0 marginal API cost** at
the expense of running the model yourself.

---

## 8. Everything else: $0

For completeness — none of these have a running cost:

| Component | Cost |
|---|---|
| Node server, Express, the editor UI | $0 (local) |
| Page discovery / extraction / save / build | $0 (local CPU) |
| Image processing (Sharp) | $0 (local) |
| Image proxy / external image fetch | $0 (your bandwidth only) |
| Git operations | $0 (local CLI + your existing remote) |
| npm dependencies | $0 (all MIT/Apache-2.0 open source) |
| Cropper.js (CDN) | $0 (public CDN; vendor it for offline use) |

The **only** line item that can ever appear on a bill is NVIDIA token usage from the AI assistant,
and only if you opt in by adding a key and using it.
</content>
