// start-wrapper.js — robust entrypoint selector
// Prefers process.cwd()/index.js (handles Render services where Root Directory is src),
// then falls back to process.cwd()/src/index.js, then process.cwd()/src/src/index.js, then cwd/index.js.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = process.cwd();

const candidates = [
  path.join(cwd, 'index.js'),
  path.join(cwd, 'src', 'index.js'),
  path.join(cwd, 'src', 'src', 'index.js'),
  path.join(cwd, '..', 'src', 'index.js'),
  path.join(cwd, 'dist', 'index.js')
];

// find first existing candidate
let entry = null;
for (const c of candidates) {
  try {
    if (fs.existsSync(c) && fs.statSync(c).isFile()) {
      entry = c;
      break;
    }
  } catch (e) {}
}

if (!entry) {
  console.error('start-wrapper: no entrypoint found. Tried:');
  console.error(candidates.join('\n'));
  console.error('process.cwd():', cwd);
  process.exit(1);
}

console.log(`start-wrapper: launching Node with entry ${entry}`);
const node = spawn(process.execPath, [entry], { stdio: 'inherit' });

node.on('close', code => process.exit(code));
node.on('error', err => {
  console.error('start-wrapper spawn error', err && err.stack || err);
  process.exit(1);
});
