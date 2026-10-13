import test from 'node:test';
import assert from 'node:assert/strict';
import { SchedulingFeatureClient } from '../src/scheduling.js';
import { SchoolFoxTransport } from '../src/transport.js';
import { loadConfig } from '../src/config.js';

type Call = { url: URL; init: RequestInit };
function fixture(routes: Record<string, unknown | (() => Response)>) {
  const calls: Call[] = [];
  const fetcher = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input)); calls.push({ url, init });
    const item = routes[`${init.method} ${url.pathname}`];
    if (item === undefined) return new Response('missing fixture', { status: 404 });
    return typeof item === 'function' ? item() : Response.json(item);
  };
  const transport = new SchoolFoxTransport(loadConfig({ SCHOOLFOX_TOKEN: 'fixture-token' }), fetcher as typeof fetch);
  return { client: new SchedulingFeatureClient(transport, () => new Date('2026-10-13T10:00:00.000Z')), calls };
}
const detail = { id: 'consultA', schoolId: 'schoolA', start: '2026-10-14T08:00:00.000Z', end: '2026-10-14T18:00:00.000Z', bookingStart: '2026-10-01T00:00:00.000Z', bookingDeadline: '2026-10-14T07:00:00.000Z', pupils: [{ pupilMasterDataId: 'pupilA', hosts: [{ hostId: 'hostA', appointmentId: null }] }] };
const slots = { online: true, slots: [{ start: '2026-10-14T09:00:00.000Z', durationMinutes: 20, pupilMasterDataId: null, isActive: true }] };

test('consultation reads use first-party paths and bounded school filter', async () => {
  const { client, calls } = fixture({
    'GET /tables/Consultations': { results: [{ id: 'consultA' }], count: 1 },
    'GET /api/Consultations/schoolA/consultA': detail,
    'GET /tables/ConsultationAppointments': { results: [{ id: 'appointmentA' }], count: 1 },
    'GET /tables/ConsultationAppointments/appointmentA': { id: 'appointmentA', schoolId: 'schoolA' },
    'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': slots
  });
  assert.equal((await client.consultations('schoolA', 25, 0)).count, 1);
  assert.equal((await client.consultationDetail('schoolA', 'consultA')).id, 'consultA');
  assert.equal((await client.consultationAppointments('schoolA', 25, 0)).count, 1);
  assert.equal((await client.consultationAppointmentDetail('appointmentA')).id, 'appointmentA');
  assert.equal((await client.consultationSlots('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-13T00:00:00.000Z', '2026-10-14T18:00:00.000Z')).slots.length, 1);
  assert.match(calls[0]!.url.searchParams.get('$filter')!, /SchoolId eq 'schoolA'/);
  assert.equal(calls[0]!.url.searchParams.get('$top'), '25');
  assert.equal(calls[4]!.url.searchParams.get('pupilMasterDataId'), 'pupilA');
  assert.equal(calls[4]!.url.searchParams.get('from'), '2026-10-13T00:00:00.000Z');
});

test('booking rechecks exact slot and sends only one POST with verified fields', async () => {
  const { client, calls } = fixture({
    'GET /api/Consultations/schoolA/consultA': detail,
    'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': slots,
    'POST /api/Consultations/schoolA/consultA/Appointments': { id: 'appointmentA' }
  });
  assert.deepEqual(await client.bookConsultation('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-14T09:00:00.000Z'), { booked: true, response: { id: 'appointmentA' } });
  assert.deepEqual(JSON.parse(String(calls[2]!.init.body)), { hostId: 'hostA', start: '2026-10-14T09:00:00.000Z', durationMinutes: 20, pupilMasterDataId: 'pupilA', online: true });
  assert.equal(calls.filter(call => call.init.method === 'POST').length, 1);
});

test('booking blocks stale, wrong-pupil and closed slots before POST', async () => {
  for (const [changedDetail, changedSlots] of [
    [detail, { ...slots, slots: [{ ...slots.slots[0], isActive: false }] }],
    [detail, { ...slots, slots: [{ ...slots.slots[0], pupilMasterDataId: 'pupilB' }] }],
    [{ ...detail, bookingDeadline: '2026-10-12T00:00:00.000Z' }, slots]
  ] as const) {
    const { client, calls } = fixture({ 'GET /api/Consultations/schoolA/consultA': changedDetail, 'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': changedSlots });
    await assert.rejects(client.bookConsultation('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-14T09:00:00.000Z'));
    assert.equal(calls.filter(call => call.init.method === 'POST').length, 0);
  }
});

