import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testProjectDir = path.resolve(__dirname, '..');
const packageRoot = path.resolve(testProjectDir, '..');
const nodeModulesDir = path.join(testProjectDir, 'node_modules');
const linkPath = path.join(nodeModulesDir, 'shotest');
const binDir = path.join(nodeModulesDir, '.bin');
const binLinkPath = path.join(binDir, 'shotest');
const binTarget = path.join('..', 'shotest', 'build', 'cli.js');

fs.mkdirSync(nodeModulesDir, { recursive: true });

try {
  if (fs.existsSync(linkPath) && fs.realpathSync(linkPath) === packageRoot) {
    fs.mkdirSync(binDir, { recursive: true });
    fs.rmSync(binLinkPath, { force: true });
    fs.symlinkSync(binTarget, binLinkPath);
    process.exit(0);
  }
} catch {
}

fs.rmSync(linkPath, { recursive: true, force: true });

const relativeTarget = path.relative(nodeModulesDir, packageRoot) || '.';
fs.symlinkSync(relativeTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

fs.mkdirSync(binDir, { recursive: true });
fs.rmSync(binLinkPath, { force: true });
fs.symlinkSync(binTarget, binLinkPath);