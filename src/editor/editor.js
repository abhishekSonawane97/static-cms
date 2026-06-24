/* cms-static editor — vanilla JS */

const state = {
  pages: [],
  currentPage: null,
  fields: [],
  sections: [],             // G1 — list of <section> rows from /api/fields
  undoAvailable: false,     // G2/G3/G4 — whether the Undo button is enabled
  changed: new Map(),       // id -> new value
  changedAlt: new Map(),    // id -> new alt text (for images)
  pendingImages: new Map(), // id -> { blob, destPath }
};

// Expose for cropper-modal.js / ai.js / inline-edit.js to share state
window.cmsState = state;

const $ = (sel) => document.querySelector(sel);

// -----------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------
async function boot() {
  await loadPages();
  $('#saveBtn').addEventListener('click', save);
  $('#buildBtn').addEventListener('click', build);
  $('#refreshBtn').addEventListener('click', () => {
    if (!state.currentPage) return;
    const iframe = $('#preview');
    const url = iframe.src;
    iframe.src = 'about:blank';
    setTimeout(() => { iframe.src = url; }, 30);
  });

  initSidebarLayout(); // A1 + A2 — collapse + resize
  initKbdHelp();       // C3 — keyboard cheat-sheet
  showFirstVisitTip(); // C2 — first-visit toast

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Don't intercept ? while typing in an input/textarea
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName || '');
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      if (hasChanges()) save();
    } else if ((e.metaKey || e.ctrlKey) && (e.key === 'b' || e.key === 'B')) {
      e.preventDefault();
      toggleSidebar();
    } else if (e.key === '?' && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      openKbdHelp();
    }
  });
}

// -----------------------------------------------------------------------
// C2 — First-visit tip
// -----------------------------------------------------------------------
const FIRST_VISIT_KEY = 'cms-static.firstVisitTip.dismissed';

function showFirstVisitTip() {
  if (localStorage.getItem(FIRST_VISIT_KEY) === '1') return;
  // Defer slightly so the editor renders first
  setTimeout(() => {
    toast(
      'Tip: edits live in the sidebar. The preview updates after Save. Press ? for shortcuts.',
      'info'
    );
    localStorage.setItem(FIRST_VISIT_KEY, '1');
  }, 700);
}

// -----------------------------------------------------------------------
// C3 — Keyboard cheat-sheet
// -----------------------------------------------------------------------
function initKbdHelp() {
  const btn = $('#kbdHelpBtn');
  const dlg = $('#kbdHelpDialog');
  const closeBtn = $('#kbdHelpClose');
  if (btn) btn.addEventListener('click', openKbdHelp);
  if (closeBtn) closeBtn.addEventListener('click', () => dlg && dlg.close());
}
function openKbdHelp() {
  const dlg = $('#kbdHelpDialog');
  if (!dlg) return;
  if (typeof dlg.showModal === 'function') dlg.showModal();
  else dlg.setAttribute('open', '');
}

// -----------------------------------------------------------------------
// Sidebar — collapse (A1) + resize (A2)
// -----------------------------------------------------------------------
const SIDEBAR_COLLAPSED_KEY = 'cms-static.sidebar.collapsed';
const SIDEBAR_WIDTH_KEY = 'cms-static.sidebar.width';
const SIDEBAR_MIN = 300;
const SIDEBAR_MAX = 600;
const SIDEBAR_DEFAULT = 380;

function initSidebarLayout() {
  const layout = $('#layout');

  // Restore persisted width — written to --user-sidebar-width so it doesn't
  // override the .is-collapsed class rule's --sidebar-width.
  const savedWidth = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY) || '', 10);
  if (savedWidth >= SIDEBAR_MIN && savedWidth <= SIDEBAR_MAX) {
    layout.style.setProperty('--user-sidebar-width', savedWidth + 'px');
  }

  // Restore persisted collapse state
  if (localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1') {
    layout.classList.add('is-collapsed');
    updateToggleA11y(true);
  }

  // Toggle button
  const toggle = $('#sidebarToggle');
  if (toggle) toggle.addEventListener('click', toggleSidebar);

  // Resizer (A2)
  const resizer = $('#sidebarResizer');
  if (resizer) wireResizer(resizer, layout);
}

function toggleSidebar() {
  const layout = $('#layout');
  const collapsed = layout.classList.toggle('is-collapsed');
  localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  updateToggleA11y(collapsed);
}

