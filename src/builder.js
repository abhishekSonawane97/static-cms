'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const beautify = require('js-beautify');
const { minify: minifyHtml } = require('html-minifier-terser');
const { minify: minifyJs } = require('terser');
const CleanCSS = require('clean-css');

// One canonical skip set shared by both pipelines. Anything here (and any
// dot-entry) is never walked into the output tree. Mirrors discovery.js plus
// the extra build-tooling / artifact names the real Simplotel build.mjs skips.
const SKIP = new Set([
  '_minified',
  '_formatted',
  'dist',
  'node_modules',
  'build.js',
  'build.mjs',
  'package.json',
  'package-lock.json',
  '.git',
  '.vscode',
  '.idea',
  '.claude',
]);

// File basenames / suffixes to skip even when they aren't directories.
function skipFile(name) {
  if (name === '.DS_Store') return true;
  if (name.endsWith('.map')) return true;
  return false;
}

// HTML minify options — copied verbatim from the production Kavin Hotels
// build.mjs so the built-in pipeline produces equivalent output.
const HTML_MIN_OPTS = {
  collapseWhitespace: true,
  conservativeCollapse: true,
  removeComments: true,
  ignoreCustomComments: [/^!/, /^\[if /, /<!\[endif\]/],
  removeRedundantAttributes: true,
  removeScriptTypeAttributes: true,
  removeStyleLinkTypeAttributes: true,
  useShortDoctype: true,
  minifyCSS: true,
  minifyJS: true,
  decodeEntities: false,
  caseSensitive: true,
};

const cleanCss = new CleanCSS({ level: 1, returnPromise: false });

/**
 * Run the build pipelines:
 *   1. _minified/  — built-in html-minifier-terser / terser / clean-css pass
 *                    (NO longer spawns the site's own build.js — that was both
 *                    an arbitrary-code-execution surface on uploaded folders and
 *                    dead in practice: uploads carry no node_modules).
 *   2. _formatted/ — mirror of source with js-beautify applied
 */
// Serialize builds process-wide. generateMinified wipes + rewrites _minified/
// with awaits in between, so two overlapping builds (e.g. an explicit Build and
// an export auto-build) would interleave into a corrupt tree. There is a single
// active workspace, so one global lock is sufficient.
let buildLock = Promise.resolve();

function runBuild(siteRoot) {
  const next = buildLock.catch(() => {}).then(() => _runBuild(siteRoot));
  buildLock = next.catch(() => {});
  return next;
}

async function _runBuild(siteRoot) {
  const result = { minified: null, formatted: null };

  try {
    result.minified = await generateMinified(siteRoot);
  } catch (err) {
    result.minified = { ok: false, error: err.message };
  }

  result.formatted = generateFormatted(siteRoot);

  return result;
}

// Read a text file as UTF-8, but only if it round-trips losslessly. Returns
// null for non-UTF-8 bytes (legacy windows-1252 CSS, latin1 JS, binaries with a
// text extension) so callers copy them verbatim instead of corrupting them.
function readUtf8(src) {
  const buf = fs.readFileSync(src);
  const str = buf.toString('utf8');
  return Buffer.from(str, 'utf8').equals(buf) ? str : null;
}

// -------------------------------------------------------------------------
//   _minified/  — built-in minification
// -------------------------------------------------------------------------

async function generateMinified(siteRoot) {
  const outDir = path.join(siteRoot, '_minified');
  if (fs.existsSync(outDir)) fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // Pass 1: content-hash every non-.min css/js so HTML ?v= refs can cache-bust.
  const assetHashes = new Map();
  collectAssetHashes(siteRoot, '', assetHashes);

  const stats = { html: 0, css: 0, js: 0, other: 0 };
  const failures = [];
  let bytesIn = 0, bytesOut = 0;

  const files = [];
  collectFiles(siteRoot, '', files);

  for (const rel of files) {
    const src = path.join(siteRoot, rel);
    const dst = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const ext = path.extname(rel).toLowerCase();
    try {
      // Non-UTF-8 text files are copied verbatim (see readUtf8) to avoid
      // corrupting legacy-encoded content.
      const text = (ext === '.html' || ext === '.css' || (ext === '.js' && !rel.includes('.min.')))
        ? readUtf8(src) : null;
      if (ext === '.html' && text !== null) {
        const html = rewriteCacheBust(text, assetHashes);
        const inB = Buffer.byteLength(html);
        const min = await minifyHtml(html, HTML_MIN_OPTS);
        fs.writeFileSync(dst, min);
        bytesIn += inB; bytesOut += Buffer.byteLength(min); stats.html++;
      } else if (ext === '.css' && text !== null) {
        const out = cleanCss.minify(text).styles || text;
        fs.writeFileSync(dst, out);
        bytesIn += Buffer.byteLength(text); bytesOut += Buffer.byteLength(out); stats.css++;
      } else if (ext === '.js' && !rel.includes('.min.') && text !== null) {
        const res = await minifyJs(text, {
          compress: { passes: 2 },
          mangle: true,
          format: { comments: false },
        });
        if (!res.code) throw new Error('terser returned empty output');
        fs.writeFileSync(dst, res.code);
        bytesIn += Buffer.byteLength(text); bytesOut += Buffer.byteLength(res.code); stats.js++;
      } else {
        fs.copyFileSync(src, dst);
        const size = fs.statSync(src).size;
        bytesIn += size; bytesOut += size; stats.other++;
      }
    } catch (err) {
      failures.push({ file: rel, error: err.message });
      try { fs.copyFileSync(src, dst); } catch (e) { /* give up on this file */ }
    }
  }

  return {
    ok: true,
    files: stats.html + stats.css + stats.js + stats.other,
    html: stats.html, css: stats.css, js: stats.js, other: stats.other,
    bytesIn, bytesOut,
    failures,
  };
}

// sha256-first-10 content hash for the cache-bust map.
function hash(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
}

function collectAssetHashes(root, rel, map) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { collectAssetHashes(root, r, map); continue; }
    if (!e.isFile()) continue;
    if (!/\.(css|js)$/i.test(e.name) || e.name.includes('.min.')) continue;
    try { map.set(r, hash(fs.readFileSync(path.join(dir, e.name)))); } catch (e2) { /* skip */ }
  }
}

