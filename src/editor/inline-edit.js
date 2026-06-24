/* cms-static — inline (in-preview) editing.
   Pattern matches ai.js / git-panel.js / cropper-modal.js (IIFE + window namespace).

   What it does:
     • Hover any text element in the preview iframe that maps to a sidebar field
       → outline + cursor:text affordance.
     • Click it → contentEditable + a floating Done/Cancel bar in the parent.
     • Typing pushes the value into the matching sidebar <textarea> via a normal
       'input' event. The sidebar's existing handler does the bookkeeping
       (state.changed, save-button refresh, dirty marker).

   What it does NOT touch:
     • Sidebar state (only writes via the sidebar's own input handlers).
     • Save / Undo / Build / section ops / git / image cropper / AI chat.
     • Fields with no DOM presence (SEO meta, JSON-LD, image src/alt). The
       sidebar remains the only entry point for those.

   Exposed:
     window.cmsInlineEdit = { exit, attached: () => boolean }
*/
(function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Constants
  // -------------------------------------------------------------------------

  // Anything matching these selectors (or living inside something that does)
  // is skipped — their own JS owns the interaction.
  const READONLY_ANCESTORS = [
    '.swiper', '.swiper-container', '.swiper-wrapper', '.swiper-slide',
    '.slick-slider', '.slick-track',
    '.tns-slider', '.tns-inner',
    'form', 'button', 'a[role="button"]',
    '[data-no-cms-edit]',
  ].join(', ');

  // Field types that show up as visible DOM text. Image / SEO / JSON-LD fields
  // are filtered out before we attempt to attach.
  const EDITABLE_TYPES = new Set(['text', 'longtext', 'richtext']);

  // Tags preserved by the rich-text sanitiser. Anything else gets stripped to
  // its text content. <b> normalises to <strong>; <i> to <em>.
  const ALLOWED_TAGS = new Set(['EM', 'STRONG', 'BR']);
  const TAG_REMAP = { B: 'STRONG', I: 'EM' };

  // -------------------------------------------------------------------------
  // Module state
  // -------------------------------------------------------------------------

  // The single in-progress inline edit, or null. We only allow one at a time.
  //   { el: HTMLElement (in iframe),
  //     fieldId: string,
  //     originalHTML: string,        // for Cancel restore
  //     originalSidebarValue: string,
  //     bar: HTMLElement (in parent) }
  let current = null;

  const iframe = document.querySelector('#preview');
  if (!iframe) return;

  // -------------------------------------------------------------------------
  // Lifecycle: re-wire on every iframe load.
  // -------------------------------------------------------------------------

  iframe.addEventListener('load', () => {
    // Any active edit is dead — the iframe just navigated. Clean up.
    cleanupCurrent();
    // Give editor.js a tick to populate state.fields if this load was triggered
    // by a page change. setupIframe() bails politely if state isn't ready.
    setTimeout(setupIframe, 150);
  });

  // Re-attach when fields change (e.g. after section clone / delete / undo).
  document.addEventListener('cms:page-changed', () => {
    setTimeout(setupIframe, 200);
  });

  function setupIframe() {
    const doc = iframe.contentDocument;
    if (!doc) return;        // navigating or cross-origin (won't happen here)
    const fields = (window.cmsState && window.cmsState.fields) || [];
    if (!fields.length) return;

    injectCss(doc);

    for (const f of fields) {
      if (!EDITABLE_TYPES.has(f.type)) continue;
      // Only fields that map to an element's content are inline-editable:
      //   attr === 'text' → el.textContent      (e.g. <title>, plain SEO title)
      //   attr === 'html' → el.innerHTML        (headings / paragraphs / list items)
      //   attr falsy      → same as 'html' (older fields)
      // Real attribute-bound fields (meta description "content", img "src", etc.)
      // can't be edited by clicking visible text. Keep them sidebar-only.
      const inPlaceMode = !f.attr || f.attr === 'text' || f.attr === 'html'
        ? (f.attr === 'text' ? 'text' : 'html')
        : null;
      if (!inPlaceMode) continue;
      // JSON-LD fields live inside <script> tags. Skip.
      if (f.scriptIndex !== undefined && f.scriptIndex !== null) continue;
      if (!f.selector) continue;

      let el;
      try { el = doc.querySelector(f.selector); }
      catch (e) { continue; }
      if (!el) continue;
      if (el.closest(READONLY_ANCESTORS)) continue;
      // Skip invisible elements (e.g. <title> lives in <head>; no user can
      // click on it). offsetParent is null for display:none, hidden, head-children.
      if (!el.offsetParent && el.tagName !== 'BODY') continue;

      // Skip if we already wired this exact element on a prior pass.
      if (el.dataset.cmsBound === '1') continue;
      el.dataset.cmsBound = '1';
      el.dataset.cmsFieldId = f.id;
      el.dataset.cmsMode = inPlaceMode;     // 'text' | 'html'

      el.addEventListener('mouseenter', onHoverEnter);
      el.addEventListener('mouseleave', onHoverLeave);
      el.addEventListener('click', onElementClick, true);    // capture: beat site handlers
    }
  }

  // -------------------------------------------------------------------------
  // Hover affordance
  // -------------------------------------------------------------------------

  function onHoverEnter(e) {
    if (current) return;
    e.currentTarget.classList.add('cms-edit-hover');
  }
  function onHoverLeave(e) {
    e.currentTarget.classList.remove('cms-edit-hover');
  }

  // -------------------------------------------------------------------------
  // Click → enter edit
  // -------------------------------------------------------------------------

  function onElementClick(e) {
    if (current) return;
    const el = e.currentTarget;
    const fieldId = el.dataset.cmsFieldId;
    if (!fieldId) return;
    const field = (window.cmsState.fields || []).find((x) => x.id === fieldId);
    if (!field) return;

    // Cancel the click — don't navigate links, don't trigger site handlers.
    e.preventDefault();
    e.stopPropagation();

    enterEdit(el, field);
  }

  function enterEdit(el, field) {
    const sidebarInput = sidebarInputFor(field.id);
    const mode = el.dataset.cmsMode || 'html';
    current = {
      el,
      fieldId: field.id,
      mode,
      originalHTML: el.innerHTML,
      originalSidebarValue: sidebarInput ? sidebarInput.value : '',
      bar: null,
    };

    el.classList.remove('cms-edit-hover');
    el.classList.add('cms-edit-active');
    // text-mode → strip any pasted/typed HTML; html-mode → allow inline tags
    // (sanitised on input). plaintext-only is well-supported in Chromium.
    el.setAttribute('contenteditable', mode === 'text' ? 'plaintext-only' : 'true');
    el.focus();
    selectAll(el);

    // Floating bar lives in PARENT so it inherits cms-static styles and stays
    // visible if the iframe scrolls.
    const bar = buildBar(friendlyLabel(field));
    document.body.appendChild(bar);
    current.bar = bar;
    positionBar();

    el.addEventListener('input', onEditInput);
    el.addEventListener('keydown', onEditKeydown);
    el.addEventListener('paste', onEditPaste);
    iframe.contentWindow.addEventListener('scroll', positionBar, { passive: true });
    window.addEventListener('resize', positionBar);
    window.addEventListener('scroll', positionBar, { passive: true });
  }

  // -------------------------------------------------------------------------
  // Live update — fire input on the sidebar's <textarea>/<input>.
  // -------------------------------------------------------------------------

  function onEditInput() {
    if (!current) return;
    const value = current.mode === 'text'
      ? current.el.textContent.replace(/\s+/g, ' ').trim()
      : sanitise(current.el.innerHTML);
    const sidebar = sidebarInputFor(current.fieldId);
    if (!sidebar) return;
    sidebar.value = value;
    sidebar.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function onEditKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      exitEdit({ cancelled: true });
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      exitEdit({ cancelled: false });
    }
  }

  // Intercept paste so we never end up with Word / Google Docs markup. We use
  // 'text/plain' rather than 'text/html' and let normal typing rules re-emit
  // any inline tags the user wants via the sanitiser.
  function onEditPaste(e) {
    const cd = e.clipboardData || window.clipboardData;
    if (!cd) return;
    const txt = cd.getData('text/plain');
    if (txt == null) return;
    e.preventDefault();
    e.stopPropagation();
    const doc = current.el.ownerDocument;
    const sel = doc.getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    range.deleteContents();
    range.insertNode(doc.createTextNode(txt));
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    onEditInput();
  }

  // -------------------------------------------------------------------------
  // Exit (Done or Cancel)
  // -------------------------------------------------------------------------

  function exitEdit({ cancelled }) {
    if (!current) return;
    const { el, fieldId, originalHTML, originalSidebarValue, bar } = current;

    el.removeEventListener('input', onEditInput);
    el.removeEventListener('keydown', onEditKeydown);
    el.removeEventListener('paste', onEditPaste);
    iframe.contentWindow.removeEventListener('scroll', positionBar);
    window.removeEventListener('resize', positionBar);
    window.removeEventListener('scroll', positionBar);

    el.removeAttribute('contenteditable');
    el.classList.remove('cms-edit-active');

    if (cancelled) {
      // Revert the iframe DOM…
      el.innerHTML = originalHTML;
      // …and the sidebar input + change tracker.
      const sidebar = sidebarInputFor(fieldId);
      if (sidebar) {
        sidebar.value = originalSidebarValue;
        sidebar.dispatchEvent(new Event('input', { bubbles: true }));
        // The 'input' handler unconditionally sets state.changed — if the value
        // is back to the field's original, remove the entry so the dirty mark
        // and save-button count are accurate.
        const f = (window.cmsState.fields || []).find((x) => x.id === fieldId);
        if (f && window.cmsState.changed && originalSidebarValue === (f.value || '')) {
          window.cmsState.changed.delete(fieldId);
          const card = sidebar.closest('.field');
          if (card) card.classList.remove('changed');
          if (typeof window.refreshSaveBtn === 'function') window.refreshSaveBtn();
          if (typeof window.setStatus === 'function') {
            const dirty = (window.cmsState.changed && window.cmsState.changed.size) || 0;
            if (!dirty) window.setStatus('', '');
          }
        }
      }
    } else {
      // Done — run the sanitiser once more on whatever's in the DOM, just in
      // case the input handler missed a synthetic event.
      const cleaned = sanitise(el.innerHTML);
      if (cleaned !== el.innerHTML) el.innerHTML = cleaned;
    }

    if (bar && bar.parentNode) bar.parentNode.removeChild(bar);
    current = null;
  }

  // Called when the iframe reloads — we don't restore anything; the new page
  // takes over.
  function cleanupCurrent() {
    if (!current) return;
    if (current.bar && current.bar.parentNode) current.bar.parentNode.removeChild(current.bar);
    current = null;
  }

  // -------------------------------------------------------------------------
  // Floating bar (in PARENT document)
  // -------------------------------------------------------------------------

  function buildBar(labelText) {
    const bar = document.createElement('div');
    bar.className = 'cms-edit-bar';
    bar.innerHTML =
      '<span class="cms-edit-bar-label"></span>' +
      '<button type="button" class="btn small cms-edit-cancel">✗ Cancel</button>' +
      '<button type="button" class="btn small primary cms-edit-done">✓ Done</button>';
    bar.querySelector('.cms-edit-bar-label').textContent = labelText;
    bar.querySelector('.cms-edit-done').addEventListener('click', () => exitEdit({ cancelled: false }));
    bar.querySelector('.cms-edit-cancel').addEventListener('click', () => exitEdit({ cancelled: true }));
    return bar;
  }

  function positionBar() {
    if (!current || !current.bar) return;
    const elRect = current.el.getBoundingClientRect();
    const ifRect = iframe.getBoundingClientRect();
    const top = ifRect.top + elRect.top - 38;          // 32px bar + 6 gap
    const left = ifRect.left + elRect.left;
    current.bar.style.top = Math.max(8, top) + 'px';
    current.bar.style.left = Math.max(8, left) + 'px';
  }

  // -------------------------------------------------------------------------
  // Sanitiser — keep em / strong / br, normalise b→strong i→em, strip the rest.
  // -------------------------------------------------------------------------

  function sanitise(html) {
    if (!html) return '';
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    walkAndClean(tpl.content);
    return tpl.innerHTML.trim();
  }

  function walkAndClean(node) {
    // Children may be replaced during the walk — iterate over a snapshot.
    const children = Array.from(node.childNodes);
    for (const child of children) {
      if (child.nodeType === 3) continue;             // text node — keep
      if (child.nodeType !== 1) {                     // comment / other — drop
        child.remove();
        continue;
      }
      let tag = child.tagName;
      if (TAG_REMAP[tag]) tag = TAG_REMAP[tag];
      if (ALLOWED_TAGS.has(tag)) {
        // Strip attributes; preserve children (recursively cleaned).
        while (child.attributes.length) child.removeAttribute(child.attributes[0].name);
        if (child.tagName !== tag) {
          // Tag remap (b→strong, i→em): replace the element, keep children.
          const replacement = child.ownerDocument.createElement(tag);
          while (child.firstChild) replacement.appendChild(child.firstChild);
          child.replaceWith(replacement);
          walkAndClean(replacement);
        } else {
          walkAndClean(child);
        }
      } else {
        // Unwrap: move the element's children up to the parent (preserving any
        // allowed inline tags inside), then drop the wrapper. Textonly fallback
        // would otherwise destroy nested <b>/<i> elements.
        const parent = child.parentNode;
        while (child.firstChild) parent.insertBefore(child.firstChild, child);
        const next = child.nextSibling;   // position after the unwrapped block
        parent.removeChild(child);
        // Re-walk the parent so the just-moved children are evaluated too.
        // We only need to walk from `next` backward across the moved siblings,
        // but walking the parent again is simpler and idempotent.
        walkAndClean(parent);
        return;       // parent recursion already covered remaining siblings
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function sidebarInputFor(fieldId) {
    const escaped = cssEscape(fieldId);
    return document.querySelector('[data-input-id="' + escaped + '"]');
  }

  function friendlyLabel(f) {
    // Reuse the same labels the sidebar shows when possible.
    if (f.tag) {
      const t = (f.tag || '').toUpperCase();
      const map = { H1: 'Heading 1', H2: 'Heading 2', H3: 'Heading 3', H4: 'Heading 4', P: 'Paragraph', LI: 'List item', BLOCKQUOTE: 'Quote', FIGCAPTION: 'Caption' };
      return map[t] || f.tag;
    }
    return f.label || f.id;
  }

  function selectAll(el) {
    const doc = el.ownerDocument;
    const sel = doc.getSelection();
    if (!sel) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  // -------------------------------------------------------------------------
  // CSS injected into the iframe document (kept self-contained — no Roboto,
  // no theme tokens; the iframe's own stylesheet drives the rest).
  // -------------------------------------------------------------------------

  function injectCss(doc) {
    if (doc.getElementById('cms-inline-edit-style')) return;
    const style = doc.createElement('style');
    style.id = 'cms-inline-edit-style';
    style.textContent = `
      [data-cms-bound="1"] { transition: outline-color .12s ease, background-color .12s ease; }
      .cms-edit-hover {
        outline: 2px solid #1f4d3f !important;
        outline-offset: 2px;
        cursor: text !important;
        background-color: rgba(31,77,63,.04);
      }
      .cms-edit-active {
        outline: 2px dashed #1f4d3f !important;
        outline-offset: 2px;
        background-color: rgba(31,77,63,.06);
      }
      .cms-edit-active a { pointer-events: none; }
    `;
    doc.head.appendChild(style);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  window.cmsInlineEdit = {
    exit: () => exitEdit({ cancelled: true }),
    attached: () => !!current,
  };
})();
