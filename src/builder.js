'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const beautify = require('js-beautify');

const SKIP = new Set([
  '_minified',
  '_formatted',
  'node_modules',
  'build.js',
  'package.json',
  'package-lock.json',
  '.git',
  '.vscode',
  '.idea',
]);

/**
 * Run the build pipelines:
 *   1. _minified/  — invokes the user's existing build.js if present
 *   2. _formatted/ — mirror of source with js-beautify applied
 */
async function runBuild(siteRoot) {
  const result = { minified: null, formatted: null };

  // 1. Run user's existing build.js if available
  const userBuild = path.join(siteRoot, 'build.js');
  if (fs.existsSync(userBuild)) {
    try {
      result.minified = await runUserBuild(siteRoot);
    } catch (err) {
      result.minified = { ok: false, error: err.message };
    }
  } else {
    result.minified = { ok: false, error: 'No build.js in site root; skipped minification.' };
  }

  // 2. Generate _formatted/ via js-beautify
  result.formatted = generateFormatted(siteRoot);

  return result;
}

function runUserBuild(siteRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['build.js'], { cwd: siteRoot, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true, log: stdout.trim() });
      else reject(new Error(stderr.trim() || ('build.js exited with code ' + code)));
    });
  });
}

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

    const srcPath = path.join(dir, entry.name);
    const r = rel ? rel + '/' + entry.name : entry.name;
    const dstPath = path.join(outRoot, r);

    if (entry.isDirectory()) {
      fs.mkdirSync(dstPath, { recursive: true });
      walk(srcRoot, r, outRoot, tally);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      try {
        if (ext === '.html') {
          const src = fs.readFileSync(srcPath, 'utf8');
          fs.writeFileSync(dstPath, beautify.html(src, {
            indent_size: 2,
            wrap_attributes: 'auto',
            end_with_newline: true,
            preserve_newlines: false,
            max_preserve_newlines: 1,
          }));
          formatted++;
        } else if (ext === '.css') {
          const src = fs.readFileSync(srcPath, 'utf8');
          fs.writeFileSync(dstPath, beautify.css(src, {
            indent_size: 2,
            end_with_newline: true,
          }));
          formatted++;
        } else if (ext === '.js') {
          const src = fs.readFileSync(srcPath, 'utf8');
          fs.writeFileSync(dstPath, beautify.js(src, {
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

module.exports = { runBuild };
