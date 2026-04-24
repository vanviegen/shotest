import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(thisDir, '..');
const buildDir = path.join(rootDir, 'build');
const frontendDir = path.join(rootDir, 'frontend');
const frontendBuildDir = path.join(rootDir, 'build.frontend');
const nodeTsconfigPath = path.join(rootDir, 'tsconfig.json');
const frontendTsconfigPath = path.join(frontendDir, 'tsconfig.json');
const tscBin = path.join(rootDir, 'node_modules', 'typescript', 'bin', 'tsc');

function runTypeScriptBuild(tsconfigPath: string) {
  execFileSync(process.execPath, [tscBin, '-p', tsconfigPath], {
    cwd: rootDir,
    stdio: 'inherit',
  });
}

async function main() {
  await fs.rm(buildDir, { recursive: true, force: true });
  await fs.rm(frontendBuildDir, { recursive: true, force: true });

  try {
    runTypeScriptBuild(nodeTsconfigPath);
    runTypeScriptBuild(frontendTsconfigPath);
  } catch (error) {
    console.error('\nTypeScript build failed. Make sure dependencies are installed.\n');
    throw error;
  }

  await viteBuild({
    root: frontendDir,
    base: './',
    plugins: [viteSingleFile()],
    logLevel: 'error',
    build: {
      outDir: frontendBuildDir,
      emptyOutDir: true,
      minify: false,
      cssCodeSplit: false,
      rollupOptions: {
        input: path.join(frontendDir, 'index.html'),
      },
    },
  });

  await fs.chmod(path.join(buildDir, 'cli.js'), 0o755);

  console.log(`Built ${path.relative(rootDir, path.join(buildDir, 'index.js'))}`);
  console.log(`Built ${path.relative(rootDir, path.join(buildDir, 'cli.js'))}`);
  console.log(`Built ${path.relative(rootDir, path.join(frontendBuildDir, 'index.html'))}`);
}

await main();