// launch.js — robust launcher + diagnostics for Render
// Prints cwd/files, finds an absolute entry for src/index.js and execs Node with it.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function statSafe(p) {
  try { return fs.statSync(p); } catch (e) { return null; }
}

console.log('=== LAUNCHER START ===');
console.log('process.cwd():', process.cwd());
console.log('__dirname:', __dirname);

// Candidate entry paths to try (absolute resolved)
const candidates = [
  path.resolve(process.cwd(), 'src', 'index.js'),
  path.resolve(process.cwd(), 'index.js'),
  path.resolve(__dirname, 'src', 'index.js'),
  path.resolve(__dirname, 'index.js'),
  path.resolve(process.cwd(), '..', 'src', 'index.js'),
  path.resolve(process.cwd(), '..', '..', 'src', 'index.js')
];

console.log('Checking candidate paths:');
for (const c of candidates) {
  const s = statSafe(c);
  console.log(' ', c, 'exists=', !!s, s ? `${s.size} bytes` : '');
}

const entry = candidates.find(c => statSafe(c) && statSafe(c).isFile());

if (!entry) {
  console.error('No entry file found among candidates. Listing cwd and src dir:');
  try { console.log('PWD listing:'); console.log(fs.readdirSync(process.cwd())); } catch (e) { console.error(e && e.message); }
  try { console.log('SRC listing:'); console.log(fs.readdirSync(path.resolve(process.cwd(), 'src'))); } catch (e) { console.error('SRC list failed:', e && e.message); }
  console.error('Aborting - cannot find app entrypoint.');
  process.exit(1);
}

console.log('Selected entry:', entry);
console.log('Launching node', process.execPath, entry);

const child = spawn(process.execPath, ['--trace-warnings', entry], { stdio: 'inherit' });

child.on('close', code => {
  console.log('Child exited with code', code);
  process.exit(code);
});
child.on('error', err => {
  console.error('Child spawn error', err && err.stack || err);
  process.exit(1);
});