function updateToggleA11y(collapsed) {
  const btn = $('#sidebarToggle');
  if (!btn) return;
  btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  btn.title = (collapsed ? 'Expand sidebar' : 'Collapse sidebar') + ' (Ctrl/⌘ B)';
}

function wireResizer(handle, layout) {
  let startX = 0;
  let startWidth = 0;

  // Read the current user-set width. We always read --user-sidebar-width
  // (not --sidebar-width) so resize works the same regardless of collapsed state.
  function readUserWidth() {
    const v = getComputedStyle(layout).getPropertyValue('--user-sidebar-width').trim();
    return parseInt(v, 10) || SIDEBAR_DEFAULT;
  }

  function onPointerMove(e) {
    const dx = e.clientX - startX;
    let w = startWidth + dx;
    if (w < SIDEBAR_MIN) w = SIDEBAR_MIN;
    if (w > SIDEBAR_MAX) w = SIDEBAR_MAX;
    layout.style.setProperty('--user-sidebar-width', w + 'px');
  }
  function onPointerUp() {
    document.body.classList.remove('is-resizing');
    handle.classList.remove('is-dragging');
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', onPointerUp);
    // Persist final width
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(readUserWidth()));
  }

  handle.addEventListener('pointerdown', (e) => {
    if (layout.classList.contains('is-collapsed')) return;
    e.preventDefault();
    startX = e.clientX;
    startWidth = readUserWidth();
    document.body.classList.add('is-resizing');
    handle.classList.add('is-dragging');
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
  });

  // Double-click resets to default
  handle.addEventListener('dblclick', () => {
    layout.style.setProperty('--user-sidebar-width', SIDEBAR_DEFAULT + 'px');
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(SIDEBAR_DEFAULT));
  });
}

async function loadPages() {
  const r = await fetchJson('/__cms/api/pages');
  state.pages = r.pages || [];
  $('#rootLabel').textContent = '· ' + (r.root || '').split('/').slice(-2).join('/');

  // Group entries by group label, preserving server's sort order within each group
  const groups = new Map();
  for (const p of state.pages) {
    // Tolerate the legacy string format if anyone is still on it
    const item = (typeof p === 'string') ? { path: p, label: p, group: 'Pages' } : p;
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }

  const picker = $('#pagePicker');
  let html = '<option value="">— select a page —</option>';
  for (const [group, items] of groups) {
    html += `<optgroup label="${escAttr(group)}">`;
    for (const it of items) {
      html += `<option value="${escAttr(it.path)}" title="${escAttr(it.path)}">${escHtml(it.label)}</option>`;
    }
    html += '</optgroup>';
  }
  picker.innerHTML = html;
  picker.addEventListener('change', () => loadPage(picker.value));
}

async function loadPage(pagePath) {
  if (!pagePath) {
    $('#fieldsBody').innerHTML = `
      <div class="welcome-card" role="region" aria-label="Welcome">
        <span class="welcome-emoji" aria-hidden="true">👋</span>
        <span class="welcome-title">Welcome to cms-static</span>
        <span class="welcome-arrow">Pick a page above to begin</span>
        <p class="welcome-body">
          Edit any field on the left, then hit <strong>Save</strong>.
          Your changes only go live after Save.
        </p>
      </div>`;
    $('#previewPath').textContent = 'No page loaded';
    $('#preview').src = 'about:blank';
    $('#openInTab').hidden = true;
    return;
  }
  state.currentPage = pagePath;
  state.changed.clear();
  state.changedAlt.clear();
  state.pendingImages.clear();
  setStatus('');

  // Notify other modules (e.g. AI chat) that the page has changed so they
  // can clear per-page state.
  document.dispatchEvent(new CustomEvent('cms:page-changed', { detail: { page: pagePath } }));

  // Load preview
  const previewUrl = '/' + pagePath;
  $('#preview').src = previewUrl;
  $('#previewPath').textContent = previewUrl;
  const link = $('#openInTab');
  link.href = previewUrl;
  link.hidden = false;

  // D3 — Loading skeletons (replaces the bare "Loading fields…" text)
  $('#fieldsBody').innerHTML = renderSkeletons(6);
  try {
    const r = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(pagePath));
    state.fields = r.fields || [];
    state.sections = r.sections || [];   // G1 — section list for clone UI
    // Pull undo state in parallel (separate endpoint; server keeps history per page)
    try {
      const u = await fetchJson('/__cms/api/undo-state?page=' + encodeURIComponent(pagePath));
      state.undoAvailable = !!u.undoAvailable;
    } catch (e) { state.undoAvailable = false; }
    renderFields(state.fields);
    if (window.cmsDrafts) window.cmsDrafts.maybeRestore(pagePath);
  } catch (err) {
    $('#fieldsBody').innerHTML = `<p class="muted center">Error: ${escHtml(err.message)}</p>`;
  }
}

