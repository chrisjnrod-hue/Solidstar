// start-wrapper.js — robust entrypoint selector (improved)
// Prefers several likely entry files from various CWDs including parent dirs.
// This helps Render where the process CWD may be /opt/render/project/src.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = process.cwd();

// Build candidate list relative to current cwd and some parent locations.
// We try a mix of likely locations so the wrapper works whether Render sets the CWD
// to the repo root or to the repo/src directory.
const candidates = [
  path.join(cwd, 'index.js'),
  path.join(cwd, 'src', 'index.js'),
  path.join(cwd, 'src', 'src', 'index.js'),
  path.join(cwd, 'dist', 'index.js'),

  // Try one level up (covers case when CWD is /opt/render/project/src but files are in repo root)
  path.join(cwd, '..', 'index.js'),
  path.join(cwd, '..', 'src', 'index.js'),
  path.join(cwd, '..', 'dist', 'index.js'),

  // Try two levels up (rare but possible in odd build setups)
  path.join(cwd, '..', '..', 'index.js'),
  path.join(cwd, '..', '..', 'src', 'index.js'),

  // Also try __dirname relative candidates (file location)
  path.join(__dirname, 'index.js'),
  path.join(__dirname, 'src', 'index.js'),
];

function findFirstExisting(paths) {
  for (const p of paths) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    } catch (e) {
      // ignore
    }
  }
  return null;
}

const entry = findFirstExisting(candidates);

if (!entry) {
  console.error('start-wrapper: no entrypoint found. Tried:');
  for (const c of candidates) console.error(' ', c);
  console.error('process.cwd():', process.cwd());
  console.error('__dirname:', __dirname);
  process.exit(1);
}

console.log(`start-wrapper: launching Node with entry ${entry}`);
const node = spawn(process.execPath, [entry], { stdio: 'inherit' });

node.on('close', code => process.exit(code));
node.on('error', err => {
  console.error('start-wrapper spawn error', err && err.stack || err);
  process.exit(1);
});
