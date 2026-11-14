import { parentPort, workerData } from 'node:worker_threads';
import { analyzeDisk } from './disk-analysis.js';

void analyzeDisk(workerData.path, { onProgress: (progress) => parentPort?.postMessage({ type: 'progress', progress }) })
  .then((report) => parentPort?.postMessage({ type: 'result', report }))
  .catch((error) => parentPort?.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Não foi possível analisar esta pasta.' }));
