/**
 * Native checkpoint and one transactional host wait, across fresh Node processes.
 * Uses built-in SQLite on Node 22.16+ or Node 24. Build the package first.
 * No service, model, production data or outside effect is contacted.
 */
import { runExample } from './durable-sqlite/host.cjs';

runExample()
  .then((report) => {
    console.log(JSON.stringify(report));
  })
  .catch(() => {
    console.error('REGRESSION: durable host example failed; no private state was printed');
    process.exit(1);
  });
