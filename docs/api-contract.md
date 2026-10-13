# API contract and verification limits

The MCP uses the first-party web client's private contract. No supported public SchoolFox API was verified. Client source establishes intended calls, not account permissions or all server behavior.

## Evidence sources

- [SchoolFox web client](https://my.schoolfox.app/)
- [First-party configuration](https://my.schoolfox.app/config.json)
- [Inspected first-party app bundle, 13 October 2026](https://my.schoolfox.app/libs/app.e06538dde7ec1e92b350.js)

The dated bundle supplied route declarations and client calls. Its URL may disappear after an app deployment. For new API evidence, inspect the bundle currently loaded by the first-party client and record its URL/date with sanitized excerpts.

The inspected configuration on 13 October 2026 used `applicationType: SchoolFox` and `baseURL: https://api.schoolfox.com/`. The MCP uses that fixed origin, `ZUMO-API-VERSION: 2.0.0`, and authenticated `X-ZUMO-AUTH` headers.

## Routes

| Operation | Route |
| --- | --- |
| Login | `POST api/Users/login` |
| Inventory | `GET api/Common/Inventory` |
| Class messages / event notices | `GET tables/Messages` with fixed bounded OData queries |
| Message detail | `GET tables/Messages/{messageId}` |
| Attachment list / file | `GET api/Files/Messages/{messageId}`, optionally with encoded `fileName` |
| Reply groups | `GET tables/InstantMessageGroups` |
| Read replies | `GET tables/InstantMessages` |
| Send reply | `POST tables/InstantMessages` |
| Confirm recipient | `PATCH tables/MessageRelatedPupils/{recipientId}` |
| FoxDrive list | `GET tables/FoxDriveItems` |
| FoxDrive detail | `GET api/FoxDriveItems/{classId}/Item/{itemId}` |
| FoxDrive download | `GET api/FoxDriveItems/{itemId}/DownloadFile/{fileId}` |

## Response shapes

- Inventory is an array with valid `id` fields.
- Paged lists contain `results` and a nonnegative integer `count`, with a valid `id` on each result.
- Detail is an object with the exact requested valid ID. The live response omitted `info`; the adapter returns its fields without inventing recipient records.
- Attachment metadata is an array of nonempty `name` strings and nonnegative integer byte `size` values. Content type comes from the file response.
- Confirmation separately requires `info` recipient records with `id`, `pupilId`, and a `userId` matching login identity. That contract is unverified with a live account.
- FoxDrive download requires matching `schoolClassId` and selected `files[].id` metadata. That shape is unverified with a live account.

## Events and downloads

Event queries select nondeleted messages for one class/pupil with an Event whose end date is on or after 00:00 UTC today, or a due date on or after that boundary. An event that ended earlier today can therefore remain in the results. This excludes consultation appointments and weekly timetables.

FoxDrive downloads accept no redirects. Message attachments may return one HTTP 302 to the observed `https://getfile.foxeducation.com` origin. That request receives no API credentials or cookies. Further redirects and other origins are rejected.

The adapter checks metadata selection, local names, byte limits, complete HTTP 200 attachment responses, exact attachment byte counts, and exclusive file creation.

## Live observations

Authorized MCP checks confirmed login, inventory, paged messages, detail, existing reply groups/replies, and PDF attachment lists/downloads. Events and FoxDrive returned valid empty results. FoxDrive detail/download and both writes were not tested live.

The selected message stayed unread after detail retrieval; listed read/signed flags did not change. This sample does not establish that every GET is free of server-side effects. No explicit receipt, reply, or confirmation was sent.

Report API changes using sanitized field names/types, HTTP status, and required-ID comparisons. Keep identities, content, tokens, and signed links out of GitHub. Add a synthetic regression before changing an adapter.
