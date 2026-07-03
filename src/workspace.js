'use strict';

/**
 * workspace.js — the single active-site seam for cms-static.
 *
 * The server no longer bakes a site root into a startup closure. Instead every
 * route resolves the current root through this module. There are two modes:
 *
 *   • 'classic' — `cms-static <folder>` pins the user's own on-disk folder.
 *                 Never swept, never deleted (pinned:true).
 *   • 'drop'    — the browser uploads a folder; ingest.js stages it under
 *                 os.tmpdir()/cms-static/ and promotes it here. App-managed,
 *                 hidden, auto-wiped on exit / TTL / explicit discard.
 *
 * Only ONE workspace is active at a time (local single-user tool).
 *
 * Public API:
 *   getRoot()            → absolute path | null
 *   isLoaded()           → boolean
 *   getInfo()            → { loaded, id, name, mode, root }
 *   pin(dir, name)       → activate an existing folder in classic mode
 *   mintId()             → fresh unguessable workspace id (hex16)
 *   parentDir()          → the os-tmp parent that holds ws-* dirs
 *   stagingPath(id)      → <parent>/ws-<id>-staging
 *   workspacePath(id)    → <parent>/ws-<id>
 *   activate({root,id,name,mode}) → promote a staged dir to the active workspace
 *   touch()              → bump lastAccess on the active drop workspace
 *   discard()            → remove + deactivate the active drop workspace
 *   initLifecycle()      → start TTL sweep + wire process-exit cleanup (idempotent)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const sectionOps = require('./section-ops');

const PARENT = path.join(os.tmpdir(), 'cms-static');
const META_FILE = '.cms-workspace.json';
const TTL_MS = 24 * 60 * 60 * 1000;          // drop workspaces older than 24h are swept
const STAGING_TTL_MS = 60 * 60 * 1000;        // orphaned staging dirs older than 1h are swept
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;     // hourly

// The single active workspace.
let active = null; // { root, id, name, mode: 'drop'|'classic', pinned, createdAt }
let lifecycleStarted = false;

// Superseded drop workspaces are RETIRED (deferred delete) rather than removed
// synchronously, so an in-flight export/save that froze the old root can finish
// before the dir disappears. Reclaimed after a short grace by the sweeper.
const RETIRE_GRACE_MS = 10 * 60 * 1000;
let retired = []; // [{ dir, at }]

function retire(dir) { retired.push({ dir, at: Date.now() }); }

function reclaimRetired(force) {
  const now = Date.now();
  retired = retired.filter(({ dir, at }) => {
    if (force || now - at > RETIRE_GRACE_MS) { rmDir(dir); return false; }
    return true;
  });
}

function ensureParent() {
  try {
    fs.mkdirSync(PARENT, { recursive: true, mode: 0o700 });
  } catch (e) { /* best-effort */ }
}

function mintId() {
  return crypto.randomBytes(8).toString('hex');
}

function parentDir() { return PARENT; }
function workspacePath(id) { return path.join(PARENT, 'ws-' + id); }
function stagingPath(id) { return path.join(PARENT, 'ws-' + id + '-staging'); }

function getRoot() { return active ? active.root : null; }
function isLoaded() { return !!active; }

function getInfo() {
  if (!active) return { loaded: false, id: null, name: null, mode: null, root: null };
  return {
    loaded: true,
    id: active.id,
    name: active.name,
    mode: active.mode,
    // Do not leak the absolute app-managed path in drop mode; classic exposes it
    // (the user owns the folder and already knows where it is).
    root: active.mode === 'classic' ? active.root : null,
  };
}

function writeMeta(root, meta) {
  try {
    fs.writeFileSync(path.join(root, META_FILE), JSON.stringify(meta, null, 2));
  } catch (e) { /* meta is best-effort; the dir still works without it */ }
}

// -------------------------------------------------------------------------
//   Classic mode — pin the user's own folder
// -------------------------------------------------------------------------