test('booking rejects a past same-day slot and queries only the requested day window for a long event', async () => {
  const past = fixture({ 'GET /api/Consultations/schoolA/consultA': detail, 'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': slots });
  await assert.rejects(past.client.bookConsultation('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-13T09:00:00.000Z'), /slot_in_past/);
  assert.equal(past.calls.length, 0);
  const future = '2026-11-14T09:00:00.000Z';
  const long = fixture({
    'GET /api/Consultations/schoolA/consultA': { ...detail, end: '2026-12-15T18:00:00.000Z', bookingDeadline: '2026-12-01T00:00:00.000Z' },
    'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': { ...slots, slots: [{ ...slots.slots[0], start: future }] },
    'POST /api/Consultations/schoolA/consultA/Appointments': {}
  });
  assert.equal((await long.client.bookConsultation('schoolA', 'consultA', 'hostA', 'pupilA', future)).booked, true);
  const slotCall = long.calls.find(call => call.url.pathname.endsWith('/Slots'))!;
  assert.equal(slotCall.url.searchParams.get('from'), '2026-11-14T00:00:00.000Z');
  assert.equal(slotCall.url.searchParams.get('to'), '2026-11-16T00:00:00.000Z');
  assert.equal(long.calls.filter(call => call.init.method === 'POST').length, 1);
});

test('slot reads reject invalid intervals and unknown availability shapes', async () => {
  const invalid = fixture({});
  await assert.rejects(invalid.client.consultationSlots('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-14T18:00:00Z', '2026-10-14T08:00:00Z'), /invalid_interval/);
  assert.equal(invalid.calls.length, 0);
  const unknown = fixture({ 'GET /api/Consultations/schoolA/consultA/Hosts/hostA/Slots': { online: true, slots: [{ start: '2026-10-14T09:00:00Z', isActive: true }] } });
  await assert.rejects(unknown.client.consultationSlots('schoolA', 'consultA', 'hostA', 'pupilA', '2026-10-14T08:00:00Z', '2026-10-14T18:00:00Z'), /unexpected_response/);
});

test('cancellation checks appointment context and sends one DELETE', async () => {
  const match = fixture({ 'GET /tables/ConsultationAppointments/appointmentA': { id: 'appointmentA', schoolId: 'schoolA', consultationId: 'consultA', pupilMasterDataId: 'pupilA' }, 'DELETE /api/Consultations/schoolA/consultA/Appointments/appointmentA': {} });
  assert.deepEqual(await match.client.cancelConsultation('schoolA', 'consultA', 'appointmentA', 'pupilA'), { appointmentId: 'appointmentA', cancelled: true });
  assert.equal(match.calls.filter(call => call.init.method === 'DELETE').length, 1);
  const mismatch = fixture({ 'GET /tables/ConsultationAppointments/appointmentA': { id: 'appointmentA', schoolId: 'schoolB', consultationId: 'consultA', pupilMasterDataId: 'pupilA' } });
  await assert.rejects(mismatch.client.cancelConsultation('schoolA', 'consultA', 'appointmentA', 'pupilA'), /school_mismatch/);
  assert.equal(mismatch.calls.filter(call => call.init.method === 'DELETE').length, 0);
});

