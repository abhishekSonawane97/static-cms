#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const { startServer } = require('../src/server');
const { looksMinified } = require('../src/ingest');

const arg = process.argv[2];
const port = parseInt(process.env.PORT, 10) || 5174;

// ---------------------------------------------------------------------------
//   Two modes:
//     • no arg  → DROP MODE. Start with no workspace; the browser uploads one.
//     • <folder> → CLASSIC MODE. Pin the given folder as the workspace.
// ---------------------------------------------------------------------------

let opts = {};

if (arg) {
  const siteRoot = path.resolve(process.cwd(), arg);

  if (!fs.existsSync(siteRoot)) {
    console.error('[!] Folder does not exist: ' + siteRoot);
    process.exit(1);
  }
  if (!fs.statSync(siteRoot).isDirectory()) {
    console.error('[!] Not a directory: ' + siteRoot);
    process.exit(1);
  }

  const probe = path.join(siteRoot, 'index.html');
  if (fs.existsSync(probe) && looksMinified(probe)) {
    console.error('\n[!] This folder looks minified.');
    console.error('    Point at your SOURCE folder, not _minified/.\n');
    process.exit(1);
  }

  opts = { initialRoot: siteRoot, initialName: path.basename(siteRoot) };
}

startServer(port, opts).then(() => {
  console.log('');
  console.log('  cms-static  v0.2');
  console.log('  ' + '-'.repeat(50));
  if (opts.initialRoot) {
    console.log('  Site:    ' + opts.initialRoot);
  } else {
    console.log('  Site:    (none yet — drop a folder in the editor)');
  }
  console.log('  Editor:  http://localhost:' + port + '/__cms/');
  console.log('');
  console.log('  Open the Editor URL in your browser.');
  if (!opts.initialRoot) {
    console.log('  Then drag a site folder onto the drop zone (or use the picker).');
  }
  console.log('  Ctrl+C to stop.');
  console.log('');
}).catch(err => {
  console.error('[!] Server failed to start: ' + err.message);
  process.exit(1);
});
