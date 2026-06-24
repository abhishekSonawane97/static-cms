#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { startServer } = require('../src/server');

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: cms-static <site-folder>\n');
  console.error('  Example: cms-static ./my-static-site');
  process.exit(1);
}

const siteRoot = path.resolve(process.cwd(), arg);

if (!fs.existsSync(siteRoot)) {
  console.error('[!] Folder does not exist: ' + siteRoot);
  process.exit(1);
}
if (!fs.statSync(siteRoot).isDirectory()) {
  console.error('[!] Not a directory: ' + siteRoot);
  process.exit(1);
}

// Sanity check: refuse if folder looks minified (e.g. user pointed at _minified/)
function looksMinified(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content.split('\n');
    return lines.length < 5 && content.length > 5000;
  } catch (e) { return false; }
}
const probe = path.join(siteRoot, 'index.html');
if (fs.existsSync(probe) && looksMinified(probe)) {
  console.error('\n[!] This folder looks minified.');
  console.error('    Point at your SOURCE folder, not _minified/.\n');
  process.exit(1);
}

const port = parseInt(process.env.PORT, 10) || 5174;

startServer(siteRoot, port).then(() => {
  console.log('');
  console.log('  cms-static  v0.1');
  console.log('  ' + '-'.repeat(50));
  console.log('  Site:    ' + siteRoot);
  console.log('  Editor:  http://localhost:' + port + '/__cms/');
  console.log('');
  console.log('  Open the Editor URL in your browser.');
  console.log('  Ctrl+C to stop.');
  console.log('');
}).catch(err => {
  console.error('[!] Server failed to start: ' + err.message);
  process.exit(1);
});
