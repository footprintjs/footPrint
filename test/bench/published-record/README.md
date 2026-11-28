# Published recording reads

Run the benchmark from the repository root to print one JSON result for each capture encoding.

```sh
npx vitest run test/bench/published-record/native-io.test.ts --maxWorkers 1 --disableConsoleIntercept
```

The fixture records two passes through the same mounted chart and a fan-out with two parallel children. A full capture and a delta capture each run twice with different values for a redacted field. For each encoding, a third recording interleaves a separate, unauthorized log between root rows. It requires more root reads yet returns the same serialized views. The benchmark compares the trusted opener’s counters with Node’s observed reads after each operation. Preparation bytes cover the sidecar, while scope bytes and read calls cover the payload. The report also counts the sidecar’s actual read calls.

The benchmark counts calls to Node’s positional file read and the bytes its callbacks return. The scanning reader opens the same data file as a baseline. The published reader opens the sidecar, reads the root and selected children, then opens a fresh session, seeks to a middle commit and advances one commit. Each requested byte span must fall inside the expected file and rows. Row positions come from the recorded JSON lines. Reference decoding, fixture writes and descriptor metadata calls are outside the counters.

`repeatedBytes` in the next-step row counts bytes already returned by the cold seek. These are application reads, so the operating system may serve them from cache. The benchmark measures local native storage. Host archive decoding, network I/O and rendering require separate measurements.
