// Regression check in Electron itself: Node-only tests cannot reproduce its virtual ASAR filesystem.
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
const root = join(here, '../..');
const fixture = await mkdtemp(join(tmpdir(), 'disk-mac-uninstall-asar-'));
try {
  const source = join(fixture, 'source');
  const resources = join(fixture, 'home/Applications/Fixture.app/Contents/Resources');
  const support = join(fixture, 'home/Library/Application Support/Fixture');
  await mkdir(source, { recursive: true });
  await mkdir(resources, { recursive: true });
  await mkdir(support, { recursive: true });
  await writeFile(join(source, 'main.js'), 'module.exports = "ASAR fixture";');
  await writeFile(join(support, 'preferences.json'), '{}');
  await writeFile(join(fixture, 'outside.txt'), 'keep me');
  await symlink(join(fixture, 'outside.txt'), join(resources, 'outside-link'));
  await createPackage(source, join(resources, 'app.asar'));
  await writeFile(join(resources, '../Info.plist'), '<plist><dict><key>CFBundleIdentifier</key><string>local.diskmac.fixture</string></dict></plist>');
  await build({
    stdin: { contents: "export { uninstallApplication } from './src/commands/uninstall.ts'; export { getSize } from './src/utils/fs.ts';", resolveDir: root },
    bundle: true, platform: 'node', format: 'cjs', outfile: join(fixture, 'uninstall.cjs'),
  });
  const { stdout } = await promisify(execFile)(electron, [join(here, 'fixtures/uninstall-asar.cjs'), fixture], {
    timeout: 30_000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '' },
  });
  process.stdout.write(stdout);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
