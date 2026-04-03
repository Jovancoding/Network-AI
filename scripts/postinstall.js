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
  if (!fs.existsSync(file)) continue;
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('ignoreDeprecations')) continue;
  text = text.replace(
    /"moduleResolution":\s*"node"/,
    '"moduleResolution": "node",\n    "ignoreDeprecations": "6.0"',
  );
  fs.writeFileSync(file, text);
}
