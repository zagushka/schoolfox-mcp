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
| Token renewal | `GET api/Users/login/token` |
| Complete 2FA challenge | `POST api/2fa/login` with temporary auth header |
| Chat organizations | `GET api/OrganizationsForConversations?applicationType=SchoolFox` |
| Standalone chats / detail | `GET tables/Conversations`, `GET tables/Conversations/{conversationId}` |
| Chat history / text send | `GET/POST tables/ConversationMessages` |
| Exact chat message | Paged `GET tables/ConversationMessages` with conversation filter and local exact-ID selection |
| Chat upload | `POST api/conversations/{conversationId}/attach?organizationId={schoolId}` |
| Send uploaded chat message | `POST api/Conversations/{conversationId}/messages/{messageId}/send` |
| Chat attachment download | `GET api/conversations/{conversationId}/attachments/{attachmentId}?organizationId={schoolId}` |
| Consultation events | `GET tables/Consultations` |
| Consultation detail | `GET api/Consultations/{schoolId}/{consultationId}` |
| Consultation slots | `GET api/Consultations/{schoolId}/{consultationId}/Hosts/{hostId}/Slots` |
| Existing appointments / detail | `GET tables/ConsultationAppointments`, `GET tables/ConsultationAppointments/{appointmentId}` |
| Book appointment | `POST api/Consultations/{schoolId}/{consultationId}/Appointments` |
| Cancel appointment | `DELETE api/Consultations/{schoolId}/{consultationId}/Appointments/{appointmentId}` |
| Weekly timetable | `GET tables/TimeTableItems`, `GET tables/LessonTimes` |
| Absence/replacement changes | `GET tables/TeacherAbsences` scoped to selected class/week |
| Separate activity feed | `GET tables/ActivityFeedItems` |

## Response shapes

- Inventory is an array with valid `id` fields.
- Paged lists contain `results` and a nonnegative integer `count`, with a valid `id` on each result.
- Detail is an object with the exact requested valid ID. The live response omitted `info`; the adapter returns its fields without inventing recipient records.
- Attachment metadata is an array of nonempty `name` strings and nonnegative integer byte `size` values. Content type comes from the file response.
- Confirmation separately requires `info` recipient records with `id`, `pupilId`, and a `userId` matching login identity. That contract is unverified with a live account.
- FoxDrive download requires matching `schoolClassId` and selected `files[].id` metadata. That shape is unverified with a live account.

## Events and downloads

Event queries select nondeleted messages for one class/pupil with an Event whose end date is on or after 00:00 UTC today, or a due date on or after that boundary. An event that ended earlier today can therefore remain in the results. This excludes consultation appointments and weekly timetables.

FoxDrive downloads accept no redirects. Class-message and chat attachments may return one HTTP 302 to the observed `https://getfile.foxeducation.com` origin. That request receives no API credentials or cookies. Further redirects and other origins are rejected.

The adapter checks metadata selection, local names, byte limits, complete HTTP 200 attachment responses, and exclusive file creation. Class-message downloads also check the exact metadata byte count. Chat file parameters do not supply a size.

## New feature contracts

Conversations use organization scope and paged table responses. A chat send requires fresh matching detail with an open conversation and a known permitted role. Notification replies retain their original, separate contract. File uploads use multipart fields followed by a send using the returned draft message ID; a failed final send can leave that draft on the server.

The observed server returns 404 for chat-message detail by ID and ignores the additional message-ID filter on the collection. Exact message lookup therefore scans conversation history with local ID checks. It checks at most 21 pages of 50 records and stops at the matching page. Messages beyond this scan limit can return `pagination_limit_exceeded`.

Consultation tools use returned event, host, and pupil master-data IDs. Booking rechecks the booking window and exact active, unassigned slot before one POST. The pupil comes from consultation detail, while duration and online mode come from fresh slots. An empty successful booking response is valid. Cancellation checks appointment context before one DELETE. Server authorization remains decisive, and availability can change between check and write.

A selected Monday identifies an ISO timetable week. Recurring lesson records and school lesson times are returned with relevant absence/replacement intervals. The source does not establish a versioned history of timetable edits. Activity entries come from their own table and do not substitute dates from message notices.

Authentication renewal expects the login response shape and a final authenticated token, as in the web client. A normal login that indicates active 2FA holds its temporary token as a pending challenge until `/api/2fa/login` succeeds. Active-2FA renewal remains unverified live. Enrolment, reset, and disable are outside this integration. Automatic recovery is bounded and applies to eligible reads; remote writes are never replayed after failure.

## Live observations

Authorized MCP checks confirmed login, inventory, paged messages, detail, existing reply groups/replies, and class-message PDF attachment lists/downloads. Events and FoxDrive returned valid empty results. FoxDrive detail/download and both writes were not tested live.

The selected message stayed unread after detail retrieval; listed read/signed flags did not change. This sample does not establish that every GET is free of server-side effects. No explicit receipt, reply, or confirmation was sent.

Report API changes using sanitized field names/types, HTTP status, and required-ID comparisons. Keep identities, content, tokens, and signed links out of GitHub. Add a synthetic regression before changing an adapter.

The reloaded desktop MCP exposed 33 tools and confirmed standalone chats/history, the separate activity feed, message paging, explicit session renewal, and valid empty consultation/appointment and timetable results. It exposed a chat-detail defect that blocked attachment downloads. After repair, both a fresh rebuilt SDK MCP server and the reloaded desktop connection passed exact chat-message lookup and attachment download. The desktop download also passed local PDF signature, size, and permission checks. Nonempty consultation slots, lessons/replacements, remote writes, automatic recovery after expiry, and active 2FA remain unverified live. See the [tool reference](tools.md) for inputs and account effects.
