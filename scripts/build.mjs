#!/usr/bin/env node
import { execFileSync } from 'child_process';
import { build as viteBuild } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(thisDir, '..');
const buildDir = path.join(rootDir, 'build');
const uiDir = path.join(rootDir, 'src', 'review-ui');
const tempDir = path.join(rootDir, '.review-ui-build');
const tsconfigPath = path.join(rootDir, 'tsconfig.json');
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');
const reviewUiOutputPath = path.join(buildDir, 'review-ui.html');

async function main() {
  await fs.rm(buildDir, { recursive: true, force: true });

  try {
    execFileSync(process.execPath, [tscBin, '-p', tsconfigPath], {
      cwd: rootDir,
      stdio: 'inherit',
    });
  } catch (error) {
    console.error('\nTypeScript build failed. Make sure dependencies are installed.\n');
    throw error;
  }

  await viteBuild({
    root: uiDir,
    base: './',
    plugins: [viteSingleFile()],
    logLevel: 'error',
    build: {
      outDir: tempDir,
      emptyOutDir: true,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: path.join(uiDir, 'index.html'),
      },
    },
  });

  await fs.mkdir(buildDir, { recursive: true });
  await fs.copyFile(path.join(tempDir, 'index.html'), reviewUiOutputPath);
  await fs.rm(tempDir, { recursive: true, force: true });

  console.log(`Built ${path.relative(rootDir, path.join(buildDir, 'index.js'))}`);
  console.log(`Built ${path.relative(rootDir, reviewUiOutputPath)}`);
}

await main();
