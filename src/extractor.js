'use strict';

const cheerio = require('cheerio');
const path = require('path');

// Ancestors that mark "structural / not content".
// If an element has any of these as an ancestor, it's excluded.
const EXCLUDED_ANCESTORS = ['nav', 'footer', 'svg', 'button', 'form', 'script', 'style', 'header', 'aside.cms-noedit'];

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4'];
const BODY_TAGS = ['p', 'li', 'blockquote', 'figcaption', 'dt', 'dd'];

// Friendly group labels (A3). Tweak here if you want different copy site-wide.
const GROUP_NAMES = {
  SEO: 'Page details (SEO)',
  HEADINGS: 'Headings',
  BODY: 'Page content',
  IMAGES: 'Photos',
};

// Map well-known JSON-LD @type strings to friendly group names.
// Anything not in this map falls back to "Schema — <Type>".
const SCHEMA_TYPE_FRIENDLY = {
  LodgingBusiness: 'Business info',
  Hotel: 'Hotel info',
  Restaurant: 'Restaurant info',
  Organization: 'Business info',
  LocalBusiness: 'Business info',
  Product: 'Product info',
  Article: 'Article info',
  WebSite: 'Site info',
  WebPage: 'Page info',
};

function friendlySchemaGroup(typeName, idx, total) {
  const base = SCHEMA_TYPE_FRIENDLY[typeName] || ('Schema — ' + (typeName || 'JSON-LD'));
  return total > 1 ? `${base} #${idx + 1}` : base;
}

/**
 * Build a CSS selector path that uniquely identifies an element from <html>.
 * Uses #id when available, otherwise nth-of-type for non-unique siblings.
 */
