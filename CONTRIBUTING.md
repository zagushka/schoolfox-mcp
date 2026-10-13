# Contributing

Use Node.js 22.12.0 or later and run:

```sh
npm ci
npm run typecheck
npm run test:coverage
```

The coverage command rebuilds and runs synthetic tests, including SDK stdio checks. Use dummy identities and files. Never add credentials, signed links, downloaded school documents, or live API recordings.

Keep changes focused. Include a bug's trigger, expected behavior, and synthetic regression. For an endpoint change, cite first-party contract evidence and state what remains unverified. Keep pupil/class/recipient selection and separate reply/confirmation guards intact.

Do not add automatic retries for uncertain writes or explicit receipts during reads. Document each account write and its required user instruction. Explain coverage changes in pull requests; see [testing](docs/testing.md).

Use [issues](https://github.com/zagushka/schoolfox-mcp/issues) for ordinary bugs and feature requests. Include Node version, tool name, safe error code, and placeholder-ID steps. Do not attach `.env`, account screenshots, raw responses, or school files. Report vulnerabilities [privately](SECURITY.md).