// -----------------------------------------------------------------------
// Field rendering
// -----------------------------------------------------------------------
// D3 — Skeleton loaders shown while /api/fields is in flight
function renderSkeletons(n) {
  const rows = [];
  for (let i = 0; i < n; i++) {
    const wide = i % 3 === 0;
    rows.push(`
      <div class="skeleton-field">
        <div class="skeleton skel-label"></div>
        <div class="skeleton skel-input ${wide ? 'tall' : ''}"></div>
      </div>
    `);
  }
  return '<div class="skeleton-stack" aria-busy="true">' + rows.join('') + '</div>';
}

// B5 — render groups in this order. Items not in the list keep their original
// (insertion) order, appended at the end. Groups are sorted by where the user is
// most likely to edit, top-to-bottom.
const GROUP_ORDER = [
  'Headings',
  'Page content',
  'Photos',
  'Page details (SEO)',
  // anything else (Business info, Schema — X, …) lands below in original order
];

function renderFields(fields) {
  if (!fields.length && !(state.sections && state.sections.length)) {
    $('#fieldsBody').innerHTML = '<p class="muted center">No editable fields detected on this page.</p>';
    return;
  }
  const groups = new Map();
  for (const f of fields) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }
  // Sort group entries by GROUP_ORDER; unknown groups keep insertion order at the end.
  const ordered = Array.from(groups.entries()).sort(([a], [b]) => {
    const ai = GROUP_ORDER.indexOf(a);
    const bi = GROUP_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });

  // G1 — Sections group rendered above everything else
  const sectionsHtml = renderSectionsGroup(state.sections || []);

  const fieldsHtml = ordered.map(([group, fs]) => `
    <details open class="group" data-group="${escAttr(group)}">
      <summary><span>${escHtml(group)}</span><span class="count">${fs.length}</span></summary>
      <div class="group-body">
        ${fs.map(renderField).join('')}
      </div>
    </details>
  `).join('');
  $('#fieldsBody').innerHTML = sectionsHtml + fieldsHtml;
  wireFieldEvents();
  wireSectionEvents();
  refreshSaveBtn();
  if (window.cmsValidation) window.cmsValidation.render(state.currentPage, fields);
}