function buildSelector(el) {
  const parts = [];
  let cur = el;
  while (cur && cur.type === 'tag' && cur.name && cur.name !== 'html') {
    let part;
    if (cur.attribs && cur.attribs.id) {
      part = cur.name + '#' + cur.attribs.id;
    } else {
      part = cur.name;
      const parent = cur.parent;
      if (parent && parent.children) {
        const sameTagSiblings = parent.children.filter(
          (c) => c.type === 'tag' && c.name === cur.name
        );
        if (sameTagSiblings.length > 1) {
          const idx = sameTagSiblings.indexOf(cur) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
    }
    parts.unshift(part);
    cur = cur.parent;
  }
  return parts.join(' > ');
}

function hasExcludedAncestor($el, $) {
  for (const sel of EXCLUDED_ANCESTORS) {
    if ($el.parents(sel).length > 0) return true;
  }
  return false;
}

/**
 * The section/class context an element lives under.
 * Returns "" if no useful context could be derived.
 *   <section class="hero-content">  …  </section>  →  "hero-content"
 *   <article id="story">  …  </article>            →  "story"
 */
function contextFor($el) {
  const parent = $el.closest('section, article, aside, .container, header.eyebrow, [class*="-text"]');
  if (!parent.length) return '';
  const id = parent.attr('id');
  if (id) return id;
  const cls = parent.attr('class') || '';
  return cls.split(/\s+/).find((c) => c && !/^(container|reveal|section|main)$/.test(c)) || '';
}

/**
 * Legacy long-form label used today as the title= tooltip on field rows.
 * Kept for backward compatibility — A4 uses tag + context directly.
 *   "hero — h1"
 *   "story-text — p · "Built with warmth…""
 */
function labelFor($el, tag) {
  const ctx = contextFor($el);
  const txt = $el.text().trim().replace(/\s+/g, ' ').slice(0, 40);
  if (ctx) return `${ctx} — ${tag}` + (txt ? ` · "${txt}…"` : '');
  return `${tag}` + (txt ? ` · "${txt}…"` : '');
}

/**
 * Flatten a JSON-LD object to a list of editable scalar fields.
 * One level of nesting only (e.g. address.streetAddress).
 * Skips arrays in v1 (amenityFeature, etc.).
 */
function flattenJsonLd(obj, basePath = '') {
  const out = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@')) continue; // @context, @type, @id
    const p = basePath ? basePath + '.' + k : k;
    if (typeof v === 'string') {
      out.push({ path: p, value: v, type: v.length > 80 ? 'longtext' : 'text' });
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out.push({ path: p, value: String(v), type: 'text' });
    } else if (v && typeof v === 'object' && !Array.isArray(v) && !basePath) {
      // recurse one level
      out.push(...flattenJsonLd(v, p));
    }
  }
  return out;
}

/**
 * Extract editable fields from an HTML string.
 * Returns an array of field descriptors keyed by stable session-local IDs.
 */
function extractFields(html, pagePath) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const fields = [];
  let n = 0;
  const nextId = (prefix) => `${prefix}:${n++}`;

  // -----------------------------------------------------------
  // SEO group: title, description, og/twitter meta
  // -----------------------------------------------------------
  const title = $('head > title').first();
  if (title.length) {
    fields.push({
      id: nextId('seo'),
      group: GROUP_NAMES.SEO,
      type: 'text',
      label: 'Page title',
      selector: 'head > title',
      attr: 'text',
      value: title.text(),
    });
  }

  const SEO_META = [
    { sel: 'meta[name="description"]', label: 'Meta description', type: 'longtext' },
    { sel: 'meta[property="og:title"]', label: 'OG title', type: 'text' },
    { sel: 'meta[property="og:description"]', label: 'OG description', type: 'longtext' },
    { sel: 'meta[property="og:image"]', label: 'OG image', type: 'image' },
    { sel: 'meta[name="twitter:title"]', label: 'Twitter title', type: 'text' },
    { sel: 'meta[name="twitter:description"]', label: 'Twitter description', type: 'longtext' },
    { sel: 'meta[name="twitter:image"]', label: 'Twitter image', type: 'image' },
  ];
  for (const m of SEO_META) {
    const el = $('head > ' + m.sel).first();
    if (!el.length) continue;
    fields.push({
      id: nextId('seo'),
      group: GROUP_NAMES.SEO,
      type: m.type,
      label: m.label,
      selector: 'head > ' + m.sel,
      attr: 'content',
      value: el.attr('content') || '',
    });
  }

  // -----------------------------------------------------------
  // JSON-LD Schema (one or more <script type="application/ld+json">)
  // -----------------------------------------------------------
  $('script[type="application/ld+json"]').each((scriptIndex, el) => {
    const txt = $(el).text();
    let data;
    try { data = JSON.parse(txt); } catch (e) { return; }

    // If it's an array of items, treat each as its own group; here just take first item.
    const items = Array.isArray(data) ? data : [data];
    items.forEach((item, idx) => {
      const typeName = (item && item['@type']) ? item['@type'] : 'JSON-LD';
      const groupLabel = friendlySchemaGroup(typeName, idx, items.length);
      const flat = flattenJsonLd(item);
      for (const f of flat) {
        fields.push({
          id: nextId('jsonld'),
          group: groupLabel,
          type: f.type,
          label: f.path,
          scriptIndex,
          arrayIndex: items.length > 1 ? idx : null,
          jsonPath: f.path,
          value: f.value,
        });
      }
    });
  });

  // -----------------------------------------------------------
  // Body content (headings + prose) inside <main>, falling back to <body>
  // -----------------------------------------------------------
  const main = $('main').first();
  const root = main.length ? main : $('body');

  const allTags = HEADING_TAGS.concat(BODY_TAGS).join(', ');
  root.find(allTags).each((_, el) => {
    const $el = $(el);
    if (hasExcludedAncestor($el, $)) return;
    const html = $el.html();
    if (!html || !html.trim()) return;
    // Skip nodes that contain only structural children (e.g. <p><img></p>)
    const onlyText = $el.contents().toArray().every(
      (c) => c.type === 'text' || (c.type === 'tag' && /^(em|strong|b|i|u|span|br|a|small|code|sub|sup)$/i.test(c.name))
    );
    if (!onlyText) return;
    const tag = el.tagName.toLowerCase();
    fields.push({
      id: nextId(tag),
      group: HEADING_TAGS.includes(tag) ? GROUP_NAMES.HEADINGS : GROUP_NAMES.BODY,
      type: 'longtext',
      label: labelFor($el, tag),
      tag,                            // A4: friendly label rendered client-side
      context: contextFor($el),       // A4: section name for the muted hint line
      selector: buildSelector(el),
      attr: 'html',
      value: html,
    });
  });

  // -----------------------------------------------------------
  // Images
  // -----------------------------------------------------------
  root.find('img').each((_, el) => {
    const $el = $(el);
    if (hasExcludedAncestor($el, $)) return;
    const src = $el.attr('src') || '';
    if (!src) return;
    const alt = $el.attr('alt') || '';
    fields.push({
      id: nextId('img'),
      group: GROUP_NAMES.IMAGES,
      type: 'image',
      label: alt ? alt.slice(0, 60) : path.posix.basename(src),
      selector: buildSelector(el),
      attr: 'src',
      altAttr: 'alt',
      value: src,
      alt,
      width: $el.attr('width') || null,
      height: $el.attr('height') || null,
    });
  });

  return fields;
}

/**
 * Walk <main> direct-child <section> elements and return a list of section
 * descriptors used by the sidebar Sections group + the clone API.
 *
 * Each entry: { selector, label, id, hasId, index }
 *   - selector: stable CSS path (same shape buildSelector produces)
 *   - label:    best-available human label (id → first heading text → first class → "Section N")
 *   - id:       string or null
 *   - index:    0-based position among <main>'s sections
 */
function extractSections(html) {
  const $ = cheerio.load(html, { decodeEntities: false });
  const main = $('main').first();
  if (!main.length) return [];

  const out = [];
  main.children('section').each((i, el) => {
    const $el = $(el);
    const id = $el.attr('id') || null;
    const heading = $el.find('h1, h2, h3').first().text().trim();
    const cls = ($el.attr('class') || '').split(/\s+/)
      .find((c) => c && !c.includes('--') && !/^(container|reveal|section|main)$/.test(c));

    let label;
    if (id) label = id;
    else if (heading) label = heading.length > 50 ? heading.slice(0, 50) + '…' : heading;
    else if (cls) label = cls;
    else label = 'Section ' + (i + 1);

    out.push({
      selector: buildSelector(el),
      label,
      id,
      hasId: !!id,
      index: i,
    });
  });
  return out;
}

module.exports = { extractFields, extractSections, buildSelector, flattenJsonLd };
