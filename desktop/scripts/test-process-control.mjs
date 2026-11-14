// Signals are restricted to the exact temporary children created by this fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { build } from 'esbuild';

if (process.platform !== 'darwin') throw new Error('This integration test requires macOS ps.');
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = await mkdtemp(join(tmpdir(), 'disk-mac-process-fixture-'));
try {
  await build({ stdin: { contents: "export { ProcessController } from './src/main/process-control.ts'; export { readProcessRecords } from './src/main/process-inventory.ts';", resolveDir: desktop }, bundle: true, platform: 'node', format: 'cjs', outfile: join(fixture, 'control.cjs') });
  const { ProcessController, readProcessRecords } = createRequire(import.meta.url)(join(fixture, 'control.cjs'));
  const owner = await stat(desktop);
  // Under an elevated runner, use the workspace owner for the disposable process.
  const uid = process.getuid() === 0 ? owner.uid : process.getuid();
  assert.notEqual(uid, 0, 'Run from a workspace owned by a non-root user.');
  for (const ignoreTerm of [false, true]) {
    const child = spawn(process.execPath, ['-e', `${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''} console.log('ready'); setInterval(()=>{},1000);`], {
      cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'], ...(process.getuid() === 0 ? { uid, gid: owner.gid } : {}),
    });
    const exit = once(child, 'exit');
    const signals = [];
    try {
      const [output] = await once(child.stdout, 'data', { signal: AbortSignal.timeout(5000) });
      assert.match(output.toString(), /ready/);
      const records = await readProcessRecords();
      const target = records.find((item) => item.pid === child.pid);
      assert.ok(target, 'Fixture must be visible through the real macOS ps parser.');
      assert.equal(target.uid, uid);
      const controller = new ProcessController({
        read: readProcessRecords,
        // Simulate an unrelated app. Default policy deliberately blocks the app's own children.
        policy: () => ({ selfPid: 2147483647, currentUid: uid }), now: Date.now, wait: delay,
        signal: (pid, signal) => { assert.equal(pid, child.pid); signals.push(signal); process.kill(pid, signal); },
      });
      let review = await controller.review(target);
      const normal = await controller.terminate(review.token, 'terminate');
      assert.equal(normal.status, ignoreTerm ? 'running' : 'exited');
      assert.deepEqual(signals, ['SIGTERM']);
      if (ignoreTerm) {
        review = await controller.review(target);
        assert.equal((await controller.terminate(review.token, 'force')).status, 'exited');
        assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
      }
      const [, signal] = await exit;
      assert.equal(signal, ignoreTerm ? 'SIGKILL' : 'SIGTERM');
      console.log(`PASS disposable child: ${ignoreTerm ? 'ignored SIGTERM, explicit SIGKILL confirmed' : 'SIGTERM confirmed'}`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exit; }
    }
  }
} finally { await rm(fixture, { recursive: true, force: true }); }
