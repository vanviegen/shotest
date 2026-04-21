import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const resultsRoot = path.join(root, 'test-project', 'test-results');
const acceptedRoot = path.join(root, 'test-project', 'test-accepted');

function listRelativePngs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  const out = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (entry.isFile() && entry.name.endsWith('.png')) {
        out.push(path.relative(baseDir, abs).split(path.sep).join('/'));
      }
    }
  }

  walk(baseDir);
  out.sort();
  return out;
}

function comparePngTrees() {
  const resultFiles = listRelativePngs(resultsRoot);
  const acceptedFiles = listRelativePngs(acceptedRoot);

  if (resultFiles.length === 0) {
    throw new Error('No PNG files found in test-project/test-results');
  }

  if (acceptedFiles.length === 0) {
    throw new Error('No PNG files found in test-project/test-accepted');
  }

  const missingInAccepted = resultFiles.filter((f) => !acceptedFiles.includes(f));
  const missingInResults = acceptedFiles.filter((f) => !resultFiles.includes(f));

  if (missingInAccepted.length || missingInResults.length) {
    const lines = [];
    if (missingInAccepted.length) {
      lines.push('Missing in accepted:');
      for (const rel of missingInAccepted) lines.push(`  ${rel}`);
    }
    if (missingInResults.length) {
      lines.push('Missing in results:');
      for (const rel of missingInResults) lines.push(`  ${rel}`);
    }
    throw new Error(lines.join('\n'));
  }

  const changed = [];
  for (const rel of resultFiles) {
    const resBuf = fs.readFileSync(path.join(resultsRoot, rel));
    const accBuf = fs.readFileSync(path.join(acceptedRoot, rel));
    if (!resBuf.equals(accBuf)) changed.push(rel);
  }

  if (changed.length) {
    throw new Error(`Binary PNG mismatch in ${changed.length} file(s):\n${changed.map((f) => `  ${f}`).join('\n')}`);
  }

  console.log(`Verified ${resultFiles.length} PNG file(s): test-results matches test-accepted`);
}

try {
  comparePngTrees();
} catch (error) {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
}
