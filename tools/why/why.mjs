import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { inspectSnapshotKey } from './inspect.mjs';

const usage = 'Usage: npm run --silent why -- <snapshot.json> <key> [--source-links <inventory.json>]';
const maxBytes = 16 * 1024 * 1024;

async function readJson(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) {
      throw new Error('Expected a regular JSON file of at most 16 MiB.');
    }
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== stat.size) throw new Error('The JSON file changed size while being read.');
    try {
      return JSON.parse(buffer.toString('utf8', 0, offset));
    } catch {
      throw new Error('The input is not valid JSON.');
    }
  } finally {
    await file.close();
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean' }, 'source-links': { type: 'string' } },
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length !== 2) throw new Error(usage);
  const [snapshotPath, key] = positionals;
  const snapshot = await readJson(snapshotPath);
  const sourceLinks = values['source-links'] === undefined ? undefined : await readJson(values['source-links']);
  console.log(JSON.stringify(await inspectSnapshotKey(snapshot, key, sourceLinks), null, 2));
}

try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
