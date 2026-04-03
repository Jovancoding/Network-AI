/**
 * postinstall: patch third-party tsconfig files that trigger TS 6.x deprecation warnings.
 * Safe to run repeatedly — skips files that are already patched or missing.
 */
const fs = require('fs');
const path = require('path');

const targets = [
  path.join(__dirname, '..', 'node_modules', 'openai', 'src', 'tsconfig.json'),
];

for (const file of targets) {
  // Use fd-based read+write to avoid TOCTOU race (CodeQL #106)
  let fd;
  try {
    fd = fs.openSync(file, 'r+');
  } catch {
    continue; // file doesn't exist — skip
  }
  try {
    const text = fs.readFileSync(fd, 'utf8');
    if (text.includes('ignoreDeprecations')) continue;
    const patched = text.replace(
      '"moduleResolution": "node"',
      '"moduleResolution": "node",\n    "ignoreDeprecations": "6.0"',
    );
    if (patched !== text) {
      fs.ftruncateSync(fd);
      fs.writeSync(fd, patched, 0, 'utf8');
    }
  } finally {
    fs.closeSync(fd);
  }
}