test('timetable returns only replacements on matching class lessons in selected week', async () => {
  const { client, calls } = fixture({
    'GET /tables/AllRolesSchoolClassesShort': [{ id: 'classA' }],
    'GET /tables/TimeTableItems': [{ id: 'lessonA', schoolId: 'schoolA', schoolClassId: 'classA', teacherId: 'teacherA', lesson: 1, dayOfWeek: 2 }],
    'GET /tables/LessonTimes': [{ lesson: 1, startTime: '09:00:00', endTime: '10:00:00' }],
    'GET /tables/TeacherAbsences': [
      { id: 'absenceA', schoolId: 'schoolA', teacherId: 'teacherA', absentFrom: '2026-10-13T07:30:00Z', absentTo: '2026-10-13T08:00:00Z', replacementType: 'Covered' },
      { schoolId: 'schoolA', teacherId: 'teacherB', absentFrom: '2026-10-13T08:00:00Z', absentTo: '2026-10-13T11:00:00Z', replacementType: 'Private' }
    ]
  });
  const result = await client.timetable('schoolA', 'classA', '2026-10-12');
  assert.equal(result.lessons.length, 1);
  assert.deepEqual(result.changes, [{ lessonId: 'lessonA', date: '2026-10-13', replacementType: 'Covered', absentFrom: '2026-10-13T07:30:00Z', absentTo: '2026-10-13T08:00:00Z', absenceId: 'absenceA' }]);
  assert.match(calls[1]!.url.searchParams.get('$filter')!, /SchoolClassId eq 'classA'/);
  const absenceFilter = calls[3]!.url.searchParams.get('$filter')!;
  assert.match(absenceFilter, /TeacherId eq 'teacherA'/);
  assert.match(absenceFilter, /AbsentFrom lt 2026-10-18T22:00:00.000Z/);
  assert.match(absenceFilter, /AbsentTo gt 2026-10-11T22:00:00.000Z/);
  assert.doesNotMatch(calls[0]!.url.searchParams.get('$filter')!, /hasTimeTable/);
  await assert.rejects(client.timetable('schoolA', 'classA', '2026-10-13'), /monday_required/);
});

test('matching absences require valid ISO times and positive intervals', async () => {
  const base = {
    'GET /tables/AllRolesSchoolClassesShort': [{ id: 'classA' }],
    'GET /tables/TimeTableItems': [{ id: 'lessonA', schoolId: 'schoolA', schoolClassId: 'classA', teacherId: 'teacherA', lesson: 1, dayOfWeek: 2 }],
    'GET /tables/LessonTimes': [{ lesson: 1, startTime: '09:00:00', endTime: '10:00:00' }]
  };
  for (const absence of [
    { absentFrom: 'not-a-time', absentTo: '2026-10-13T08:00:00Z' },
    { absentFrom: '2026-10-13T08:00:00Z', absentTo: '2026-10-13T08:00:00Z' }
  ]) {
    const { client } = fixture({ ...base, 'GET /tables/TeacherAbsences': [{ schoolId: 'schoolA', teacherId: 'teacherA', ...absence }] });
    await assert.rejects(client.timetable('schoolA', 'classA', '2026-10-12'), /unexpected_response/);
  }
});

test('empty authorized class returns an empty timetable without absence read', async () => {
  const { client, calls } = fixture({ 'GET /tables/AllRolesSchoolClassesShort': [{ id: 'classA', hasTimeTable: false }], 'GET /tables/TimeTableItems': [], 'GET /tables/LessonTimes': [] });
  const result = await client.timetable('schoolA', 'classA', '2026-10-12');
  assert.deepEqual(result.changes, []);
  assert.deepEqual(result.lessons, []);
  assert.equal(calls.some(call => call.url.pathname === '/tables/TeacherAbsences'), false);
});

