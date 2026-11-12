/** The reader's R2-2 edit: the copy's run-order.mjs makes a 3 GB sparse file (no disk used). */
export const SPARSE_EDIT = {
  path: 'src/run-order.mjs',
  find: 'const file = process.argv[2];',
  replace: "import { openSync, ftruncateSync, closeSync } from 'node:fs';\n{ const fd = openSync(process.argv[3] ?? 'big.bin', 'w'); ftruncateSync(fd, 3 * 2 ** 30); closeSync(fd); }\nconst file = process.argv[2];",
};
