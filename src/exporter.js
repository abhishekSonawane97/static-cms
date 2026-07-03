'use strict';

/**
 * exporter.js — stream a workspace variant to the browser as a .zip download.
 *
 * archiver (streaming) is used deliberately: adm-zip buffers the whole archive
 * in RAM and blocks the event loop (a 200 MB site → 400 MB+ sync spike); the
 * system `zip` CLI is non-portable and gives no control over the internal root
 * folder name. archiver keeps RSS flat and lets us name every entry.
 *
 * Variants map to a directory:
 *   source    → the workspace root itself (SKIP-filtered)
 *   minified  → <root>/_minified
 *   formatted → <root>/_formatted
 *
 * The server route decides whether to (re)build before calling this.
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const { SKIP, skipFile } = require('./builder');

// Already-compressed payloads: store (no deflate) — pointless CPU otherwise,
// and hotel sites are mostly images.
const STORE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.ico',
  '.mp4', '.webm', '.mov',
  '.woff', '.woff2', '.ttf', '.otf',
  '.pdf', '.zip', '.gz',
]);

const VARIANTS = {
  source: { sub: '', suffix: '' },       // source zip root = plain <siteName>/ so it re-drops cleanly
  minified: { sub: '_minified', suffix: '-minified' },
  formatted: { sub: '_formatted', suffix: '-formatted' },
};

function isVariant(v) {
  return Object.prototype.hasOwnProperty.call(VARIANTS, v);
}

function sanitizeName(name) {
  const s = String(name || 'site').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return s || 'site';
}

/**
 * Stream a zip of `variant` to `res`. Returns a promise that resolves when the
 * archive has been finalized (or rejects on a pre-stream error).
 */
function streamExport(siteRoot, variant, siteName, res) {
  return new Promise((resolve, reject) => {
    if (!isVariant(variant)) {
      res.status(400).json({ error: 'unknown variant: ' + variant });
      return resolve();
    }
    const cfg = VARIANTS[variant];
    const srcDir = cfg.sub ? path.join(siteRoot, cfg.sub) : siteRoot;
    if (!fs.existsSync(srcDir)) {
      res.status(409).json({ error: 'nothing to export for variant "' + variant + '" — run Build first', code: 'NOT_BUILT' });
      return resolve();
    }

    const clean = sanitizeName(siteName);
    const rootFolder = clean + cfg.suffix;         // e.g. kavinhotels-minified
    const fileName = rootFolder + '.zip';

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Cache-Control', 'no-store');
    // ASCII filename plus RFC 5987 filename* for non-ASCII site names.
    res.setHeader(
      'Content-Disposition',
      'attachment; filename="' + fileName + '"; filename*=UTF-8\'\'' + encodeURIComponent(fileName)
    );

    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };

    archive.on('error', (err) => {
      if (!res.headersSent) res.status(500).json({ error: err.message });
      try { res.destroy(); } catch (e) { /* ignore */ }
      done(reject, err);
    });
    archive.on('warning', (err) => { /* ENOENT for a file removed mid-walk — non-fatal */ });

    // If the client aborts the download, stop the walk so it doesn't leak.
    res.on('close', () => {
      if (!settled) { try { archive.abort(); } catch (e) { /* ignore */ } }
    });

    archive.pipe(res);

    // Manual SKIP-aware walk so a source export can never ship node_modules /
    // _minified / _formatted / .git etc.
    addDir(archive, srcDir, '', rootFolder);

    archive.finalize().then(() => done(resolve)).catch((err) => done(reject, err));
  });
}

function addDir(archive, root, rel, rootFolder) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    const abs = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;             // never follow / archive symlinks
    if (e.isDirectory()) {
      addDir(archive, root, r, rootFolder);
    } else if (e.isFile() && !skipFile(e.name)) {
      const ext = path.extname(e.name).toLowerCase();
      archive.file(abs, { name: rootFolder + '/' + r, store: STORE_EXT.has(ext) });
    }
  }
}

module.exports = { streamExport, isVariant, sanitizeName };