// G1–G4 — Render the Sections group at the top of the sidebar.
// Each row gets four actions: ▲ move up · ▼ move down · 📋 clone · 🗑 delete
// Plus a toolbar at the top of the group with an Undo button.
function renderSectionsGroup(sections) {
  if (!sections || !sections.length) return '';
  const rows = sections.map((s, i) => {
    const isFirst = i === 0;
    const isLast = i === sections.length - 1;
    return `
    <div class="section-row" data-sec-selector="${escAttr(s.selector)}">
      <div class="section-meta">
        <span class="section-label">${escHtml(s.label)}</span>
        ${s.id ? `<span class="section-id">#${escHtml(s.id)}</span>` : '<span class="section-id muted">no id</span>'}
      </div>
      <div class="section-actions">
        <button class="btn small icon-btn move-up-btn"
                data-sec-selector="${escAttr(s.selector)}"
                ${isFirst ? 'disabled' : ''} title="Move up">▲</button>
        <button class="btn small icon-btn move-down-btn"
                data-sec-selector="${escAttr(s.selector)}"
                ${isLast ? 'disabled' : ''} title="Move down">▼</button>
        <button class="btn small icon-btn clone-section-btn"
                data-sec-selector="${escAttr(s.selector)}" title="Duplicate this section in place">📋</button>
        <button class="btn small icon-btn delete-section-btn"
                data-sec-selector="${escAttr(s.selector)}" data-sec-label="${escAttr(s.id || s.label)}"
                title="Delete this section">🗑</button>
      </div>
    </div>`;
  }).join('');

  const undoEnabled = !!state.undoAvailable;
  return `
    <details open class="group group-sections" data-group="Sections">
      <summary><span>Sections</span><span class="count">${sections.length}</span></summary>
      <div class="group-body">
        <div class="sections-toolbar">
          <button class="btn small undo-btn" ${undoEnabled ? '' : 'disabled'}
                  title="Undo the most recent clone / delete / move on this page">↩ Undo</button>
        </div>
        ${rows}
      </div>
    </details>
  `;
}

function wireSectionEvents() {
  document.querySelectorAll('.clone-section-btn').forEach((btn) => {
    btn.addEventListener('click', () => sectionAction('clone', btn.dataset.secSelector));
  });
  document.querySelectorAll('.delete-section-btn').forEach((btn) => {
    btn.addEventListener('click', () => sectionAction('delete', btn.dataset.secSelector, { label: btn.dataset.secLabel }));
  });
  document.querySelectorAll('.move-up-btn').forEach((btn) => {
    btn.addEventListener('click', () => sectionAction('move-up', btn.dataset.secSelector));
  });
  document.querySelectorAll('.move-down-btn').forEach((btn) => {
    btn.addEventListener('click', () => sectionAction('move-down', btn.dataset.secSelector));
  });
  const undoBtn = document.querySelector('.undo-btn');
  if (undoBtn) undoBtn.addEventListener('click', () => sectionAction('undo'));
}

/**
 * Single dispatcher for clone / delete / move-up / move-down / undo.
 * All four:
 *   1. refuse if there are unsaved field edits
 *   2. POST the right endpoint
 *   3. show success/error toast
 *   4. reload preview + fields + sections (and undo state)
 */
async function sectionAction(kind, selector, opts) {
  opts = opts || {};
  if (!state.currentPage) return;
  if (hasChanges()) {
    toast('Save your edits first — section actions rewrite the file.', 'error');
    return;
  }

  // Confirm-on-delete (native — small friction, undo is one click anyway)
  if (kind === 'delete') {
    const label = opts.label || 'this section';
    if (!window.confirm(`Delete ${label}?\n\nYou can Undo immediately if needed.`)) return;
  }

  let url, body, label;
  if (kind === 'clone')        { url = '/__cms/api/clone-section';  body = { page: state.currentPage, selector }; label = 'Cloning section…'; }
  else if (kind === 'delete')  { url = '/__cms/api/delete-section'; body = { page: state.currentPage, selector }; label = 'Deleting section…'; }
  else if (kind === 'move-up') { url = '/__cms/api/move-section';   body = { page: state.currentPage, selector, direction: 'up' };   label = 'Moving up…'; }
  else if (kind === 'move-down'){url = '/__cms/api/move-section';   body = { page: state.currentPage, selector, direction: 'down' }; label = 'Moving down…'; }
  else if (kind === 'undo')    { url = '/__cms/api/undo';           body = { page: state.currentPage };           label = 'Undoing…'; }
  else return;

  toast(label, 'info');
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || (kind + ' failed'));

    // Friendly success toasts per kind
    if (kind === 'clone') {
      toast(`Cloned · new id: #${j.newId}`, 'success');
      if (j.formInside) {
        toast('Note: the cloned section contains a form — JS hooks won\'t fire on the copy until rewired.', 'info');
      }
    } else if (kind === 'delete') {
      toast(j.removedId ? `Deleted #${j.removedId}` : 'Deleted section', 'success');
    } else if (kind === 'move-up' || kind === 'move-down') {
      toast(`Moved ${kind === 'move-up' ? 'up' : 'down'}` + (j.movedId ? ` · #${j.movedId}` : ''), 'success');
    } else if (kind === 'undo') {
      toast(`Undone (${j.action || 'last action'})`, 'success');
    }

    // Refresh preview + fields + sections + undo state
    state.undoAvailable = !!j.undoAvailable;
    refreshFromServer();
  } catch (err) {
    toast(`${kind} error: ${err.message}`, 'error');
  }
}

// Reload the preview iframe + re-fetch fields & sections.
// Used after every structural action.
function refreshFromServer() {
  if (!state.currentPage) return;
  const url = '/' + state.currentPage;
  $('#preview').src = 'about:blank';
  setTimeout(() => { $('#preview').src = url; }, 50);
  setTimeout(async () => {
    try {
      const r2 = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(state.currentPage));
      state.fields = r2.fields || [];
      state.sections = r2.sections || [];
      // Also refresh undo state in case the server's record drifted
      const u = await fetchJson('/__cms/api/undo-state?page=' + encodeURIComponent(state.currentPage));
      state.undoAvailable = !!u.undoAvailable;
      renderFields(state.fields);
    } catch (e) { /* swallow — toast already shown by caller */ }
  }, 80);
}