// Rewrite existing ?v=… on referenced css/js with the content hash. Only
// touches refs that ALREADY carry ?v= — never injects new query params, so it
// is a safe no-op for sites that don't use the convention.
function rewriteCacheBust(html, assetHashes) {
  if (!assetHashes.size) return html;
  return html.replace(
    /(["'(\s])(\/?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.(?:css|js))\?v=[A-Za-z0-9._-]+/g,
    (m, prefix, ref) => {
      const lookup = ref.replace(/^\//, '');
      const h = assetHashes.get(lookup);
      return h ? `${prefix}${ref}?v=${h}` : m;
    }
  );
}

// Flat list of source-relative file paths, honouring the shared skip set.
function collectFiles(root, rel, out) {
  const dir = rel ? path.join(root, rel) : root;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP.has(e.name)) continue;
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) collectFiles(root, r, out);
    else if (e.isFile() && !skipFile(e.name)) out.push(r);
  }
}

// -------------------------------------------------------------------------
//   _formatted/  — pretty-printed mirror
// -------------------------------------------------------------------------

function generateFormatted(siteRoot) {
  const outDir = path.join(siteRoot, '_formatted');
  if (fs.existsSync(outDir)) {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  let copied = 0;
  walk(siteRoot, '', outDir, (n, c) => { count += n; copied += c; });

  return { ok: true, formatted: count, copied };
}

function walk(srcRoot, rel, outRoot, tally) {
  const dir = rel ? path.join(srcRoot, rel) : srcRoot;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  let formatted = 0;
  let copied = 0;

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP.has(entry.name)) continue;
    if (entry.isFile() && skipFile(entry.name)) continue;

    const srcPath = path.join(dir, entry.name);
    const r = rel ? rel + '/' + entry.name : entry.name;
    const dstPath = path.join(outRoot, r);

    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      walk(srcRoot, r, outRoot, tally);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      try {
        const text = (ext === '.html' || ext === '.css' || ext === '.js') ? readUtf8(srcPath) : null;
        if (ext === '.html' && text !== null) {
          fs.writeFileSync(dstPath, beautify.html(text, {
            indent_size: 2,
            wrap_attributes: 'auto',
            end_with_newline: true,
            preserve_newlines: false,
            max_preserve_newlines: 1,
          }));
          formatted++;
        } else if (ext === '.css' && text !== null) {
          fs.writeFileSync(dstPath, beautify.css(text, {
            indent_size: 2,
            end_with_newline: true,
          }));
          formatted++;
        } else if (ext === '.js' && text !== null) {
          fs.writeFileSync(dstPath, beautify.js(text, {
            indent_size: 2,
            end_with_newline: true,
            preserve_newlines: true,
            max_preserve_newlines: 2,
          }));
          formatted++;
        } else {
          fs.copyFileSync(srcPath, dstPath);
          copied++;
        }
      } catch (err) {
        console.warn('[builder] failed on ' + r + ': ' + err.message);
        try { fs.copyFileSync(srcPath, dstPath); copied++; } catch (e) {}
      }
    }
  }

  tally(formatted, copied);
}

module.exports = { runBuild, generateMinified, SKIP, skipFile };
