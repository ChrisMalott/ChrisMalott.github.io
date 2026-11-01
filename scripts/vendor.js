// Copies the ffmpeg.wasm files from node_modules into /vendor so they are self-hosted.
// Run after `npm install` whenever you bump the @ffmpeg/* versions: `npm run vendor`.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nm = path.join(root, 'node_modules', '@ffmpeg');
const out = path.join(root, 'vendor');

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log('vendor:', path.relative(root, to));
}

// @ffmpeg/ffmpeg (MIT): the small ES-module wrapper + its web worker.
const ffDir = path.join(nm, 'ffmpeg', 'dist', 'esm');
for (const f of fs.readdirSync(ffDir)) {
  if (f.endsWith('.js') || f.endsWith('.mjs')) copy(path.join(ffDir, f), path.join(out, 'ffmpeg', f));
}
// @ffmpeg/core (GPL-2.0-or-later): SINGLE-THREAD build only (not @ffmpeg/core-mt).
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  copy(path.join(nm, 'core', 'dist', 'esm', f), path.join(out, 'ffmpeg-core', f));
}
// Record exact versions for the credits page / license compliance.
const versions = {
  '@ffmpeg/ffmpeg': require(path.join(nm, 'ffmpeg', 'package.json')).version,
  '@ffmpeg/core': require(path.join(nm, 'core', 'package.json')).version,
};
fs.writeFileSync(path.join(out, 'VERSIONS.json'), JSON.stringify(versions, null, 2) + '\n');
console.log('vendor: VERSIONS.json', versions);
