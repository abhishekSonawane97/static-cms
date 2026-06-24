'use strict';

/**
 * cloner.js — duplicate a <section> within a static HTML page.
 *
 * Public API:
 *   cloneSection(html, selector) → { html, newId, suffix, originalId }
 *
 * The cloned subtree is inserted *immediately after* the original. Inner element
 * IDs and anything that references them (aria-*, <label for>, anchor hrefs) get
 * rewritten with the same suffix, so the resulting document has no duplicate IDs
 * and no broken cross-references.
 *
 * IDs/refs that point *outside* the cloned subtree are left untouched — they
 * still resolve to the original target, which is what the user wants.
 */

const cheerio = require('cheerio');

// Class tokens that aren't useful as a stem when no id exists.
const CLASS_BLACKLIST = new Set([
  'container', 'reveal', 'section', 'main', 'wrapper',
]);

const ARIA_REF_ATTRS = [
  'aria-labelledby',
  'aria-describedby',
  'aria-controls',
  'aria-owns',
  'aria-flowto',
  'aria-activedescendant',
  'aria-details',
  'aria-errormessage',
];

/**
 * Pick a stem to use for the new section's id.
 *   <section id="hero">           → "hero"
 *   <section class="hero hero--eco"> → "hero"  (skips modifier --eco)
 *   <section class="container reveal section"> → null (all blacklisted)
 *   no id, no usable class → null  (caller falls back to a positional label)
 */
function pickStem($section) {
  const id = ($section.attr('id') || '').trim();
  if (id) {
    // Strip a trailing "-copy" or "-copy-N" so cloning a clone produces a
    // tidy name like "story-copy-2" rather than "story-copy-copy".
    const stripped = id.replace(/-copy(?:-\d+)?$/, '');
    return sanitizeIdToken(stripped || id);
  }
  const cls = ($section.attr('class') || '').trim();
  if (!cls) return null;
  const candidate = cls
    .split(/\s+/)
    .find((c) => c && !c.includes('--') && !CLASS_BLACKLIST.has(c.toLowerCase()));
  return candidate ? sanitizeIdToken(candidate) : null;
}

/**
 * Convert any string to something safe for an HTML id.
 * Lowercase, alphanum + dash + underscore only, max 60 chars.
 */
function sanitizeIdToken(s) {
  return String(s)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

/**
 * Find the first available "<stem>-copy[-N]" id that isn't already in the doc.
 *   stem = "about"
 *   taken = {"about", "about-copy"}
 *   →  candidate "about-copy-2"
 */
function pickAvailableSuffix(stem, taken) {
  let n = 1;
  // First attempt is always "-copy" (no number).
  let candidate = `${stem}-copy`;
  if (!taken.has(candidate)) return { newId: candidate, suffixOnly: '-copy' };
  while (true) {
    n += 1;
    candidate = `${stem}-copy-${n}`;
    if (!taken.has(candidate)) return { newId: candidate, suffixOnly: `-copy-${n}` };
    if (n > 9999) throw new Error('clone numbering exceeded sanity limit (9999)');
  }
}

/**
 * Walk the document and collect every used id into a Set.
 */
function collectIds($, $root) {
  const ids = new Set();
  $root.each((_, el) => {
    if (el.attribs && el.attribs.id) ids.add(el.attribs.id);
  });
  $('[id]').each((_, el) => {
    if (el.attribs && el.attribs.id) ids.add(el.attribs.id);
  });
  return ids;
}

/**
 * Inside a cloned subtree:
 *  1. collect the set of ids about to exist
 *  2. rewrite each inner id by appending suffix
 *  3. update aria-*, <label for>, anchor href="#…" when their target is one of those ids
 */
function rewriteInnerIds($, $clone, suffix) {
  // 1. Find every id inside the clone, build oldId → newId map
  const innerIdMap = new Map();
  $clone.find('[id]').each((_, el) => {
    const id = el.attribs.id;
    if (!id) return;
    innerIdMap.set(id, id + suffix);
  });

  // 2. Rewrite the ids
  for (const [oldId, newId] of innerIdMap) {
    $clone.find('#' + cssEscape(oldId)).attr('id', newId);
  }

  // 3. Rewrite ARIA references whose value lives inside the clone
  for (const attr of ARIA_REF_ATTRS) {
    $clone.find(`[${attr}]`).each((_, el) => {
      const v = (el.attribs[attr] || '').trim();
      if (!v) return;
      // aria-* attrs can hold space-separated id lists
      const tokens = v.split(/\s+/).map((tok) => innerIdMap.has(tok) ? innerIdMap.get(tok) : tok);
      el.attribs[attr] = tokens.join(' ');
    });
  }

  // 4. <label for="X">  → suffix when X is in the clone
  $clone.find('label[for]').each((_, el) => {
    const tgt = el.attribs.for;
    if (innerIdMap.has(tgt)) el.attribs.for = innerIdMap.get(tgt);
  });

  // 5. <a href="#X">  → suffix when X is in the clone
  $clone.find('a[href^="#"]').each((_, el) => {
    const href = el.attribs.href;
    if (!href || href.length < 2) return;
    const tgt = href.slice(1);
    if (innerIdMap.has(tgt)) el.attribs.href = '#' + innerIdMap.get(tgt);
  });

  // 6. <use href="#X">, xlink:href="#X" — for inline SVG
  $clone.find('[href^="#"], [xlink\\:href^="#"]').each((_, el) => {
    for (const attr of ['href', 'xlink:href']) {
      const v = el.attribs && el.attribs[attr];
      if (!v || v[0] !== '#') continue;
      const tgt = v.slice(1);
      if (innerIdMap.has(tgt)) el.attribs[attr] = '#' + innerIdMap.get(tgt);
    }
  });
}

// Minimal CSS-escape for use in cheerio selectors.
// We only need to escape characters that actually appear in HTML ids.
function cssEscape(s) {
  return String(s).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Main entry point. Given the source HTML and a cheerio-style selector
 * pointing at a <section>, return a new HTML string with the section
 * cloned + an inserted copy directly after the original.
 *
 * Throws if the selector doesn't resolve to a <section>.
 */
function cloneSection(html, selector) {
  const $ = cheerio.load(html, { decodeEntities: false });

  const $section = $(selector).first();
  if (!$section.length) {
    throw new Error('Section not found: ' + selector);
  }
  if (($section[0].name || '').toLowerCase() !== 'section') {
    throw new Error('Selector does not point to a <section>: ' + selector);
  }

  // Build set of all currently-used ids
  const taken = collectIds($, $('[id]'));

  // Stem: prefer the section's own id; else first non-modifier class; else 'section'
  const stem = pickStem($section) || 'section';

  // Pick "<stem>-copy" or "<stem>-copy-N"
  const { newId, suffixOnly } = pickAvailableSuffix(stem, taken);

  // Deep-clone the subtree. Cheerio's .clone() returns a fresh cheerio object.
  const $clone = $section.clone();

  // 1. Rewrite the section's own id
  $clone.attr('id', newId);

  // 2. Rewrite inner ids + references
  rewriteInnerIds($, $clone, suffixOnly);

  // 3. Insert the clone immediately after the original
  $section.after($clone);

  return {
    html: $.html(),
    newId,
    suffix: suffixOnly,
    originalId: $section.attr('id') || null,
  };
}

module.exports = {
  cloneSection,
  // exported for tests / reuse
  pickStem,
  pickAvailableSuffix,
  sanitizeIdToken,
};
