import test from 'node:test';
import assert from 'node:assert/strict';
import { SchoolFoxClient } from '../src/client.js';
import { loadConfig } from '../src/config.js';
import { absenceReasons } from '../src/absences.js';

const ctx = { schoolId: 'schoolA', classId: 'classA', pupilId: 'pupilA' };
const pupil = { id: 'pupilA', itemType: 'Pupil', schoolId: 'schoolA', schoolClassId: 'classA', isActive: true, deleted: false, applicationType: 'SchoolFox', purchasedFeature: 'Plus' };
const school = { id: 'schoolA', itemType: 'School', purchasedFeature: 'Plus', applicationType: 'SchoolFox' };
const message = { id: 'msgA', schoolId: 'schoolA', schoolClassId: 'classA', pupilId: 'pupilA', messageType: 'Absence', isOwned: true, createdBy: 'userA', deleted: false, content: 'ABSENCE_ILLNESS' };
const input = { ...ctx, reason: absenceReasons[0], startDate: '2026-10-16', endDate: '2026-10-16', allDayEvent: true, teacherIds: ['teacherA'] };
const login = { token: 'fixture', user: { id: 'userA', firstName: 'Parent', lastName: 'Fixture', twoFactorAuthActive: false, twoFactorAuthStatus: 'Optional' } };
type Route = unknown | ((init: RequestInit) => Response);
function fixture(overrides: Record<string, Route> = {}, token = false, timeoutMs = 10000) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const routes: Record<string, Route> = {
    'POST /api/Users/login': login,
    'GET /api/Common/Inventory': [school, pupil],
    'GET /api/SchoolClasses/classA/Teachers': [{ teacherId: 'teacherA', firstName: 'Teacher', lastName: 'Fixture' }, { teacherId: 'teacherA' }],
    'GET /api/Messages/HasAbsence': false,
    'POST /tables/Messages': { id: 'msgA' },
    'POST /api/Messages/msgA/Pupils/pupilA/TeacherRecipients': {},
    'GET /tables/Messages/msgA': message,
    'PATCH /api/Messages/msgA': { id: 'msgA' },
    ...overrides
  };
  const fetcher = async (urlInput: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(urlInput)); calls.push({ url, init });
    const route = routes[`${init.method} ${url.pathname}`];
    return typeof route === 'function' ? route(init) : Response.json(route ?? {});
  };
  const client = new SchoolFoxClient({ ...loadConfig(token ? { SCHOOLFOX_TOKEN: 'fixture' } : { SCHOOLFOX_EMAIL: 'fixture@example.test', SCHOOLFOX_PASSWORD: 'fixture' }), timeoutMs }, fetcher as typeof fetch, () => new Date('2026-10-16T12:00:00Z'));
  return { client: client.absences, calls };
}
const mutations = (calls: ReturnType<typeof fixture>['calls']) => calls.filter(call => call.init.method !== 'GET' && call.url.pathname !== '/api/Users/login');

test('absence list locally filters bounded exact-context source pages without an absence total', async () => {
  const f = fixture({ 'GET /tables/Messages': { results: [message, { ...message, id: 'ordinary', messageType: 'Message' }], count: 30 } });
  assert.deepEqual(await f.client.list({ ...ctx, top: 5, skip: 10 }), { results: [message], sourceMessageCount: 30, top: 5, skip: 10 });
  const query = f.calls.at(-1)!.url.searchParams;
  assert.equal(query.get('$top'), '5'); assert.equal(query.get('$skip'), '10');
  assert.equal(query.get('$filter'), "Deleted eq false and SchoolClassId eq 'classA' and PupilId eq 'pupilA'");
  assert.deepEqual(await f.client.detail({ ...ctx, messageId: 'msgA' }), message);
  assert.deepEqual(await f.client.options(ctx), { reasons: [...absenceReasons], teachers: [{ teacherId: 'teacherA', firstName: 'Teacher', lastName: 'Fixture' }] });
});

