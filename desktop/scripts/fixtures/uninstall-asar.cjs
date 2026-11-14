const assert = require('node:assert/strict');
const { join } = require('node:path');
const { app } = require('electron');
const physical = require('original-fs').promises;
const fixture = process.argv[2];

app.whenReady().then(async () => {
  // Confine discovery to our generated home; never inspect or remove an installed app.
  require('node:os').homedir = () => join(fixture, 'home');
  const readdir = physical.readdir;
  physical.readdir = (path, ...args) => path === '/Applications' ? Promise.resolve([]) : readdir(path, ...args);
  const { uninstallApplication, getSize } = require(join(fixture, 'uninstall.cjs'));
  const bundle = join(fixture, 'home/Applications/Fixture.app');
  const archive = join(bundle, 'Contents/Resources/app.asar');
  const support = join(fixture, 'home/Library/Application Support/Fixture');
  assert.equal(await getSize(archive), (await physical.stat(archive)).size, 'Measure the real ASAR file');
  const result = await uninstallApplication(bundle);
  assert.equal(result.success, true, result.errors.join('\n'));
  assert.equal(result.removedItems, 2, 'Bundle and related support directory');
  assert.ok(result.freedSpace > 0);
  await assert.rejects(physical.lstat(bundle), { code: 'ENOENT' });
  await assert.rejects(physical.lstat(support), { code: 'ENOENT' });
  assert.equal(await physical.readFile(join(fixture, 'outside.txt'), 'utf8'), 'keep me', 'Never follow an app symlink when deleting');
  console.log('PASS: Electron removes ASAR bundles and related data, measures physical bytes, and preserves symlink targets.');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
