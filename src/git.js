'use strict';

/**
 * Thin wrapper around the local `git` CLI.
 * Every function returns a promise.
 *
 * Why CLI not a library?
 *   - No PAT / API auth flow. Uses your existing creds (SSH key, GH CLI, Helper).
 *   - Provider-agnostic: GitHub / Bitbucket / GitLab / self-hosted all work the same.
 *   - Tiny: under 250 lines.
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * Run a git command in `cwd`. Resolves with { code, stdout, stderr }.
 * Never throws on non-zero exit; the caller decides what to do.
 */
function run(args, cwd, opts = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    }
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      resolve({ code: -1, stdout: '', stderr: err.message });
    });
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function isGitInstalled() {
  const r = await run(['--version'], process.cwd());
  return r.code === 0;
}

/**
 * If the given dir (or any ancestor) is inside a git repo, return its top-level path.
 * Otherwise null.
 */
async function repoRoot(dir) {
  const r = await run(['rev-parse', '--show-toplevel'], dir);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

async function currentBranch(dir) {
  const r = await run(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  if (r.code !== 0) return null;
  const b = r.stdout.trim();
  return b === 'HEAD' ? null : b;
}

async function hasRemote(dir, name = 'origin') {
  const r = await run(['remote'], dir);
  if (r.code !== 0) return false;
  return r.stdout.split('\n').map((s) => s.trim()).includes(name);
}

async function remoteUrl(dir, name = 'origin') {
  const r = await run(['remote', 'get-url', name], dir);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * Returns ahead/behind counts vs the remote tracking branch.
 * If no upstream is set, ahead = totalCommits, behind = 0.
 */
async function aheadBehind(dir) {
  const upstream = await run(['rev-parse', '--abbrev-ref', '@{upstream}'], dir);
  if (upstream.code !== 0) {
    // No upstream configured; report total commits as "ahead"
    const total = await run(['rev-list', '--count', 'HEAD'], dir);
    if (total.code !== 0) return { ahead: 0, behind: 0, hasUpstream: false };
    return { ahead: parseInt(total.stdout.trim(), 10) || 0, behind: 0, hasUpstream: false };
  }
  const r = await run(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], dir);
  if (r.code !== 0) return { ahead: 0, behind: 0, hasUpstream: true };
  const parts = r.stdout.trim().split(/\s+/);
  return {
    ahead: parseInt(parts[0], 10) || 0,
    behind: parseInt(parts[1], 10) || 0,
    hasUpstream: true,
    upstream: upstream.stdout.trim(),
  };
}

/**
 * Parse `git status --porcelain=v1` into a structured list.
 * Each entry: { x, y, path }
 *   x = index status, y = working-tree status (one char each)
 */
async function status(dir) {
  const r = await run(['status', '--porcelain=v1', '-z'], dir);
  if (r.code !== 0) return [];
  // -z is null-separated, more robust against newlines/spaces in filenames
  const out = [];
  const items = r.stdout.split('\0').filter(Boolean);
  for (const item of items) {
    if (item.length < 3) continue;
    out.push({
      x: item[0],
      y: item[1],
      path: item.slice(3),
    });
  }
  return out;
}

async function log(dir, n = 5) {
  const r = await run(
    ['log', '-n', String(n), '--pretty=format:%H%x09%s%x09%cr'],
    dir
  );
  if (r.code !== 0) return [];
  return r.stdout.trim().split('\n').filter(Boolean).map((line) => {
    const [hash, subject, when] = line.split('\t');
    return { hash: hash.slice(0, 8), full: hash, subject, when };
  });
}

/**
 * Initialise a fresh repo at `dir`. Creates main branch, .gitignore, first commit.
 * Optionally adds a remote.
 */
async function init(dir, opts = {}) {
  const initRes = await run(['init', '-b', 'main'], dir);
  if (initRes.code !== 0) {
    throw new Error('git init failed: ' + initRes.stderr.trim());
  }

  // Write a sane .gitignore if one doesn't exist
  const ignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(ignorePath)) {
    fs.writeFileSync(ignorePath, [
      '# cms-static defaults',
      '_minified/',
      '_formatted/',
      'node_modules/',
      '.DS_Store',
      '*.log',
      '',
    ].join('\n'));
  }

  // Set local user.name / user.email if absent (so commit doesn't fail)
  const nameRes = await run(['config', 'user.name'], dir);
  if (nameRes.code !== 0 || !nameRes.stdout.trim()) {
    await run(['config', 'user.name', opts.userName || 'cms-static'], dir);
  }
  const emailRes = await run(['config', 'user.email'], dir);
  if (emailRes.code !== 0 || !emailRes.stdout.trim()) {
    await run(['config', 'user.email', opts.userEmail || 'cms-static@local'], dir);
  }

  // First commit
  await run(['add', '-A'], dir);
  const commitRes = await run(['commit', '-m', opts.message || 'Initial commit from cms-static'], dir);
  if (commitRes.code !== 0) {
    // Allow empty repo (no files); not necessarily fatal
    if (!/nothing to commit/i.test(commitRes.stdout + commitRes.stderr)) {
      throw new Error('git commit failed: ' + commitRes.stderr.trim());
    }
  }

  if (opts.remote) {
    const remoteRes = await run(['remote', 'add', 'origin', opts.remote], dir);
    if (remoteRes.code !== 0) {
      throw new Error('git remote add failed: ' + remoteRes.stderr.trim());
    }
  }

  return { ok: true };
}

/**
 * Stage and commit. If `files` is empty, stage everything.
 */
async function commit(dir, message, files) {
  if (!message || !message.trim()) {
    throw new Error('commit message required');
  }
  if (Array.isArray(files) && files.length) {
    const addRes = await run(['add', '--', ...files], dir);
    if (addRes.code !== 0) {
      throw new Error('git add failed: ' + addRes.stderr.trim());
    }
  } else {
    const addRes = await run(['add', '-A'], dir);
    if (addRes.code !== 0) {
      throw new Error('git add failed: ' + addRes.stderr.trim());
    }
  }

  const r = await run(['commit', '-m', message], dir);
  if (r.code !== 0) {
    if (/nothing to commit/i.test(r.stdout + r.stderr)) {
      return { ok: true, empty: true };
    }
    throw new Error(r.stderr.trim() || r.stdout.trim() || 'git commit failed');
  }
  // Capture the new commit hash
  const head = await run(['rev-parse', 'HEAD'], dir);
  return { ok: true, hash: head.stdout.trim() };
}

/**
 * Push the current branch. Sets upstream automatically on first push.
 */
async function push(dir) {
  const branch = await currentBranch(dir);
  if (!branch) throw new Error('no current branch');

  // Check if upstream exists. If not, push --set-upstream.
  const upstreamRes = await run(['rev-parse', '--abbrev-ref', '@{upstream}'], dir);
  const args = upstreamRes.code === 0
    ? ['push']
    : ['push', '-u', 'origin', branch];

  const r = await run(args, dir);
  if (r.code !== 0) {
    throw new Error(r.stderr.trim() || 'git push failed');
  }
  return { ok: true, log: r.stdout.trim() || r.stderr.trim() };
}

/**
 * Aggregate state for the editor's Git panel.
 */
async function fullState(siteRoot) {
  const out = {
    installed: false,
    isRepo: false,
    repoRoot: null,
    hasRemote: false,
    remoteUrl: null,
    branch: null,
    ahead: 0,
    behind: 0,
    hasUpstream: false,
    upstream: null,
    dirty: 0,
    log: [],
  };

  out.installed = await isGitInstalled();
  if (!out.installed) return out;

  const root = await repoRoot(siteRoot);
  if (!root) return out;
  out.isRepo = true;
  out.repoRoot = root;

  out.branch = await currentBranch(root);
  out.hasRemote = await hasRemote(root);
  if (out.hasRemote) out.remoteUrl = await remoteUrl(root);

  const ab = await aheadBehind(root);
  out.ahead = ab.ahead;
  out.behind = ab.behind;
  out.hasUpstream = ab.hasUpstream;
  out.upstream = ab.upstream || null;

  const st = await status(root);
  out.dirty = st.length;

  out.log = await log(root, 5);

  return out;
}

module.exports = {
  isGitInstalled,
  repoRoot,
  currentBranch,
  hasRemote,
  remoteUrl,
  aheadBehind,
  status,
  log,
  init,
  commit,
  push,
  fullState,
};
