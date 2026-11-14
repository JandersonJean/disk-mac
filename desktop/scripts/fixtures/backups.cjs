const { app } = require('electron');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const fs = require('original-fs').promises;
const root = process.argv[2];
const home = join(root, 'home');
require('os').homedir = () => home;
const backup = require(join(root, 'backup.cjs'));

app.whenReady().then(async () => {
  const session = await backup.ensureBackupDir();
  const archive = join(home, 'Documents', 'fixture.asar');
  const content = await fs.readFile(archive);
  const normal = join(home, 'Documents', 'document.txt');
  await fs.writeFile(normal, 'old backup');
  for (const path of [archive, normal]) assert.equal(await backup.backupItem({ path, size: 100, name: 'fixture', isDirectory: false }, session), true);
  await fs.writeFile(normal, 'new current file');
  const first = await backup.restoreBackup(session);
  assert.equal(first.success, 1);
  assert.equal(first.failed, 1);
  assert.ok((await fs.lstat(archive)).isFile());
  assert.deepEqual(await fs.readFile(archive), content);
  assert.equal(await fs.readFile(normal, 'utf8'), 'new current file');
  assert.equal(await fs.readFile(join(session, 'HOME/Documents/document.txt'), 'utf8'), 'old backup');
  // Delete only this test fixture's new file to exercise the successful retry.
  await fs.unlink(normal);
  assert.equal((await backup.restoreBackup(session)).success, 1);
  assert.equal(await fs.readFile(normal, 'utf8'), 'old backup');
  await assert.rejects(fs.lstat(session), { code: 'ENOENT' });
  console.log('Electron backups: physical ASAR round trip, conflict preservation and successful retry passed.');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