function renderField(f) {
  const cur = currentValue(f);
  if (f.type === 'image') {
    const altCur = state.changedAlt.has(f.id) ? state.changedAlt.get(f.id) : (f.alt || '');
    const isDirty = state.changed.has(f.id) || state.changedAlt.has(f.id) || state.pendingImages.has(f.id);
    return `<div class="field${isDirty ? ' changed' : ''}" data-fid="${escAttr(f.id)}" data-type="image">
      <label>${escHtml(f.label)}</label>
      <div class="img-row">
        <img class="thumb" data-thumb="${escAttr(f.id)}" src="${escAttr(thumbUrl(f, cur))}" alt=""
             onerror="this.style.opacity=.25;this.title='couldn\\'t load image'">
        <div class="thumb-meta">
          <div class="img-input-row">
            <span class="img-input-label">URL</span>
            <input class="img-url-input" data-img-url-id="${escAttr(f.id)}" type="text"
                   value="${escAttr(cur)}" placeholder="paste a URL or local path">
          </div>
          ${f.altAttr ? `<div class="img-input-row">
            <span class="img-input-label">Alt</span>
            <input class="alt-input" data-alt-id="${escAttr(f.id)}" type="text"
                   placeholder="alt text" value="${escAttr(altCur)}">
          </div>` : ''}
          <div class="img-actions">
            <button class="btn small replace-img" data-fid="${escAttr(f.id)}" title="Upload a new file and crop">📁 Replace file…</button>
            <button class="btn small crop-img" data-fid="${escAttr(f.id)}" title="Crop the current image without replacing">✂ Crop</button>
            <button class="btn small reset-img" data-fid="${escAttr(f.id)}" ${isDirty ? '' : 'disabled'} title="Discard local changes to this field">↻ Reset</button>
          </div>
        </div>
      </div>
    </div>`;
  }
  if (f.type === 'longtext') {
    const { label, hint } = friendlyLabelFor(f);
    const tooltip = f.label || '';
    const hintHtml = hint ? `<div class="field-hint" title="${escAttr(tooltip)}">${escHtml(hint)}</div>` : '';
    return `<div class="field" data-fid="${escAttr(f.id)}" title="${escAttr(tooltip)}">
      <label>${escHtml(label)}</label>
      <textarea data-input-id="${escAttr(f.id)}" rows="3">${escHtml(cur)}</textarea>
      ${hintHtml}
    </div>`;
  }
  return `<div class="field" data-fid="${escAttr(f.id)}">
    <label>${escHtml(f.label)}</label>
    <input type="text" data-input-id="${escAttr(f.id)}" value="${escAttr(cur)}">
  </div>`;
}

// A4 — Tag → friendly label map for Headings + Body text fields.
const TAG_LABELS = {
  h1: 'Heading 1',
  h2: 'Heading 2',
  h3: 'Heading 3',
  h4: 'Heading 4',
  p: 'Paragraph',
  li: 'List item',
  blockquote: 'Quote',
  figcaption: 'Caption',
  dt: 'Term',
  dd: 'Description',
};

/**
 * Build the friendly two-line label for a Heading / Body-text field:
 *   { label: "Heading 1", hint: "in hero-content" }
 *
 * Falls back to the legacy long label if the field has no `tag` property
 * (e.g. SEO meta, JSON-LD schema fields — those aren't reformatted).
 */
function friendlyLabelFor(f) {
  if (!f.tag) return { label: f.label || '', hint: '' };
  const label = TAG_LABELS[f.tag] || f.tag;
  const ctx = (f.context || '').replace(/[-_]+/g, ' ').trim();
  const hint = ctx ? 'in ' + ctx : '';
  return { label, hint };
}

