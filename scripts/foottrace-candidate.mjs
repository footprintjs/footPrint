/**
 * E3 only: build the exact, unpublished foottrace source and install its packed bytes.
 * The sole source pin is foottrace-candidate.json. There is no branch/latest/npm fallback.
 * Remove this bootstrap when the approved 1.0.0 is published at E4; E6 uses the ordinary
 * dependency range. Neither command publishes, tags, pushes, or changes package.json.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ARCHIVE = 'foottrace-candidate.tgz';
const readJSON = (file) => JSON.parse(readFileSync(file, 'utf8'));
const integrityOf = (file) => 'sha512-' + createHash('sha512').update(readFileSync(file)).digest('base64');
const pinFromDisk = () => readJSON(join(ROOT, 'scripts/foottrace-candidate.json'));

export function validatePin(pin) {
  if (pin.repository !== 'footprintjs/foottrace' || !/^[a-f0-9]{40}$/.test(pin.commit) || /^0+$/.test(pin.commit))
    throw new Error(
      'E3 requires the exact pushed foottrace commit in scripts/foottrace-candidate.json; no fallback is allowed',
    );
  if (pin.version !== '1.0.0') throw new Error('The E3 bootstrap is only for foottrace 1.0.0');
  return pin;
}

/** Check the artifact against the checked-in source pin and its packed-byte digest. */
export function readFoottraceCandidate(tarball, pin = pinFromDisk()) {
  validatePin(pin);
  const archive = resolve(tarball);
  const manifest = readJSON(archive + '.json');
  for (const key of ['repository', 'commit', 'version'])
    if (manifest[key] !== pin[key]) throw new Error(`foottrace candidate ${key} does not match the E3 source pin`);
  if (manifest.integrity !== integrityOf(archive))
    throw new Error('foottrace candidate archive integrity does not match');
  return { ...manifest, archive };
}

/** npm's installed lock proves archive identity and one root package entry in this install. */
export function installedFoottraceProblem(root, candidate) {
  let packages;
  try {
    ({ packages } = readJSON(join(root, 'node_modules/.package-lock.json')));
  } catch {
    return 'npm did not record the installed dependency tree';
  }
  const copies = Object.entries(packages ?? {}).filter(
    ([path]) => path === 'node_modules/foottrace' || path.endsWith('/node_modules/foottrace'),
  );
  if (copies.length !== 1 || copies[0][0] !== 'node_modules/foottrace')
    return `expected one root foottrace installation; found ${copies.map(([path]) => path).join(', ') || 'none'}`;
  const [, installed] = copies[0];
  if (
    installed.version !== candidate.version ||
    installed.integrity !== candidate.integrity ||
    !installed.resolved?.startsWith('file:') ||
    !installed.resolved.endsWith(basename(candidate.archive))
  )
    return 'installed foottrace is not the exact candidate archive';
  return null;
}

/**
 * Linked playground siblings have separate npm trees but execute in one process. Share their
 * verified candidate through one physical package, only inside the audit-created workspace.
 * Preflight every path and archive BEFORE replacing any package path with a link.
 */
export function shareFoottraceCandidate(dirs, candidate, workspace) {
  if (!dirs.length) throw new Error('The candidate workspace has no installations');
  const boundary = realpathSync(workspace) + sep;
  const paths = dirs.map((dir) => {
    const real = realpathSync(dir);
    if (!real.startsWith(boundary)) throw new Error('Refusing to link foottrace outside the temporary audit workspace');
    const modules = join(real, 'node_modules');
    if (realpathSync(modules) !== modules) throw new Error('Refusing a linked node_modules directory');
    const installed = join(modules, 'foottrace');
    if (!realpathSync(installed).startsWith(boundary))
      throw new Error('Refusing a foottrace path outside the temporary audit workspace');
    const problem = installedFoottraceProblem(real, candidate);
    if (problem) throw new Error(`${basename(dir)}: ${problem}`);
    return installed;
  });
  const canonical = realpathSync(paths[0]);
  for (const installed of paths.slice(1)) {
    if (realpathSync(installed) === canonical) continue;
    rmSync(installed, { recursive: true, force: true });
    symlinkSync(canonical, installed, 'dir');
  }
  if (new Set(paths.map((path) => realpathSync(path))).size !== 1)
    throw new Error('The candidate workspace still has multiple physical foottrace copies');
  return canonical;
}

function run(command, args, cwd, capture = false) {
  return execFileSync(command, args, {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...(capture ? { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] } : { stdio: 'inherit' }),
  });
}

function packCandidate(output) {
  const pin = validatePin(pinFromDisk());
  const destination = resolve(output);
  mkdirSync(destination, { recursive: true });
  const source = mkdtempSync(join(tmpdir(), 'foottrace-e3-source-'));
  try {
    run('git', ['init', '--quiet', source], ROOT);
    run(
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        'http.extraHeader=',
        'fetch',
        '--quiet',
        '--depth',
        '1',
        `https://github.com/${pin.repository}.git`,
        pin.commit,
      ],
      source,
    );
    run('git', ['checkout', '--quiet', '--detach', 'FETCH_HEAD'], source);
    const actual = run('git', ['rev-parse', 'HEAD'], source, true).trim();
    if (actual !== pin.commit) throw new Error('Fetched foottrace source does not match the pinned commit');
    const pkg = readJSON(join(source, 'package.json'));
    if (pkg.name !== 'foottrace' || pkg.version !== pin.version)
      throw new Error('Pinned source is not the expected foottrace package/version');
    run('npm', ['ci', '--no-audit', '--no-fund'], source);
    run('npm', ['run', 'build'], source);
    run('git', ['diff', '--exit-code'], source);
    const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', destination], source, true));
    const archive = join(destination, ARCHIVE);
    renameSync(join(destination, packed.filename), archive);
    writeFileSync(archive + '.json', JSON.stringify({ ...pin, integrity: integrityOf(archive) }, null, 2) + '\n');
    console.log(`Packed foottrace ${pin.version} from ${pin.repository}@${pin.commit}: ${archive}`);
    return archive;
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
}

function installCandidate(tarball, ignoreScripts) {
  const candidate = readFoottraceCandidate(tarball);
  const root = process.cwd();
  const packageFile = join(root, 'package.json');
  const before = readFileSync(packageFile, 'utf8');
  run(
    'npm',
    [
      'install',
      '--no-save',
      '--no-audit',
      '--no-fund',
      ...(ignoreScripts ? ['--ignore-scripts'] : []),
      candidate.archive,
    ],
    root,
  );
  if (readFileSync(packageFile, 'utf8') !== before) throw new Error('Candidate installation changed package.json');
  const problem = installedFoottraceProblem(root, candidate);
  if (problem) throw new Error(problem);
  console.log(`Installed exactly one foottrace ${candidate.version} from ${candidate.commit}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, argument, ...flags] = process.argv.slice(2);
  if (
    !argument ||
    flags.some((flag) => flag !== '--ignore-scripts') ||
    (command !== 'install' && command !== 'pack') ||
    (command === 'pack' && flags.length)
  )
    throw new Error('Usage: foottrace-candidate.mjs pack <output-directory> | install <archive> [--ignore-scripts]');
  if (command === 'pack') packCandidate(argument);
  else installCandidate(argument, flags.includes('--ignore-scripts'));
}
