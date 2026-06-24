/* cms-static — SEO / content validation warnings.
   Pattern matches ai.js / git-panel.js / drafts.js (IIFE + window namespace).

   v1 covers one rule:
     • H1 count: a page should have exactly one <h1>. If we find 2+, show a
       toast (auto-dismissing) on the page-transition that surfaces the
       issue, and render a persistent card at the top of the sidebar listing
       each h1 with its text + section context. Clicking an item scrolls the
       corresponding sidebar input into view and focuses it.

   Designed to extend later — checkPage() returns an array of issue objects
   shaped { code, severity, message, items?: [{ id, label, context }] }. New
   checks (missing meta description, title too long, etc.) drop in beside
   checkH1 with the same shape.

   Exposed:
     window.cmsValidation = { render }
*/
(function () {
  'use strict';

  // pagePath → last h1 count for which we toasted, so we don't re-toast on
  // every renderFields() inside the same page session.
  const lastToastCount = new Map();

  // ---------------------------------------------------------------------
  // Rules
  // ---------------------------------------------------------------------

  function checkH1(fields) {
    return (fields || []).filter((f) => (f.tag || '').toLowerCase() === 'h1');
  }

  function checkPage(fields) {
    const issues = [];
    const h1s = checkH1(fields);
    if (h1s.length > 1) {
      issues.push({
        code: 'multiple-h1',
        severity: 'warn',
        message: h1s.length + ' <h1> tags on this page. SEO best practice is one <h1> per page.',
        toast: h1s.length + ' H1 tags found — see SEO panel in sidebar.',
        items: h1s.map((f) => ({
          id: f.id,
          label: previewText(f.value),
          context: f.context || '',
        })),
      });
    }
    return issues;
  }

  // ---------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------

  function render(pagePath, fields) {
    const issues = checkPage(fields);
    renderCard(issues);
    toastIfNew(pagePath, issues);
  }

  function renderCard(issues) {
    const host = document.querySelector('#fieldsBody');
    if (!host || !host.parentNode) return;

    let card = document.querySelector('#seoCard');
    if (!issues.length) {
      if (card) card.remove();
      return;
    }
    if (!card) {
      card = document.createElement('div');
      card.id = 'seoCard';
      card.className = 'seo-card';
      host.parentNode.insertBefore(card, host);
    }
    card.innerHTML = issues.map(renderIssue).join('');
  }

  function renderIssue(issue) {
    const items = (issue.items || []).map((it, i) =>
      '<li>' +
        '<span class="seo-num">' + (i + 1) + '.</span>' +
        '<button type="button" class="seo-item-jump" data-fid="' + escAttr(it.id) + '">' +
          escHtml(it.label) +
        '</button>' +
        (it.context ? ' <span class="seo-context muted small">in ' + escHtml(it.context) + '</span>' : '') +
      '</li>'
    ).join('');
    return (
      '<div class="seo-issue seo-' + issue.severity + '">' +
        '<div class="seo-issue-head">' +
          '<span class="seo-icon" aria-hidden="true">⚠</span>' +
          '<span class="seo-msg">' + escHtml(issue.message) + '</span>' +
        '</div>' +
        (items ? '<ol class="seo-list">' + items + '</ol>' : '') +
      '</div>'
    );
  }

  // ---------------------------------------------------------------------
  // Toast (one per transition; not per re-render)
  // ---------------------------------------------------------------------

  function toastIfNew(pagePath, issues) {
    // Aggregate signature of all issues that have a toast message. We toast
    // only when this signature changes for this page in this session.
    const sig = issues.filter((i) => i.toast).map((i) => i.code + ':' + (i.items || []).length).join('|');
    if (!sig) {
      lastToastCount.set(pagePath, '');
      return;
    }
    if (lastToastCount.get(pagePath) === sig) return;
    lastToastCount.set(pagePath, sig);
    if (typeof window.cmsToast === 'function') {
      for (const i of issues) {
        if (i.toast) window.cmsToast(i.toast, 'info');
      }
    }
  }

  // ---------------------------------------------------------------------
  // Click delegation — jump to the sidebar input for that field
  // ---------------------------------------------------------------------

  document.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest && e.target.closest('.seo-item-jump');
    if (!btn) return;
    const fid = btn.dataset.fid;
    if (!fid) return;
    const input = document.querySelector('[data-input-id="' + cssEscape(fid) + '"]');
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setTimeout(() => {
      input.focus();
      // Flash the field card so it's obvious where you landed
      const card = input.closest('.field');
      if (card) {
        card.classList.add('field-flash');
        setTimeout(() => card.classList.remove('field-flash'), 1200);
      }
    }, 320);
  });

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function previewText(value) {
    if (!value) return '(empty)';
    // Strip HTML tags (we already show field's tag-prefix context separately).
    const text = String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    if (!text) return '(empty)';
    return text.length > 80 ? text.slice(0, 80) + '…' : text;
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s); }
  function cssEscape(s) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(s);
    return String(s).replace(/([^\w-])/g, '\\$1');
  }

  // Wipe the per-page toast memory when the user navigates to a new page so
  // the warning re-toasts if they come back to a problem page later.
  document.addEventListener('cms:page-changed', (e) => {
    const newPage = e && e.detail && e.detail.page;
    if (newPage) lastToastCount.delete(newPage);
  });

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------
  window.cmsValidation = { render, checkPage };
})();
