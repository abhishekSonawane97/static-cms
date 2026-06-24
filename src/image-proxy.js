'use strict';

/**
 * GET /__cms/api/image-proxy?url=<encoded URL>
 *
 * Fetches an external image server-side and streams it back so the browser
 * can load it into a <canvas> for cropping without CORS-tainting the canvas.
 *
 * Guards:
 *   - http: / https: only
 *   - 8-second timeout
 *   - 10 MB hard cap on response size
 *   - returns 502 with JSON error on any failure
 */

const MAX_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 8000;

async function imageProxy(req, res) {
  const raw = (req.query.url || '').toString();
  if (!raw) {
    return res.status(400).json({ error: 'missing url' });
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return res.status(400).json({ error: 'invalid url' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return res.status(400).json({ error: 'only http(s) urls are supported' });
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  try {
    const upstream = await fetch(raw, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'cms-static-image-proxy/0.1' },
    });
    if (!upstream.ok) {
      clearTimeout(timer);
      return res.status(502).json({ error: 'upstream HTTP ' + upstream.status });
    }
    const contentLength = parseInt(upstream.headers.get('content-length') || '0', 10);
    if (contentLength && contentLength > MAX_BYTES) {
      clearTimeout(timer);
      return res.status(502).json({ error: 'image too large (>10 MB)' });
    }
    const ct = upstream.headers.get('content-type') || 'application/octet-stream';
    if (!/^image\//i.test(ct)) {
      clearTimeout(timer);
      return res.status(502).json({ error: 'upstream is not an image (' + ct + ')' });
    }

    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // Stream with running size guard
    const reader = upstream.body.getReader();
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received > MAX_BYTES) {
        try { reader.cancel(); } catch (e) { /* ignore */ }
        if (!res.headersSent) res.status(502);
        return res.end();
      }
      res.write(Buffer.from(value));
    }
    clearTimeout(timer);
    res.end();
  } catch (err) {
    clearTimeout(timer);
    if (!res.headersSent) {
      res.status(502).json({ error: err.name === 'AbortError' ? 'timeout' : err.message });
    } else {
      res.end();
    }
  }
}

module.exports = { imageProxy };