function wireFieldEvents() {
  document.querySelectorAll('[data-input-id]').forEach(el => {
    el.addEventListener('input', (e) => {
      const id = el.dataset.inputId;
      state.changed.set(id, e.target.value);
      el.closest('.field').classList.add('changed');
      setStatus('● unsaved', 'dirty');
      refreshSaveBtn();
      if (window.cmsDrafts) window.cmsDrafts.persist();
    });
  });
  document.querySelectorAll('[data-alt-id]').forEach(el => {
    el.addEventListener('input', (e) => {
      const id = el.dataset.altId;
      state.changedAlt.set(id, e.target.value);
      el.closest('.field').classList.add('changed');
      setStatus('● unsaved', 'dirty');
      refreshSaveBtn();
      enableResetBtn(id);
      if (window.cmsDrafts) window.cmsDrafts.persist();
    });
  });
  // URL text input on image fields — live edit with thumb preview
  document.querySelectorAll('[data-img-url-id]').forEach(el => {
    el.addEventListener('input', (e) => {
      const id = el.dataset.imgUrlId;
      const v = e.target.value;
      state.changed.set(id, v);
      // Editing the URL clears any pending cropped blob (it's no longer the source-of-truth)
      if (state.pendingImages.has(id)) state.pendingImages.delete(id);
      const f = state.fields.find(x => x.id === id);
      const thumb = document.querySelector(`[data-thumb="${cssEscape(id)}"]`);
      if (thumb && f) {
        thumb.style.opacity = '';
        thumb.title = '';
        thumb.src = thumbUrl(f, v);
      }
      el.closest('.field').classList.add('changed');
      setStatus('● unsaved', 'dirty');
      refreshSaveBtn();
      enableResetBtn(id);
      if (window.cmsDrafts) window.cmsDrafts.persist();
    });
  });
  // 📁 Replace file… — existing flow (file picker + cropper)
  document.querySelectorAll('.replace-img').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.openCropperFor === 'function') {
        window.openCropperFor(btn.dataset.fid);
      }
    });
  });
  // ✂ Crop — load the current URL/path into the cropper without replacing
  document.querySelectorAll('.crop-img').forEach(btn => {
    btn.addEventListener('click', () => {
      if (typeof window.openCropperForExisting === 'function') {
        window.openCropperForExisting(btn.dataset.fid);
      }
    });
  });
  // ↻ Reset — discard pending changes for a single image field
  document.querySelectorAll('.reset-img').forEach(btn => {
    btn.addEventListener('click', () => resetImageField(btn.dataset.fid));
  });
}

function enableResetBtn(id) {
  const btn = document.querySelector(`.reset-img[data-fid="${cssEscape(id)}"]`);
  if (btn) btn.disabled = false;
}

function resetImageField(id) {
  const f = state.fields.find(x => x.id === id);
  if (!f) return;
  state.changed.delete(id);
  state.changedAlt.delete(id);
  state.pendingImages.delete(id);
  // Update DOM in place — avoid a full re-render so user doesn't lose scroll
  const fieldEl = document.querySelector(`.field[data-fid="${cssEscape(id)}"]`);
  if (!fieldEl) return;
  fieldEl.classList.remove('changed');
  const urlInput = fieldEl.querySelector('[data-img-url-id]');
  if (urlInput) urlInput.value = f.value || '';
  const altInput = fieldEl.querySelector('[data-alt-id]');
  if (altInput) altInput.value = f.alt || '';
  const thumb = fieldEl.querySelector('[data-thumb]');
  if (thumb) {
    thumb.style.opacity = '';
    thumb.title = '';
    thumb.src = thumbUrl(f, f.value);
  }
  const resetBtn = fieldEl.querySelector('.reset-img');
  if (resetBtn) resetBtn.disabled = true;
  refreshSaveBtn();
  setStatus(hasChanges() ? '● unsaved' : '', hasChanges() ? 'dirty' : 'muted');
}

function currentValue(f) {
  if (state.changed.has(f.id)) return state.changed.get(f.id);
  return f.value;
}

function thumbUrl(f, cur) {
  if (state.pendingImages.has(f.id)) {
    return URL.createObjectURL(state.pendingImages.get(f.id).blob);
  }
  if (!cur) return '';
  if (/^(https?:|data:|blob:)/.test(cur)) return cur;
  return cur.startsWith('/') ? cur : '/' + cur;
}

// Called by cropper-modal.js after a successful crop
window.applyCrop = function(fieldId, blob, destPath) {
  state.pendingImages.set(fieldId, { blob, destPath });
  state.changed.set(fieldId, destPath);
  // Update thumb + URL input in-place
  const thumb = document.querySelector(`[data-thumb="${cssEscape(fieldId)}"]`);
  const urlInput = document.querySelector(`[data-img-url-id="${cssEscape(fieldId)}"]`);
  if (thumb) {
    thumb.style.opacity = '';
    thumb.title = '';
    thumb.src = URL.createObjectURL(blob);
  }
  if (urlInput) urlInput.value = destPath;
  const fieldEl = thumb && thumb.closest('.field');
  if (fieldEl) fieldEl.classList.add('changed');
  enableResetBtn(fieldId);
  setStatus('● unsaved', 'dirty');
  refreshSaveBtn();
  if (window.cmsDrafts) window.cmsDrafts.persist();
};