test('creation normalizes Berlin dates and sends the exact selected teacher array once', async () => {
  const f = fixture();
  assert.deepEqual(await f.client.report(input), { messageId: 'msgA', delivery: 'sent' });
  const writes = mutations(f.calls); assert.equal(writes.length, 2);
  assert.deepEqual(JSON.parse(String(writes[0]!.init.body)), { startDate: '2026-10-15T22:00:00.000Z', endDate: '2026-10-16T21:59:59.000Z', content: 'ABSENCE_ILLNESS', allDayEvent: true, messageType: 'Absence', topic: 'Absence', instantMessagesAllowed: true, schoolId: 'schoolA', schoolClassId: 'classA', applicationVersion: '10.10.0', recipientsType: 'All' });
  assert.deepEqual(JSON.parse(String(writes[1]!.init.body)), ['teacherA']);
  assert.equal(writes[1]!.url.searchParams.get('sendAbsenceNotifications'), 'true');
  const overlap = f.calls.find(call => call.url.pathname.endsWith('HasAbsence'))!.url.searchParams;
  assert.equal(overlap.get('startDate'), '2026-10-15T22:00:00.000Z'); assert.equal(overlap.has('ignoreMessageId'), false);
});

test('spring and autumn DST all-day boundaries, arbitrary zone and equal timed endpoints', async () => {
  for (const [date, from, to] of [
    ['2026-03-29', '2026-03-28T23:00:00.000Z', '2026-03-29T21:59:59.000Z'],
    ['2026-10-25', '2026-10-24T22:00:00.000Z', '2026-10-25T22:59:59.000Z']
  ]) {
    const f = fixture(); await f.client.report({ ...input, startDate: date!, endDate: date! });
    const body = JSON.parse(String(mutations(f.calls)[0]!.init.body)); assert.equal(body.startDate, from); assert.equal(body.endDate, to);
  }
  const f = fixture(); await f.client.report({ ...input, allDayEvent: false, startDate: '2026-10-16T10:00:00+02:00', endDate: '2026-10-16T08:00:00Z', timeZone: 'UTC' });
  const body = JSON.parse(String(mutations(f.calls)[0]!.init.body)); assert.equal(body.startDate, body.endDate);
});

test('explicit empty recipients and deduplicated selections do not auto-select teachers', async () => {
  const f = fixture({ 'GET /api/SchoolClasses/classA/Teachers': [{ teacherId: 'teacherA' }, { teacherId: 'teacherB' }] });
  await f.client.report({ ...input, teacherIds: [] });
  assert.equal(JSON.parse(String(mutations(f.calls)[0]!.init.body)).recipientsType, 'NotAll');
  assert.deepEqual(JSON.parse(String(mutations(f.calls)[1]!.init.body)), []);
  const g = fixture(); await g.client.report({ ...input, teacherIds: ['teacherA', 'teacherA'] });
  assert.deepEqual(JSON.parse(String(mutations(g.calls)[1]!.init.body)), ['teacherA']);
});

test('invalid dates, timezone, interval and reason fail before account access', async () => {
  for (const changed of [ { startDate: '2026-02-30' }, { timeZone: 'Invalid/Zone' }, { endDate: '2026-10-15' }, { allDayEvent: false, startDate: '2026-10-16T10:00:00', endDate: '2026-10-16T11:00:00' }, { reason: 'INVALID' }, { teacherIds: undefined } ]) {
    const f = fixture(); await assert.rejects(f.client.report({ ...input, ...changed } as typeof input)); assert.equal(f.calls.length, 0);
  }
});

