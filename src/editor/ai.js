/* cms-static AI assistant — single-file module
   Pattern matches git-panel.js / cropper-modal.js (IIFE + window namespace).

   Exposes window.cmsAI with:
     - key:    get/set/clear API key (localStorage or sessionStorage)
     - chat:   open/close/state for the chat panel  (filled in later phases)
     - tools:  schemas + dispatch                    (filled in later phases)
     - client: LLM fetch wrapper                     (callLLM)

   All sections are added phase-by-phase per ai-integration-plan.md.
*/

(function () {
  'use strict';

  // -----------------------------------------------------------------------
  //  Phase 1 — API-key plumbing
  // -----------------------------------------------------------------------
  // Two storage scopes:
  //   • localStorage  if the user checked "Remember on this browser"
  //   • sessionStorage otherwise (cleared when the tab closes)
  //
  // Whichever scope holds the key, that's where rememberKey says it lives.
  // setKey(value, remember) writes only to the chosen scope and clears the
  // other so the two never disagree.

  const KEY = 'cms-static.nvidia.apiKey';
  const REMEMBER_KEY = 'cms-static.nvidia.rememberKey';

  function isRemembered() {
    return localStorage.getItem(REMEMBER_KEY) === '1';
  }

  function getKey() {
    return localStorage.getItem(KEY) || sessionStorage.getItem(KEY) || '';
  }

  function setKey(value, remember) {
    const v = (value || '').trim();
    if (!v) {
      clearKey();
      return;
    }
    // Wipe both first so we never double-store.
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    if (remember) {
      localStorage.setItem(KEY, v);
      localStorage.setItem(REMEMBER_KEY, '1');
    } else {
      sessionStorage.setItem(KEY, v);
      localStorage.setItem(REMEMBER_KEY, '0');
    }
  }

  function clearKey() {
    localStorage.removeItem(KEY);
    sessionStorage.removeItem(KEY);
    localStorage.removeItem(REMEMBER_KEY);
  }

  function hasKey() {
    return !!getKey();
  }

  // -----------------------------------------------------------------------
  //  Bootstrap — runs after DOM is ready
  // -----------------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', () => {
    initKeyDialog();
    initFab();
  });

  function initKeyDialog() {
    const dlg = document.querySelector('#aiKeyDialog');
    if (!dlg) return;
    const input = dlg.querySelector('#aiKeyInput');
    const remember = dlg.querySelector('#aiKeyRemember');
    const cancelBtn = dlg.querySelector('#aiKeyCancel');
    const saveBtn = dlg.querySelector('#aiKeySave');
    const clearBtn = dlg.querySelector('#aiKeyClear');

    cancelBtn.addEventListener('click', () => dlg.close());
    saveBtn.addEventListener('click', () => {
      const v = (input.value || '').trim();
      if (!v) {
        input.focus();
        return;
      }
      setKey(v, remember.checked);
      dlg.close();
      if (typeof window.cmsToast === 'function') {
        window.cmsToast('AI ready · key saved', 'success');
      }
    });
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearKey();
        dlg.close();
        if (typeof window.cmsToast === 'function') {
          window.cmsToast('AI key cleared', 'info');
        }
      });
    }
  }

  function openKeyDialog() {
    const dlg = document.querySelector('#aiKeyDialog');
    if (!dlg) return;
    const input = dlg.querySelector('#aiKeyInput');
    const remember = dlg.querySelector('#aiKeyRemember');
    const clearBtn = dlg.querySelector('#aiKeyClear');
    // Pre-fill if a key already exists; user can update or clear.
    input.value = getKey();
    remember.checked = isRemembered() || !getKey(); // default checked when empty
    if (clearBtn) clearBtn.hidden = !getKey();
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
    setTimeout(() => input.focus(), 30);
  }

  function initFab() {
    const fab = document.querySelector('#aiFab');
    if (!fab) return;
    fab.addEventListener('click', () => {
      if (!hasKey()) {
        openKeyDialog();
        return;
      }
      toggleChatPanel();
    });
  }

  // -----------------------------------------------------------------------
  //  Phase 2 — Chat panel state, open/close, scope picker, echo behaviour
  // -----------------------------------------------------------------------

  /**
   * Chat state. Per-page in-memory only; cleared on page switch.
   *   open       — is the panel currently showing?
   *   page       — the cms page this chat is bound to
   *   scope      — { kind: 'page-meta' | 'section' | 'whole-page', ref?: selector }
   *   history    — array of { role: 'user' | 'assistant' | 'tool' | 'error', text }
   *   isThinking — is a request in flight?
   */
  const chat = {
    open: false,
    page: null,
    scope: null,
    history: [],
    isThinking: false,
    pendingPlan: [],   // Phase 6 — tool calls buffered for approval-card review
  };

  document.addEventListener('DOMContentLoaded', () => {
    initChatPanel();
  });

  function initChatPanel() {
    const closeBtn = document.querySelector('#chatClose');
    const sendBtn = document.querySelector('#chatSend');
    const input = document.querySelector('#chatInput');
    const scopeSel = document.querySelector('#chatScope');
    const keyBtn = document.querySelector('#chatKeyBtn');
    if (!closeBtn || !sendBtn || !input || !scopeSel || !keyBtn) return;

    closeBtn.addEventListener('click', closeChatPanel);
    keyBtn.addEventListener('click', openKeyDialog);
    sendBtn.addEventListener('click', onSend);
    input.addEventListener('keydown', (e) => {
      // Enter sends, Shift+Enter = newline
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });
    input.addEventListener('input', autosizeInput);
    scopeSel.addEventListener('change', () => onScopeChange(scopeSel.value));

    // Esc closes the chat (when input not focused, so it doesn't fight typing)
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!chat.open) return;
      if (document.activeElement && document.activeElement.id === 'chatInput') return;
      closeChatPanel();
    });

    // Close + clear chat history when the user switches pages
    // (state.currentPage changes via the page picker in editor.js)
    document.addEventListener('cms:page-changed', (e) => {
      const newPage = (e && e.detail && e.detail.page) || null;
      if (newPage !== chat.page) {
        chat.history = [];
        chat.scope = null;
        chat.page = newPage;
      }
      if (chat.open) renderChat(); // refresh scope dropdown for new page
    });
  }

  function autosizeInput() {
    const el = document.querySelector('#chatInput');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(120, el.scrollHeight) + 'px';
  }

  function toggleChatPanel() {
    if (chat.open) closeChatPanel();
    else openChatPanel();
  }

  function openChatPanel() {
    const panel = document.querySelector('#chatPanel');
    if (!panel) return;

    // Snap chat.page to the currently-loaded editor page
    const cmsState = window.cmsState;
    const currentPage = (cmsState && cmsState.currentPage) || null;
    if (currentPage !== chat.page) {
      chat.history = [];
      chat.scope = null;
      chat.page = currentPage;
    }

    chat.open = true;
    panel.hidden = false;
    renderChat();
    setTimeout(() => {
      const input = document.querySelector('#chatInput');
      if (input) input.focus();
    }, 50);
  }

  function closeChatPanel() {
    const panel = document.querySelector('#chatPanel');
    if (!panel) return;
    chat.open = false;
    panel.hidden = true;
  }

  // -----------------------------------------------------------------------
  //  Scope picker — populates the dropdown from the current page's sections
  // -----------------------------------------------------------------------

  function buildScopeOptions() {
    const cmsState = window.cmsState;
    const sections = (cmsState && cmsState.sections) || [];
    const opts = [
      { value: 'page-meta', label: 'Page metadata (SEO + Schema)' },
    ];
    for (const s of sections) {
      const tag = s.id ? '#' + s.id : s.label;
      opts.push({ value: 'section:' + s.selector, label: 'Section: ' + tag });
    }
    opts.push({ value: 'whole-page', label: 'Whole page text' });
    return opts;
  }

  function defaultScopeFor() {
    // Default: first section if any, else page-meta
    const cmsState = window.cmsState;
    const sections = (cmsState && cmsState.sections) || [];
    if (sections.length) return { kind: 'section', ref: sections[0].selector };
    return { kind: 'page-meta', ref: null };
  }

  function onScopeChange(value) {
    if (value === 'page-meta') chat.scope = { kind: 'page-meta', ref: null };
    else if (value === 'whole-page') chat.scope = { kind: 'whole-page', ref: null };
    else if (value.startsWith('section:')) chat.scope = { kind: 'section', ref: value.slice('section:'.length) };
    renderChat();
  }

  function scopeAsValue(scope) {
    if (!scope) return 'page-meta';
    if (scope.kind === 'page-meta') return 'page-meta';
    if (scope.kind === 'whole-page') return 'whole-page';
    return 'section:' + scope.ref;
  }

  /**
   * Phase 7 — scope-aware suggestion chips. Returns 3 short prompts the user
   * can click to seed the input. Suggestions are predefined per scope kind
   * and lightly tailored using the current page's section labels when useful.
   */
  function buildSuggestionsForScope(scope) {
    const cmsState = window.cmsState;
    const sections = (cmsState && cmsState.sections) || [];
    const k = (scope && scope.kind) || 'page-meta';

    if (k === 'page-meta') {
      return [
        'Tighten the meta description',
        'Make the page title shorter and punchier',
        'What SEO metadata can I edit here?',
      ];
    }
    if (k === 'whole-page') {
      const target = sections[0] && sections[0].label;
      return [
        target ? 'Suggest 3 things to improve on this page' : 'Suggest 3 things to improve on this page',
        'Find any text that feels too long and shorten it',
        'What can you change on this page?',
      ];
    }
    // section scope
    const ref = scope && scope.ref;
    const sec = sections.find((s) => s.selector === ref);
    const label = (sec && sec.label) || 'this section';
    return [
      'Make the headline in ' + label + ' more concise',
      'Shorten the longest paragraph in ' + label,
      'What can you change in ' + label + '?',
    ];
  }

  // -----------------------------------------------------------------------
  //  Render
  // -----------------------------------------------------------------------

  function renderChat() {
    if (!chat.open) return;
    if (!chat.scope && chat.page) chat.scope = defaultScopeFor(chat.page);

    // Scope dropdown
    const scopeSel = document.querySelector('#chatScope');
    if (scopeSel) {
      const opts = buildScopeOptions();
      scopeSel.innerHTML = opts.map((o) =>
        `<option value="${escAttr(o.value)}">${escHtml(o.label)}</option>`
      ).join('');
      scopeSel.value = scopeAsValue(chat.scope);
    }

    // Messages
    const wrap = document.querySelector('#chatMessages');
    if (!wrap) return;

    if (!chat.history.length && !chat.isThinking) {
      const suggestions = buildSuggestionsForScope(chat.scope);
      const chipsHtml = suggestions.map((s) =>
        `<button class="chat-suggestion" data-suggestion="${escAttr(s)}">${escHtml(s)}</button>`
      ).join('');
      wrap.innerHTML = `
        <div class="chat-empty">
          <strong>Hi 👋 I can edit text, swap images, or clone/move/delete sections on this page.</strong>
          What would you like to change?
          ${chipsHtml}
        </div>
      `;
      wrap.querySelectorAll('.chat-suggestion').forEach((btn) => {
        btn.addEventListener('click', () => {
          const input = document.querySelector('#chatInput');
          if (input) {
            input.value = btn.dataset.suggestion || '';
            autosizeInput();
            input.focus();
          }
        });
      });
      return;
    }

    wrap.innerHTML = chat.history.map(renderMessage).join('') +
      (chat.isThinking ? '<div class="chat-bubble thinking">…thinking</div>' : '');
    wrap.scrollTop = wrap.scrollHeight;
  }

  function renderMessage(m, idx) {
    if (m.role === 'user')
      return `<div class="chat-bubble user">${escHtml(m.text)}</div>`;
    if (m.role === 'tool')
      return `<div class="chat-bubble assistant tool">${escHtml(m.text)}</div>`;
    if (m.role === 'error')
      return `<div class="chat-bubble error">${escHtml(m.text)}</div>`;
    if (m.role === 'plan') {
      const items = (m.plan || []).map((c, i) =>
        `<li><span class="plan-num">${i + 1}.</span> ${escHtml(humanizePlanItem(c))}</li>`
      ).join('');
      const buttons = (m.applied || m.cancelled)
        ? `<div class="chat-approval-status muted small">${m.applied ? '✓ Applied' : '✗ Cancelled'}</div>`
        : `<div class="chat-approval-buttons">
            <button class="btn small chat-approval-cancel">✗ Cancel</button>
            <button class="btn small primary chat-approval-apply">✓ Apply ${(m.plan || []).length}</button>
          </div>`;
      return `<div class="chat-bubble approval chat-approval" data-plan-index="${idx}">
        <div class="chat-approval-header">I'll do ${(m.plan || []).length} thing${(m.plan || []).length === 1 ? '' : 's'}:</div>
        <ol class="chat-approval-list">${items}</ol>
        ${buttons}
      </div>`;
    }
    return `<div class="chat-bubble assistant">${escHtmlMultiline(m.text)}</div>`;
  }

  // -----------------------------------------------------------------------
  //  Phase 5 — System prompt + context manifest + orchestration loop
  // -----------------------------------------------------------------------
  //
  // On each user message:
  //   1. race-guard (refuse if hasChanges)
  //   2. fresh-fetch /api/fields for current page
  //   3. build context manifest scoped to chat.scope
  //   4. build OpenAI messages = [{system}, ...history mapped to user/assistant]
  //   5. callLLM(...) → text or toolCalls
  //   6. if toolCalls: execute via callTool, append role:'tool' message, loop
  //   7. cap: AI_MAX_TOOL_CALLS per user message
  //   8. final text → assistant bubble in chat

  const AI_MAX_TOOL_CALLS = 8;

  // Tool calls that are "deferred" — buffered into a plan and reviewed via
  // the approval card (Phase 6). update_field is auto-execute.
  const DEFERRED_TOOLS = new Set([
    'clone_section',
    'delete_section',
    'move_section',
    'undo',
  ]);

  function buildSystemPrompt(scopeContext) {
    const tail =
      '\n\nCurrent page: ' + (chat.page || '(none)') +
      '\n\n' + scopeContext;
    return SYSTEM_PROMPT_HEAD + tail;
  }

  const SYSTEM_PROMPT_HEAD =
    'You are the cms-static assistant. You help a user edit a static HTML site\n' +
    'through a fixed set of tools.\n' +
    '\n' +
    'You can ONLY perform these operations:\n' +
    '  • Read content: list_pages, get_page_fields, read_field, find_fields,\n' +
    '    get_section_list\n' +
    '  • Edit content: update_field\n' +
    '  • Reorganise content: clone_section, delete_section, move_section, undo\n' +
    '\n' +
    'You CANNOT:\n' +
    '  • Write or modify HTML, CSS, or JavaScript directly\n' +
    '  • Add new sections, components, or pages from scratch\n' +
    '  • Generate images, translate text, or fetch external data\n' +
    '  • Run scripts, builds, or Git commands\n' +
    '  • Edit files outside the current page\n' +
    '\n' +
    'HOW TO MAKE CHANGES (read carefully):\n' +
    '  • To change ANY content, you MUST call the corresponding tool. Describing\n' +
    '    a change in your text reply does NOT change anything — the user only\n' +
    '    sees changes that come from real tool calls.\n' +
    '  • Do not write a "proposed change" paragraph. Emit the tool call.\n' +
    '  • If the user asks for several edits, emit one tool call per edit, all in\n' +
    '    the same response. The host will collect them and show an approval card\n' +
    '    automatically — you do not need to write the plan in text.\n' +
    '  • After your tool calls have been buffered, give a one-line summary in\n' +
    '    plain text describing what you queued, then stop.\n' +
    '  • If the user asks for something outside your tools, do NOT call any\n' +
    '    tool. Reply with: "I can\'t do that — it\'s outside what I\'m allowed to\n' +
    '    change. I can only edit existing field values, clone/delete/move\n' +
    '    sections, and undo recent changes. For your request, you might try:\n' +
    '    <2-3 in-scope alternatives>."\n' +
    '\n' +
    'IDs and selectors:\n' +
    '  • Use field IDs and selectors EXACTLY as they appear in the manifest\n' +
    '    below. Never invent IDs.\n' +
    '  • If you need information that is not in the manifest, call a read tool\n' +
    '    (get_page_fields, read_field, find_fields, get_section_list) first.\n' +
    '  • Never call more than ' + AI_MAX_TOOL_CALLS + ' tools per user message.\n';

  // Build a compact text manifest for the AI based on the current scope.
  async function buildScopeContext() {
    if (!chat.page) return 'No page is currently loaded.';
    const m = await callTool('get_page_fields', { page: chat.page });
    if (m.error) return 'Could not load page fields: ' + m.error;

    const scope = chat.scope || { kind: 'page-meta', ref: null };
    const allFields = m.fields || [];
    const allSections = m.sections || [];

    if (scope.kind === 'page-meta') {
      const meta = allFields.filter(
        (f) => /^Page details/i.test(f.group) || /^Schema/i.test(f.group) || /Business info/i.test(f.group)
      );
      return [
        'Scope: Page metadata (SEO + Schema)',
        'Editable fields:',
        ...meta.map(fmtField),
      ].join('\n');
    }

    if (scope.kind === 'whole-page') {
      return [
        'Scope: Whole page text (' + allFields.length + ' fields)',
        'Sections on this page:',
        ...allSections.map((s) => '  - ' + (s.id ? '#' + s.id : '(no id) ' + s.label) +
                                  '   selector: ' + s.selector),
        '',
        'Fields (truncated):',
        ...allFields.map(fmtField),
      ].join('\n');
    }

    // Section-scoped
    const secSel = scope.ref;
    const fieldsInSection = allFields.filter(
      (f) => typeof f.selector === 'string' && f.selector.startsWith(secSel)
    );
    const sec = allSections.find((s) => s.selector === secSel);
    const secLabel = sec ? (sec.id ? '#' + sec.id : sec.label) : 'unknown';
    return [
      'Scope: Section ' + secLabel,
      'Section selector: ' + secSel,
      'Editable fields in this section:',
      ...fieldsInSection.map(fmtField),
    ].join('\n');
  }

  function fmtField(f) {
    const v = (f.value || '').replace(/\s+/g, ' ').trim();
    const head = '  - id="' + f.id + '"  type=' + f.type + '  group=' + f.group;
    return head + '\n      label: ' + (f.label || '') +
                  '\n      value: ' + (v ? '"' + v + '"' : '(empty)');
  }

  // Convert chat.history into OpenAI Chat messages[]. The system message is
  // prepended by the caller; this only emits user/assistant turns.
  function chatHistoryToMessages() {
    const out = [];
    for (const m of chat.history) {
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.text });
      } else if (m.role === 'assistant') {
        out.push({ role: 'assistant', content: m.text });
      }
      // 'tool', 'error', 'plan' history entries are UI-only (not sent to LLM)
    }
    return out;
  }

  async function onSend() {
    const input = document.querySelector('#chatInput');
    if (!input) return;
    const msg = (input.value || '').trim();
    if (!msg) return;
    if (chat.isThinking) return;

    // Race-guard — same convention as Clone / Delete / Move / Undo
    if (typeof window.hasChanges === 'function' && window.hasChanges()) {
      chat.history.push({ role: 'user', text: msg });
      chat.history.push({
        role: 'error',
        text: 'Save your edits first — AI changes rewrite the file.',
      });
      input.value = '';
      autosizeInput();
      renderChat();
      return;
    }

    chat.history.push({ role: 'user', text: msg });
    input.value = '';
    autosizeInput();
    chat.isThinking = true;
    renderChat();

    try {
      await runAgent();
    } catch (err) {
      const code = (err && err.code) || '';
      let body = err && err.message ? err.message : String(err);
      if (code === 'BAD_KEY')
        body = 'Your NVIDIA API key was rejected. Click ⚙ to update it.';
      chat.history.push({ role: 'error', text: body });
    } finally {
      chat.isThinking = false;
      renderChat();
    }
  }

  /**
   * The agent loop. Talks to the LLM until it produces a final text response
   * or hits the tool-call cap. Buffers write-tools into chat.pendingPlan;
   * after the loop ends, decides whether to auto-apply (single update_field)
   * or surface an approval card.
   */
  async function runAgent() {
    // Reset the plan buffer for this turn
    chat.pendingPlan = [];

    // Refresh per turn — keep state in sync with disk
    const scopeContext = await buildScopeContext();
    const system = buildSystemPrompt(scopeContext);

    // OpenAI-shape messages array. System first, then prior turns, then
    // any assistant tool_call / tool result pairs we accumulate this turn.
    const messages = [{ role: 'system', content: system }, ...chatHistoryToMessages()];
    let toolCallCount = 0;
    let consecutiveFailures = 0;  // Phase 8 — abort if AI keeps calling broken tools

    for (let iter = 0; iter < 16; iter++) {
      const r = await callLLM({ messages, tools: TOOL_SCHEMAS });

      // Short-circuit if there are no calls — final answer
      if (!r.toolCalls.length) {
        // Render the AI's summary first, then handle pending plan
        if (r.text) chat.history.push({ role: 'assistant', text: r.text });
        else if (!chat.pendingPlan.length)
          chat.history.push({ role: 'assistant', text: '(no response)' });

        // Phase 6 — decide what to do with buffered write-tool calls
        if (chat.pendingPlan.length) {
          const onlyOneSafeEdit =
            chat.pendingPlan.length === 1 &&
            chat.pendingPlan[0].name === 'update_field';
          if (onlyOneSafeEdit) {
            // Auto-apply: single field edit, no destructive ops.
            await applyPlan(chat.pendingPlan, /* showCard */ false);
            chat.pendingPlan = [];
          } else {
            // Show approval card; user clicks Apply / Cancel.
            const planSnapshot = chat.pendingPlan;
            chat.pendingPlan = [];
            chat.history.push({ role: 'plan', plan: planSnapshot });
          }
        }
        return;
      }

      // Append the assistant message verbatim — preserves tool_call_ids.
      messages.push(r.assistantMsg);

      // If we'd exceed the cap, force-end with a system nudge. We must still
      // satisfy any tool_calls in the assistant message OR the next request
      // is malformed, so emit empty tool results first.
      if (toolCallCount + r.toolCalls.length > AI_MAX_TOOL_CALLS) {
        for (const call of r.toolCalls) {
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: 'action limit reached' }),
          });
        }
        messages.push({
          role: 'user',
          content: 'You have reached the action limit for this turn (max ' + AI_MAX_TOOL_CALLS +
                   '). Stop calling tools. Summarise what you did and what is still pending in plain text.',
        });
        continue;
      }

      // Per-call decision: auto-execute (read tools) or buffer into approval plan.
      //   • Single update_field per turn  → auto-apply at end-of-turn.
      //   • ≥ 2 update_field, OR any clone/delete/move/undo
      //                                    → buffer into pendingPlan,
      //                                      send a placeholder "deferred" tool
      //                                      result so the model can keep planning.
      // The single-vs-multi decision is made when the model returns text (no calls).
      for (const call of r.toolCalls) {
        toolCallCount++;

        if (call.args && call.args.__parse_error) {
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify({ ok: false, error: 'arguments were not valid JSON: ' + (call.rawArgs || '') }),
          });
          consecutiveFailures++;
          continue;
        }

        if (DEFERRED_TOOLS.has(call.name) || call.name === 'update_field') {
          chat.pendingPlan.push(call);
          messages.push({
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify({ ok: true, deferred: true, note: 'queued for user review' }),
          });
          continue;
        }

        // Read tools — execute now and feed the result back.
        const result = await callTool(call.name, call.args);
        if (result && (result.error || result.ok === false)) consecutiveFailures++;
        else consecutiveFailures = 0;
        messages.push({
          role: 'tool', tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      // Phase 8 safety net — if the AI keeps calling broken tools, abort.
      if (consecutiveFailures >= 3) {
        chat.history.push({
          role: 'error',
          text: 'AI hit 3 tool errors in a row. Stopping. Try rephrasing your request.',
        });
        return;
      }
      // Loop continues — model will see the tool results and either
      // produce more tool calls or a final text response.
    }

    // Ran out of iterations (safety net — shouldn't happen with the cap)
    chat.history.push({
      role: 'error',
      text: 'AI didn\'t finish in time. Try a smaller, more specific ask.',
    });
  }

  // -----------------------------------------------------------------------
  //  Phase 6 — Approval card: human-readable plan + Apply/Cancel
  // -----------------------------------------------------------------------

  /**
   * Turn a queued tool call into a one-liner the user can read on the card.
   *   { name: 'update_field', args: { fieldId: 'h1:28', value: 'New text' } }
   *     → "Update h1:28 to: \"New text\""
   */
  function humanizePlanItem(call) {
    const a = call.args || {};
    switch (call.name) {
      case 'update_field': {
        const target = a.fieldId || '(unknown field)';
        const v = (a.value || '').replace(/\s+/g, ' ').trim();
        const preview = v.length > 80 ? v.slice(0, 80) + '…' : v;
        const altPart = a.alt !== undefined ? '   alt: "' + a.alt + '"' : '';
        return 'Update ' + target + ' to: "' + preview + '"' + altPart;
      }
      case 'clone_section':
        return 'Clone section ' + (a.selector ? lastIdInSelector(a.selector) : '');
      case 'delete_section':
        return 'Delete section ' + (a.selector ? lastIdInSelector(a.selector) : '');
      case 'move_section':
        return 'Move ' + (a.direction || '?') + ' ' +
               (a.selector ? lastIdInSelector(a.selector) : '');
      case 'undo':
        return 'Undo the most recent change';
      default:
        return call.name + '(' + JSON.stringify(a) + ')';
    }
  }

  function lastIdInSelector(sel) {
    // selector like "body > main#main > section#story" → "#story"
    // or "body > main#main > section:nth-of-type(2)"   → "section:nth-of-type(2)"
    const last = String(sel).split('>').pop().trim();
    if (!last) return '';
    const m = last.match(/#([\w-]+)/);
    if (m) return '#' + m[1];
    return last;
  }

  /**
   * Apply each call in the plan in order. Stops on first error and
   * reports remaining as cancelled. Each successful call appends a
   * "tool" log line in the chat.
   */
  async function applyPlan(plan, /* showCard */ _show) {
    let stopped = null;
    for (let i = 0; i < plan.length; i++) {
      const call = plan[i];
      const result = await callTool(call.name, call.args);
      const isErr = !!(result && result.error) || result.ok === false;
      chat.history.push({
        role: isErr ? 'error' : 'tool',
        text: '· ' + summariseToolCall(call.name, call.args, result),
      });
      renderChat();
      if (isErr) { stopped = i; break; }
    }
    if (stopped !== null && stopped < plan.length - 1) {
      const remaining = plan.length - stopped - 1;
      chat.history.push({
        role: 'error',
        text: 'Stopped after error · ' + remaining + ' remaining action' + (remaining === 1 ? '' : 's') + ' not applied',
      });
      renderChat();
    }
    // Refresh the editor's view after a structural change so the sidebar
    // sections list / fields stay in sync.
    if (typeof window.refreshFromServer === 'function') {
      try { window.refreshFromServer(); } catch (e) { /* ignore */ }
    }
  }

  // Wire approval-card buttons via event delegation (since cards are
  // re-rendered on every chat update).
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!target || !target.matches) return;
    const card = target.closest && target.closest('.chat-approval');
    if (!card) return;
    const idx = parseInt(card.dataset.planIndex || '-1', 10);
    if (idx < 0) return;
    const planEntry = chat.history[idx];
    if (!planEntry || planEntry.role !== 'plan') return;

    if (target.matches('.chat-approval-apply')) {
      const plan = planEntry.plan || [];
      // Mark the card as applied so it doesn't render with buttons again
      planEntry.applied = true;
      renderChat();
      applyPlan(plan, false);
    } else if (target.matches('.chat-approval-cancel')) {
      planEntry.cancelled = true;
      chat.history.push({ role: 'tool', text: '· Cancelled — nothing changed.' });
      renderChat();
    }
  });

  function summariseToolCall(name, args, result) {
    if (result && result.error) return name + ' failed: ' + result.error;
    switch (name) {
      case 'update_field':    return 'Updated ' + (args && args.fieldId);
      case 'clone_section':   return 'Cloned · new id #' + (result && result.newId);
      case 'delete_section':  return 'Deleted ' + (result && result.removedId ? '#' + result.removedId : 'a section');
      case 'move_section':    return 'Moved ' + (args && args.direction) +
                                     (result && result.movedId ? ' · #' + result.movedId : '');
      case 'undo':            return 'Undone ' + (result && result.action ? '(' + result.action + ')' : '');
      default:                return name + ' ✓';
    }
  }

  // -----------------------------------------------------------------------
  //  Phase 3 — Tool schemas + dispatch
  // -----------------------------------------------------------------------
  // The 10 tools the AI is allowed to call. Each schema is consumed by an
  // OpenAI-compatible function-calling API. Each dispatch function is a thin
  // fetch wrapper around an existing /__cms/api/* endpoint and returns
  // { ok, ...data } | { ok: false, error }.
  //
  // The orchestrator (Phase 5) hands tool calls to TOOL_DISPATCH[name](args)
  // and feeds the JSON result back to the model as a role:'tool' message.

  // _RAW schemas (the function declarations). TOOL_SCHEMAS below wraps each in
  // OpenAI's { type:'function', function:{...} } envelope.
  const TOOL_SCHEMAS_RAW = [
    {
      name: 'list_pages',
      description: 'List every editable HTML page in the site. Returns an array of { path, label, group }.',
      parameters: { type: 'object', properties: {} },
    },
    {
      name: 'get_page_fields',
      description:
        'Get the editable field manifest for a page, including its sections. Returns { fields, sections }. ' +
        'Each field has id, group, type, label, and value (truncated to ~60 chars). ' +
        'Use read_field if you need the full value of one specific field.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string', description: 'Page path, e.g. "akasa-dalhousie/index.html"' },
        },
        required: ['page'],
      },
    },
    {
      name: 'read_field',
      description: 'Read the full value of one editable field. Returns { value, alt? }.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          fieldId: { type: 'string', description: 'Field id from get_page_fields, e.g. "h1:28"' },
        },
        required: ['page', 'fieldId'],
      },
    },
    {
      name: 'find_fields',
      description:
        'Find fields whose value matches a substring (case-insensitive). Use for cross-cutting asks ' +
        'like "every paragraph mentioning X" or "all H2s containing welcome". Returns up to 20 matches.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          query: { type: 'string' },
        },
        required: ['page', 'query'],
      },
    },
    {
      name: 'get_section_list',
      description:
        'List the <section> direct children of <main> on a page. Returns [{ selector, label, id, hasId }]. ' +
        'The selector is what you pass to clone_section / delete_section / move_section.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'string' } },
        required: ['page'],
      },
    },
    {
      name: 'update_field',
      description:
        'Update a single field value. Use for text, longtext (HTML may include inline tags em/strong/a), ' +
        'and image-URL fields. For image fields the value is the new URL/path; alt is the new alt text.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          fieldId: { type: 'string' },
          value: { type: 'string' },
          alt: { type: 'string', description: '(optional) alt text for image fields' },
        },
        required: ['page', 'fieldId', 'value'],
      },
    },
    {
      name: 'clone_section',
      description:
        'Duplicate a <section> in place. The clone is inserted right after the original with a fresh id ' +
        '("<stem>-copy" / "-copy-2" / "-copy-3" …). Returns { newId, formInside }.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          selector: { type: 'string', description: 'Section selector from get_section_list' },
        },
        required: ['page', 'selector'],
      },
    },
    {
      name: 'delete_section',
      description: 'Remove a <section> from the page. Reversible via undo. Returns { removedId }.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          selector: { type: 'string' },
        },
        required: ['page', 'selector'],
      },
    },
    {
      name: 'move_section',
      description: 'Move a <section> up or down among its <section> siblings.',
      parameters: {
        type: 'object',
        properties: {
          page: { type: 'string' },
          selector: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down'] },
        },
        required: ['page', 'selector', 'direction'],
      },
    },
    {
      name: 'undo',
      description:
        'Undo the most recent clone / delete / move on this page. Stack depth: 10. ' +
        'Returns { action } describing what was undone.',
      parameters: {
        type: 'object',
        properties: { page: { type: 'string' } },
        required: ['page'],
      },
    },
  ];

  // Wrap each raw declaration in OpenAI's { type:'function', function:{...} } envelope.
  const TOOL_SCHEMAS = TOOL_SCHEMAS_RAW.map((s) => ({
    type: 'function',
    function: { name: s.name, description: s.description, parameters: s.parameters },
  }));

  const ALLOWED_TOOLS = new Set(TOOL_SCHEMAS_RAW.map((s) => s.name));

  // ---- helpers used by multiple tools --------------------------------

  async function fetchJson(url, opts) {
    const r = await fetch(url, opts);
    let body;
    try { body = await r.json(); } catch (e) { body = { error: 'invalid JSON response (HTTP ' + r.status + ')' }; }
    if (!r.ok) return { ok: false, error: body.error || ('HTTP ' + r.status) };
    return body;
  }

  function truncateValue(s, max) {
    if (typeof s !== 'string') return s;
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  function compactFields(fields, maxChars) {
    return fields.map((f) => {
      const out = {
        id: f.id,
        group: f.group,
        type: f.type,
        label: f.label,
      };
      if (f.value !== undefined) out.value = truncateValue(f.value, maxChars);
      if (f.alt !== undefined && f.alt !== '') out.alt = truncateValue(f.alt, 80);
      if (f.selector) out.selector = f.selector;
      return out;
    });
  }

  // ---- dispatch ------------------------------------------------------
  // Every dispatch function returns a plain JSON-friendly value.
  // The orchestrator handles errors uniformly by serialising as { error }.

  const TOOL_DISPATCH = {
    list_pages: async () => {
      const j = await fetchJson('/__cms/api/pages');
      if (!j.ok && j.ok !== undefined) return j; // { ok:false, error }
      return { pages: (j.pages || []).map((p) => ({ path: p.path, label: p.label, group: p.group })) };
    },

    get_page_fields: async ({ page }) => {
      const j = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(page));
      if (j.ok === false) return j;
      return {
        page,
        fields: compactFields(j.fields || [], 60),
        sections: (j.sections || []).map((s) => ({
          selector: s.selector, label: s.label, id: s.id, hasId: s.hasId,
        })),
      };
    },

    read_field: async ({ page, fieldId }) => {
      const j = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(page));
      if (j.ok === false) return j;
      const f = (j.fields || []).find((x) => x.id === fieldId);
      if (!f) return { ok: false, error: 'field not found: ' + fieldId };
      return { value: f.value || '', alt: f.alt || '' };
    },

    find_fields: async ({ page, query }) => {
      const j = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(page));
      if (j.ok === false) return j;
      const q = String(query || '').toLowerCase();
      if (!q) return { matches: [] };
      const all = j.fields || [];
      const matches = [];
      for (const f of all) {
        const v = String(f.value || '').toLowerCase();
        if (v.includes(q)) {
          matches.push({
            id: f.id,
            group: f.group,
            label: f.label,
            snippet: truncateValue(f.value || '', 120),
          });
          if (matches.length >= 20) break;
        }
      }
      return { matches };
    },

    get_section_list: async ({ page }) => {
      const j = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(page));
      if (j.ok === false) return j;
      return { sections: j.sections || [] };
    },

    update_field: async ({ page, fieldId, value, alt }) => {
      // We need the field's selector + attr to build a valid /api/save change.
      const m = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(page));
      if (m.ok === false) return m;
      const f = (m.fields || []).find((x) => x.id === fieldId);
      if (!f) return { ok: false, error: 'field not found: ' + fieldId };
      const change = {
        id: f.id,
        group: f.group,
        type: f.type,
        selector: f.selector,
        attr: f.attr,
        altAttr: f.altAttr || null,
        scriptIndex: f.scriptIndex !== undefined ? f.scriptIndex : null,
        arrayIndex: f.arrayIndex !== undefined ? f.arrayIndex : null,
        jsonPath: f.jsonPath || null,
        value: value,
      };
      if (alt !== undefined) change.alt = alt;
      const r = await fetchJson('/__cms/api/save', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, changes: [change] }),
      });
      return r;
    },

    clone_section: async ({ page, selector }) => {
      return fetchJson('/__cms/api/clone-section', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, selector }),
      });
    },

    delete_section: async ({ page, selector }) => {
      return fetchJson('/__cms/api/delete-section', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, selector }),
      });
    },

    move_section: async ({ page, selector, direction }) => {
      return fetchJson('/__cms/api/move-section', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page, selector, direction }),
      });
    },

    undo: async ({ page }) => {
      return fetchJson('/__cms/api/undo', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ page }),
      });
    },
  };

  // Safe call site for the orchestrator. Enforces the whitelist; serialises
  // any thrown error into a JSON shape the AI can consume.
  async function callTool(name, args) {
    if (!ALLOWED_TOOLS.has(name)) return { error: 'unknown tool: ' + name };
    const fn = TOOL_DISPATCH[name];
    if (typeof fn !== 'function') return { error: 'tool not implemented: ' + name };
    try {
      const result = await fn(args || {});
      return result == null ? { ok: true } : result;
    } catch (err) {
      return { error: (err && err.message) || String(err) };
    }
  }

  // -----------------------------------------------------------------------
  //  Phase 4 — LLM REST client (NVIDIA-hosted Gemma, OpenAI-compatible)
  // -----------------------------------------------------------------------
  // Direct fetch() to NVIDIA's /v1/chat/completions endpoint. No SDK.
  // Wire format is OpenAI-style; the only NVIDIA specific is the host.
  //
  // callLLM({ messages, tools }) →
  //   { text?: string, toolCalls?: [{ id, name, args, rawArgs }], assistantMsg, raw }
  //
  //   'messages'      — array of OpenAI Chat messages (system / user / assistant /
  //                      tool). The first must be the system message.
  //   'tools'         — array of OpenAI tool schemas: [{ type:'function', function:{...} }]
  //   'assistantMsg'  — the raw assistant message returned by the model. Pass it
  //                      back unchanged in the next request so tool_call_ids match.

  const LLM_MODEL = 'google/gemma-4-31b-it';
  // We POST to a same-origin proxy (/__cms/api/llm). NVIDIA's upstream endpoint
  // does not send CORS headers, so the browser cannot fetch it directly. The
  // proxy is a pass-through — it does not read, log, or cache the key.
  const LLM_URL = '/__cms/api/llm';

  async function callLLM({ messages, tools }) {
    const apiKey = getKey();
    if (!apiKey) {
      const err = new Error('No API key set');
      err.code = 'NO_KEY';
      throw err;
    }

    const body = {
      model: LLM_MODEL,
      messages,
      max_tokens: 4096,
      temperature: 0.4,
      stream: false,
    };
    if (tools && tools.length) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    let response;
    try {
      response = await fetch(LLM_URL, {
        method: 'POST',
        headers: {
          'x-llm-key': apiKey,
          'content-type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const err = new Error('Could not reach the AI service (network error)');
      err.code = 'NETWORK';
      err.cause = e;
      throw err;
    }

    if (response.status === 401 || response.status === 403) {
      const err = new Error('Your NVIDIA API key was rejected.');
      err.code = 'BAD_KEY';
      throw err;
    }
    if (response.status === 429) {
      // OpenAI/NVIDIA puts the message in error.message; no structured per-day
      // quota object to parse.
      let detail = '';
      try {
        const j = await response.json();
        detail = (j && j.error && j.error.message) ? ' — ' + j.error.message : '';
      } catch (e) { /* ignore */ }
      const err = new Error('Rate-limited by the AI service. Wait a moment and retry.' + detail);
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!response.ok) {
      let detail = '';
      try {
        const j = await response.json();
        detail = (j && j.error && j.error.message) ? ' — ' + j.error.message : '';
      } catch (e) { /* ignore */ }
      const err = new Error('AI service error (HTTP ' + response.status + ')' + detail);
      err.code = 'HTTP_' + response.status;
      throw err;
    }

    let raw;
    try { raw = await response.json(); }
    catch (e) {
      const err = new Error('AI service returned a non-JSON response');
      err.code = 'BAD_JSON';
      throw err;
    }

    const choice = raw.choices && raw.choices[0];
    const msg = choice && choice.message;
    if (!msg) {
      const err = new Error('AI service returned an empty response');
      err.code = 'EMPTY';
      throw err;
    }

    const out = { raw, assistantMsg: msg, text: (msg.content || '').trim(), toolCalls: [] };
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        const fn = tc && tc.function;
        if (!fn || !fn.name) continue;
        let args = {};
        try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; }
        catch (e) { args = { __parse_error: true, raw: fn.arguments }; }
        out.toolCalls.push({
          id: tc.id,
          name: fn.name,
          args,
          rawArgs: fn.arguments || '{}',
        });
      }
    }
    return out;
  }

  // -----------------------------------------------------------------------
  //  Helpers
  // -----------------------------------------------------------------------
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escHtmlMultiline(s) { return escHtml(s).replace(/\n/g, '<br>'); }
  function escAttr(s) { return escHtml(s); }

  // -----------------------------------------------------------------------
  //  Public namespace
  // -----------------------------------------------------------------------
  window.cmsAI = window.cmsAI || {};
  window.cmsAI.key = {
    get: getKey,
    set: setKey,
    clear: clearKey,
    has: hasKey,
    isRemembered,
  };
  window.cmsAI.openKeyDialog = openKeyDialog;
  window.cmsAI.openChatPanel = openChatPanel;
  window.cmsAI.closeChatPanel = closeChatPanel;
  window.cmsAI._chat = chat; // for debugging in console
  window.cmsAI.tools = {
    schemas: TOOL_SCHEMAS,
    dispatch: TOOL_DISPATCH,
    call: callTool,        // safe: whitelist + try/catch
    allowed: ALLOWED_TOOLS,
  };
  window.cmsAI.client = { callLLM, model: LLM_MODEL };
})();
