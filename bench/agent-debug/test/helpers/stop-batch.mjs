/**
 * A batch of one run that is stopped hard in the middle (RULE 1.3, B2), or
 * resumed. Spends nothing: the model is a script.
 *   node stop-batch.mjs kill <out>    the second model request SIGKILLs this process
 *   node stop-batch.mjs resume <out>  starts the batch again; the model must not be asked
 */
import { loadFault } from '../../faults/apply.mjs';
import { runBatch } from '../../harness/batch.mjs';
import { scriptedModel } from '../../harness/model.mjs';

const [mode, out] = process.argv.slice(2);
const fault = loadFault('wrong-key-read');
const script = ({ turn }) => {
  if (turn === 1) process.kill(process.pid, 'SIGKILL');
  return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `t${turn}`, name: 'list_files', input: {} }] };
};
await runBatch({
  out,
  setups: [1],
  faults: [fault],
  repeats: 1,
  modelFor: async () => {
    if (mode === 'resume') throw new Error('a started run must not be run again');
    return scriptedModel(script);
  },
  say: (line) => console.log(line),
});