test('inventory, feature gate, recipients and overlap fail closed before writes', async () => {
  for (const overrides of [
    { 'GET /api/Common/Inventory': {} },
    { 'GET /api/Common/Inventory': [school, { ...pupil, isActive: false }] },
    { 'GET /api/Common/Inventory': [school, { ...pupil, deleted: true }] },
    { 'GET /api/Common/Inventory': [{ ...school, purchasedFeature: 'Basic' }, pupil] },
    { 'GET /api/SchoolClasses/classA/Teachers': {} },
    { 'GET /api/SchoolClasses/classA/Teachers': [{}] },
    { 'GET /api/SchoolClasses/classA/Teachers': [] },
    { 'GET /api/Messages/HasAbsence': {} },
    { 'GET /api/Messages/HasAbsence': true }
  ]) { const f = fixture(overrides); await assert.rejects(f.client.report(input)); assert.equal(mutations(f.calls).length, 0); }
});

test('foreign context and inactive/nonabsence details never return account data', async () => {
  for (const changed of [ { schoolId: 'foreign' }, { schoolClassId: 'foreign' }, { pupilId: 'foreign' }, { id: 'foreign' }, { messageType: 'Message' }, { deleted: true }, { isArchived: true } ]) {
    const f = fixture({ 'GET /tables/Messages/msgA': { ...message, ...changed } });
    await assert.rejects(f.client.detail({ ...ctx, messageId: 'msgA' }));
  }
  const f = fixture({ 'GET /tables/Messages': { results: [{ ...message, pupilId: 'foreign' }], count: 1 } });
  await assert.rejects(f.client.list({ ...ctx, top: 25, skip: 0 }));
});

test('partial send returns saved ID and safe error without replay', async () => {
  for (const response of [() => new Response('private content', { status: 401 }), () => { throw new Error('private token'); }]) {
    const f = fixture({ 'POST /api/Messages/msgA/Pupils/pupilA/TeacherRecipients': response });
    const result = await f.client.report(input); assert.equal(result.messageId, 'msgA'); assert.equal(result.delivery, 'incomplete'); assert.equal(result.retrySafe, false);
    assert.doesNotMatch(JSON.stringify(result), /private/); assert.equal(mutations(f.calls).length, 2);
  }
  const f = fixture({ 'POST /tables/Messages': () => { throw new Error('network failure'); } });
  assert.equal((await f.client.report(input)).delivery, 'unknown'); assert.equal(mutations(f.calls).length, 1);
  const g = fixture({ 'POST /tables/Messages': {} }); assert.equal((await g.client.report(input)).delivery, 'unknown'); assert.equal(mutations(g.calls).length, 1);
});

test('edit preserves unrelated model and change history, strips transient fields and retains recipients', async () => {
  const previous = { Date: '2026-01-01', Text: 'Earlier note' };
  const f = fixture({ 'GET /tables/Messages/msgA': { ...message, custom: 'keep', info: [], recipientsNames: 'remove', recipientsType: 'All', messageProperties: JSON.stringify({ Other: 42, Changes: [previous] }) } });
  assert.deepEqual(await f.client.edit({ ...input, messageId: 'msgA', changeNote: 'Correction' }), { messageId: 'msgA', updated: true });
  const writes = mutations(f.calls); assert.equal(writes.length, 1); assert.equal(writes[0]!.init.method, 'PATCH');
  const body = JSON.parse(String(writes[0]!.init.body)); assert.equal(body.custom, 'keep'); assert.equal(body.recipientsType, 'All'); assert.equal('info' in body, false); assert.equal('recipientsNames' in body, false);
  assert.deepEqual(JSON.parse(body.messageProperties), { Other: 42, Changes: [previous, { Date: '2026-10-16T12:00:00.000Z', Text: 'Correction' }] });
  assert.equal(f.calls.find(call => call.url.pathname.endsWith('HasAbsence'))!.url.searchParams.get('ignoreMessageId'), 'msgA');
});

test('edit permits optional notes and validated object properties', async () => {
  for (const properties of [undefined, null, { Other: true }]) {
    const f = fixture({ 'GET /tables/Messages/msgA': { ...message, messageProperties: properties } });
    await f.client.edit({ ...input, messageId: 'msgA' });
    const history = JSON.parse(JSON.parse(String(mutations(f.calls)[0]!.init.body)).messageProperties).Changes;
    assert.deepEqual(history, [{ Date: '2026-10-16T12:00:00.000Z' }]);
  }
});

