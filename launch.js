// launch.js — robust launcher + diagnostics for Render
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function statSafe(p) { try { return fs.statSync(p); } catch (e) { return null; } }

console.log('=== LAUNCHER START ===');
console.log('process.cwd():', process.cwd());
console.log('__dirname:', __dirname);

const candidates = [
  path.resolve(process.cwd(), 'src', 'index.js'),
  path.resolve(process.cwd(), 'index.js'),
  path.resolve(__dirname, 'src', 'index.js'),
  path.resolve(__dirname, 'index.js')
];

console.log('Checking candidate paths:');
for (const c of candidates) {
  const s = statSafe(c);
  console.log(' ', c, 'exists=', !!s, s ? `${s.size} bytes` : '');
}

const entry = candidates.find(c => statSafe(c) && statSafe(c).isFile());
if (!entry) {
  console.error('No entry file found. Listing cwd and src:');
  try { console.log(fs.readdirSync(process.cwd())); } catch (e) {}
  try { console.log(fs.readdirSync(path.resolve(process.cwd(), 'src'))); } catch (e) {}
  process.exit(1);
}

console.log('Selected entry:', entry);
const child = spawn(process.execPath, ['--trace-warnings', entry], { stdio: 'inherit' });

child.on('close', code => {
  console.log('Child exited with code', code);
  process.exit(code);
});
child.on('error', err => {
  console.error('Child spawn error', err && err.stack || err);
  process.exit(1);
});