// -----------------------------------------------------------------------
// Save flow
// -----------------------------------------------------------------------
function hasChanges() {
  return state.changed.size > 0 || state.changedAlt.size > 0 || state.pendingImages.size > 0;
}

function refreshSaveBtn() {
  const btn = $('#saveBtn');
  if (!btn) return;
  const dirty = hasChanges();
  btn.disabled = !dirty;
  btn.classList.remove('is-saving', 'is-saved');
  const labelEl = btn.querySelector('.save-btn-label');
  if (labelEl) labelEl.textContent = dirty ? saveButtonDirtyLabel() : 'Save';
}

function saveButtonDirtyLabel() {
  const ids = new Set([
    ...state.changed.keys(),
    ...state.changedAlt.keys(),
    ...state.pendingImages.keys(),
  ]);
  const n = ids.size;
  return n === 1 ? 'Save 1 change' : 'Save ' + n + ' changes';
}

function setSaveBtnState(phase /* 'saving' | 'saved' | 'idle' */) {
  const btn = $('#saveBtn');
  if (!btn) return;
  const labelEl = btn.querySelector('.save-btn-label');
  btn.classList.remove('is-saving', 'is-saved');
  if (phase === 'saving') {
    btn.classList.add('is-saving');
    btn.disabled = true;
    if (labelEl) labelEl.textContent = 'Saving…';
  } else if (phase === 'saved') {
    btn.classList.add('is-saved');
    btn.disabled = true;
    if (labelEl) labelEl.textContent = '✓ Saved';
    setTimeout(() => refreshSaveBtn(), 900);
  } else {
    refreshSaveBtn();
  }
}

async function save() {
  if (!state.currentPage || !hasChanges()) return;
  setSaveBtnState('saving');

  // Step 1: upload pending images
  for (const [id, { blob, destPath }] of state.pendingImages) {
    try {
      const fd = new FormData();
      fd.append('image', blob, 'crop' + extOf(destPath));
      fd.append('destPath', destPath);
      const r = await fetch('/__cms/api/upload-image', { method: 'POST', body: fd });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'upload failed');
      state.changed.set(id, j.path);
    } catch (err) {
      toast('Image upload failed: ' + err.message, 'error');
      setSaveBtnState('idle');
      return;
    }
  }

  // Step 2: build payload
  const changes = [];
  const ids = new Set([...state.changed.keys(), ...state.changedAlt.keys()]);
  for (const id of ids) {
    const f = state.fields.find(x => x.id === id);
    if (!f) continue;
    const value = state.changed.has(id) ? state.changed.get(id) : f.value;
    const out = {
      id: f.id,
      group: f.group,
      type: f.type,
      selector: f.selector,
      attr: f.attr,
      altAttr: f.altAttr || null,
      scriptIndex: f.scriptIndex !== undefined ? f.scriptIndex : null,
      arrayIndex: f.arrayIndex !== undefined ? f.arrayIndex : null,
      jsonPath: f.jsonPath || null,
      value,
    };
    if (state.changedAlt.has(id)) out.alt = state.changedAlt.get(id);
    changes.push(out);
  }

  // Compute a suggested commit message *before* clearing state
  const suggestedMessage = buildCommitMessage(state.currentPage, changes);

  // Step 3: post save
  try {
    const r = await fetch('/__cms/api/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ page: state.currentPage, changes }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'save failed');

    state.changed.clear();
    state.changedAlt.clear();
    state.pendingImages.clear();
    if (window.cmsDrafts) window.cmsDrafts.clear(state.currentPage);
    setSaveBtnState('saved');
    toast('Saved · ' + formatBytes(j.bytes), 'success');

    // Notify Git panel — handles auto-commit + state refresh
    if (window.cmsGit && typeof window.cmsGit.onAfterSave === 'function') {
      window.cmsGit.onAfterSave({ page: state.currentPage, suggestedMessage });
    }

    // Pre-fill the manual commit textarea with the suggested message
    const msgEl = document.querySelector('#gitCommitMsg');
    if (msgEl && !msgEl.value) msgEl.value = suggestedMessage;

    // Reload preview + fields
    const url = '/' + state.currentPage;
    $('#preview').src = 'about:blank';
    setTimeout(() => { $('#preview').src = url; }, 50);
    setTimeout(async () => {
      const r2 = await fetchJson('/__cms/api/fields?page=' + encodeURIComponent(state.currentPage));
      state.fields = r2.fields || [];
      renderFields(state.fields);
    }, 80);
  } catch (err) {
    toast('Save error: ' + err.message, 'error');
    setSaveBtnState('idle');
  }
}

