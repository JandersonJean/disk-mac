// All paths, including the simulated home directory, belong to a temporary fixture.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';
import electron from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = await mkdtemp(join(tmpdir(), 'disk-mac-backups-electron-'));
try {
  await mkdir(join(fixture, 'source'));
  await mkdir(join(fixture, 'home/Documents'), { recursive: true });
  await writeFile(join(fixture, 'source/main.js'), 'fixture'.repeat(3000));
  await createPackage(join(fixture, 'source'), join(fixture, 'home/Documents/fixture.asar'));
  await build({ entryPoints: [join(here, '../../src/utils/backup.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(fixture, 'backup.cjs') });
  const { stdout } = await promisify(execFile)(electron, [join(here, 'fixtures/backups.cjs'), fixture], {
    timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  process.stdout.write(stdout);
} finally { await rm(fixture, { recursive: true, force: true }); }