function pin(dir, name) {
  deactivate({ removeIfDrop: true });
  active = {
    root: path.resolve(dir),
    id: mintId(),
    name: name || path.basename(path.resolve(dir)) || 'site',
    mode: 'classic',
    pinned: true,
    createdAt: Date.now(),
  };
  sectionOps.clearAll();
  return getInfo();
}

// -------------------------------------------------------------------------
//   Drop mode — activate a staged/promoted directory
// -------------------------------------------------------------------------

function activate({ root, id, name }) {
  deactivate({ removeIfDrop: true });
  const resolved = path.resolve(root);
  active = {
    root: resolved,
    id: id || mintId(),
    name: name || 'site',
    mode: 'drop',
    pinned: false,
    createdAt: Date.now(),
  };
  writeMeta(resolved, {
    id: active.id,
    name: active.name,
    createdAt: active.createdAt,
    lastAccess: active.createdAt,
  });
  sectionOps.clearAll();
  return getInfo();
}

function touch() {
  if (!active || active.mode !== 'drop') return;
  const metaPath = path.join(active.root, META_FILE);
  try {
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch (e) { /* recreate */ }
    meta.lastAccess = Date.now();
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  } catch (e) { /* best-effort */ }
}

/**
 * Remove the active workspace from disk if it is a drop workspace, then clear
 * the active pointer. Classic (pinned) workspaces are never deleted.
 */
function deactivate({ removeIfDrop }) {
  if (active && removeIfDrop && active.mode === 'drop' && !active.pinned) {
    retire(active.root);   // deferred delete — reclaimed after RETIRE_GRACE_MS
  }
  active = null;
  sectionOps.clearAll();
}

function discard() {
  deactivate({ removeIfDrop: true });
  return getInfo();
}

function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
}

// -------------------------------------------------------------------------
//   Lifecycle: TTL sweep + process-exit cleanup
// -------------------------------------------------------------------------

function sweepOnce() {
  ensureParent();
  reclaimRetired(false);
  let entries;
  try { entries = fs.readdirSync(PARENT, { withFileTypes: true }); }
  catch (e) { return; }

  const now = Date.now();
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith('ws-')) continue;
    const dir = path.join(PARENT, e.name);
    // Never sweep the currently-active workspace.
    if (active && path.resolve(dir) === active.root) continue;

    const isStaging = e.name.endsWith('-staging');
    let age;
    if (isStaging) {
      age = ageFromMtime(dir);
      if (age > STAGING_TTL_MS) rmDir(dir);
      continue;
    }
    // A promoted workspace: prefer lastAccess from meta, fall back to mtime.
    const meta = readMeta(dir);
    const stamp = (meta && meta.lastAccess) || (meta && meta.createdAt) || mtimeMs(dir);
    age = now - stamp;
    if (age > TTL_MS) rmDir(dir);
  }
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, META_FILE), 'utf8')); }
  catch (e) { return null; }
}

function mtimeMs(dir) {
  try { return fs.statSync(dir).mtimeMs; } catch (e) { return 0; }
}
function ageFromMtime(dir) {
  return Date.now() - mtimeMs(dir);
}

function cleanupOnExit() {
  if (active && active.mode === 'drop' && !active.pinned) {
    rmDir(active.root);
    active = null;
  }
  reclaimRetired(true);   // force-remove any deferred dirs on exit
}

function initLifecycle() {
  if (lifecycleStarted) return;
  lifecycleStarted = true;
  ensureParent();
  sweepOnce();
  const timer = setInterval(sweepOnce, SWEEP_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();

  const onSignal = (sig) => {
    cleanupOnExit();
    // Re-raise default behaviour: exit with the conventional code.
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('exit', cleanupOnExit);
}

module.exports = {
  getRoot,
  isLoaded,
  getInfo,
  pin,
  activate,
  touch,
  discard,
  mintId,
  parentDir,
  stagingPath,
  workspacePath,
  initLifecycle,
  // exposed for tests
  _sweepOnce: sweepOnce,
};
