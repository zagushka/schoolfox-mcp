# Configuration

## Authentication

Choose one mode. Do not set a token and login credentials together.

| Mode | Variables | Effect |
| --- | --- | --- |
| Token | `SCHOOLFOX_TOKEN` | Reads only. No validated login identity is available for writes. |
| Login | `SCHOOLFOX_EMAIL` and `SCHOOLFOX_PASSWORD` | Logs in once and keeps token and user identity in process memory. Writes also require a valid user ID and display name. |

Login uses `https://api.schoolfox.com/api/Users/login`. A supported response must contain a token, valid user ID, `twoFactorAuthActive: false`, and `twoFactorAuthStatus` equal to `Optional` or `Disabled`. Active, required, missing, and unknown 2FA states are rejected.

The app derives a display name from nonblank first and last names, with `fullUsername` as a fallback. A missing name permits reads but blocks writes. `schoolfox_status.writeReady` means a cached identity is available; it does not prove that SchoolFox permits a write.

Status does not initiate login. In login mode, `writeReady` stays false until another tool first authenticates. Call `schoolfox_classes` to check login, then inspect status again.

## Environment variables

| Variable | Default | Allowed value |
| --- | --- | --- |
| `SCHOOLFOX_TOKEN` | Empty | Existing token; use without login fields. |
| `SCHOOLFOX_EMAIL` | Empty | Account email; requires password. |
| `SCHOOLFOX_PASSWORD` | Empty | Account password; requires email. |
| `SCHOOLFOX_TIMEOUT_MS` | `10000` | Integer from `1000` to `60000`. |
| `SCHOOLFOX_MAX_RESPONSE_BYTES` | `1048576` | Integer from `1024` to `10485760`. |
| `SCHOOLFOX_MAX_DOWNLOAD_BYTES` | `10485760` | Integer from `1024` to `104857600`. |
| `SCHOOLFOX_DOWNLOAD_DIR` | `./downloads` | Local directory; relative paths resolve from the server's working directory. |

The timeout covers a request and its body read. Attachment downloads share one timeout across the API request, redirect, and file body. Files are downloaded into bounded memory before they are saved.

New download files use owner-only permissions. Existing files and symlinks are not overwritten. A failed save removes only the new partial file created by that request.

## Load local credentials

The server does not read `.env` itself. Use Node's environment-file option:

```sh
cp .env.example .env
chmod 600 .env
# Edit .env locally, then:
node --env-file=.env dist/src/index.js
```

An MCP client can also pass environment variables directly to the process. Keep real values in local configuration or a secret store. Do not put them in examples, issues, or commits.

## Troubleshooting

| Result | Check or action |
| --- | --- |
| Process waits without output | Normal for stdio. Connect an MCP client; stdout is reserved for protocol messages. |
| `credentials_required` | Set one complete authentication mode. |
| Startup rejects configuration | Check credential conflicts, integer limits, and paired login fields. |
| `two_factor_unsupported` | The server cannot complete that account's 2FA login. |
| `two_factor_state_unverified` | Login returned an unknown or incomplete 2FA state. |
| `authentication_required` | Correct credentials/token and restart; login is not retried automatically. |
| `login_identity_required` | Token-only mode or incomplete display-name identity cannot write. |
| `forbidden` | SchoolFox denied the operation. Check account permissions and school features. |
| `unexpected_response` | The adapter's required shape or exact ID did not match. Report only sanitized field names and types. |
| `missing_recipient_records` | Confirmation needs a valid `info` array; the observed detail response omitted it. |
| `redirect_rejected` | An unsupported redirect or host was used. |
| `response_too_large` | A configured byte limit was exceeded. |
| `file_exists_or_unwritable` | Use a new filename and check directory access. |
| Old behavior after rebuild | Restart the MCP connection and check its tool description; a host can retain an older process. |

For a first account check, call status, inventory, then a bounded message page. Read detail only when its possible read-state effect is acceptable. Invoke writes only for a deliberate user request for the exact action.
