# SchoolFox MCP

[![CI](https://github.com/zagushka/schoolfox-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zagushka/schoolfox-mcp/actions/workflows/ci.yml)

A local TypeScript MCP server for SchoolFox. Read class messages, standalone chats, consultation appointments, weekly timetables, the activity feed, attachments, and FoxDrive items. Download selected files to your computer.

The server also implements chat messages and attachment sends, consultation booking/cancellation, replies in existing notification groups, and ordinary message confirmations. These tools write to your account and have synthetic test coverage. Normal session renewal passed a live account check. Live sends, booking/cancellation, automatic expired-session recovery, and 2FA remain untested. Confirmation requires recipient records that were absent from the observed detail response.

This is an independent preview. It uses the first-party web client's private API contract and is not an official SchoolFox integration. SchoolFox can change that contract.

Account checks on 13 October 2026 verified standalone chats, exact chat-message lookup, PDF downloads, the activity feed, and normal session renewal through the desktop MCP. PDF checks covered size, signature, and file permissions. The synthetic suite passes 84 tests. See the [verification scope](docs/api-contract.md#live-observations) for remaining limits.

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

Edit `.env` locally. Set both `SCHOOLFOX_EMAIL` and `SCHOOLFOX_PASSWORD` for login, or use `SCHOOLFOX_TOKEN` for an existing session. You can combine a token with the complete login pair for recovery fallback. `.env` is ignored by Git.

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

There are 33 tools:

| Area | Tools |
| --- | --- |
| Configuration and inventory | `schoolfox_status`, `schoolfox_classes` |
| Messages | `schoolfox_messages`, `schoolfox_message_detail` |
| Message attachments | `schoolfox_message_attachments`, `schoolfox_download_message_attachment` |
| Existing reply threads | `schoolfox_reply_groups`, `schoolfox_replies` |
| Event and due-date notices | `schoolfox_event_notices` |
| FoxDrive reads and downloads | `schoolfox_files`, `schoolfox_file_detail`, `schoolfox_download_file` |
| Notification writes | `schoolfox_reply`, `schoolfox_confirm` |
| Session recovery and 2FA | `schoolfox_authenticate`, `schoolfox_renew_session` |
| Standalone chats | `schoolfox_chat_organizations`, `schoolfox_conversations`, `schoolfox_conversation_detail`, `schoolfox_chat_history`, `schoolfox_chat_message_detail` |
| Chat sends and attachments | `schoolfox_chat_send`, `schoolfox_chat_send_attachment`, `schoolfox_chat_download_attachment` |
| Consultations | `schoolfox_consultations`, `schoolfox_consultation_detail`, `schoolfox_consultation_slots`, `schoolfox_consultation_appointments`, `schoolfox_consultation_appointment_detail` |
| Appointment writes | `schoolfox_book_consultation`, `schoolfox_cancel_consultation` |
| Weekly lessons and replacements | `schoolfox_timetable` |
| Separate activity stream | `schoolfox_activity_feed` |

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

- Eligible reads recover expired sessions through renewal or login fallback and retry once. `schoolfox_authenticate` completes an existing 2FA challenge. A new code can be required after re-login; 2FA enrolment/reset/disable are outside this release.
- Most list tools use `top` from 1 to 50; chat history permits up to 100. `skip` is from 0 to 1000. Exact chat-message lookup scans at most 21 pages of 50 records and stops at the matching page. The tools accept no arbitrary URLs or OData filters.
- Event notices contain dates from messages, excluding consultation appointments and the weekly timetable.
- New conversation creation, new notification reply groups, signatures, absence reports, surveys, FoxDrive uploads/file changes, archives, and FoxPay are not implemented. Existing chat attachment upload is supported.
- Reads send no explicit mark-as-read request. General server-side GET effects remain unknown. The tested message stayed unread after detail retrieval; that sample does not prove the same behavior for every message.
- Chat sends, appointment booking/cancellation, replies, and confirmation are separate writes. Each remote write is sent once; uncertain results are not retried. Invoke them only for the user's exact intended target and action. Attachment sending has an upload step and a send step; a failure can leave a draft.
- Timetable changes are relevant teacher absence/replacement records; a versioned history of timetable edits was not found. Set the timetable school timezone when it differs from `Europe/Berlin`.
- Downloads refuse overwrite and unsafe local filenames. Class-message and chat attachments accept one redirect to the observed HTTPS file host without forwarding API credentials. FoxDrive downloads reject redirects.

## Documentation

- [Configuration and troubleshooting](docs/configuration.md)
- [Tool reference and feature coverage](docs/tools.md)
- [API contract and verification limits](docs/api-contract.md)
- [Testing and code coverage](docs/testing.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## License

[MIT](LICENSE).
