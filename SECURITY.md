# Security Policy

## Supported Versions

We release security fixes for the latest minor version. Older major versions receive fixes only for critical vulnerabilities.

| Version | Supported |
| ------- | --------- |
| 3.x (latest) | ✅ Active |
| 2.x | ⚠️ Critical fixes only |
| < 2.0 | ❌ End of life |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, pull requests, or discussions.**

Use GitHub's [private vulnerability reporting](https://github.com/footprintjs/footPrint/security/advisories/new) to file a report confidentially. This keeps the disclosure private until a fix is available.

### What to include

A useful report answers these questions:

- **What type of issue is it?** (e.g. prototype pollution, path traversal, data exposure, ReDoS)
- **Which component is affected?** (e.g. `validateInput`, `ScopeFacade`, `normalizeSchema`)
- **How can it be reproduced?** — a minimal code sample is worth a thousand words
- **What is the potential impact?** — who is affected and under what conditions

### Response timeline

| Stage | Target |
| ----- | ------ |
| Acknowledgement | Within 48 hours |
| Triage + severity assessment | Within 5 business days |
| Fix available (critical/high) | Within 30 days |
| Fix available (medium/low) | Within 90 days |
| Public disclosure | After fix is released and deployed |

We follow [coordinated disclosure](https://en.wikipedia.org/wiki/Coordinated_vulnerability_disclosure). We will credit reporters by name (or alias) in the release notes unless you prefer to remain anonymous.

## Scope

**In scope:**

- Prototype pollution in schema evaluation, filter operators, or scope operations
- Arbitrary code execution via user-supplied schemas, flowchart IDs, or stage names
- Data exposure through the redaction system (PII leaking into recorder events)
- Denial of service via unbounded input (e.g., deeply nested schemas, circular references)
- Supply chain issues (compromised dependencies or build artifacts)

**Out of scope:**

- Issues in user-authored stage functions (the library executes what you give it)
- `AbortSignal` / timeout configuration mistakes in calling code
- Vulnerabilities in optional peer dependencies (`zod`) — report those upstream
- Issues only reproducible with `footprintjs/advanced` internal APIs — these are explicitly unsupported for production use

## Security Model

FootPrint executes user-supplied functions in the same process and trust boundary as the host application. It does not sandbox stage functions or evaluate arbitrary strings as code. The security surface is:

1. **Schema validation** (`src/lib/schema/`) — user-supplied schemas are evaluated; prototype pollution and ReDoS are relevant threats
2. **Filter operators** (`src/lib/decide/evaluator.ts`) — evaluates user-supplied `WhereFilter` objects against scope state
3. **Scope keys** — user-supplied key strings are used as property accessors; prototype pollution defences are in place
4. **Self-describing outputs** (`toOpenAPI`, `toMCPTool`) — stage IDs and descriptions are injected into generated specs

The prototype pollution denylist in `evaluator.ts` (`__proto__`, `constructor`, `toString`, `valueOf`, and related keys) is part of the security design, not just defensive coding. Any bypass of this denylist is a valid security finding.

## Acknowledgements

We thank all security researchers who responsibly disclose issues. Contributors who report valid vulnerabilities will be credited in the release notes.