test('DST converts Berlin lesson hours and week bounds to exact UTC instants', async () => {
  const routes = {
    'GET /tables/AllRolesSchoolClassesShort': [{ id: 'classA' }],
    'GET /tables/TimeTableItems': [{ id: 'lessonA', schoolId: 'schoolA', schoolClassId: 'classA', teacherId: 'teacherA', lesson: 1, dayOfWeek: 1 }],
    'GET /tables/LessonTimes': [{ lesson: 1, startTime: '09:00:00', endTime: '10:00:00' }],
    'GET /tables/TeacherAbsences': [{ schoolId: 'schoolA', teacherId: 'teacherA', absentFrom: '2026-03-30T07:30:00Z', absentTo: '2026-03-30T07:45:00Z', replacementType: 'Covered' }]
  };
  const summer = fixture(routes);
  const summerResult = await summer.client.timetable('schoolA', 'classA', '2026-03-30');
  assert.deepEqual(summerResult.changes, [{ lessonId: 'lessonA', date: '2026-03-30', replacementType: 'Covered', absentFrom: '2026-03-30T07:30:00Z', absentTo: '2026-03-30T07:45:00Z' }]);
  assert.match(summer.calls[3]!.url.searchParams.get('$filter')!, /AbsentTo gt 2026-03-29T22:00:00.000Z/);
  const winter = fixture({ ...routes, 'GET /tables/TeacherAbsences': [{ schoolId: 'schoolA', teacherId: 'teacherA', absentFrom: '2026-10-26T08:30:00Z', absentTo: '2026-10-26T08:45:00Z', replacementType: 'Covered' }] });
  const winterResult = await winter.client.timetable('schoolA', 'classA', '2026-10-26');
  assert.deepEqual(winterResult.changes, [{ lessonId: 'lessonA', date: '2026-10-26', replacementType: 'Covered', absentFrom: '2026-10-26T08:30:00Z', absentTo: '2026-10-26T08:45:00Z' }]);
  assert.match(winter.calls[3]!.url.searchParams.get('$filter')!, /AbsentTo gt 2026-10-25T23:00:00.000Z/);
});

test('New York timetable uses its own local lesson hour and UTC week bounds', async () => {
  const { client, calls } = fixture({
    'GET /tables/AllRolesSchoolClassesShort': [{ id: 'classA' }],
    'GET /tables/TimeTableItems': [{ id: 'lessonA', schoolId: 'schoolA', schoolClassId: 'classA', teacherId: 'teacherA', lesson: 1, dayOfWeek: 1 }],
    'GET /tables/LessonTimes': [{ lesson: 1, startTime: '09:00:00', endTime: '10:00:00' }],
    'GET /tables/TeacherAbsences': [{ id: 'absenceNY', schoolId: 'schoolA', teacherId: 'teacherA', absentFrom: '2026-03-30T13:30:00Z', absentTo: '2026-03-30T13:45:00Z', replacementType: 'Covered' }]
  });
  const result = await client.timetable('schoolA', 'classA', '2026-03-30', 'America/New_York');
  assert.deepEqual(result.changes, [{ lessonId: 'lessonA', date: '2026-03-30', replacementType: 'Covered', absentFrom: '2026-03-30T13:30:00Z', absentTo: '2026-03-30T13:45:00Z', absenceId: 'absenceNY' }]);
  const filter = calls.find(call => call.url.pathname === '/tables/TeacherAbsences')!.url.searchParams.get('$filter')!;
  assert.match(filter, /AbsentTo gt 2026-03-30T04:00:00.000Z/);
  assert.match(filter, /AbsentFrom lt 2026-04-06T04:00:00.000Z/);
});

test('activity feed uses pupil filter and leaves action links as data', async () => {
  const { client, calls } = fixture({ 'GET /tables/ActivityFeedItems': { results: [{ id: 'activityA', actionLink: 'https://example.invalid/path' }, { id: 'activityB', actionKey: 'ACTIVITY_DISCUSSIONS_NEW_ATTACHMENT' }], count: 2 } });
  const result = await client.activityFeed('schoolA', 'pupilA', 10, 5);
  assert.deepEqual(result.results.map(row => row.id), ['activityA']);
  assert.equal(result.count, 2);
  assert.match(calls[0]!.url.searchParams.get('$filter')!, /pupilId eq 'pupilA'/);
  assert.match(calls[0]!.url.searchParams.get('$filter')!, /ApplicationType eq 'SchoolFox'/);
  assert.match(calls[0]!.url.searchParams.get('$filter')!, /organizationId eq 'schoolA'/);
  assert.match(calls[0]!.url.searchParams.get('$filter')!, /actorType eq 'Parent'/);
  assert.equal(calls[0]!.url.searchParams.get('$skip'), '5');
  assert.equal(calls.length, 1);
  const foreign = fixture({ 'GET /tables/ActivityFeedItems': { results: [{ id: 'foreign', organizationId: 'schoolB' }], count: 1 } });
  await assert.rejects(foreign.client.activityFeed('schoolA', 'pupilA', 10, 0), /school_mismatch/);
});
