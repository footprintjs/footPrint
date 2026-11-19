/** Prove the explain door with a clean install of two supplied tarballs. No packages are published. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const hash = (body, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(body).digest(encoding);
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));

function paymentChart(flowChart) {
  // The chart definition from examples/post-execution/causal-chain/06-subflow-output-handoff.ts.
  const payment = flowChart(
    'Charge',
    (scope) => {
      scope.txnId = `TXN-${scope.chargedAmount}`;
    },
    'charge',
  ).build();
  return flowChart(
    'Seed',
    (scope) => {
      scope.amount = 99;
      scope.txnId = 'UNRELATED-PARENT-VALUE';
    },
    'seed',
  )
    .addSubFlowChartNext('payment', payment, 'Payment', {
      inputMapper: (parent) => ({ chargedAmount: parent.amount }),
      outputMapper: (child) => ({ receipt: child.txnId }),
    })
    .addFunction(
      'Ship',
      (scope) => {
        scope.shipped = scope.receipt !== undefined;
      },
      'ship',
    )
    .build();
}

function proveScope(snapshot, findLastWriter, captureWitnessOf) {
  assert.deepEqual(snapshot.sharedState, {
    amount: 99,
    txnId: 'UNRELATED-PARENT-VALUE',
    receipt: 'TXN-99',
    shipped: true,
  });
  const parent = findLastWriter(snapshot.commitLog, 'receipt');
  assert.ok(parent);
  const child = snapshot.subflowResults[parent.runtimeStageId];
  assert.ok(child, 'select the exact mounted child rather than a reusable alias');
  const log = child.treeContext.history;
  const chargeIdx = log.findIndex((entry) => entry.stageId === 'payment/charge');
  assert.notEqual(chargeIdx, -1);
  assert.ok(log[chargeIdx].trace.some((row) => row.path === 'txnId'));
  const scope = (record, commitLog, mounts) => {
    const captureWitness = captureWitnessOf(record);
    return {
      address: record.logAddress,
      commitLog,
      complete: true,
      // The app supplies the two fixture logs. The native mount inventory remains partial.
      subflows: { version: 1, status: 'partial', mounts, collections: [] },
      ...(record.capture && { capture: record.capture }),
      ...(captureWitness && { captureWitness }),
    };
  };
  return {
    root: scope(snapshot, snapshot.commitLog, [
      {
        runtimeStageId: parent.runtimeStageId,
        child: child.treeContext.logAddress,
        ...(child.inputHandoff && { inputHandoff: child.inputHandoff }),
        ...(child.outputHandoff && { outputHandoff: child.outputHandoff }),
      },
    ]),
    child: scope(child.treeContext, log, []),
    parent: { runtimeStageId: parent.runtimeStageId, commitIdx: snapshot.commitLog.indexOf(parent), key: 'receipt' },
    charge: { runtimeStageId: log[chargeIdx].runtimeStageId, commitIdx: chargeIdx, key: 'txnId' },
  };
}

async function sourceOfReceipt(scopes, createRecordGraph, shareChild = true) {
  const graph = createRecordGraph(shareChild ? [scopes.root, scopes.child] : [scopes.root]);
  const target = graph.nodeId(scopes.root.address, scopes.parent);
  const writer = graph.nodeId(scopes.child.address, scopes.charge);
  const context = { signal: new AbortController().signal };
  const page = await graph.parents(target, context);
  const gaps = await graph.gaps(target, context);
  assert.notEqual(target, 'record:invalid');
  assert.notEqual(writer, 'record:invalid');
  assert.ok(!gaps.some((gap) => gap.code === 'invalid-data'));
  return { page, gaps, writer, exactEdge: page.edges.find((edge) => edge.nodeId === writer) };
}

async function proveCoverage(onScopes, offScopes, createRecordGraph, collected) {
  const graph = createRecordGraph([onScopes.root, onScopes.child]);
  if (typeof graph.captureCoverage !== 'function') {
    return { status: 'unavailable', reason: 'reader-does-not-expose-capture-coverage' };
  }
  const context = { signal: new AbortController().signal };
  const query = (scope) => ({ channel: 'reads', mode: 'full', from: 0, to: scope.commitLog.length });
  const coverageOf = (scope) => createRecordGraph([scope]).captureCoverage(scope.address, query(scope), context);
  const rootCoverage = await graph.captureCoverage(onScopes.root.address, query(onScopes.root), context);
  const childCoverage = await graph.captureCoverage(onScopes.child.address, query(onScopes.child), context);
  const missingCoverage = await coverageOf(offScopes.root);
  const newerScope = { ...onScopes.root, capture: { ...onScopes.root.capture, version: 4 } };
  const newerCoverage = await coverageOf(newerScope);
  const borrowedCoverage = await coverageOf({ ...onScopes.child, captureWitness: onScopes.root.captureWitness });
  // Keep the child leg and interval to test address binding on its own.
  const wrongAddressCoverage = await coverageOf({
    ...onScopes.child,
    captureWitness: { ...onScopes.child.captureWitness, logAddress: onScopes.root.captureWitness.logAddress },
  });
  const crossing = await graph.captureCoverage(
    onScopes.child.address,
    { ...query(onScopes.child), crossing: 'transport' },
    context,
  );
  assert.deepEqual(rootCoverage, { state: 'covered', reasons: [] });
  assert.deepEqual(childCoverage, { state: 'covered', reasons: [] });
  assert.equal(missingCoverage.state, 'collection-unknown');
  assert.equal(newerCoverage.state, 'collection-unknown');
  assert.equal(borrowedCoverage.state, 'collection-unknown');
  assert.equal(wrongAddressCoverage.state, 'collection-unknown');
  assert.deepEqual(crossing, { state: 'collection-unknown', reasons: ['transport-boundary'] });
  const positiveAfterUpgrade = await sourceOfReceipt({ ...onScopes, root: newerScope }, createRecordGraph);
  assert.deepEqual(positiveAfterUpgrade.exactEdge, collected.exactEdge);
  return {
    status: 'verified',
    rootCoverage,
    childCoverage,
    missingCoverage,
    newerCoverage,
    borrowedCoverage,
    wrongAddressCoverage,
    crossing,
  };
}

async function proveFormat(load, format) {
  const { flowChart, FlowChartExecutor } = await load('footprintjs');
  const { findLastWriter } = await load('foottrace');
  const { createRecordGraph } = await load('foottrace/cause');
  const { explain, captureWitnessOf } = await load('footprintjs/explain');
  assert.equal(typeof captureWitnessOf, 'function', 'the packed engine exports captureWitnessOf');
  const chart = paymentChart(flowChart);
  const on = new FlowChartExecutor(chart, explain(true));
  const off = new FlowChartExecutor(chart);
  await on.run();
  await off.run();
  const onSnapshot = on.getSnapshot();
  const offSnapshot = off.getSnapshot();
  const onScopes = proveScope(onSnapshot, findLastWriter, captureWitnessOf);
  const offScopes = proveScope(offSnapshot, findLastWriter, captureWitnessOf);
  const collected = await sourceOfReceipt(onScopes, createRecordGraph);
  const omitted = await sourceOfReceipt(offScopes, createRecordGraph);
  const transported = await sourceOfReceipt(onScopes, createRecordGraph, false);
  for (const scope of [onScopes.root, onScopes.child]) {
    assert.equal(scope.capture?.version, 3);
    assert.equal(scope.capture.scope, 'log');
    assert.deepEqual(scope.capture.logAddress, scope.address);
    assert.deepEqual(scope.capture.commits, { from: 0, to: scope.commitLog.length });
    assert.equal(scope.capture.boundary.status, 'completed');
    assert.ok(scope.commitLog.every((commit, index) => commit.idx === index));
    assert.ok(scope.captureWitness, 'the exact served record carries its own capture witness');
    assert.equal(scope.captureWitness.source, 'live');
    assert.deepEqual(scope.captureWitness.logAddress, scope.address);
    assert.equal(scope.captureWitness.runId, scope.capture.runId);
    assert.equal(scope.captureWitness.boundary, 'completed');
    assert.deepEqual(scope.captureWitness.commits, { from: 0, to: scope.commitLog.length });
    assert.deepEqual(scope.capture.channels.reads, { mode: 'full', status: 'collected', reasons: [] });
  }
  assert.equal(onScopes.root.captureWitness.runId, onSnapshot.runId);
  // This is a fresh child, so its first log owner is also its producing leg.
  assert.equal(onScopes.child.captureWitness.runId, onScopes.child.address.logRunId);
  assert.notDeepEqual(onScopes.root.captureWitness.logAddress, onScopes.child.captureWitness.logAddress);
  assert.equal(offScopes.root.capture, undefined);
  assert.equal(offScopes.child.capture, undefined);
  assert.equal(offScopes.root.captureWitness, undefined);
  assert.equal(offScopes.child.captureWitness, undefined);
  assert.equal(onScopes.root.subflows.mounts[0].outputHandoff.status, 'captured');
  assert.equal(offScopes.root.subflows.mounts[0].outputHandoff, undefined);
  assert.ok(collected.exactEdge?.evidence.includes('subflow:output:0'), 'Foottrace names the exact child writer');
  assert.equal(omitted.exactEdge, undefined);
  assert.ok(omitted.gaps.some((gap) => gap.code === 'not-collected'));
  assert.ok(omitted.gaps.some((gap) => gap.code === 'scope-boundary' && gap.evidence.includes('subflow:output:0')));
  assert.equal(transported.exactEdge, undefined);
  assert.equal(transported.page.complete, false);
  assert.ok(transported.gaps.some((gap) => gap.code === 'scope-boundary' && gap.evidence.includes('subflow:output:0')));
  return {
    format,
    coverage: await proveCoverage(onScopes, offScopes, createRecordGraph, collected),
    enabled: {
      receiptAddress: onScopes.root.address,
      receipt: onScopes.parent,
      writerAddress: onScopes.child.address,
      writer: onScopes.charge,
      edge: collected.exactEdge,
      captureVersion: onSnapshot.capture?.version,
      childCaptureVersion: onScopes.child.capture?.version,
    },
    omitted: { answer: 'not-collected', gaps: omitted.gaps.map((gap) => gap.code) },
    transported: { complete: transported.page.complete, gaps: transported.gaps.map((gap) => gap.code) },
  };
}

async function installedProbe() {
  const require = createRequire(import.meta.url);
  const engine = require.resolve('footprintjs');
  const reader = require.resolve('foottrace');
  assert.equal(createRequire(engine).resolve('foottrace'), reader);
  for (const [name, entry] of [
    ['footprintjs', engine],
    ['foottrace', reader],
  ]) {
    assert.ok(entry.startsWith(join(dirname(self), 'node_modules', name) + '/'));
  }
  for (const name of ['footprintjs', 'footprintjs/explain', 'foottrace/cause']) {
    assert.ok(fileURLToPath(import.meta.resolve(name)).startsWith(join(dirname(self), 'node_modules') + '/'));
  }
  return { cases: [await proveFormat((specifier) => import(specifier), 'esm'), await proveFormat(require, 'cjs')] };
}

function neutralInstall(enginePack, readerPack) {
  const path = mkdtempSync(join(tmpdir(), 'footprint-explain-consumer-'));
  try {
    const packs = { footprintjs: realpathSync(enginePack), foottrace: realpathSync(readerPack) };
    const dependencies = Object.fromEntries(Object.entries(packs).map(([name, archive]) => [name, `file:${archive}`]));
    writeFileSync(
      join(path, 'package.json'),
      JSON.stringify({ name: 'packed-explain-proof', private: true, dependencies }),
    );
    const npm = (args) =>
      execFileSync('npm', ['--cache', join(path, 'npm-cache'), ...args], {
        cwd: path,
        timeout: 120_000,
        stdio: ['ignore', 'pipe', 'inherit'],
      });
    const options = ['--ignore-scripts', '--strict-peer-deps', '--offline', '--no-audit', '--no-fund'];
    npm(['install', '--package-lock-only', ...options]);
    npm(['ci', ...options]);
    const lock = json(join(path, 'package-lock.json'));
    const manifest = {};
    for (const [name, archive] of Object.entries(packs)) {
      const entry = lock.packages[`node_modules/${name}`];
      const body = readFileSync(archive);
      assert.equal(realpathSync(resolve(path, entry.resolved.slice('file:'.length))), archive);
      assert.ok(entry.resolved.startsWith('file:') && !entry.link);
      assert.equal(entry.integrity, `sha512-${hash(body, 'sha512', 'base64')}`);
      assert.ok(!lstatSync(join(path, 'node_modules', name)).isSymbolicLink());
      manifest[name] = {
        version: entry.version,
        archive: basename(archive),
        sha256: hash(body),
        integrity: entry.integrity,
      };
    }
    assert.deepEqual(
      Object.keys(lock.packages).filter((key) => key.endsWith('/node_modules/foottrace')),
      [],
    );
    const copy = join(path, 'probe.mjs');
    copyFileSync(self, copy);
    const stdout = execFileSync(process.execPath, [copy, '--installed'], {
      cwd: path,
      timeout: 30_000,
      encoding: 'utf8',
    });
    return {
      packages: manifest,
      node: process.version,
      npm: npm(['--version']).toString().trim(),
      ...JSON.parse(stdout),
    };
  } finally {
    rmSync(path, { recursive: true });
  }
}

const [first, second, ...extra] = process.argv.slice(2);
assert.ok(
  !extra.length && (first === '--installed' ? !second : first && second),
  'Use: node scripts/subflow-protocol/prove-explain-consumer.mjs <engine.tgz> <reader.tgz>',
);
const result = first === '--installed' ? await installedProbe() : neutralInstall(first, second);
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
