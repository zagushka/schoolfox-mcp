# Security

Use GitHub's private vulnerability reporting from the repository's **Security** tab. Keep credentials, account data, and exploitable details out of public issues. Include the affected version, safe reproduction steps, and a synthetic fixture if possible.

This preview has no formal support period or response-time guarantee.

Tokens and login identity stay in process memory. Credentials belong in the local environment or an ignored `.env`. Stdout is reserved for MCP; diagnostics go to stderr. Tool errors contain safe codes, not raw responses or signed URLs.

Successful tool results can contain school messages, pupil records, and file metadata. Your MCP client may retain those results in chat history or logs. Use a client whose data storage and access controls fit your account data.

Requests use a fixed API origin. Attachment redirects are limited to one observed HTTPS origin without API credentials. Downloads use bounded memory, safe filenames, owner-only new files, and exclusive creation.

Tests and CI use synthetic data. Public source and coverage artifacts must not contain credentials, recordings, or downloaded documents. See [verification limits](docs/api-contract.md).
