/** Real built public module instances and declarations. Runs only after the normal package build. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('optional capture built public package', () => {
  it('supports matching CJS/ESM, refuses instance mixes, and configures fresh worker-local capture', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    import assert from 'node:assert/strict';
    import {createRequire} from 'node:module';
    import {Worker} from 'node:worker_threads';
    const require=createRequire(import.meta.url);
    const cjs=require('footprintjs'), cjsCapture=require('footprintjs/subflow-capture');
    const esm=await import('footprintjs'), esmCapture=await import('footprintjs/subflow-capture');
    assert.deepEqual(Object.keys(cjsCapture),['subflowCapture']);
    assert.deepEqual(Object.keys(esmCapture),['subflowCapture']);
    for(const [engine,factory] of [[cjs,cjsCapture],[esm,esmCapture]]){
      const child=engine.flowChart('Child',s=>{s.answer=s.seed*2;},'child').build();
      const chart=engine.flowChart('Start',s=>{s.x=7;},'start').addSubFlowChartNext('mount',child,'Mount',{inputMapper:p=>({seed:p.x})}).build();
      const executor=new engine.FlowChartExecutor(chart,factory.subflowCapture({input:true}));
      await executor.run();const snapshot=executor.getSnapshot();
      assert.deepEqual(snapshot.subflowResults.mount.inputHandoff.writes[0].reads,['x']);
      assert.equal(snapshot.subflowResults.mount.treeContext.globalContext.answer,14);
    }
    for(const [engine,factory] of [[cjs,esmCapture],[esm,cjsCapture]]){
      let touched=0;const chart=engine.flowChart('Stage',()=>{touched++;},'stage').build();
      assert.throws(()=>new engine.FlowChartExecutor(chart,{...factory.subflowCapture({input:true}),get initialContext(){touched++;return {};}}),/Invalid subflow capture configuration/);
      assert.equal(touched,0);
    }
    const worker=new Worker(\`
      const {parentPort}=require('node:worker_threads');
      const {flowChart,FlowChartExecutor}=require('footprintjs');
      const {subflowCapture}=require('footprintjs/subflow-capture');
      const chart=flowChart('Stage',s=>{s.answer=1;},'stage').build();
      const executor=new FlowChartExecutor(chart,subflowCapture({input:true}));
      executor.run().then(()=>parentPort.postMessage(executor.getSnapshot().sharedState.answer));
    \`,{eval:true});
    assert.equal(await new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('worker exit '+code));});}),1);
    await worker.terminate();
  `,
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 30_000 },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + '\n' + result.stderr).toBe(0);
  });
  it.each(['mts', 'cts'])('resolves actual public %s declarations without source aliases', (extension) => {
    const file = resolve('test', `subflow-capture-public-types.${extension}`);
    const contents = `import {FlowChartExecutor,flowChart} from 'footprintjs';
    import {subflowCapture} from 'footprintjs/subflow-capture';
    const executor=new FlowChartExecutor(flowChart('Start',()=>{},'start').build(),subflowCapture({input:true,fanout:true}));
    // @ts-expect-error configuration is boolean data
    subflowCapture({input:'yes'});
    // @ts-expect-error unknown factory configuration
    subflowCapture({callback:()=>{}});
    void executor;`;
    const options: ts.CompilerOptions = {
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      types: [],
    };
    const host = ts.createCompilerHost(options);
    const read = host.readFile.bind(host);
    const exists = host.fileExists.bind(host);
    host.readFile = (path) => (resolve(path) === file ? contents : read(path));
    host.fileExists = (path) => resolve(path) === file || exists(path);
    const program = ts.createProgram([file], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    expect(diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))).toEqual([]);
    const sources = program.getSourceFiles().map((source) => source.fileName);
    expect(
      sources.some((path) =>
        path.endsWith('/dist/' + (extension === 'mts' ? 'esm' : 'types') + '/subflow-capture.d.ts'),
      ),
    ).toBe(true);
  });
});
