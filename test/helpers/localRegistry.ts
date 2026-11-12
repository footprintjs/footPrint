/**
 * A loopback-only npm registry that serves one package, `footprintjs@<version>`, from a local archive,
 * so a test can run an install that needs a registry (the consumer audit's published leg) without the
 * network. Used by test/architecture/consumer-install.test.ts and consumer-repeat-process.test.ts.
 * It listens on 127.0.0.1: where a sandbox forbids that, those tests fail there and CI is their check.
 */
import { spawn } from 'node:child_process';

export async function localRegistry(archive: string, version = '9.48.3') {
  // Separate process: swap invokes npm synchronously while this loopback-only registry serves it.
  const server = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
const archive = readFileSync(process.argv[1]);
const version = process.argv[2];
const integrity = 'sha512-' + createHash('sha512').update(archive).digest('base64');
const server = createServer((request, response) => {
  if (request.url === '/footprintjs.tgz') return response.end(archive);
  if (request.url !== '/footprintjs') { response.writeHead(404); return response.end(); }
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify({ name: 'footprintjs', 'dist-tags': { latest: version }, versions: {
    [version]: { name: 'footprintjs', version, dist: {
      tarball: 'http://127.0.0.1:' + server.address().port + '/footprintjs.tgz', integrity,
    } },
  } }));
});
server.listen(0, '127.0.0.1', () => console.log('http://127.0.0.1:' + server.address().port));`,
      archive,
      version,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const url = await new Promise<string>((resolve, reject) => {
    let errorOutput = '';
    server.stderr.on('data', (data) => (errorOutput += data.toString()));
    const timeout = setTimeout(() => {
      server.kill();
      reject(new Error('local fixture registry did not start'));
    }, 10_000);
    server.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`local fixture registry exited (${code}): ${errorOutput}`));
    });
    server.stdout.once('data', (data) => {
      clearTimeout(timeout);
      resolve(data.toString().trim());
    });
  });
  return { url, stop: () => server.kill() };
}
