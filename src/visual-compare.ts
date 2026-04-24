import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ODiffServer } from 'odiff-bin';

const odiffOptions = {
  antialiasing: true,
};

let odiffServer: ODiffServer | undefined;
let odiffDiffSequence = 0;
const odiffTempDir = path.join(os.tmpdir(), 'shotest-odiff', String(process.pid));
const comparisonCache = new Map<string, Promise<boolean>>();

fs.mkdirSync(odiffTempDir, { recursive: true });

function getOdiffServer(): ODiffServer {
  if (!odiffServer) {
    odiffServer = new ODiffServer();
    process.once('exit', () => {
      odiffServer?.stop();
    });
  }
  return odiffServer;
}

function createDiscardDiffPath(): string {
  return path.join(odiffTempDir, `diff-${odiffDiffSequence++}.png`);
}

function getFileSignature(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${filePath}:${stat.size}:${stat.mtimeMs}`;
}

function getComparisonCacheKey(acceptedFile: string, currentFile: string): string {
  return `${getFileSignature(acceptedFile)}=>${getFileSignature(currentFile)}`;
}

export async function areImagesEquivalent(acceptedFile: string, currentFile: string): Promise<boolean> {
  const cacheKey = getComparisonCacheKey(acceptedFile, currentFile);
  const cachedComparison = comparisonCache.get(cacheKey);
  if (cachedComparison) {
    return cachedComparison;
  }

  const comparison = (async () => {
    const diffPath = createDiscardDiffPath();

    try {
      const result = await getOdiffServer().compare(acceptedFile, currentFile, diffPath, odiffOptions);
      return result.match;
    } finally {
      if (fs.existsSync(diffPath)) {
        fs.rmSync(diffPath, { force: true });
      }
    }
  })();

  comparisonCache.set(cacheKey, comparison);

  try {
    return await comparison;
  } catch (error) {
    comparisonCache.delete(cacheKey);
    throw error;
  }
}