# Configuration

## Authentication

Use login credentials, an existing token, or a token with login credentials as recovery fallback.

| Mode | Variables | Effect |
| --- | --- | --- |
| Token | `SCHOOLFOX_TOKEN` | Uses the supplied session; attempts renewal when an eligible read receives 401. |
| Login | `SCHOOLFOX_EMAIL` and `SCHOOLFOX_PASSWORD` | Logs in and keeps the session in memory. |
| Token with fallback | All three variables | Uses the supplied token first; can log in if renewal fails. |

An expired session is recovered through `GET api/Users/login/token`, then login if credentials are available. Concurrent failures share recovery. An eligible read retries once; a failed remote write is never replayed. A failed initial login remains stopped until an explicit `schoolfox_authenticate` call, which permits recovery without a process restart.

`schoolfox_authenticate` without a code starts a fresh login. Repeating it replaces a pending or expired challenge, so enrolment completed in SchoolFox can be checked without a process restart. For an account with active 2FA, complete that challenge by calling the same tool with `code`. The temporary token is kept in memory and is never used for ordinary account requests. Required 2FA enrolment returns `two_factor_setup_required`; set up the authenticator in SchoolFox before trying again. The integration does not enrol, reset, or disable 2FA. If renewal fails and recovery starts a new login, an active 2FA account waits for its code. Renewal itself expects a final authenticated token, as in the web client; active-2FA renewal remains unverified live.

`schoolfox_renew_session` explicitly renews the current session or starts login. It sends no message or booking. Authentication results contain safe status fields, never the password, code, or token. A code supplied as an MCP argument can be retained by the MCP host in its own conversation or logs.

The app derives a display name from nonblank first and last names, with `fullUsername` as a fallback. Original notification replies and confirmations require this validated identity. `schoolfox_status.writeReady` means such an identity is cached; it does not prove permission to send, book, or cancel. Each new write also checks its own returned context and permissions.

Status does not initiate login. Call `schoolfox_authenticate` or `schoolfox_classes` to authenticate, then inspect status again.

## Environment variables

| Variable | Default | Allowed value |
| --- | --- | --- |
| `SCHOOLFOX_TOKEN` | Empty | Existing session token; optional complete login pair provides fallback. |
| `SCHOOLFOX_EMAIL` | Empty | Account email; requires password. |
| `SCHOOLFOX_PASSWORD` | Empty | Account password; requires email. |
| `SCHOOLFOX_TIMEOUT_MS` | `10000` | Integer from `1000` to `60000`. |
| `SCHOOLFOX_MAX_RESPONSE_BYTES` | `1048576` | Integer from `1024` to `10485760`. |
| `SCHOOLFOX_MAX_DOWNLOAD_BYTES` | `10485760` | Integer from `1024` to `104857600`. |
| `SCHOOLFOX_MAX_UPLOAD_BYTES` | `10485760` | Integer from `1024` to `104857600`. |
| `SCHOOLFOX_DOWNLOAD_DIR` | `./downloads` | Local directory; relative paths resolve from the server's working directory. |

The timeout covers each HTTP request and its body read. Recovery can add a renewal, login, and one read retry, each with its own timeout. Attachment downloads share one timeout across the API request, redirect, and file body. Files are downloaded into bounded memory before they are saved.

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
| Startup rejects configuration | Check integer limits and paired login fields. |
| `two_factor_required` | Call `schoolfox_authenticate` with the current authenticator code. |
| `two_factor_setup_required` | Complete 2FA enrolment in SchoolFox, then start authentication again. |
| `two_factor_challenge_required` | Start authentication before submitting a code. |
| `two_factor_state_unverified` | Login returned an unknown or incomplete 2FA state. |
| `authentication_required` | Check credentials, then call `schoolfox_authenticate` or `schoolfox_renew_session`; failed writes are not replayed. |
| `login_identity_required` | The original reply/confirmation path needs a validated login or renewal identity with a display name. |
| `forbidden` | SchoolFox denied the operation. Check account permissions and school features. |
| `unexpected_response` | The adapter's required shape or exact ID did not match. Report only sanitized field names and types. |
| `missing_recipient_records` | Confirmation needs a valid `info` array; the observed detail response omitted it. |
| `message_not_found` | The selected chat message was not present in the returned conversation history. |
| `pagination_limit_exceeded` | Exact chat-message lookup reached its bounded history scan without a match. |
| `redirect_rejected` | An unsupported redirect or host was used. |
| `response_too_large` | A configured byte limit was exceeded. |
| `file_exists_or_unwritable` | Use a new filename and check directory access. |
| Old behavior after rebuild | Restart the MCP connection and check its tool description; a host can retain an older process. |

For a first account check, call status, inventory, then a bounded message page. Read detail only when its possible read-state effect is acceptable. Invoke writes only for a deliberate user request for the exact action.

## Chat file uploads

`schoolfox_chat_send_attachment` takes an explicit absolute local `path`. It accepts one nonempty regular file, refuses a symlink at the final path, and checks the upload byte limit before upload. The path is read locally; it is not sent to SchoolFox. The filename and file contents are uploaded, then a second request sends the draft message. An incomplete result can leave a draft attachment on the server; inspect the chat before repeating the action.
