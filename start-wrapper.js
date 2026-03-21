// start-wrapper.js — choose correct entrypoint whether Render runs from repo root or a nested src folder
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const cwd = process.cwd();
const candidates = [
  path.join(cwd, 'src', 'index.js'),
  path.join(cwd, 'index.js')
];

// prefer src/index.js (most common), but fall back to index.js if not found
let entry = candidates.find(p => fs.existsSync(p));
if (!entry) {
  console.error('start-wrapper: no entrypoint found (tried src/index.js and index.js). Exiting.');
  process.exit(1);
}

console.log(`start-wrapper: launching Node with entry ${entry}`);
const node = spawn(process.execPath, [entry], { stdio: 'inherit' });

node.on('close', code => process.exit(code));
node.on('error', err => {
  console.error('start-wrapper spawn error', err && err.stack || err);
  process.exit(1);
});
