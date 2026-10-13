# Tool reference and feature coverage

Use returned IDs, limited to 128 letters, digits, underscores, or hyphens. List tools accept `top` from 1 to 50 (default 25) and `skip` from 0 to 1000 (default 0).

## Inputs, effects, and live checks

Live status describes authorized account checks on 13 October 2026. Automated tests use synthetic data and are separate from these observations.

| Tool | Required inputs | Optional inputs | Effect | Live status |
| --- | --- | --- | --- | --- |
| `schoolfox_status` | None | None | Local configuration and cached identity; does not log in. | Checked |
| `schoolfox_classes` | None | `schoolId` | Reads school/class/pupil inventory. | Checked, including school filter |
| `schoolfox_messages` | `classId`, `pupilId` | `top`, `skip` | Reads nondeleted class messages for one pupil. | Checked, including pagination |
| `schoolfox_message_detail` | `messageId` | None | Reads a message with an exact ID; `info` may be absent. General GET effects remain unknown. | Checked through SDK and desktop MCP |
| `schoolfox_message_attachments` | `messageId` | None | Reads attachment names/sizes without fetching detail. | Checked with PDFs |
| `schoolfox_download_message_attachment` | `messageId`, `attachmentName` | `fileName` | Refreshes metadata and saves one file locally. | Checked with PDF size/type/signature/permissions |
| `schoolfox_reply_groups` | `messageId`, `pupilId` | `top`, `skip` | Reads existing reply groups. | Checked with a nonempty result |
| `schoolfox_replies` | `groupId`, `pupilId` | `top`, `skip` | Reads existing replies. | Checked with a nonempty result |
| `schoolfox_event_notices` | `classId`, `pupilId` | `top`, `skip` | Reads message event/due notices. | Valid empty result; nonempty untested |
| `schoolfox_files` | `classId`, `pupilId` | `folderId`, `top`, `skip` | Reads FoxDrive items in a folder. | Valid empty root; items/traversal untested |
| `schoolfox_file_detail` | `classId`, `itemId` | None | Reads FoxDrive metadata. | Not checked; no item available |
| `schoolfox_download_file` | `classId`, `itemId`, `fileId`, `fileName` | None | Checks metadata and saves one file locally. | Not checked; no file available |
| `schoolfox_reply` | `messageId`, `pupilId`, `groupId`, `text` | None | Checks detail permission, then sends one reply to an existing group. | Synthetic only; no live send |
| `schoolfox_confirm` | `messageId`, `pupilId`, `recipientId` | None | Refreshes detail, then confirms one recipient. | Synthetic only; no live confirmation |

Downloads change local files. Detail is conservatively marked as not read-only because general server-side GET effects are unknown. Read tools send no explicit receipt.

## Select a pupil and message

1. Call `schoolfox_classes`.
2. Find an active record with `itemType: "Pupil"`.
3. Use its `schoolClassId` as `classId` and `id` as `pupilId`.
4. Call `schoolfox_messages` with those IDs and bounded paging.
5. Use a returned message ID for subsequent tools.

```json
{"classId":"CLASS_ID","pupilId":"PUPIL_ID","top":25,"skip":0}
```

## Download an attachment

Call `schoolfox_message_attachments`, then use an exact returned name:

```json
{"messageId":"MESSAGE_ID","attachmentName":"example.pdf","fileName":"local-copy.pdf"}
```

The result contains absolute `path`, actual `bytes`, and `contentType`. `fileName` changes only the local filename. Attachment names support spaces and Unicode; FoxDrive's local filename accepts letters, digits, dots, underscores, and hyphens only.

The tool requires exactly one matching name in fresh metadata, checks actual bytes against the reported size, and refuses overwrite.

## Select a FoxDrive file

1. Call `schoolfox_files` with the selected class and pupil. For a returned folder, use its ID as `folderId` in another list call.
2. Select an item's returned ID as `itemId`; call `schoolfox_file_detail` with the same `classId`.
3. Select a returned `files[].id` as `fileId`. Use those IDs and a safe local filename with `schoolfox_download_file`.

```json
{"classId":"CLASS_ID","itemId":"ITEM_ID","fileId":"FILE_ID","fileName":"local-copy.pdf"}
```

The detail/download contract remains unverified with a live account. If the required metadata fields are absent, stop; do not invent IDs.

## Writes

Reply text is 1 to 10,000 characters. A reply requires validated login identity, matching message/pupil/class/group context, an active group, and known permission fields. It does not create a first reply group. SchoolFox decides final authorization.

Confirmation requires a unique recipient for the same logged-in user and pupil, no existing confirmation, and no signature requirement. Missing records stop before PATCH. Detail reads work without those records; confirmation does not.

Each write is sent once. An uncertain result is an error and is not replayed. Invoke a write only after the user requests the exact target and text or confirmation action.

For a reply, list `schoolfox_reply_groups` for the selected message and pupil. Choose a returned group for that same context and use its `id` as `groupId`, together with the message/pupil IDs and exact user-approved text.

For confirmation, read the selected message detail and choose `recipientId` only from an `info` record for that pupil and logged-in user. It is a recipient-record ID, not the message or pupil ID. If detail contains no `info` array, confirmation is unavailable; do not fabricate a recipient record.

## Features outside this release

| Feature | Coverage |
| --- | --- |
| Conversation chat and new outgoing messages | Not implemented |
| Creating a reply group | Not implemented |
| Signature-required confirmation / FoxSign | Not implemented |
| Absence reports | Not implemented |
| Surveys and event registration | Not implemented |
| Consultation booking and weekly timetable | Not implemented |
| Archives and exports | Not implemented |
| Uploads, file/folder changes, portfolios | Not implemented |
| FoxPay and class fund history | Not implemented |
| Text/status/date search filters | Not implemented |
| Explicit read receipts | Not implemented |
| 2FA and automatic token renewal | Not implemented |
