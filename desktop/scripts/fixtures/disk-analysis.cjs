const { app } = require('electron');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const fs = require('original-fs').promises;
const root = process.argv[2];
const { DiskExplorer } = require(join(root, 'explorer.cjs'));

app.whenReady().then(async () => {
  const explorer = new DiskExplorer(join(root, 'worker.asar', 'worker.cjs'));
  const directory = await fs.realpath(join(root, 'data'));
  const progress = [];
  const report = await explorer.scan(directory, (value) => progress.push(value));
  assert.equal(report.status, 'complete');
  assert.equal(report.files, 2); // ASAR is one physical file; symlink is not traversed.
  assert.equal(report.largestFiles.length, 1);
  const archive = join(directory, 'Fixture.app/Contents/Resources/app.asar');
  assert.equal(report.largestFiles[0].path, archive);
  assert.equal(report.largestFiles[0].bytes, (await fs.lstat(archive)).blocks * 512);
  assert.ok(progress.length > 0);
  const cancelled = explorer.scan(directory, () => {});
  assert.throws(() => explorer.scan(directory, () => {}), /em andamento/);
  explorer.cancel();
  assert.equal(await cancelled, null);
  assert.equal(explorer.report, null);
  assert.equal((await explorer.scan(directory, () => {})).status, 'complete');
  console.log('Electron disk analysis: packaged worker, physical ASAR, symlinks, progress, cancellation and rescan passed.');
  app.exit(0);
}).catch((error) => { console.error(error); app.exit(1); });
