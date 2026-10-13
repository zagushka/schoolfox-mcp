# SchoolFox MCP

[![CI](https://github.com/zagushka/schoolfox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zagushka/schoolfox-mcp/actions/workflows/ci.yml)

A local TypeScript MCP server for SchoolFox. Read class messages, reply threads, attachments, event notices, and FoxDrive items. Download selected files to your computer.

The server also implements replies in existing groups and ordinary message confirmations. These two tools write to your account. They have synthetic test coverage but have not been checked with a live account. Confirmation requires recipient records that were absent from the observed detail response.

This is an independent preview. It uses the first-party web client's private API contract and is not an official SchoolFox integration. SchoolFox can change that contract.

## Quick start

Use Node.js 22.12.0 or later and npm.

```sh
git clone https://github.com/zagushka/schoolfox-mcp.git
cd schoolfox-mcp
npm ci
npm run build
cp .env.example .env
chmod 600 .env
```

Edit `.env` locally. Set either `SCHOOLFOX_TOKEN` for reads, or both `SCHOOLFOX_EMAIL` and `SCHOOLFOX_PASSWORD` for login. Leave the unused fields empty. `.env` is ignored by Git.

Start the stdio process through an MCP client, or directly:

```sh
node --env-file=.env dist/src/index.js
```

The process waits for MCP input; it does not provide an HTTP server. Node's `--env-file` option loads the file. The application does not load `.env` automatically.

## Connect an MCP client

Use absolute paths in your client's server configuration:

```json
{
  "mcpServers": {
    "schoolfox": {
      "command": "node",
      "args": [
        "--env-file=/absolute/path/to/schoolfox-mcp/.env",
        "/absolute/path/to/schoolfox-mcp/dist/src/index.js"
      ]
    }
  }
}
```

Restart the MCP connection after a rebuild. If `node` is not on the client's PATH, use its absolute executable path. Set `SCHOOLFOX_DOWNLOAD_DIR` to an absolute path when the client's working directory is uncertain.

## Tools and supported features

There are 14 tools:

| Area | Tools |
| --- | --- |
| Configuration and inventory | `schoolfox_status`, `schoolfox_classes` |
| Messages | `schoolfox_messages`, `schoolfox_message_detail` |
| Message attachments | `schoolfox_message_attachments`, `schoolfox_download_message_attachment` |
| Existing reply threads | `schoolfox_reply_groups`, `schoolfox_replies` |
| Event and due-date notices | `schoolfox_event_notices` |
| FoxDrive reads and downloads | `schoolfox_files`, `schoolfox_file_detail`, `schoolfox_download_file` |
| Account writes | `schoolfox_reply`, `schoolfox_confirm` |

Use returned IDs. For an active inventory item with `itemType: "Pupil"`, use its `schoolClassId` as `classId` and its `id` as `pupilId`.

```json
{"classId":"CLASS_ID","pupilId":"PUPIL_ID","top":25,"skip":0}
```

Pass that object to `schoolfox_messages`, then use a returned message ID for detail, attachments, or reply groups. Full arguments, effects, and live status are in the [tool reference](docs/tools.md).

## Tests and coverage

```sh
npm run typecheck
npm test
npm run test:coverage
```

Tests use synthetic data. They do not log in to SchoolFox or send a real message. Coverage includes every file in `src/`, including the stdio entry. The command enforces minimum coverage and writes HTML, LCOV, and JSON reports under `coverage/`.

GitHub Actions runs type checking and coverage on Node.js 22 and 24. Download each run's coverage artifact to open its HTML report. See [testing and coverage](docs/testing.md) for measured results, thresholds, and test scope.

## Limits and account effects

- 2FA and automatic token renewal are not supported. After authentication fails or a token expires, correct local configuration and restart the process.
- List tools use `top` from 1 to 50 and `skip` from 0 to 1000. They accept no arbitrary URLs or OData filters.
- Event notices contain dates from messages, excluding consultation appointments and the weekly timetable.
- Conversation chat, new reply groups, signatures, absence reports, surveys, uploads, file changes, archives, and FoxPay are not implemented.
- Reads send no explicit mark-as-read request. General server-side GET effects remain unknown. The tested message stayed unread after detail retrieval; that sample does not prove the same behavior for every message.
- Reply and confirmation are separate writes. Each write is sent once; uncertain results are not retried. The MCP client must obtain the user's exact target and text or confirmation instruction before invoking either tool.
- Downloads refuse overwrite and unsafe local filenames. Attachments accept one redirect to the observed HTTPS file host without forwarding API credentials; other redirects are rejected.

## Documentation

- [Configuration and troubleshooting](docs/configuration.md)
- [Tool reference and feature coverage](docs/tools.md)
- [API contract and verification limits](docs/api-contract.md)
- [Testing and code coverage](docs/testing.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE).
