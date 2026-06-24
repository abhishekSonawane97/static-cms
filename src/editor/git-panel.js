/* Git panel + onboarding modal — shares state with editor.js via window.cmsState */

(function () {
  const $ = (s) => document.querySelector(s);

  const SKIP_KEY = 'cms-static.git.skipOnboarding';
  const AUTOCOMMIT_KEY = 'cms-static.git.autoCommit';
  const EXPANDED_KEY = 'cms-static.git.expanded';

  const state = {
    git: null,             // last fullState from server
    autoCommit: localStorage.getItem(AUTOCOMMIT_KEY) === '1',
    expanded: localStorage.getItem(EXPANDED_KEY) === '1',  // E1 — persisted
    pollHandle: null,
  };

  // expose for editor.js so it can call onAfterSave()
  window.cmsGit = {
    onAfterSave,
    refreshState,
    isAutoCommitOn: () => state.autoCommit,
  };

  // --------------------------------------------------------
  // Boot
  // --------------------------------------------------------
  document.addEventListener('DOMContentLoaded', init);

  async function init() {
    await refreshState();
    wireOnboardDialog();
    if (!state.git) return;

    // Decide what to show first
    if (!state.git.installed) {
      renderPanel(); // shows "git not installed" notice
      return;
    }
    if (!state.git.isRepo && localStorage.getItem(SKIP_KEY) !== '1') {
      // Auto-open the onboarding modal on first run
      openOnboardDialog();
    }
    renderPanel();
    // Light polling to keep ahead/behind fresh while user works
    state.pollHandle = setInterval(refreshState, 8000);
  }

  async function refreshState() {
    try {
      const r = await fetch('/__cms/api/git/state');
      state.git = await r.json();
    } catch (e) {
      state.git = { installed: false, error: e.message };
    }
    renderPanel();
  }

  // --------------------------------------------------------
  // Render
  // --------------------------------------------------------
  function renderPanel() {
    const el = $('#gitPanel');
    if (!el) return;
    if (!state.git) {
      el.hidden = true;
      return;
    }

    if (!state.git.installed) {
      el.hidden = false;
      el.innerHTML = `<div class="git-noinit">
        <span class="muted">⚠ Git not installed; edits won't be versioned.</span>
      </div>`;
      return;
    }

    if (!state.git.isRepo) {
      if (localStorage.getItem(SKIP_KEY) === '1') {
        el.innerHTML = `<div class="git-noinit">
          <span class="muted">Git skipped for this folder.</span>
          <button class="btn small" id="gitSetupBtn">Set up Git</button>
        </div>`;
        $('#gitSetupBtn').addEventListener('click', () => {
          localStorage.removeItem(SKIP_KEY);
          openOnboardDialog();
        });
      } else {
        el.innerHTML = `<div class="git-noinit">
          <span class="muted">Folder is not a Git repo.</span>
          <button class="btn small primary" id="gitSetupBtn">Set up Git</button>
        </div>`;
        $('#gitSetupBtn').addEventListener('click', openOnboardDialog);
      }
      el.hidden = false;
      return;
    }

    // Repo exists — render compact-by-default panel (E1).
    el.hidden = false;
    const g = state.git;

    // E2 — plain-English pill labels
    const dirtyPill = g.dirty > 0
      ? `<span class="git-pill dirty" title="Files changed but not yet committed">● ${g.dirty} unsaved file${g.dirty === 1 ? '' : 's'}</span>`
      : `<span class="git-pill" title="No uncommitted changes">✓ Up to date</span>`;
    const aheadPill = g.ahead > 0
      ? `<span class="git-pill ahead" title="Local commits not yet on the remote">↑ ${g.ahead} ready to push</span>`
      : '';
    const behindPill = g.behind > 0
      ? `<span class="git-pill behind" title="Remote has commits you don't have locally">↓ ${g.behind} update${g.behind === 1 ? '' : 's'} from team</span>`
      : '';

    // E3 — verb-first button labels with provider detection
    const provider = detectGitProvider(g.remoteUrl);
    const pushLabel = g.hasRemote ? 'Send to ' + provider : 'Send to remote';
    const commitLabel = 'Save to history';

    const remoteLabel = g.hasRemote
      ? `<span class="muted small git-remote-url" title="${escAttr(g.remoteUrl || 'origin')}">${escHtml(shortenRemote(g.remoteUrl) || 'origin')}</span>`
      : `<button class="btn small" id="gitAddRemoteBtn" title="Connect a remote URL">+ remote</button>`;

    const logHtml = (g.log || []).map(c => `
      <div class="git-log-item">
        <span class="hash">${escHtml(c.hash)}</span>
        <span class="subject" title="${escAttr(c.subject)}">${escHtml(c.subject)}</span>
        <span class="when">${escHtml(c.when)}</span>
      </div>
    `).join('');

    // Compact (always visible) section — branch + pills + commit form + push
    el.innerHTML = `
      <div class="git-row git-compact-row">
        <strong>Git</strong>
        <span class="git-pill">${escHtml(g.branch || 'detached')}</span>
        ${dirtyPill}
        ${aheadPill}
        ${behindPill}
      </div>

      <div class="git-commit-row">
        <textarea id="gitCommitMsg" rows="1" placeholder="What changed? (auto-filled after Save)"></textarea>
        <button id="gitCommitBtn" class="btn primary" ${g.dirty > 0 ? '' : 'disabled'}
                title="Stage all changed files and commit (Git: commit)">${escHtml(commitLabel)}</button>
      </div>
      <div class="git-actions-row">
        <button id="gitPushBtn" class="btn" ${g.ahead > 0 && g.hasRemote ? '' : 'disabled'}
                title="Push your committed changes to the remote (Git: push)">↑ ${escHtml(pushLabel)}</button>
        <button id="gitMoreBtn" class="btn small" title="Show more options">${state.expanded ? '▴ Less' : '▾ More'}</button>
        <button id="gitRefreshBtn" class="btn small" title="Refresh status">⟳</button>
      </div>

      <div class="git-details" ${state.expanded ? '' : 'hidden'}>
        <div class="git-row">${remoteLabel}</div>
        <label class="git-toggle-row" title="When on, every Save also commits with the auto-suggested message">
          <input type="checkbox" id="gitAutoCommit" ${state.autoCommit ? 'checked' : ''}>
          Auto-save to history on every Save
        </label>
        ${logHtml ? `<div class="git-log">${logHtml}</div>` : ''}
      </div>
    `;

    // Wire events
    $('#gitAutoCommit') && $('#gitAutoCommit').addEventListener('change', (e) => {
      state.autoCommit = e.target.checked;
      localStorage.setItem(AUTOCOMMIT_KEY, state.autoCommit ? '1' : '0');
    });
    $('#gitCommitBtn').addEventListener('click', commitNow);
    $('#gitPushBtn').addEventListener('click', pushNow);
    $('#gitRefreshBtn').addEventListener('click', refreshState);
    $('#gitMoreBtn').addEventListener('click', () => {
      state.expanded = !state.expanded;
      localStorage.setItem(EXPANDED_KEY, state.expanded ? '1' : '0');
      renderPanel();
    });
    const addRemoteBtn = $('#gitAddRemoteBtn');
    if (addRemoteBtn) addRemoteBtn.addEventListener('click', () => {
      const url = window.prompt('Remote URL (e.g. git@github.com:user/repo.git):');
      if (!url) return;
      alert('Run this in a terminal:\n\n  git -C "' + (state.git.repoRoot || '.') + '" remote add origin ' + url + '\n\nThen click ⟳ in the Git panel.');
    });
  }

  // E3 — friendly provider name from the remote URL
  function detectGitProvider(url) {
    if (!url) return 'remote';
    const u = String(url).toLowerCase();
    if (u.includes('github.com'))    return 'GitHub';
    if (u.includes('bitbucket.org')) return 'Bitbucket';
    if (u.includes('gitlab.com'))    return 'GitLab';
    if (u.includes('gitea'))         return 'Gitea';
    if (u.includes('codeberg.org'))  return 'Codeberg';
    if (u.includes('dev.azure.com')) return 'Azure DevOps';
    return 'remote';
  }

  // Show "user/repo" instead of the full SSH/HTTPS URL when possible
  function shortenRemote(url) {
    if (!url) return null;
    const m = String(url).match(/[:/]([^:/]+\/[^:/]+?)(?:\.git)?$/);
    return m ? m[1] : url;
  }

  // --------------------------------------------------------
  // Onboarding modal
  // --------------------------------------------------------
  function wireOnboardDialog() {
    const dlg = $('#gitOnboardDialog');
    const radios = dlg.querySelectorAll('input[name="onboardMode"]');
    const remoteRow = $('#onboardRemoteRow');
    radios.forEach(r => r.addEventListener('change', () => {
      remoteRow.hidden = (dlg.querySelector('input[name="onboardMode"]:checked').value !== 'remote');
    }));
    $('#onboardCancel').addEventListener('click', () => {
      dlg.close();
    });
    $('#onboardOk').addEventListener('click', onOnboardSubmit);
  }

  function openOnboardDialog() {
    const dlg = $('#gitOnboardDialog');
    $('#onboardError').textContent = '';
    dlg.showModal();
  }

  async function onOnboardSubmit() {
    const dlg = $('#gitOnboardDialog');
    const mode = dlg.querySelector('input[name="onboardMode"]:checked').value;
    const message = $('#onboardMessage').value.trim() || 'Initial commit from cms-static';
    const errEl = $('#onboardError');
    errEl.textContent = '';

    if (mode === 'skip') {
      localStorage.setItem(SKIP_KEY, '1');
      dlg.close();
      renderPanel();
      return;
    }

    let remote = null;
    if (mode === 'remote') {
      remote = ($('#onboardRemoteUrl').value || '').trim();
      if (!remote) {
        errEl.textContent = 'Remote URL is required for this option.';
        return;
      }
    }

    // Disable buttons during init
    $('#onboardOk').disabled = true;
    $('#onboardCancel').disabled = true;

    try {
      const r = await fetch('/__cms/api/git/init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ remote, message }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'init failed');
      state.git = j.state;
      dlg.close();
      renderPanel();
    } catch (err) {
      errEl.textContent = 'Init failed: ' + err.message;
    } finally {
      $('#onboardOk').disabled = false;
      $('#onboardCancel').disabled = false;
    }
  }

  // --------------------------------------------------------
  // Commit / push
  // --------------------------------------------------------
  async function commitNow() {
    const msgEl = $('#gitCommitMsg');
    const message = (msgEl.value || '').trim();
    if (!message) {
      msgEl.focus();
      msgEl.placeholder = 'Type a commit message first…';
      return;
    }
    setStatus('Committing…', '');
    try {
      const r = await fetch('/__cms/api/git/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'commit failed');
      msgEl.value = '';
      state.git = j.state;
      renderPanel();
      setStatus('Committed ✓', 'ok');
    } catch (err) {
      setStatus('Commit error: ' + err.message, 'error');
    }
  }

  async function pushNow() {
    setStatus('Pushing…', '');
    try {
      const r = await fetch('/__cms/api/git/push', { method: 'POST' });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'push failed');
      state.git = j.state;
      renderPanel();
      setStatus('Pushed ✓', 'ok');
    } catch (err) {
      setStatus('Push error: ' + err.message, 'error');
    }
  }

  // --------------------------------------------------------
  // Auto-commit hook (called by editor.js after a successful save)
  // --------------------------------------------------------
  async function onAfterSave({ page, suggestedMessage }) {
    // Refresh state regardless of auto-commit, so dirty count updates
    if (!state.autoCommit || !state.git || !state.git.isRepo) {
      await refreshState();
      return;
    }
    try {
      await fetch('/__cms/api/git/commit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: suggestedMessage }),
      });
    } catch (e) {
      // non-fatal; surface in panel via refresh
    }
    await refreshState();
  }

  // --------------------------------------------------------
  // Helpers
  // --------------------------------------------------------
  function setStatus(msg, cls) {
    const el = document.querySelector('#statusBar');
    if (!el) return;
    el.textContent = msg;
    el.className = 'status ' + (cls || 'muted');
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return escHtml(s); }
})();
