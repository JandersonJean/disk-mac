// Uses only temporary fixture data; never optimizes services or trashes real files.
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { createPackage } from '@electron/asar';
import electron from 'electron';

const here = dirname(fileURLToPath(import.meta.url));
const desktop = join(here, '..');
const fixture = await mkdtemp(join(tmpdir(), 'disk-mac-analysis-'));
try {
  const source = join(fixture, 'source');
  const resources = join(fixture, 'data/Fixture.app/Contents/Resources');
  await mkdir(source, { recursive: true });
  await mkdir(resources, { recursive: true });
  await writeFile(join(source, 'main.js'), 'fixture content'.repeat(4000));
  await createPackage(source, join(resources, 'app.asar'));
  await symlink(join(fixture, 'data'), join(fixture, 'data/loop'));
  await build({ entryPoints: [join(desktop, 'src/main/disk-analysis-worker.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(fixture, 'worker/worker.cjs') });
  await build({ entryPoints: [join(desktop, 'src/main/disk-explorer.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: join(fixture, 'explorer.cjs') });
  await createPackage(join(fixture, 'worker'), join(fixture, 'worker.asar'));
  const { stdout } = await promisify(execFile)(electron, [join(here, 'fixtures/disk-analysis.cjs'), fixture], {
    timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  process.stdout.write(stdout);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
