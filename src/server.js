'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { listPages } = require('./discovery');
const { extractFields, extractSections } = require('./extractor');
const { applyChanges } = require('./applier');
const { handleImageUpload } = require('./image');
const { runBuild } = require('./builder');
const { imageProxy } = require('./image-proxy');
const { cloneSection } = require('./cloner');
const sectionOps = require('./section-ops');
const beautify = require('js-beautify').html;
const git = require('./git');
const workspace = require('./workspace');
const ingest = require('./ingest');
const { streamExport, isVariant } = require('./exporter');
const { resolveInRoot } = require('./safe-path');

// Shared js-beautify settings for any HTML write through this module
const BEAUTIFY_OPTS = {
  indent_size: 2,
  indent_inner_html: false,
  wrap_attributes: 'auto',
  end_with_newline: true,
  preserve_newlines: false,
  max_preserve_newlines: 1,
  extra_liners: [],
  inline: ['em', 'strong', 'b', 'i', 'u', 'span', 'a', 'small', 'code', 'sub', 'sup', 'br'],
};

// Reusable selector regex for "<section> direct child of <main>"
const SECTION_SELECTOR_RE =
  /^body\s*>\s*main(?:#[\w-]+)?\s*>\s*section(?:#[\w-]+|:nth-of-type\(\d+\))?$/;

/**
 * startServer(port, { initialRoot, initialName })
 *   - initialRoot present  → classic mode: pin that folder as the workspace.
 *   - initialRoot absent    → drop mode: no workspace until the browser uploads one.
 */
function startServer(port, opts = {}) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  workspace.initLifecycle();
  if (opts.initialRoot) {
    workspace.pin(opts.initialRoot, opts.initialName);
  }

  // Export dirty-tracking (O(1), no mtime scans). All mutations flow through the
  // handlers below, so bumping these there is sufficient.
  let lastMutationAt = 0;
  let lastBuildAt = 0;
  let builtForId = null;
  const bumpMutation = () => { lastMutationAt = Date.now(); workspace.touch(); };

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });

  // ---------------------------------------------------------------
  // Editor frontend at /__cms/ (root-independent — must work with no workspace)
  // ---------------------------------------------------------------
  app.use('/__cms', express.static(path.join(__dirname, 'editor')));

  // ---------------------------------------------------------------
  // Workspace guard — 409 { code:'NO_WORKSPACE' } until a site is loaded.
  // Freezes the root per-request so a mid-request swap can't mix two roots.
  // ---------------------------------------------------------------
  function requireWorkspace(req, res, next) {
    const root = workspace.getRoot();
    if (!root) {
      return res.status(409).json({ error: 'No workspace loaded. Upload a site folder first.', code: 'NO_WORKSPACE' });
    }
    req.siteRoot = root;
    next();
  }

  // ---------------------------------------------------------------
  // Workspace status / reset
  // ---------------------------------------------------------------
  app.get('/__cms/api/workspace', async (req, res) => {
    const info = workspace.getInfo();
    let pageCount = 0;
    if (info.loaded) {
      try { pageCount = (await listPages(workspace.getRoot())).length; } catch (e) { /* 0 */ }
    }
    res.json({ ...info, pageCount });
  });

  app.delete('/__cms/api/workspace', (req, res) => {
    workspace.discard();
    lastMutationAt = 0; lastBuildAt = 0; builtForId = null;
    res.json({ ok: true, loaded: false });
  });

  // ---------------------------------------------------------------
  // Folder ingestion (drop mode). No workspace guard — this is how one is made.
  // ---------------------------------------------------------------
  app.post('/__cms/api/ingest/begin', ingest.begin);
  app.post('/__cms/api/ingest/batch', ingest.ingestUpload.array('files', 64), ingest.batch);
  app.post('/__cms/api/ingest/finish', ingest.finish);
  app.post('/__cms/api/ingest/abort', ingest.abort);

  // ---------------------------------------------------------------
  // API at /__cms/api/  (all workspace-guarded unless noted)
  // ---------------------------------------------------------------

  app.get('/__cms/api/pages', requireWorkspace, async (req, res) => {
    try {
      const pages = await listPages(req.siteRoot);
      res.json({ pages, workspace: workspace.getInfo() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/__cms/api/fields', requireWorkspace, async (req, res) => {
    try {
      const page = req.query.page;
      if (!page) return res.status(400).json({ error: 'missing page' });
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });
      const html = fs.readFileSync(filePath, 'utf8');
      const fields = extractFields(html, page);
      const sections = extractSections(html);
      res.json({ page, fields, sections });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/save', requireWorkspace, async (req, res) => {
    try {
      const { page, changes } = req.body || {};
      if (!page || !Array.isArray(changes)) {
        return res.status(400).json({ error: 'invalid payload' });
      }
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });
      const html = fs.readFileSync(filePath, 'utf8');
      const updated = await applyChanges(html, changes);
      fs.writeFileSync(filePath, updated);
      bumpMutation();
      res.json({ ok: true, bytes: Buffer.byteLength(updated) });
    } catch (err) {
      console.error('[save error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Proxy an external image so the browser can read its pixels into a canvas.
  // No workspace needed — it only touches an external URL.
  app.get('/__cms/api/image-proxy', (req, res) => imageProxy(req, res));

  // Image upload (post-cropper). Body: multipart with 'image' file + 'destPath'.
  app.post('/__cms/api/upload-image', requireWorkspace, upload.single('image'), async (req, res) => {
    try {
      const destPath = (req.body && req.body.destPath) || '';
      if (!destPath || !req.file) {
        return res.status(400).json({ error: 'missing destPath or image' });
      }
      const result = await handleImageUpload(req.siteRoot, destPath, req.file.buffer);
      bumpMutation();
      res.json(result);
    } catch (err) {
      console.error('[upload error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Section ops: clone / delete / move / undo ------------------------

  app.post('/__cms/api/clone-section', requireWorkspace, async (req, res) => {
    try {
      const { page, selector } = req.body || {};
      if (!page || !selector) return res.status(400).json({ error: 'missing page or selector' });
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const formInside = sectionOps.subtreeContainsForm(html, selector);
      const result = cloneSection(html, selector);

      sectionOps.pushHistory(page, html, 'clone');
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);
      bumpMutation();

      res.json({
        ok: true,
        newId: result.newId,
        suffix: result.suffix,
        originalId: result.originalId,
        formInside,
        sections: extractSections(pretty),
        undoAvailable: sectionOps.historyDepth(page) > 0,
      });
    } catch (err) {
      console.error('[clone-section error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/delete-section', requireWorkspace, async (req, res) => {
    try {
      const { page, selector } = req.body || {};
      if (!page || !selector) return res.status(400).json({ error: 'missing page or selector' });
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const result = sectionOps.deleteSection(html, selector);

      sectionOps.pushHistory(page, html, 'delete');
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);
      bumpMutation();

      res.json({
        ok: true,
        removedId: result.removedId,
        sections: extractSections(pretty),
        undoAvailable: sectionOps.historyDepth(page) > 0,
      });
    } catch (err) {
      console.error('[delete-section error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/move-section', requireWorkspace, async (req, res) => {
    try {
      const { page, selector, direction } = req.body || {};
      if (!page || !selector || !direction) {
        return res.status(400).json({ error: 'missing page, selector, or direction' });
      }
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const result = sectionOps.moveSection(html, selector, direction);

      sectionOps.pushHistory(page, html, 'move-' + direction);
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);
      bumpMutation();

      res.json({
        ok: true,
        movedId: result.movedId,
        sections: extractSections(pretty),
        undoAvailable: sectionOps.historyDepth(page) > 0,
      });
    } catch (err) {
      console.error('[move-section error]', err);
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/__cms/api/undo', requireWorkspace, async (req, res) => {
    try {
      const { page } = req.body || {};
      if (!page) return res.status(400).json({ error: 'missing page' });
      const filePath = resolveInRoot(req.siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const entry = sectionOps.popHistory(page);
      if (!entry) return res.status(400).json({ error: 'nothing to undo for this page' });

      fs.writeFileSync(filePath, entry.html);
      bumpMutation();
      res.json({
        ok: true,
        action: entry.action,
        sections: extractSections(entry.html),
        undoAvailable: sectionOps.historyDepth(page) > 0,
      });
    } catch (err) {
      console.error('[undo error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/__cms/api/undo-state', requireWorkspace, (req, res) => {
    const page = req.query.page;
    if (!page) return res.status(400).json({ error: 'missing page' });
    res.json({ undoAvailable: sectionOps.historyDepth(String(page)) > 0 });
  });

  // Run minify + format pipelines
  app.post('/__cms/api/build', requireWorkspace, async (req, res) => {
    try {
      const result = await runBuild(req.siteRoot);
      lastBuildAt = Date.now();
      builtForId = workspace.getInfo().id;
      workspace.touch();
      res.json(result);
    } catch (err) {
      console.error('[build error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // Export — stream a variant as a .zip. Auto-builds when stale.
  // ---------------------------------------------------------------
  app.get('/__cms/api/export', requireWorkspace, async (req, res) => {
    try {
      const variant = (req.query.variant || 'minified').toString();
      if (!isVariant(variant)) return res.status(400).json({ error: 'unknown variant: ' + variant });

      if (variant === 'minified' || variant === 'formatted') {
        const outDir = path.join(req.siteRoot, '_' + variant);
        const currentId = workspace.getInfo().id;
        const stale = builtForId !== currentId || lastMutationAt > lastBuildAt;
        if (stale || !fs.existsSync(outDir)) {
          await runBuild(req.siteRoot);
          lastBuildAt = Date.now();
          builtForId = currentId;
        }
      }
      const name = workspace.getInfo().name || path.basename(req.siteRoot);
      await streamExport(req.siteRoot, variant, name, res);
    } catch (err) {
      console.error('[export error]', err);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // LLM proxy — forwards browser POST to NVIDIA's chat-completions endpoint.
  // No workspace needed.
  // ---------------------------------------------------------------
  const LLM_UPSTREAM = 'https://integrate.api.nvidia.com/v1/chat/completions';

  app.post('/__cms/api/llm', async (req, res) => {
    const key = req.get('x-llm-key');
    if (!key) return res.status(400).json({ error: 'missing x-llm-key header' });

    try {
      const upstream = await fetch(LLM_UPSTREAM, {
        method: 'POST',
        headers: {
          'authorization': 'Bearer ' + key,
          'content-type': 'application/json',
          'accept': 'application/json',
        },
        body: JSON.stringify(req.body || {}),
      });
      const text = await upstream.text();
      res.status(upstream.status)
         .set('content-type', upstream.headers.get('content-type') || 'application/json')
         .send(text);
    } catch (err) {
      console.error('[llm proxy error]', err.message);
      res.status(502).json({ error: 'upstream unreachable: ' + err.message });
    }
  });

  // ---------------------------------------------------------------
  // Git API — classic mode only. In drop mode the workspace is an ephemeral
  // temp dir, so versioning it is meaningless AND git rev-parse could climb
  // into an enclosing repo. requireClassicGit blocks it defensively.
  // ---------------------------------------------------------------
  function requireClassicGit(req, res, next) {
    const root = workspace.getRoot();
    if (!root) return res.status(409).json({ error: 'No workspace loaded.', code: 'NO_WORKSPACE' });
    if (workspace.getInfo().mode !== 'classic') {
      return res.status(400).json({ error: 'Git is disabled for uploaded folders.', code: 'GIT_DISABLED' });
    }
    req.siteRoot = root;
    next();
  }

  // Reject git actions when the repo toplevel is not the workspace itself
  // (prevents committing/pushing an enclosing ancestor repo).
  async function assertRepoIsWorkspace(root) {
    const top = await git.repoRoot(root);
    if (!top) return; // not a repo yet (init handles that)
    if (path.resolve(top) !== path.resolve(root)) {
      const e = new Error('workspace is inside another git repo (' + top + '); refusing to operate on the enclosing repo');
      e.code = 'ANCESTOR_REPO';
      throw e;
    }
  }

  app.get('/__cms/api/git/state', requireClassicGit, async (req, res) => {
    try {
      const state = await git.fullState(req.siteRoot);
      // If the detected repo is an ancestor, don't present it as ours.
      if (state.isRepo && state.repoRoot && path.resolve(state.repoRoot) !== path.resolve(req.siteRoot)) {
        return res.json({ installed: state.installed, isRepo: false, enclosingRepo: state.repoRoot });
      }
      res.json(state);
    } catch (err) {
      console.error('[git/state error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/git/init', requireClassicGit, async (req, res) => {
    try {
      const { remote, message, userName, userEmail } = req.body || {};
      const installed = await git.isGitInstalled();
      if (!installed) return res.status(400).json({ error: 'git is not installed on this machine' });

      const existingRoot = await git.repoRoot(req.siteRoot);
      if (existingRoot) {
        return res.status(400).json({ error: 'Already a git repo at ' + existingRoot });
      }

      await git.init(req.siteRoot, {
        remote: remote || null,
        message: message || 'Initial commit from cms-static',
        userName: userName || undefined,
        userEmail: userEmail || undefined,
      });
      const state = await git.fullState(req.siteRoot);
      res.json({ ok: true, state });
    } catch (err) {
      console.error('[git/init error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/git/commit', requireClassicGit, async (req, res) => {
    try {
      const { message, files } = req.body || {};
      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'commit message required' });
      }
      await assertRepoIsWorkspace(req.siteRoot);
      const root = await git.repoRoot(req.siteRoot);
      if (!root) return res.status(400).json({ error: 'not a git repo' });
      const result = await git.commit(root, message, Array.isArray(files) ? files : null);
      const state = await git.fullState(req.siteRoot);
      res.json({ ok: true, result, state });
    } catch (err) {
      console.error('[git/commit error]', err);
      res.status(err.code === 'ANCESTOR_REPO' ? 400 : 500).json({ error: err.message, code: err.code });
    }
  });

  app.post('/__cms/api/git/push', requireClassicGit, async (req, res) => {
    try {
      await assertRepoIsWorkspace(req.siteRoot);
      const root = await git.repoRoot(req.siteRoot);
      if (!root) return res.status(400).json({ error: 'not a git repo' });
      if (!(await git.hasRemote(root))) {
        return res.status(400).json({ error: 'no remote configured (origin)' });
      }
      const result = await git.push(root);
      const state = await git.fullState(req.siteRoot);
      res.json({ ok: true, result, state });
    } catch (err) {
      console.error('[git/push error]', err);
      res.status(err.code === 'ANCESTOR_REPO' ? 400 : 500).json({ error: err.message, code: err.code });
    }
  });

  // Redirect bare / to the editor (BEFORE the dynamic static mount).
  app.get('/', (req, res) => res.redirect('/__cms/'));

  // ---------------------------------------------------------------
  // Dynamic static serve of the active workspace. express.static binds its
  // root at creation, so we memoize one instance per root string and rebuild
  // only when the workspace changes. Cache-Control: no-store neutralises
  // stale-after-swap.
  // ---------------------------------------------------------------
  let staticMw = null;
  let staticRoot = null;
  app.use((req, res, next) => {
    const root = workspace.getRoot();
    if (!root) return next();
    if (root !== staticRoot) {
      staticRoot = root;
      staticMw = express.static(root, {
        extensions: ['html'],
        setHeaders(r) { r.setHeader('Cache-Control', 'no-store'); },
      });
    }
    return staticMw(req, res, next);
  });

  // Terminal handler: no workspace / unmatched path.
  app.use((req, res) => {
    if (req.path.startsWith('/__cms/api/')) {
      return res.status(404).json({ error: 'not found' });
    }
    // A workspace IS loaded but the static mount didn't find this file → it's a
    // genuinely missing site asset. Return a real 404 so the preview iframe
    // doesn't parse editor HTML as JS/CSS. Only redirect to the editor when no
    // workspace is loaded AND this looks like a page navigation.
    if (workspace.getRoot()) {
      return res.status(404).send('Not found');
    }
    const accept = req.headers.accept || '';
    if (req.method === 'GET' && accept.includes('text/html')) {
      return res.redirect('/__cms/');
    }
    res.status(404).send('Not found');
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(port));
    server.on('error', reject);
  });
}

module.exports = { startServer };
