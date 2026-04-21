import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const resultsDir = path.join(root, 'test-results');
const acceptedDir = path.join(root, 'test-accepted');

if (!fs.existsSync(resultsDir)) {
  console.error('test-results does not exist. Run tests first.');
  process.exit(1);
}

fs.mkdirSync(acceptedDir, { recursive: true });

function copyPngTree(fromDir, toDir) {
  const entries = fs.readdirSync(fromDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(fromDir, entry.name);
    const dst = path.join(toDir, entry.name);

    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyPngTree(src, dst);
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.png')) {
      fs.copyFileSync(src, dst);
    }
  }
}

copyPngTree(resultsDir, acceptedDir);
console.log('Copied PNG baselines to test-accepted');
