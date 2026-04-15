#!/usr/bin/env node
import { build } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(thisDir, '..');
const uiDir = path.join(rootDir, 'src', 'review-ui');
const tempDir = path.join(rootDir, '.review-ui-build');
const outputPath = path.join(rootDir, 'src', 'review-ui.html');

await build({
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

await fs.copyFile(path.join(tempDir, 'index.html'), outputPath);
await fs.rm(tempDir, { recursive: true, force: true });
console.log(`Built ${path.relative(rootDir, outputPath)}`);
