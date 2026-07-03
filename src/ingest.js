'use strict';

/**
 * ingest.js — server side of the browser folder-upload protocol.
 *
 *   POST /__cms/api/ingest/begin   { name, totalFiles, totalBytes, source }
 *        → { uploadId }                       (413 if over caps)
 *   POST /__cms/api/ingest/batch   multipart: files[] + uploadId + paths(JSON)
 *        → { written, skipped, bytesSoFar }
 *   POST /__cms/api/ingest/finish  { uploadId, manifest:[{path,size}] }
 *        → { ok, missing } | { ok, id, name, pageCount, warnings }
 *   POST /__cms/api/ingest/abort   { uploadId }
 *
 * Files are streamed into a staging dir under the workspace parent; finish
 * atomically renames staging → the active workspace. Nothing is promoted until
 * finish confirms every manifest file arrived, so an abandoned upload never
 * corrupts an active workspace.
 */

const fs = require('fs');
const path = require('path');
const multer = require('multer');

const workspace = require('./workspace');
const { resolveInRoot } = require('./safe-path');
const { listPages } = require('./discovery');

const MAX_FILES = 5000;
const MAX_BYTES = 500 * 1024 * 1024;   // 500 MB
const PER_FILE_BYTES = 25 * 1024 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000; // 30-min idle

// Directories/files rejected at ingest (defence-in-depth mirror of the client
// filter). NOTE: dist/build are intentionally NOT skipped — a user may legitly
// drop a folder named build; discovery hides it from the page list anyway.
const SKIP_DIRS = new Set(['node_modules', '.git', '_minified', '_formatted', '.vscode', '.idea']);
const SKIP_FILES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);

// Dedicated multer instance — NOT the 25 MB single-image one. Caps file count
// per request and field size so a batch can't blow up RAM.
const ingestUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PER_FILE_BYTES, files: 64, fieldSize: 2 * 1024 * 1024 },
});

// uploadId → { stagingDir, received: Map<relPath,size>, name, createdAt, lastAccess }
const sessions = new Map();

let sweeper = null;
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) {
      if (now - s.lastAccess > SESSION_TTL_MS) {
        try { fs.rmSync(s.stagingDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
        sessions.delete(id);
      }
    }
  }, 10 * 60 * 1000);
  if (typeof sweeper.unref === 'function') sweeper.unref();
}

// A relative path is skipped if any segment is a dotfile/dir, a skip-dir, or a
// skip-file basename. Returns a reason string or null.
function skipReason(rel) {
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (!seg) continue;
    if (seg.startsWith('.')) return 'dot-entry';
    if (i < segs.length - 1 && SKIP_DIRS.has(seg)) return 'skip-dir';
  }
  const base = segs[segs.length - 1];
  if (SKIP_DIRS.has(base)) return 'skip-dir';
  if (SKIP_FILES.has(base)) return 'skip-file';
  return null;
}

// -------------------------------------------------------------------------
//   Handlers
// -------------------------------------------------------------------------

function begin(req, res) {
  ensureSweeper();
  const { name, totalFiles, totalBytes } = req.body || {};
  const nFiles = parseInt(totalFiles, 10) || 0;
  const nBytes = parseInt(totalBytes, 10) || 0;
  if (nFiles > MAX_FILES) {
    return res.status(413).json({ error: 'too many files (' + nFiles + ' > ' + MAX_FILES + ')', code: 'TOO_MANY_FILES', limit: MAX_FILES });
  }
  if (nBytes > MAX_BYTES) {
    return res.status(413).json({ error: 'upload too large (> 500 MB)', code: 'TOO_LARGE', limit: MAX_BYTES });
  }

  const uploadId = workspace.mintId();
  const stagingDir = workspace.stagingPath(uploadId);
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });
  } catch (e) {
    return res.status(500).json({ error: 'could not create staging dir: ' + e.message });
  }
  sessions.set(uploadId, {
    stagingDir,
    received: new Map(),
    name: (name || 'site').toString(),
    createdAt: Date.now(),
    lastAccess: Date.now(),
  });
  res.json({ ok: true, uploadId });
}

