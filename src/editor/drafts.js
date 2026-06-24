/* cms-static — draft persistence + refresh guard.
   Pattern matches ai.js / git-panel.js / inline-edit.js (IIFE + window namespace).

   Three layers of protection against accidental reload data loss:

     1. Auto-save: every change in state.changed / state.changedAlt is mirrored
        to localStorage (debounced 400 ms). On the next editor load for that
        page, a banner offers to restore.

     2. ⌘R / Ctrl+R / F5 hijack: if there are unsaved changes, we intercept
        the keystroke and show an in-app dialog (Save & reload / Discard &
        reload / Cancel) instead of just relying on the browser's native
        beforeunload prompt — which can only say "Leave/Stay" with no Save.

     3. The existing native beforeunload prompt stays in place as the catch-all
        for cases we can't intercept (clicking the browser's reload button,
        closing the tab from the title bar, etc.). Even if the user ignores it
        and reloads, drafts come back via layer 1.

   Image crops (state.pendingImages) hold Blob references that can't be stored
   in localStorage cleanly. The banner mentions if any crops were lost so the
   user knows to re-crop.
*/
(function () {
  'use strict';

  const STORAGE_PREFIX = 'cms-static.draft.';
  const DEBOUNCE_MS = 400;

  // Debounce handle; null when no pending write.
  let pendingPersist = null;
  // The restore-banner element currently in the sidebar, if any.
  let bannerEl = null;

  // ---------------------------------------------------------------------
  // localStorage operations
  // ---------------------------------------------------------------------

  function keyFor(pagePath) {
    return STORAGE_PREFIX + pagePath;
  }

  function persistNow() {
    const state = window.cmsState;
    if (!state || !state.currentPage) return;
    const hasText = state.changed && state.changed.size > 0;
    const hasAlt  = state.changedAlt && state.changedAlt.size > 0;
    if (!hasText && !hasAlt) {
      try { localStorage.removeItem(keyFor(state.currentPage)); } catch (e) { /* quota or disabled */ }
      return;
    }
    const draft = {
      changed: Array.from(state.changed.entries()),
      changedAlt: Array.from(state.changedAlt.entries()),
      savedAt: new Date().toISOString(),
      pendingImagesCount: (state.pendingImages && state.pendingImages.size) || 0,
    };
    try { localStorage.setItem(keyFor(state.currentPage), JSON.stringify(draft)); }
    catch (e) { /* quota exceeded — silently skip; user still has beforeunload */ }
  }

  function persist() {
    if (pendingPersist) clearTimeout(pendingPersist);
    pendingPersist = setTimeout(() => {
      pendingPersist = null;
      persistNow();
    }, DEBOUNCE_MS);
  }

  function clearDraft(pagePath) {
    const key = keyFor(pagePath || (window.cmsState && window.cmsState.currentPage));
    if (!key.endsWith('.')) {
      try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
    }
    if (pendingPersist) { clearTimeout(pendingPersist); pendingPersist = null; }
  }

  function readDraft(pagePath) {
    try {
      const raw = localStorage.getItem(keyFor(pagePath));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------
  // Restore banner
  // ---------------------------------------------------------------------

  function maybeRestore(pagePath) {
    removeBanner();
    const draft = readDraft(pagePath);
    if (!draft) return;
    const total = (draft.changed || []).length + (draft.changedAlt || []).length;
    if (!total) {
      clearDraft(pagePath);
      return;
    }

    const banner = document.createElement('div');
    banner.className = 'draft-banner';
    const imgLost = draft.pendingImagesCount > 0
      ? ` <em class="draft-banner-warn">(image crops were lost)</em>`
      : '';
    banner.innerHTML =
      '<span class="draft-banner-icon" aria-hidden="true">💾</span>' +
      '<span class="draft-banner-text">' +
        '<strong>' + total + ' unsaved edit' + (total === 1 ? '' : 's') + '</strong>' +
        ' from your last session.' + imgLost +
      '</span>' +
      '<button type="button" class="btn small draft-discard">✗ Discard</button>' +
      '<button type="button" class="btn small primary draft-restore">↻ Restore</button>';
    const sidebarBody = document.querySelector('#fieldsBody');
    if (!sidebarBody || !sidebarBody.parentNode) return;
    sidebarBody.parentNode.insertBefore(banner, sidebarBody);
    bannerEl = banner;

    banner.querySelector('.draft-restore').addEventListener('click', () => {
      applyDraft(draft);
      removeBanner();
    });
    banner.querySelector('.draft-discard').addEventListener('click', () => {
      clearDraft(pagePath);
      removeBanner();
    });
  }

  function applyDraft(draft) {
    const state = window.cmsState;
    if (!state) return;
    for (const [id, value] of draft.changed || []) state.changed.set(id, value);
    for (const [id, value] of draft.changedAlt || []) state.changedAlt.set(id, value);
    if (typeof window.renderFields === 'function') {
      window.renderFields(state.fields);
    }
    if (typeof window.refreshSaveBtn === 'function') window.refreshSaveBtn();
    if (typeof window.setStatus === 'function') window.setStatus('● unsaved (restored)', 'dirty');
  }

  function removeBanner() {
    if (bannerEl && bannerEl.parentNode) bannerEl.parentNode.removeChild(bannerEl);
    bannerEl = null;
  }

  // ---------------------------------------------------------------------
  // ⌘R / Ctrl+R / F5 hijack
  // ---------------------------------------------------------------------

  function isRefreshKey(e) {
    if (e.key === 'F5') return true;
    if ((e.metaKey || e.ctrlKey) && (e.key === 'r' || e.key === 'R')) return true;
    return false;
  }

  function hasUnsaved() {
    const s = window.cmsState;
    if (!s) return false;
    return (s.changed && s.changed.size > 0) || (s.changedAlt && s.changedAlt.size > 0);
  }

  document.addEventListener('keydown', (e) => {
    if (!isRefreshKey(e)) return;
    if (!hasUnsaved()) return;        // no changes → let the refresh through
    e.preventDefault();
    e.stopPropagation();
    showRefreshDialog();
  }, true);

  function showRefreshDialog() {
    const dlg = document.querySelector('#refreshConfirmDialog');
    if (!dlg) {
      // Fallback if the dialog markup is missing for some reason
      if (window.confirm('You have unsaved changes. Reload anyway?')) location.reload();
      return;
    }
    const s = window.cmsState || { changed: new Map(), changedAlt: new Map() };
    const count = ((s.changed && s.changed.size) || 0) + ((s.changedAlt && s.changedAlt.size) || 0);
    const countEl = dlg.querySelector('.draft-count');
    const pluralEl = dlg.querySelector('.draft-count-plural');
    if (countEl) countEl.textContent = String(count);
    if (pluralEl) pluralEl.textContent = count === 1 ? '' : 's';
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', '');
  }

  function wireDialog() {
    const dlg = document.querySelector('#refreshConfirmDialog');
    if (!dlg) return;
    const saveBtn = dlg.querySelector('#draftSaveReload');
    const discardBtn = dlg.querySelector('#draftDiscardReload');
    const cancelBtn = dlg.querySelector('#draftCancelReload');

    if (saveBtn) saveBtn.addEventListener('click', async () => {
      dlg.close();
      try { if (typeof window.save === 'function') await window.save(); }
      catch (e) { /* save() already shows a toast on failure; abort reload */ return; }
      // If save succeeded, state.changed is empty → reload skips beforeunload.
      // If it failed, we don't reload.
      const stillDirty = hasUnsaved();
      if (!stillDirty) location.reload();
    });

    if (discardBtn) discardBtn.addEventListener('click', () => {
      const s = window.cmsState;
      if (s) {
        if (s.changed) s.changed.clear();
        if (s.changedAlt) s.changedAlt.clear();
        if (s.pendingImages) s.pendingImages.clear();
      }
      clearDraft();
      dlg.close();
      location.reload();
    });

    if (cancelBtn) cancelBtn.addEventListener('click', () => dlg.close());
  }

  // ---------------------------------------------------------------------
  // Flush on hide/unload — the debounce timer might not have fired yet.
  // ---------------------------------------------------------------------
  window.addEventListener('beforeunload', () => {
    if (pendingPersist) {
      clearTimeout(pendingPersist);
      pendingPersist = null;
      persistNow();
    } else if (hasUnsaved()) {
      // Even with no debounce pending, the very latest keystroke may have
      // been written within the last 400 ms and never debounced again.
      persistNow();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && hasUnsaved()) persistNow();
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireDialog);
  } else {
    wireDialog();
  }

  window.cmsDrafts = {
    persist,
    maybeRestore,
    clear: clearDraft,
    _persistNow: persistNow,   // exposed for tests
  };
})();
