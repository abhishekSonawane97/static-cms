'use strict';

/**
 * safe-path.js — one hardened path resolver used everywhere a client-supplied
 * relative path is joined to a trusted root (save, fields, section ops, image
 * upload, folder ingest, export). Replaces the ad-hoc `startsWith(root)` checks
 * that had a sibling-prefix escape (root "/ws/site" wrongly accepted
 * "/ws/site-evil") because they lacked a trailing separator.
 *
 * Rejects: NUL bytes, absolute Windows drive prefixes (C:\…), any ".." segment,
 * and anything that resolves outside `root`. Normalises backslashes to slashes
 * and strips leading slashes so "/images/x" is treated relative to the root.
 */

const path = require('path');

function resolveInRoot(root, rel) {
  if (typeof rel !== 'string') throw new Error('path must be a string');
  if (rel.indexOf('\0') !== -1) throw new Error('path contains NUL byte: ' + rel);

  // Normalise separators, then strip leading slashes so it is always relative.
  let clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');

  // Reject Windows absolute drive prefixes (e.g. "C:/…", "C:foo").
  if (/^[a-zA-Z]:/.test(clean)) throw new Error('absolute path not allowed: ' + rel);

  // Reject any ".." segment outright (defence in depth on top of the
  // resolved-prefix check below).
  const segments = clean.split('/');
  if (segments.some((s) => s === '..')) throw new Error('path escapes root: ' + rel);

  const resolvedRoot = path.resolve(root);
  const abs = path.resolve(resolvedRoot, clean);

  // Must be the root itself or strictly inside it (trailing separator guards
  // against sibling-prefix collisions).
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + path.sep)) {
    throw new Error('path escapes root: ' + rel);
  }
  return abs;
}

module.exports = { resolveInRoot };
