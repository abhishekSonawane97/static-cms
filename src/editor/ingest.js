/* cms-static — client-side folder ingestion.
   Pattern matches ai.js / git-panel.js (IIFE + window namespace).

   Three sources normalise to one stream of { relPath, file, size }:
     1. <input webkitdirectory> folder picker
     2. drag-and-drop (webkitGetAsEntry recursion, readEntries-until-empty loop)
     3. .zip unpacked client-side with vendored fflate
   …then a shared uploader ships them to the server in capped multipart batches
   (begin → batch×N → finish) with a 3-way concurrent XHR pool and progress.

   Exposed: window.cmsIngest = { init }
*/
(function () {
  'use strict';

  const qs = (s) => document.querySelector(s);

  // Mirror of the server's ingest caps + skip list (defence in depth; the
  // server re-checks everything).
  const SKIP_DIRS = new Set(['node_modules', '.git', '_minified', '_formatted', '.vscode', '.idea']);
  const SKIP_FILES = new Set(['Thumbs.db', 'desktop.ini', '.DS_Store']);
  const MAX_FILE = 25 * 1024 * 1024;
  const MAX_FILES = 5000;
  const MAX_BYTES = 500 * 1024 * 1024;
  const BATCH_FILES = 40;
  const BATCH_BYTES = 8 * 1024 * 1024;
  const CONCURRENCY = 3;

  let loadedCb = null;
  let cancelled = false;
  let inflightXhrs = new Set();
  let activeUploadId = null;

  // ---------------------------------------------------------------------
  //   Boot
  // ---------------------------------------------------------------------

  function init(opts) {
    loadedCb = (opts && opts.onLoaded) || null;
    const dz = qs('#dropZone');
    if (!dz) return;
    const folderInput = qs('#folderInput');
    const zipInput = qs('#zipInput');

    qs('#pickFolderBtn').addEventListener('click', () => { folderInput.value = ''; folderInput.click(); });
    qs('#pickZipBtn').addEventListener('click', () => { zipInput.value = ''; zipInput.click(); });
    folderInput.addEventListener('change', () => {
      if (folderInput.files && folderInput.files.length) start(() => collectFromInput(folderInput.files));
    });
    zipInput.addEventListener('change', () => {
      const f = zipInput.files && zipInput.files[0];
      if (f) start(() => collectFromZip(f));
    });

    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-dragover'); }));
    dz.addEventListener('dragleave', (e) => {
      if (e.target === dz) dz.classList.remove('is-dragover');
    });
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('is-dragover');
      const dt = e.dataTransfer;
      // collectFromDrop reads dataTransfer.items synchronously before any await.
      start(() => collectFromDrop(dt));
    });

    const cancelBtn = qs('#dropCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', cancel);
  }

  // ---------------------------------------------------------------------
  //   Collectors → { accepted:[{relPath,file,size}], skipped:[{relPath,reason}], totalBytes }
  // ---------------------------------------------------------------------

  function collectFromInput(fileList) {
    const raw = [];
    for (const f of fileList) {
      raw.push({ relPath: (f.webkitRelativePath || f.name), file: f });
    }
    return normalize(raw);
  }

  async function collectFromDrop(dataTransfer) {
    // Grab entries synchronously — the item list is neutered once we yield.
    const entries = [];
    const items = dataTransfer.items;
    if (items && items.length) {
      for (const it of items) {
        const entry = it.webkitGetAsEntry && it.webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
    }
    if (!entries.length) {
      // No directory API — fall back to a flat file list.
      return normalize(Array.from(dataTransfer.files || []).map((f) => ({ relPath: f.name, file: f })));
    }
    const raw = [];
    for (const e of entries) await traverse(e, raw);
    return normalize(raw);
  }

  function traverse(entry, out) {
    return new Promise((resolve) => {
      if (entry.isFile) {
        entry.file(
          (file) => { out.push({ relPath: entry.fullPath.replace(/^\/+/, ''), file }); resolve(); },
          () => resolve()   // retry-less skip on transient error
        );
      } else if (entry.isDirectory) {
        // Prune skip-dirs / dotdirs BEFORE reading — never enumerate node_modules.
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) return resolve();
        const reader = entry.createReader();
        const all = [];
        const drain = () => { (async () => { for (const e of all) await traverse(e, out); resolve(); })(); };
        const readBatch = () => reader.readEntries(
          (ents) => {
            if (!ents.length) { drain(); return; }
            all.push(...ents);
            readBatch();     // Chromium returns ≤100 per call — loop until empty.
          },
          // On a mid-enumeration error, still process whatever we already read
          // rather than discarding the batches accumulated so far.
          () => drain()
        );
        readBatch();
      } else {
        resolve();
      }
    });
  }

  async function collectFromZip(file) {
    if (typeof fflate === 'undefined' || !fflate.unzipSync) {
      throw new Error('zip support unavailable (fflate not loaded)');
    }
    const buf = new Uint8Array(await file.arrayBuffer());
    const unzipped = fflate.unzipSync(buf, {
      filter: (f) => {
        if (f.name.endsWith('/')) return false;              // directory entry
        if (f.name.startsWith('__MACOSX/')) return false;
        return !skipReason(f.name);                          // never inflate node_modules etc.
      },
    });
    const raw = [];
    for (const name of Object.keys(unzipped)) {
      const data = unzipped[name];
      const base = name.split('/').pop();
      raw.push({ relPath: name, file: new File([data], base) });
    }
    return normalize(raw);
  }

  // Strip a single shared root folder (GitHub-style wrapper, picked-folder name,
  // single dropped directory), then skip-filter + size-filter.
  function normalize(raw) {
    let list = raw.map((r) => ({
      relPath: String(r.relPath).replace(/\\/g, '/').replace(/^\/+/, ''),
      file: r.file,
      size: r.file.size,
    })).filter((r) => r.relPath);

    const stripped = stripCommonRoot(list);
    list = stripped.list;

    const accepted = [];
    const skipped = [];
    let totalBytes = 0;
    for (const it of list) {
      const reason = skipReason(it.relPath) || (it.size > MAX_FILE ? 'too-large (>25 MB)' : null);
      if (reason) { skipped.push({ relPath: it.relPath, reason }); continue; }
      accepted.push(it);
      totalBytes += it.size;
    }
    // The stripped folder name is the natural workspace name (e.g. "akasa-dalhousie").
    return { accepted, skipped, totalBytes, name: stripped.root || 'site' };
  }

  // Returns { list, root } — root is the shared top-level folder name that was
  // stripped (used as the workspace name), or null when there was nothing to strip.
  function stripCommonRoot(list) {
    if (!list.length) return { list, root: null };
    let root = null;
    for (const it of list) {
      const seg = it.relPath.split('/')[0];
      if (root === null) root = seg;
      else if (seg !== root) return { list, root: null };   // >1 top-level entry
    }
    // Only strip when EVERY entry is actually nested under "<root>/". A zip may
    // legally contain both a top-level file "report" and a dir "report/…"; a
    // bare "report" would slice to "" and be dropped, so don't strip then.
    if (root && list.every((it) => it.relPath.startsWith(root + '/'))) {
      const out = list
        .map((it) => ({ ...it, relPath: it.relPath.slice(root.length + 1) }))
        .filter((it) => it.relPath);
      return { list: out, root };
    }
    return { list, root: null };
  }

  function skipReason(rel) {
    const segs = rel.split('/');
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (!seg) continue;
      if (seg.startsWith('.')) return 'dot-entry';
      if (i < segs.length - 1 && SKIP_DIRS.has(seg)) return 'skip-dir';
    }
    const base = segs[segs.length - 1];
    if (SKIP_DIRS.has(base)) return 'skip-dir';
    if (SKIP_FILES.has(base)) return 'skip-file';
    return null;
  }

  // ---------------------------------------------------------------------
  //   Orchestration: scan → upload → finish
  // ---------------------------------------------------------------------

  async function start(collectorThunk) {
    cancelled = false;
    showProgress();
    setPhase('Scanning…');
    setMeta('Reading files…');
    setBar(null);

    let collection;
    try { collection = await collectorThunk(); }
    catch (e) { return showError('Could not read the folder: ' + e.message); }

    if (cancelled) return;
    if (!collection.accepted.length) {
      return showError('No usable files found — everything was skipped or the folder was empty.');
    }
    if (collection.accepted.length > MAX_FILES) {
      return showError('Too many files (' + collection.accepted.length + '). The limit is ' + MAX_FILES + '.');
    }
    if (collection.totalBytes > MAX_BYTES) {
      return showError('Folder is too large (limit 500 MB).');
    }
    renderSkipped(collection.skipped);

    setPhase('Uploading…');
    try {
      const info = await uploadAll(collection);
      if (cancelled) return;
      if (loadedCb) loadedCb(info);
    } catch (e) {
      if (!cancelled) showError('Upload failed: ' + e.message);
    }
  }

  async function uploadAll(collection) {
    const { accepted, totalBytes } = collection;

    // begin
    const begin = await postJson('/__cms/api/ingest/begin', {
      name: collection.name || 'site',
      totalFiles: accepted.length,
      totalBytes,
      source: 'web',
    });
    if (!begin.ok) throw new Error(begin.error || 'begin failed');
    // Capture the id locally and pass it explicitly to every request, so a
    // later run's activeUploadId can never be picked up by a straggler worker.
    const uploadId = begin.uploadId;
    activeUploadId = uploadId;

    // batches
    const batches = buildBatches(accepted);
    let completedBytes = 0;
    const inflightLoaded = new Map();  // batchIndex → bytes loaded so far
    const totalFiles = accepted.length;
    let filesDone = 0;
    let failed = false;                // a batch failed permanently → stop the pool

    const reportProgress = () => {
      let inflight = 0;
      for (const v of inflightLoaded.values()) inflight += v;
      const done = Math.min(totalBytes, completedBytes + inflight);
      setBar(totalBytes ? done / totalBytes : 0);
      setMeta(filesDone + ' / ' + totalFiles + ' files · ' + fmtBytes(done) + ' / ' + fmtBytes(totalBytes));
    };
    reportProgress();

    // Concurrency pool of CONCURRENCY workers over the batch queue.
    let next = 0;
    async function worker() {
      while (next < batches.length && !cancelled && !failed) {
        const idx = next++;
        const batch = batches[idx];
        await sendBatchWithRetry(batch, idx, inflightLoaded, reportProgress, uploadId);
        inflightLoaded.delete(idx);
        completedBytes += batch.bytes;
        filesDone += batch.files.length;
        reportProgress();
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    } catch (e) {
      // Stop siblings and abort any in-flight requests so no orphan worker keeps
      // writing into a session we're about to give up on.
      failed = true;
      for (const xhr of inflightXhrs) { try { xhr.abort(); } catch (_) { /* ignore */ } }
      inflightXhrs.clear();
      throw e;
    }
    if (cancelled) throw new Error('cancelled');

    // finish — server diffs manifest vs received; re-upload any missing.
    const manifest = accepted.map((a) => ({ path: a.relPath, size: a.size }));
    let attempts = 0;
    while (true) {
      const fin = await postJson('/__cms/api/ingest/finish', { uploadId, manifest });
      if (fin.ok) return fin;
      if (fin.missing && fin.missing.length && attempts < 3) {
        attempts++;
        setPhase('Re-sending ' + fin.missing.length + ' file(s)…');
        const missingSet = new Set(fin.missing);
        const retryBatches = buildBatches(accepted.filter((a) => missingSet.has(a.relPath)));
        for (const b of retryBatches) {
          if (cancelled) throw new Error('cancelled');
          await sendBatchWithRetry(b, 'retry', new Map(), () => {}, uploadId);
        }
        continue;
      }
      throw new Error(fin.error || 'finish failed');
    }
  }

  function buildBatches(files) {
    const batches = [];
    let cur = [];
    let curBytes = 0;
    for (const f of files) {
      if (cur.length && (cur.length >= BATCH_FILES || curBytes + f.size > BATCH_BYTES)) {
        batches.push({ files: cur, bytes: curBytes });
        cur = []; curBytes = 0;
      }
      cur.push(f); curBytes += f.size;
    }
    if (cur.length) batches.push({ files: cur, bytes: curBytes });
    return batches;
  }

  function sendBatchWithRetry(batch, idx, inflightLoaded, reportProgress, uploadId) {
    const delays = [500, 1500, 4000];
    let attempt = 0;
    const tryOnce = () => sendBatch(batch, idx, inflightLoaded, reportProgress, uploadId).catch((err) => {
      if (cancelled) throw err;
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 404) throw err; // don't retry client errors
      if (attempt >= delays.length) throw err;
      const wait = delays[attempt++];
      return new Promise((r) => setTimeout(r, wait)).then(tryOnce);
    });
    return tryOnce();
  }

  function sendBatch(batch, idx, inflightLoaded, reportProgress, uploadId) {
    return new Promise((resolve, reject) => {
      const fd = new FormData();
      fd.append('uploadId', uploadId);
      fd.append('paths', JSON.stringify(batch.files.map((f) => f.relPath)));
      for (const f of batch.files) fd.append('files', f.file, f.file.name || 'file');

      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/__cms/api/ingest/batch');
      xhr.timeout = 60000;
      inflightXhrs.add(xhr);
      if (idx !== 'retry') {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            // Scale byte progress to the batch's actual file bytes (form has overhead).
            inflightLoaded.set(idx, Math.min(batch.bytes, e.loaded));
            reportProgress();
          }
        };
      }
      xhr.onload = () => {
        inflightXhrs.delete(xhr);
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve({ ok: true }); }
        } else {
          const err = new Error('HTTP ' + xhr.status); err.status = xhr.status; reject(err);
        }
      };
      xhr.onerror = () => { inflightXhrs.delete(xhr); reject(new Error('network error')); };
      xhr.ontimeout = () => { inflightXhrs.delete(xhr); reject(new Error('timeout')); };
      xhr.send(fd);
    });
  }

  async function cancel() {
    cancelled = true;
    for (const xhr of inflightXhrs) { try { xhr.abort(); } catch (e) { /* ignore */ } }
    inflightXhrs.clear();
    if (activeUploadId) {
      try { await postJson('/__cms/api/ingest/abort', { uploadId: activeUploadId }); } catch (e) { /* ignore */ }
      activeUploadId = null;
    }
    hideProgress();
  }

  // ---------------------------------------------------------------------
  //   Small helpers
  // ---------------------------------------------------------------------

  async function postJson(url, body) {
    const r = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    let j;
    try { j = await r.json(); } catch (e) { j = {}; }
    if (!r.ok && j.ok === undefined) j.ok = false;
    if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
    return j;
  }

  function fmtBytes(b) {
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(0) + ' KB';
    return (b / 1024 / 1024).toFixed(1) + ' MB';
  }

  // ---------------------------------------------------------------------
  //   Drop-zone UI state
  // ---------------------------------------------------------------------

  function showProgress() {
    const card = qs('#dropCard'); if (card) card.hidden = true;
    const p = qs('#dropProgress'); if (p) p.hidden = false;
    const err = qs('#dropError'); if (err) err.hidden = true;
  }
  function hideProgress() {
    const card = qs('#dropCard'); if (card) card.hidden = false;
    const p = qs('#dropProgress'); if (p) p.hidden = true;
  }
  function setPhase(t) { const el = qs('#dropPhase'); if (el) el.textContent = t; }
  function setMeta(t) { const el = qs('#dropMeta'); if (el) el.textContent = t; }
  function setBar(frac) {
    const fill = qs('#dropBarFill'); if (!fill) return;
    if (frac === null) { fill.classList.add('indeterminate'); fill.style.width = '35%'; }
    else { fill.classList.remove('indeterminate'); fill.style.width = Math.round(frac * 100) + '%'; }
  }
  function showError(msg) {
    const err = qs('#dropError');
    if (err) { err.hidden = false; err.textContent = msg; }
    setPhase('Something went wrong');
    // Re-offer the card so the user can retry.
    const card = qs('#dropCard'); if (card) card.hidden = false;
  }
  function renderSkipped(skipped) {
    const wrap = qs('#dropSkipped');
    if (!wrap) return;
    if (!skipped || !skipped.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    qs('#dropSkippedCount').textContent = String(skipped.length);
    const list = qs('#dropSkippedList');
    list.innerHTML = skipped.slice(0, 200).map((s) =>
      '<li>' + escHtml(s.relPath) + ' <span class="muted">(' + escHtml(s.reason) + ')</span></li>'
    ).join('');
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  window.cmsIngest = { init };
})();
