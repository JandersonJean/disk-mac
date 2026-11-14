import * as nodeFs from 'fs/promises';
import { createRequire } from 'node:module';

/** Work on installed files, not Electron's virtual directories inside ASAR archives.
 * Keep ordinary Node/Bun behavior for the CLI and avoid changing process.noAsar globally.
 */
export const physicalFs: typeof nodeFs = process.versions.electron
  ? createRequire(process.execPath)('original-fs').promises
  : nodeFs;