test('edit blocks missing identity, creator, ownership and malformed change history', async () => {
  for (const changed of [ { createdBy: 'other' }, { isOwned: false }, { messageProperties: '{' }, { messageProperties: '[]' }, { messageProperties: { Changes: 'bad' } } ]) {
    const f = fixture({ 'GET /tables/Messages/msgA': { ...message, ...changed } });
    await assert.rejects(f.client.edit({ ...input, messageId: 'msgA' })); assert.equal(mutations(f.calls).length, 0);
  }
  const f = fixture({}, true); await assert.rejects(f.client.edit({ ...input, messageId: 'msgA' }), /login_identity_required/);
  const g = fixture({ 'PATCH /api/Messages/msgA': { id: 'other' } }); assert.equal((await g.client.edit({ ...input, messageId: 'msgA' })).updated, 'unknown'); assert.equal(mutations(g.calls).length, 1);
});


test('recipient options reject foreign class rows and remove inactive or deleted teachers', async () => {
  const f = fixture({ 'GET /api/SchoolClasses/classA/Teachers': [{ teacherId: 'teacherA', classId: 'foreign' }] });
  await assert.rejects(f.client.options(ctx), /teacher_context_mismatch/);
  const g = fixture({ 'GET /api/SchoolClasses/classA/Teachers': [{ teacherId: 'teacherA', deleted: true }, { teacherId: 'teacherB', isActive: false }] });
  assert.deepEqual((await g.client.options(ctx)).teachers, []);
});

test('a skipped local calendar date and offset-only timezone fail before writes', async () => {
  const f = fixture();
  await assert.rejects(f.client.report({ ...input, startDate: '2011-12-30', endDate: '2011-12-30', timeZone: 'Pacific/Apia' }), /invalid_local_date/);
  await assert.rejects(f.client.report({ ...input, timeZone: '+01:00' }), /invalid_time_zone/);
  assert.equal(f.calls.length, 0);
});

test('shared pupil guard rejects concurrent report/report, edit/edit and report/edit before requests', async () => {
  for (const [first, second] of [['report', 'report'], ['edit', 'edit'], ['report', 'edit']] as const) {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture({ 'GET /api/Common/Inventory': async () => { entered(); await gate; return Response.json([school, pupil]); } });
    const call = (method: 'report' | 'edit') => method === 'report' ? f.client.report(input) : f.client.edit({ ...input, messageId: 'msgA' });
    const pending = call(first); await started;
    const count = f.calls.length;
    await assert.rejects(call(second), /absence_write_in_progress/); assert.equal(f.calls.length, count);
    release(); await pending;
    await call(second); // Finally released the same guard after success.
  }
  const f = fixture({ 'GET /api/Messages/HasAbsence': true });
  await assert.rejects(f.client.report(input), /absence_overlap/);
  await assert.rejects(f.client.report(input), /absence_overlap/); // Released after preflight failure too.
});

test('save uncertainty includes safe stage and known ID only, and never sends recipients', async () => {
  for (const response of [() => { throw new Error('private lost response'); }, () => new Response('{'), {}, { id: 'invalid id' }, { id: 'msgA', schoolId: 'foreign' }, { id: 'msgA', schoolClassId: 'foreign' }, { id: 'msgA', pupilId: 'foreign' }, { id: 'msgA', messageType: 'Message' }]) {
    const f = fixture({ 'POST /tables/Messages': response });
    const result = await f.client.report(input);
    assert.equal(result.delivery, 'unknown'); assert.ok('stage' in result); assert.equal(result.stage, 'save'); assert.equal(result.retrySafe, false);
    assert.equal(result.messageId, typeof response === 'object' && 'id' in response && response.id === 'msgA' ? 'msgA' : undefined);
    assert.doesNotMatch(JSON.stringify(result), /private/); assert.equal(mutations(f.calls).length, 1);
    assert.equal(f.calls.some(call => call.url.pathname.includes('TeacherRecipients')), false);
  }
});

