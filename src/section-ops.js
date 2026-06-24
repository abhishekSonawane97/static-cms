'use strict';

/**
 * section-ops.js — structural section operations (delete, move) plus a tiny
 * per-page in-memory history stack used by the Undo button.
 *
 * Public:
 *   deleteSection(html, selector)   → { html, removedId }
 *   moveSection(html, selector, dir) → { html, movedId, newIndex }   dir: 'up' | 'down'
 *   pushHistory(page, html, action) → void
 *   popHistory(page)                → { html, action } | null
 *   historyDepth(page)              → number
 *   clearHistory(page)              → void  (currently unused; for future "discard" UX)
 *   subtreeContainsForm(html, selector) → boolean
 */

const cheerio = require('cheerio');

const MAX_HISTORY = 10;
const history = new Map(); // pagePath → [{ html, action, timestamp }]

// ---------------------------------------------------------------------------
//   History stack
// ---------------------------------------------------------------------------

function pushHistory(page, html, action) {
  if (!history.has(page)) history.set(page, []);
  const stack = history.get(page);
  stack.push({ html, action, timestamp: Date.now() });
  while (stack.length > MAX_HISTORY) stack.shift();
}

function popHistory(page) {
  const stack = history.get(page);
  if (!stack || !stack.length) return null;
  return stack.pop();
}

function historyDepth(page) {
  const stack = history.get(page);
  return stack ? stack.length : 0;
}

function clearHistory(page) {
  history.delete(page);
}

// ---------------------------------------------------------------------------
//   Section operations
// ---------------------------------------------------------------------------

function deleteSection(html, selector) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const $section = $(selector).first();
  if (!$section.length) throw new Error('Section not found: ' + selector);
  if (($section[0].name || '').toLowerCase() !== 'section') {
    throw new Error('Selector does not point to a <section>: ' + selector);
  }
  const removedId = $section.attr('id') || null;
  $section.remove();
  return { html: $.html(), removedId };
}

/**
 * Move a section among its <section> siblings.
 *   direction: 'up'   — swap with the closest preceding <section> sibling
 *              'down' — swap with the closest following <section> sibling
 *
 * Throws if there's no section in that direction (caller should disable the
 * button in the UI but the server still validates defensively).
 */
function moveSection(html, selector, direction) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const $section = $(selector).first();
  if (!$section.length) throw new Error('Section not found: ' + selector);
  if (($section[0].name || '').toLowerCase() !== 'section') {
    throw new Error('Selector does not point to a <section>: ' + selector);
  }
  if (direction !== 'up' && direction !== 'down') {
    throw new Error('Direction must be "up" or "down"');
  }

  const target = direction === 'up'
    ? $section.prevAll('section').first()
    : $section.nextAll('section').first();

  if (!target.length) {
    throw new Error('No section to move ' + direction + ' of: ' + selector);
  }

  // .insertBefore / .insertAfter detach the moving node from its old position.
  if (direction === 'up') {
    $section.insertBefore(target);
  } else {
    $section.insertAfter(target);
  }

  return {
    html: $.html(),
    movedId: $section.attr('id') || null,
  };
}

/**
 * Quick check: does the subtree at selector contain any <form>?
 * Used to surface a warning toast after Clone — the cloned form's JS hooks
 * are typically keyed by the original id and won't fire on the clone until
 * the user wires JS by hand.
 */
function subtreeContainsForm(html, selector) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const $section = $(selector).first();
  if (!$section.length) return false;
  return $section.find('form').length > 0;
}

module.exports = {
  deleteSection,
  moveSection,
  subtreeContainsForm,
  pushHistory,
  popHistory,
  historyDepth,
  clearHistory,
};
