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

function safePath(siteRoot, rel) {
  const abs = path.resolve(siteRoot, rel.replace(/^\/+/, ''));
  if (!abs.startsWith(path.resolve(siteRoot))) {
    throw new Error('Path escapes site root: ' + rel);
  }
  return abs;
}

function startServer(siteRoot, port) {
  const app = express();
  app.use(express.json({ limit: '20mb' }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 }
  });

  // ---------------------------------------------------------------
  // Editor frontend at /__cms/
  // ---------------------------------------------------------------
  app.use('/__cms', express.static(path.join(__dirname, 'editor')));

  // ---------------------------------------------------------------
  // API at /__cms/api/
  // ---------------------------------------------------------------

  // List all editable HTML pages in the site
  app.get('/__cms/api/pages', async (req, res) => {
    try {
      const pages = await listPages(siteRoot);
      res.json({ pages, root: siteRoot });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Extract editable fields from a single page
  app.get('/__cms/api/fields', async (req, res) => {
    try {
      const page = req.query.page;
      if (!page) return res.status(400).json({ error: 'missing page' });
      const filePath = safePath(siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });
      const html = fs.readFileSync(filePath, 'utf8');
      const fields = extractFields(html, page);
      const sections = extractSections(html);
      res.json({ page, fields, sections });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Apply changes back to source HTML
  app.post('/__cms/api/save', async (req, res) => {
    try {
      const { page, changes } = req.body || {};
      if (!page || !Array.isArray(changes)) {
        return res.status(400).json({ error: 'invalid payload' });
      }
      const filePath = safePath(siteRoot, page);
      const html = fs.readFileSync(filePath, 'utf8');
      const updated = await applyChanges(html, changes);
      fs.writeFileSync(filePath, updated);
      res.json({ ok: true, bytes: Buffer.byteLength(updated) });
    } catch (err) {
      console.error('[save error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Proxy an external image so the browser can read its pixels into a canvas.
  // Used by the cropper for "Crop existing" on a remote URL.
  app.get('/__cms/api/image-proxy', (req, res) => imageProxy(req, res));

  // Image upload (post-cropper). Body: multipart with 'image' file + 'destPath' string.
  app.post('/__cms/api/upload-image', upload.single('image'), async (req, res) => {
    try {
      const destPath = (req.body && req.body.destPath) || '';
      if (!destPath || !req.file) {
        return res.status(400).json({ error: 'missing destPath or image' });
      }
      const result = await handleImageUpload(siteRoot, destPath, req.file.buffer);
      res.json(result);
    } catch (err) {
      console.error('[upload error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---- Section ops: clone / delete / move / undo ------------------------
  // All four push the pre-write HTML onto a per-page in-memory stack so the
  // user gets a one-click Undo per page.

  // Clone a <section> direct child of <main>. Body: { page, selector }.
  app.post('/__cms/api/clone-section', async (req, res) => {
    try {
      const { page, selector } = req.body || {};
      if (!page || !selector) return res.status(400).json({ error: 'missing page or selector' });
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = safePath(siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const formInside = sectionOps.subtreeContainsForm(html, selector);
      const result = cloneSection(html, selector);

      sectionOps.pushHistory(page, html, 'clone');                         // history snapshot
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);

      res.json({
        ok: true,
        newId: result.newId,
        suffix: result.suffix,
        originalId: result.originalId,
        formInside,                                                        // → frontend warns
        sections: extractSections(pretty),
        undoAvailable: sectionOps.historyDepth(page) > 0,
      });
    } catch (err) {
      console.error('[clone-section error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Delete a <section> direct child of <main>. Body: { page, selector }.
  app.post('/__cms/api/delete-section', async (req, res) => {
    try {
      const { page, selector } = req.body || {};
      if (!page || !selector) return res.status(400).json({ error: 'missing page or selector' });
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = safePath(siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const result = sectionOps.deleteSection(html, selector);

      sectionOps.pushHistory(page, html, 'delete');
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);

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

  // Move a <section> up or down among its <section> siblings.
  // Body: { page, selector, direction: 'up' | 'down' }.
  app.post('/__cms/api/move-section', async (req, res) => {
    try {
      const { page, selector, direction } = req.body || {};
      if (!page || !selector || !direction) {
        return res.status(400).json({ error: 'missing page, selector, or direction' });
      }
      if (!SECTION_SELECTOR_RE.test(selector)) {
        return res.status(400).json({ error: 'selector must target a <section> directly under <main>' });
      }
      const filePath = safePath(siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const html = fs.readFileSync(filePath, 'utf8');
      const result = sectionOps.moveSection(html, selector, direction);

      sectionOps.pushHistory(page, html, 'move-' + direction);
      const pretty = beautify(result.html, BEAUTIFY_OPTS);
      fs.writeFileSync(filePath, pretty);

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

  // Undo the most recent clone / delete / move on this page.
  app.post('/__cms/api/undo', async (req, res) => {
    try {
      const { page } = req.body || {};
      if (!page) return res.status(400).json({ error: 'missing page' });
      const filePath = safePath(siteRoot, page);
      if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'page not found' });

      const entry = sectionOps.popHistory(page);
      if (!entry) return res.status(400).json({ error: 'nothing to undo for this page' });

      // Restore the pre-action HTML verbatim. (Already pretty-printed when pushed.)
      fs.writeFileSync(filePath, entry.html);
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

  // Lightweight state poll — used by the Sections toolbar to show/disable Undo.
  app.get('/__cms/api/undo-state', (req, res) => {
    const page = req.query.page;
    if (!page) return res.status(400).json({ error: 'missing page' });
    res.json({ undoAvailable: sectionOps.historyDepth(String(page)) > 0 });
  });

  // Run minify + format pipelines
  app.post('/__cms/api/build', async (req, res) => {
    try {
      const result = await runBuild(siteRoot);
      res.json(result);
    } catch (err) {
      console.error('[build error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ---------------------------------------------------------------
  // LLM proxy — forwards browser POST to NVIDIA's chat-completions endpoint.
  // Needed because integrate.api.nvidia.com does not send CORS headers, so a
  // browser-to-NVIDIA fetch is blocked. The API key still lives in the user's
  // localStorage; the server reads it from x-llm-key only long enough to set
  // Authorization on the forwarded request. No logging, no caching.
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
      // never include the key in error output
      console.error('[llm proxy error]', err.message);
      res.status(502).json({ error: 'upstream unreachable: ' + err.message });
    }
  });

  // ---------------------------------------------------------------
  // Git API: state / init / commit / push
  // ---------------------------------------------------------------

  app.get('/__cms/api/git/state', async (req, res) => {
    try {
      const state = await git.fullState(siteRoot);
      res.json(state);
    } catch (err) {
      console.error('[git/state error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/git/init', async (req, res) => {
    try {
      const { remote, message, userName, userEmail } = req.body || {};
      // Always init at the site root we were given
      const installed = await git.isGitInstalled();
      if (!installed) return res.status(400).json({ error: 'git is not installed on this machine' });

      const existingRoot = await git.repoRoot(siteRoot);
      if (existingRoot) {
        return res.status(400).json({ error: 'Already a git repo at ' + existingRoot });
      }

      await git.init(siteRoot, {
        remote: remote || null,
        message: message || 'Initial commit from cms-static',
        userName: userName || undefined,
        userEmail: userEmail || undefined,
      });
      const state = await git.fullState(siteRoot);
      res.json({ ok: true, state });
    } catch (err) {
      console.error('[git/init error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/git/commit', async (req, res) => {
    try {
      const { message, files } = req.body || {};
      if (!message || !message.trim()) {
        return res.status(400).json({ error: 'commit message required' });
      }
      const root = await git.repoRoot(siteRoot);
      if (!root) return res.status(400).json({ error: 'not a git repo' });
      const result = await git.commit(root, message, Array.isArray(files) ? files : null);
      const state = await git.fullState(siteRoot);
      res.json({ ok: true, result, state });
    } catch (err) {
      console.error('[git/commit error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/__cms/api/git/push', async (req, res) => {
    try {
      const root = await git.repoRoot(siteRoot);
      if (!root) return res.status(400).json({ error: 'not a git repo' });
      if (!(await git.hasRemote(root))) {
        return res.status(400).json({ error: 'no remote configured (origin)' });
      }
      const result = await git.push(root);
      const state = await git.fullState(siteRoot);
      res.json({ ok: true, result, state });
    } catch (err) {
      console.error('[git/push error]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Redirect bare / to the editor (must come BEFORE static, otherwise
  // static will serve siteRoot/index.html instead).
  app.get('/', (req, res) => res.redirect('/__cms/'));

  // ---------------------------------------------------------------
  // Static serve everything else from the site root
  // (so /index.html, /images/..., /styles.css all work natively)
  // ---------------------------------------------------------------
  app.use(express.static(siteRoot, {
    extensions: ['html'],
    setHeaders(res) {
      // disable caching so edits show immediately
      res.setHeader('Cache-Control', 'no-store');
    }
  }));

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => resolve(port));
    server.on('error', reject);
  });
}

module.exports = { startServer };