test('edit PATCH network, timeout and malformed responses report unknown exactly once', async () => {
  for (const response of [() => { throw new Error('private connection'); }, () => new Response('{'), {}, { id: 'other' }]) {
    const f = fixture({ 'PATCH /api/Messages/msgA': response });
    const result = await f.client.edit({ ...input, messageId: 'msgA' });
    assert.equal(result.messageId, 'msgA'); assert.equal(result.updated, 'unknown'); assert.equal(result.retrySafe, false);
    assert.doesNotMatch(JSON.stringify(result), /private/); assert.equal(mutations(f.calls).length, 1);
  }
});

test('archived absence rows are filtered without changing source count', async () => {
  const f = fixture({ 'GET /tables/Messages': { results: [message, { ...message, id: 'archived', isArchived: true }], count: 50 } });
  const page = await f.client.list({ ...ctx, top: 25, skip: 0 }); assert.deepEqual(page.results, [message]); assert.equal(page.sourceMessageCount, 50);
});

test('Kathmandu all-day dates preserve quarter-hour timezone offset', async () => {
  const f = fixture(); await f.client.report({ ...input, timeZone: 'Asia/Kathmandu' });
  const body = JSON.parse(String(mutations(f.calls)[0]!.init.body));
  assert.equal(body.startDate, '2026-10-15T18:15:00.000Z'); assert.equal(body.endDate, '2026-10-16T18:14:59.000Z');
});

test('one available teacher keeps All model shortcut with explicit empty delivery array', async () => {
  const f = fixture(); await f.client.report({ ...input, teacherIds: [] });
  assert.equal(JSON.parse(String(mutations(f.calls)[0]!.init.body)).recipientsType, 'All');
  assert.deepEqual(JSON.parse(String(mutations(f.calls)[1]!.init.body)), []);
});

test('edit rechecks creator identity after overlap recovery changes or removes identity', async () => {
  for (const user of [ { ...login.user, id: 'other' }, { id: 'userA' } ]) {
    let overlapCalls = 0;
    const f = fixture({
      'GET /api/Messages/HasAbsence': () => ++overlapCalls === 1 ? new Response('', { status: 401 }) : Response.json(false),
      'GET /api/Users/login/token': { token: 'renewed', user }
    });
    await assert.rejects(f.client.edit({ ...input, messageId: 'msgA' }), /absence_edit_forbidden|login_identity_required/);
    assert.equal(overlapCalls, 2); assert.equal(mutations(f.calls).length, 0);
  }
});


test('edit transport timeout leaves explicit unknown outcome without replay', async () => {
  const f = fixture({ 'PATCH /api/Messages/msgA': (init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init.signal!.addEventListener('abort', () => reject(new DOMException('private timeout', 'AbortError')), { once: true });
  }) }, false, 10);
  const result = await f.client.edit({ ...input, messageId: 'msgA' });
  assert.equal(result.updated, 'unknown'); assert.equal(result.error?.code, 'timeout'); assert.equal(result.retrySafe, false);
  assert.equal(mutations(f.calls).length, 1);
});


test('an unassigned saved pupil null proceeds once to the selected pupil recipient route', async () => {
  const f = fixture({ 'POST /tables/Messages': { id: 'msgA', pupilId: null } });
  assert.deepEqual(await f.client.report(input), { messageId: 'msgA', delivery: 'sent' });
  const writes = mutations(f.calls);
  assert.equal(writes.length, 2);
  assert.equal(writes[1]!.url.pathname, '/api/Messages/msgA/Pupils/pupilA/TeacherRecipients');
  assert.deepEqual(JSON.parse(String(writes[1]!.init.body)), ['teacherA']);
});
