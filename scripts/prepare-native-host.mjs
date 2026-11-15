// Owned evidence deliberately rejects aliases. Hosted macOS /var and Windows
// short-name TEMP paths must resolve before tests create their scratch roots.
import {appendFile, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';

const temporary = await realpath(process.env.RUNNER_TEMP || tmpdir());
if (!process.env.GITHUB_ENV) throw Error('GITHUB_ENV is required');
await appendFile(process.env.GITHUB_ENV, ['TMPDIR', 'TMP', 'TEMP'].map(name => `${name}=${temporary}\n`).join(''));
console.log(`Native scratch directory: ${temporary}`);
