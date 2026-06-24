'use strict';

const fs = require('fs');
const path = require('path');

const SKIP_DIRS = new Set([
  'node_modules',
  '_minified',
  '_formatted',
  '.git',
  '.vscode',
  '.idea',
  'dist',
  'build'
]);

const TOP_LEVEL_GROUP = 'Top-level';

/**
 * Walk the site root and return an enriched list of editable HTML pages.
 *
 * Each entry: { path, label, group }
 *   - path  = relative to siteRoot, forward-slashed (e.g. "akasa-dalhousie/about/index.html")
 *   - label = breadcrumb label ("Akasa Dalhousie › About")
 *   - group = top-level <optgroup> label ("Akasa Dalhousie", or "Top-level" for root pages)
 *
 * Heuristics:
 *   - skip dotfiles, node_modules, build outputs
 *   - skip files larger than 5 MB (probably a generated artifact, not source)
 *   - skip files that look minified (single huge line)
 */
async function listPages(siteRoot) {
  const raw = [];
  walk(siteRoot, '', raw);

  // ─── Pass 1: count how many pages share each top-level segment ───
  // A top-level segment "owns" its own group iff it has multiple pages under it,
  // OR a single page that is itself nested below the top segment (>1 segment deep).
  // Pages that are just "<segment>/index.html" with no children stay in Top-level.
  const segCount = new Map();
  for (const p of raw) {
    const segs = pathSegments(p);
    if (segs.length === 0) continue;
    const top = segs[0];
    segCount.set(top, (segCount.get(top) || 0) + (segs.length > 1 ? 10 : 1));
    // segments deeper than 1 contribute "10" so any nested page promotes the group;
    // shallow-only top-level pages (count 1) stay in Top-level.
  }

  const promotedTops = new Set();
  for (const [top, score] of segCount) {
    if (score >= 10) promotedTops.add(top);
  }

  // ─── Pass 2: assign label + group ───
  const pages = raw.map((p) => {
    const segs = pathSegments(p);
    return {
      path: p,
      label: labelFor(segs),
      group: groupFor(segs, promotedTops),
    };
  });

  // Sort: by group (Top-level first, then alphabetical), then by depth ASC, then by label
  pages.sort((a, b) => {
    if (a.group !== b.group) {
      if (a.group === TOP_LEVEL_GROUP) return -1;
      if (b.group === TOP_LEVEL_GROUP) return 1;
      return a.group.localeCompare(b.group);
    }
    const da = depthOf(a.path);
    const db = depthOf(b.path);
    if (da !== db) return da - db;
    return a.label.localeCompare(b.label);
  });

  return pages;
}

function walk(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (SKIP_DIRS.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    const r = rel ? rel + '/' + entry.name : entry.name;

    if (entry.isDirectory()) {
      walk(full, r, out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      try {
        const stat = fs.statSync(full);
        if (stat.size > 5 * 1024 * 1024) continue;
        // Quick minified-check: peek first 4 KB
        const fd = fs.openSync(full, 'r');
        const buf = Buffer.alloc(4096);
        const len = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        const head = buf.slice(0, len).toString('utf8');
        // If the first 4 KB has fewer than 3 newlines AND length > 3500, treat as minified.
        const newlines = (head.match(/\n/g) || []).length;
        if (newlines < 3 && head.length >= 3500) continue;
      } catch (e) {
        continue;
      }
      out.push(r);
    }
  }
}

// ---------------------------------------------------------------------------
//   Label / group derivation
// ---------------------------------------------------------------------------

function pathSegments(p) {
  // Strip trailing /index.html so the file becomes "transparent"
  const stripped = p.replace(/\/?index\.html$/i, '');
  if (!stripped) return []; // root index.html
  return stripped.split('/');
}

function depthOf(p) {
  const segs = pathSegments(p);
  return segs.length;
}

/**
 * Build a breadcrumb label from path segments.
 *   []                                  → "Home"
 *   ["akasa-dalhousie"]                 → "Akasa Dalhousie"
 *   ["akasa-dalhousie", "about"]        → "Akasa Dalhousie › About"
 *   ["foo", "bar.html"] (non-index)     → "Foo › Bar"
 */
function labelFor(segs) {
  if (segs.length === 0) return 'Home';
  return segs.map(slugToTitle).join(' › ');
}

/**
 * Top-level group label.
 *   - root index.html               → "Top-level"
 *   - segs[0] is in promotedTops    → titleCase(segs[0])  (heads its own group)
 *   - otherwise                     → "Top-level"
 *
 * promotedTops contains top-level segments that have nested children;
 * those segments get their own <optgroup> and their own index page belongs there too.
 */
function groupFor(segs, promotedTops = new Set()) {
  if (segs.length === 0) return TOP_LEVEL_GROUP;
  if (promotedTops.has(segs[0])) return slugToTitle(segs[0]);
  return TOP_LEVEL_GROUP;
}

/**
 * Slug → Title Case.
 *   "akasa-dalhousie"      → "Akasa Dalhousie"
 *   "honeymoon-special"    → "Honeymoon Special"
 *   "404"                  → "404"
 *   "rooms_with_view"      → "Rooms With View"
 *   "about.html"           → "About"
 */
function slugToTitle(slug) {
  // Strip a trailing .html if present (for non-index .html files)
  const base = slug.replace(/\.html$/i, '');
  return base
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

module.exports = {
  listPages,
  // exported for tests / reuse
  labelFor,
  groupFor,
  slugToTitle,
};
