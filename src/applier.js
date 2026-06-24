'use strict';

const cheerio = require('cheerio');
const beautify = require('js-beautify').html;

/**
 * Apply a list of changes back to an HTML source string.
 * Returns a pretty-printed HTML string ready to write to disk.
 */
async function applyChanges(html, changes) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Split changes into DOM-targeted and JSON-LD-targeted
  const domChanges = [];
  const jsonldByScript = new Map(); // scriptIndex -> [{jsonPath, value, arrayIndex}]

  for (const c of changes) {
    if (c.scriptIndex !== undefined && c.scriptIndex !== null && c.jsonPath) {
      if (!jsonldByScript.has(c.scriptIndex)) jsonldByScript.set(c.scriptIndex, []);
      jsonldByScript.get(c.scriptIndex).push(c);
    } else if (c.selector) {
      domChanges.push(c);
    }
  }

  // ---- Apply DOM changes ----
  for (const c of domChanges) {
    const $el = $(c.selector).first();
    if (!$el.length) continue;
    if (c.attr === 'text') {
      $el.text(c.value);
    } else if (c.attr === 'html') {
      $el.html(c.value);
    } else {
      $el.attr(c.attr, c.value);
    }
    if (c.altAttr && c.alt !== undefined) {
      $el.attr(c.altAttr, c.alt);
    }
  }

  // ---- Apply JSON-LD changes ----
  $('script[type="application/ld+json"]').each((i, el) => {
    if (!jsonldByScript.has(i)) return;
    let data;
    try { data = JSON.parse($(el).text()); } catch (e) { return; }

    const items = Array.isArray(data) ? data : null;

    for (const c of jsonldByScript.get(i)) {
      if (items && c.arrayIndex !== null && c.arrayIndex !== undefined) {
        setNestedValue(items[c.arrayIndex], c.jsonPath, c.value);
      } else {
        setNestedValue(data, c.jsonPath, c.value);
      }
    }
    $(el).text('\n' + JSON.stringify(items || data, null, 2) + '\n');
  });

  // Serialize and pretty-print the whole document
  const serialized = $.html();
  return beautify(serialized, {
    indent_size: 2,
    indent_inner_html: false,
    wrap_attributes: 'auto',
    end_with_newline: true,
    preserve_newlines: false,
    max_preserve_newlines: 1,
    extra_liners: [],
    inline: ['em', 'strong', 'b', 'i', 'u', 'span', 'a', 'small', 'code', 'sub', 'sup', 'br'],
  });
}

/**
 * Set a value at a dotted path inside an object.
 * Coerces back to original primitive type when possible (numbers, booleans).
 */
function setNestedValue(obj, dotPath, value) {
  if (!obj) return;
  const parts = dotPath.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] === undefined || cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') {
      // Create empty object so the write succeeds (rare)
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]];
  }
  const last = parts[parts.length - 1];
  const orig = cur[last];
  if (typeof orig === 'number' && value !== '' && !isNaN(parseFloat(value))) {
    cur[last] = parseFloat(value);
  } else if (typeof orig === 'boolean') {
    cur[last] = (value === true || value === 'true');
  } else {
    cur[last] = value;
  }
}

module.exports = { applyChanges, setNestedValue };
