# Testing and code coverage

## Run checks

```sh
npm ci
npm run typecheck
npm test
npm run test:coverage
```

`test:coverage` rebuilds the server, runs all synthetic tests under c8/V8 coverage, and fails below configured thresholds. No account credentials are needed and no live SchoolFox request is sent.

Use Node.js 22.12.0 or later, as required by the coverage dependency. CI tests Node.js 22 and 24 on Ubuntu; authorized live checks used macOS. Windows has not been verified.

## Measured baseline

Measured on 16 October 2026 with Node.js 26.8.1 and 111 passing tests:

| Metric | Coverage | Enforced minimum |
| --- | --- | --- |
| Lines | 98.22% (1215/1237) | 95% |
| Statements | 98.22% (1215/1237) | 95% |
| Branches | 88.54% (742/838) | 80% |
| Functions | 86.98% (147/169) | 80% |

`.c8rc.json` includes all eleven TypeScript source files, even unloaded files. Source maps and remapping include the compiled stdio entry in the TypeScript report. Test code, generated JavaScript, dependency code, and local data are not counted as application source.

Some MCP handler callbacks and failure paths remain uncovered. Coverage measures exercised code; it does not prove live permissions, API stability, or that every behavior is correct. Results can vary slightly by Node version.

## Reports

| Report | Location |
| --- | --- |
| Terminal table | Command output |
| HTML | `coverage/index.html` |
| LCOV | `coverage/lcov.info` |
| JSON summary | `coverage/coverage-summary.json` |

Reports are ignored by Git. GitHub Actions uploads them as `coverage-node-22` and `coverage-node-24` artifacts, retained for 14 days. Download an artifact and open its `index.html` locally. No Codecov account or token is required.

## Test scope

| Test file | Main behavior checked |
| --- | --- |
| `test/config.test.ts` | Defaults, paired login credentials and token fallback, numeric boundaries, path resolution |
| `test/client.test.ts` | Pupil filters, authentication, detail compatibility, reply/confirmation guards, bounded responses, download safety, uncertain-write no-retry behavior |
| `test/attachments.test.ts` | Exact metadata selection, Unicode names, redirect isolation, timeouts, size/status/byte checks, overwrite refusal, partial-file cleanup |
| `test/auth.test.ts` | Shared session renewal, fallback login, 2FA challenge and code handling, late-response races, and no write replay |
| `test/absences.test.ts` | Pupil/plan/recipient checks, local absence filtering, all-day and timed dates, DST/skipped/fractional-offset dates, overlap, per-pupil write guards, uncertain save/edit outcomes, partial delivery, edit history, and identity renewal |
| `test/absences-server.test.ts` | All five absence handlers over SDK MCP, exact recipient arrays and date mapping, partial delivery, edit field preservation, and invalid inputs with no writes |
| `test/chats.test.ts` | Standalone chat scope/roles, bounded exact-message paging, long histories and scan limits, exact text payloads, multipart draft/send, local regular-file checks, attachment membership, and signed-host redirect isolation |
| `test/scheduling.test.ts` | Slot selection and booking/cancel guards, bounded class/week absence reads, school time zones and DST, and independent activity paging |
| `test/server.test.ts` | MCP schemas, structured errors, detail/attachment tool results over SDK transport |
| `test/stdio.test.ts` | Built process initialization, tool listing, status, and clean shutdown |

All network responses in tests are synthetic. Successful write tests send only to fake fetch handlers. Live reads were checked separately with owner authorization; their limits are in the [tool reference](tools.md) and [API contract](api-contract.md).