function batch(req, res) {
  const uploadId = req.body && req.body.uploadId;
  const session = uploadId && sessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'unknown or expired upload session', code: 'NO_SESSION' });
  }
  session.lastAccess = Date.now();

  let paths;
  try { paths = JSON.parse(req.body.paths || '[]'); }
  catch (e) { return res.status(400).json({ error: 'paths is not valid JSON' }); }

  const files = req.files || [];
  if (!Array.isArray(paths) || paths.length !== files.length) {
    return res.status(400).json({ error: 'paths length (' + (paths || []).length + ') != files length (' + files.length + ')' });
  }

  const skipped = [];
  let written = 0;
  for (let i = 0; i < files.length; i++) {
    const rel = String(paths[i] || '');
    const reason = skipReason(rel);
    if (reason) { skipped.push({ path: rel, reason }); continue; }
    let abs;
    try { abs = resolveInRoot(session.stagingDir, rel); }
    catch (e) { skipped.push({ path: rel, reason: 'unsafe-path' }); continue; }
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, files[i].buffer);
      session.received.set(rel, files[i].buffer.length);
      written++;
    } catch (e) {
      skipped.push({ path: rel, reason: 'write-error: ' + e.message });
    }
  }

  // Keep the staging dir's mtime fresh so the workspace TTL sweeper (which reaps
  // ws-*-staging by directory mtime after 1h) never deletes an active upload
  // whose bytes are streaming into subdirectories.
  try { const t = new Date(); fs.utimesSync(session.stagingDir, t, t); } catch (e) { /* ignore */ }

  let bytesSoFar = 0;
  for (const v of session.received.values()) bytesSoFar += v;

  // Enforce the real caps against actual received data — begin() only checked
  // the client-declared totals, which a buggy/hostile client can under-report.
  if (session.received.size > MAX_FILES || bytesSoFar > MAX_BYTES) {
    try { fs.rmSync(session.stagingDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    sessions.delete(uploadId);
    return res.status(413).json({ error: 'upload exceeded caps (files/bytes)', code: 'CAP_EXCEEDED' });
  }

  res.json({ ok: true, written, skipped, bytesSoFar });
}

async function finish(req, res) {
  const { uploadId, manifest } = req.body || {};
  const session = uploadId && sessions.get(uploadId);
  if (!session) {
    return res.status(404).json({ error: 'unknown or expired upload session', code: 'NO_SESSION' });
  }
  session.lastAccess = Date.now();

  const expected = Array.isArray(manifest) ? manifest : [];
  const missing = [];
  for (const m of expected) {
    const p = m && m.path;
    if (p && !session.received.has(p)) missing.push(p);
  }
  if (missing.length) {
    return res.status(409).json({ ok: false, missing, code: 'INCOMPLETE' });
  }

  // Promote: atomic rename staging → final workspace dir.
  const finalDir = workspace.workspacePath(uploadId);
  try {
    fs.rmSync(finalDir, { recursive: true, force: true });
    fs.renameSync(session.stagingDir, finalDir);
  } catch (e) {
    return res.status(500).json({ error: 'could not finalize workspace: ' + e.message });
  }
  sessions.delete(uploadId);

  const warnings = [];
  let pageCount = 0;
  try {
    const pages = await listPages(finalDir);
    pageCount = pages.length;
  } catch (e) { /* pageCount stays 0 */ }
  if (pageCount === 0) warnings.push('No editable HTML pages were detected in this folder.');

  const probe = path.join(finalDir, 'index.html');
  if (fs.existsSync(probe) && looksMinified(probe)) {
    warnings.push('index.html looks minified — you may have uploaded a build output rather than source.');
  }

  const info = workspace.activate({ root: finalDir, id: uploadId, name: session.name });
  res.json({ ok: true, id: info.id, name: info.name, pageCount, warnings });
}

function abort(req, res) {
  const uploadId = req.body && req.body.uploadId;
  const session = uploadId && sessions.get(uploadId);
  if (session) {
    try { fs.rmSync(session.stagingDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    sessions.delete(uploadId);
  }
  res.json({ ok: true });
}

// Shared with bin/cli.js — a single huge line is almost certainly a build
// output, not editable source.
function looksMinified(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    return lines.length < 5 && content.length > 5000;
  } catch (e) { return false; }
}

module.exports = { ingestUpload, begin, batch, finish, abort, looksMinified };
