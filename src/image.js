'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInRoot } = require('./safe-path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  sharp = null; // graceful degrade if sharp couldn't install
}

/**
 * Save an uploaded (already-cropped, client-side) image buffer to disk.
 * destPath is relative to siteRoot (e.g. "/images/akasa/foo.jpg") OR an
 * external URL — when destPath is an external URL (http(s)://...), the
 * upload is automatically routed to a generated local path under
 *   /images/cropped/<basename-from-url>-<6char-hash>.<ext>
 * and the new local path is what's returned + written into the source HTML.
 *
 * If Sharp is available, re-encode for optimal size based on extension.
 * Otherwise just write the raw buffer.
 */
async function handleImageUpload(siteRoot, destPath, buffer) {
  // External URLs can't be written to. Generate a local path and store there.
  if (/^https?:\/\//i.test(destPath)) {
    destPath = generateLocalPathForExternalUrl(destPath, buffer);
  }

  const rel = destPath.replace(/^\/+/, '').replace(/\\/g, '/');
  const abs = resolveInRoot(siteRoot, rel);

  fs.mkdirSync(path.dirname(abs), { recursive: true });

  let finalBuf = buffer;
  let width = null, height = null;

  if (sharp) {
    try {
      const img = sharp(buffer);
      const meta = await img.metadata();
      width = meta.width || null;
      height = meta.height || null;

      const ext = path.extname(abs).toLowerCase();
      let pipeline = img;
      if (ext === '.jpg' || ext === '.jpeg') {
        pipeline = pipeline.jpeg({ quality: 82, progressive: true, mozjpeg: true });
      } else if (ext === '.png') {
        pipeline = pipeline.png({ compressionLevel: 9 });
      } else if (ext === '.webp') {
        pipeline = pipeline.webp({ quality: 82 });
      } else if (ext === '.avif') {
        pipeline = pipeline.avif({ quality: 50 });
      } else {
        // Unknown ext: keep as JPEG
        pipeline = pipeline.jpeg({ quality: 82 });
      }
      finalBuf = await pipeline.toBuffer();
    } catch (err) {
      console.warn('[image] sharp failed, writing raw buffer:', err.message);
      finalBuf = buffer;
    }
  }

  fs.writeFileSync(abs, finalBuf);

  return {
    ok: true,
    path: '/' + rel,
    bytes: finalBuf.length,
    width,
    height,
    sharp: !!sharp,
  };
}

/**
 * For an external URL destination, derive a sane local path.
 *   https://cdn.x.com/foo/Hero_Image_2026.jpeg?w=1280
 *   → /images/cropped/hero_image_2026-a3f2c1.jpg
 */
function generateLocalPathForExternalUrl(url, buffer) {
  let basename = 'image';
  try {
    const u = new URL(url);
    const stem = path.posix.basename(u.pathname).replace(/\.[a-z0-9]+$/i, '');
    if (stem) basename = stem;
  } catch (e) {
    // fall back
  }
  // Sanitize: lowercase, replace non-alphanumerics with -, cap length
  basename = basename.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!basename) basename = 'image';
  if (basename.length > 40) basename = basename.slice(0, 40);

  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 6);
  // Always re-encode to .jpg for external-URL crops (Sharp handles this below)
  return '/images/cropped/' + basename + '-' + hash + '.jpg';
}

module.exports = { handleImageUpload };