function formatBytes(b) {
  if (typeof b !== 'number') return '';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(2) + ' MB';
}

/**
 * Build a default commit message based on what was edited.
 *   "[cms] akasa-dalhousie/index.html · 1 SEO, 2 Body text, 1 image"
 */
function buildCommitMessage(page, changes) {
  if (!changes.length) return '[cms] ' + page;
  const counts = {};
  for (const c of changes) {
    let label = c.group || 'edit';
    if (c.type === 'image') label = 'image';
    counts[label] = (counts[label] || 0) + 1;
  }
  const parts = Object.entries(counts).map(([k, v]) => v + ' ' + k);
  return '[cms] ' + page + ' · ' + parts.join(', ');
}

async function build() {
  toast('Building…', 'info');
  try {
    const r = await fetch('/__cms/api/build', { method: 'POST' });
    const j = await r.json();
    const m = j.minified ? (j.minified.ok ? 'minified ✓' : 'minify failed') : '';
    const f = j.formatted ? `${j.formatted.formatted} files formatted` : '';
    toast('Build done · ' + [m, f].filter(Boolean).join(' · '), 'success');
  } catch (err) {
    toast('Build error: ' + err.message, 'error');
  }
}

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------
/**
 * D1 — Toast notification. Shows in the bottom-right corner.
 *   toast('Saved')                 → success-tinted, auto-dismisses
 *   toast('Push failed', 'error')  → error-tinted, sticks until clicked
 *   toast('Building…', 'info')     → info-tinted
 */
function toast(msg, kind) {
  const container = $('#toastContainer');
  if (!container) return;
  // Cap to 4 visible toasts
  while (container.children.length >= 4) container.firstElementChild.remove();
  const el = document.createElement('div');
  el.className = 'toast toast-' + (kind || 'info');
  el.innerHTML = '<span class="toast-msg"></span><button class="toast-close" aria-label="Dismiss">×</button>';
  el.querySelector('.toast-msg').textContent = msg;
  el.querySelector('.toast-close').addEventListener('click', () => dismissToast(el));
  container.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-shown'));
  // Errors stick until dismissed; info/success auto-dismiss after 3 s
  if (kind !== 'error') {
    setTimeout(() => dismissToast(el), 3000);
  }
}
function dismissToast(el) {
  if (!el || !el.parentNode) return;
  el.classList.remove('is-shown');
  el.classList.add('is-hiding');
  setTimeout(() => el.remove(), 220);
}
window.cmsToast = toast; // git-panel.js + cropper-modal.js can call this

/**
 * Legacy status setter — now a thin wrapper around toast().
 * Transient states ('dirty', muted "● unsaved") are no-ops here because
 * the Save button itself now reflects dirty state (D2).
 */
function setStatus(msg, cls) {
  if (!msg) return;
  if (cls === 'ok') toast(msg, 'success');
  else if (cls === 'error') toast(msg, 'error');
  else if (cls === 'dirty') return; // visually shown by the Save button
  else if (msg.length < 24 && /^(Saving|Building|Pushing|Committing|Loading)…?$/i.test(msg)) {
    return; // suppress transient progress chatter
  } else {
    toast(msg, 'info');
  }
}

async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escAttr(s) { return escHtml(s); }
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, c => '\\' + c);
}
function extOf(p) {
  const m = String(p).match(/\.[a-zA-Z0-9]+$/);
  return m ? m[0] : '.jpg';
}

// Warn before leaving with unsaved changes
window.addEventListener('beforeunload', (e) => {
  if (hasChanges()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// Exposed for inline-edit.js Cancel-restore path
window.refreshSaveBtn = refreshSaveBtn;
window.setStatus = setStatus;
window.save = save;                 // for drafts.js refresh-dialog "Save & reload"
window.renderFields = renderFields; // for drafts.js to redraw after restore

boot();
