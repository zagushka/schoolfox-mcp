import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SchoolFoxError, idSchema, list, object, pageSchema, quoteId, requiredId, type RecordData } from './contracts.js';
import { SchoolFoxTransport } from './transport.js';

const dateTime = z.iso.datetime({ offset: true });
const monday = z.iso.date();
const operationError = (operation: string, code: string): never => { throw new SchoolFoxError(operation, code); };
const sameTime = (a: string, b: string) => Date.parse(a) === Date.parse(b);
function instant(value: unknown, operation: string): string {
  if (typeof value !== 'string' || !dateTime.safeParse(value).success || !Number.isFinite(Date.parse(value))) operationError(operation, 'unexpected_response');
  return value as string;
}
function interval(from: string, to: string, operation: string): void {
  if (Date.parse(from) >= Date.parse(to) || Date.parse(to) - Date.parse(from) > 32 * 86400000) operationError(operation, 'invalid_interval');
}
function arrayRows(value: unknown, operation: string): RecordData[] {
  if (!Array.isArray(value)) operationError(operation, 'unexpected_response');
  return (value as unknown[]).map((row: unknown) => object(row, operation));
}
function exactField(row: RecordData, field: string, expected: string, operation: string, code: string): void {
  if (requiredId(row[field], operation) !== expected) operationError(operation, code);
}
function pathWithQuery(path: string, query: Record<string, string>): string {
  const params = new URLSearchParams(query);
  return `${path}?${params.toString()}`;
}
function zoneParts(date: Date, timeZone: string): number[] {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const number = (kind: string) => Number(parts.find(part => part.type === kind)?.value);
  return [number('year'), number('month'), number('day'), number('hour'), number('minute'), number('second')];
}
function zonedInstant(date: string, time: string, timeZone: string, operation: string): number {
  const parsed = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
  if (!parsed) operationError(operation, 'invalid_lesson_time');
  const [year, month, day] = date.split('-').map(Number);
  const hour = Number(parsed![1]), minute = Number(parsed![2]), second = Number(parsed![3] ?? 0);
  if (hour > 23 || minute > 59 || second > 59) operationError(operation, 'invalid_lesson_time');
  const desired = Date.UTC(year, month - 1, day, hour, minute, second);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const [y, m, d, h, min, sec] = zoneParts(new Date(guess), timeZone);
    const seen = Date.UTC(y, m - 1, d, h, min, sec);
    const delta = desired - seen;
    if (delta === 0) {
      for (const nearby of [guess - 3600000, guess + 3600000]) {
        const [ny, nm, nd, nh, nmin, ns] = zoneParts(new Date(nearby), timeZone);
        if (Date.UTC(ny, nm - 1, nd, nh, nmin, ns) === desired) operationError(operation, 'ambiguous_lesson_time');
      }
      return guess;
    }
    guess += delta;
  }
  return operationError(operation, 'invalid_lesson_time');
}
function lessonTime(value: unknown, operation: string): string {
  if (typeof value !== 'string') operationError(operation, 'invalid_lesson_time');
  const source = value as string;
  const time = source.includes('T') ? source.split('T')[1]!.replace(/(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?$/, '') : source;
  if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) operationError(operation, 'invalid_lesson_time');
  return time;
}

export class SchedulingFeatureClient {
  constructor(private readonly transport: SchoolFoxTransport, private readonly now: () => Date = () => new Date()) {}

  async consultations(schoolId: string, top: number, skip: number) {
    const operation = 'consultations';
    const filter = `Deleted eq false and SchoolId eq ${quoteId(schoolId)} and (End gt now() or End eq null)`;
    return list(await this.transport.request(operation, 'GET', this.transport.query('tables/Consultations', filter, 'End desc', top, skip)), operation);
  }
  async consultationDetail(schoolId: string, consultationId: string) {
    const operation = 'consultation_detail';
    const row = object(await this.transport.request(operation, 'GET', `api/Consultations/${idSchema.parse(schoolId)}/${idSchema.parse(consultationId)}`), operation);
    exactField(row, 'id', consultationId, operation, 'consultation_mismatch');
    // This endpoint is scoped by school in its path. If the body also names a school, it must agree.
    if (row.schoolId !== undefined) exactField(row, 'schoolId', schoolId, operation, 'school_mismatch');
    return row;
  }
  async consultationSlots(schoolId: string, consultationId: string, hostId: string, pupilMasterDataId: string, from: string, to: string, appointmentId?: string) {
    const operation = 'consultation_slots';
    interval(from, to, operation);
    const query: Record<string, string> = { pupilMasterDataId: idSchema.parse(pupilMasterDataId), from, to };
    if (appointmentId) query.appointmentId = idSchema.parse(appointmentId);
    const path = pathWithQuery(`api/Consultations/${idSchema.parse(schoolId)}/${idSchema.parse(consultationId)}/Hosts/${idSchema.parse(hostId)}/Slots`, query);
    const row = object(await this.transport.request(operation, 'GET', path), operation);
    if (!Array.isArray(row.slots) || typeof row.online !== 'boolean') operationError(operation, 'unexpected_response');
    const slots = arrayRows(row.slots, operation);
    for (const slot of slots) {
      instant(slot.start, operation);
      if (!Number.isSafeInteger(slot.durationMinutes) || (slot.durationMinutes as number) <= 0) operationError(operation, 'unexpected_response');
      if (slot.pupilMasterDataId !== null && slot.pupilMasterDataId !== undefined) requiredId(slot.pupilMasterDataId, operation);
      if (typeof slot.isActive !== 'boolean') operationError(operation, 'unexpected_response');
    }
    return { ...row, online: row.online as boolean, slots };
  }
  async consultationAppointments(schoolId: string, top: number, skip: number) {
    const operation = 'consultation_appointments';
    const filter = `Deleted eq false and SchoolId eq ${quoteId(schoolId)} and (End gt now() or End eq null)`;
    return list(await this.transport.request(operation, 'GET', this.transport.query('tables/ConsultationAppointments', filter, 'Start asc', top, skip)), operation);
  }
  async consultationAppointmentDetail(appointmentId: string) {
    const operation = 'consultation_appointment_detail';
    const row = object(await this.transport.request(operation, 'GET', `tables/ConsultationAppointments/${idSchema.parse(appointmentId)}`), operation);
    exactField(row, 'id', appointmentId, operation, 'appointment_mismatch');
    return row;
  }
  private consultationPupilHost(detail: RecordData, pupilMasterDataId: string, hostId: string, operation: string): void {
    const pupils = arrayRows(detail.pupils, operation);
    const pupil = pupils.find(row => row.pupilMasterDataId === pupilMasterDataId || row.id === pupilMasterDataId);
    if (!pupil) operationError(operation, 'pupil_not_found');
    const hosts = arrayRows(pupil!.hosts, operation);
    const host = hosts.find(row => row.hostId === hostId || row.id === hostId);
    if (!host) operationError(operation, 'host_not_found');
    if (host!.appointmentId !== null && host!.appointmentId !== undefined) operationError(operation, 'already_booked');
  }
  async bookConsultation(schoolId: string, consultationId: string, hostId: string, pupilMasterDataId: string, start: string) {
    const operation = 'consultation_book';
    const requestedStart = instant(start, operation);
    const requestedMillis = Date.parse(requestedStart);
    const current = this.now().getTime();
    if (requestedMillis <= current) operationError(operation, 'slot_in_past');
    const detail = await this.consultationDetail(schoolId, consultationId);
    this.consultationPupilHost(detail, pupilMasterDataId, hostId, operation);
    const bookingStart = instant(detail.bookingStart, operation);
    const bookingDeadline = instant(detail.bookingDeadline, operation);
    if (current < Date.parse(bookingStart) || current > Date.parse(bookingDeadline)) operationError(operation, 'booking_closed');
    const consultationStart = instant(detail.start, operation);
    const consultationEnd = instant(detail.end, operation);
    const requestedDay = Date.parse(new Date(requestedMillis).toISOString().slice(0, 10) + 'T00:00:00.000Z');
    const from = new Date(Math.max(requestedDay, Date.parse(consultationStart))).toISOString();
    const to = new Date(Math.min(requestedDay + 2 * 86400000, Date.parse(consultationEnd))).toISOString();
    interval(from, to, operation);
    const slotData = await this.consultationSlots(schoolId, consultationId, hostId, pupilMasterDataId, from, to);
    const matches = (slotData.slots as RecordData[]).filter(slot => sameTime(slot.start as string, requestedStart));
    if (matches.length !== 1) operationError(operation, 'slot_not_unique');
    const slot = matches[0]!;
    if (slot.isActive !== true) operationError(operation, 'slot_unavailable');
    if (slot.pupilMasterDataId !== null && slot.pupilMasterDataId !== undefined) operationError(operation, 'slot_unavailable');
    const duration = slot.durationMinutes as number;
    if (Date.parse(requestedStart) < Date.parse(from) || Date.parse(requestedStart) + duration * 60000 > Date.parse(to)) operationError(operation, 'slot_outside_consultation');
    const body = { hostId: idSchema.parse(hostId), start: slot.start, durationMinutes: duration, pupilMasterDataId: idSchema.parse(pupilMasterDataId), online: slotData.online };
    const response = object(await this.transport.request(operation, 'POST', `api/Consultations/${idSchema.parse(schoolId)}/${idSchema.parse(consultationId)}/Appointments`, body), operation);
    return { booked: true, response };
  }
  async cancelConsultation(schoolId: string, consultationId: string, appointmentId: string, pupilMasterDataId: string) {
    const operation = 'consultation_cancel';
    const appointment = await this.consultationAppointmentDetail(appointmentId);
    exactField(appointment, 'schoolId', schoolId, operation, 'school_mismatch');
    exactField(appointment, 'consultationId', consultationId, operation, 'consultation_mismatch');
    exactField(appointment, 'pupilMasterDataId', pupilMasterDataId, operation, 'pupil_mismatch');
    if (appointment.deleted === true) operationError(operation, 'appointment_unavailable');
    // A successful DELETE can be empty. Never replay an uncertain write.
    await this.transport.request(operation, 'DELETE', `api/Consultations/${idSchema.parse(schoolId)}/${idSchema.parse(consultationId)}/Appointments/${idSchema.parse(appointmentId)}`);
    return { appointmentId, cancelled: true };
  }
  async timetable(schoolId: string, classId: string, weekStart: string, timeZone = 'Europe/Berlin') {
    const operation = 'timetable';
    monday.parse(weekStart);
    if (timeZone.length > 100 || !/^[A-Za-z_][A-Za-z0-9_+\-/]*$/.test(timeZone)) operationError(operation, 'invalid_time_zone');
    try { new Intl.DateTimeFormat('en-US', { timeZone }); }
    catch { operationError(operation, 'invalid_time_zone'); }
    const mondayDate = new Date(`${weekStart}T00:00:00.000Z`);
    if (mondayDate.getUTCDay() !== 1) operationError(operation, 'monday_required');
    const nextMonday = new Date(mondayDate.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    const weekStartInstant = zonedInstant(weekStart, '00:00:00', timeZone, operation);
    const weekEndInstant = zonedInstant(nextMonday, '00:00:00', timeZone, operation);
    const school = quoteId(schoolId), schoolClass = quoteId(classId);
    const classFilter = `Deleted eq false and IsTeamClass ne true and SchoolId eq ${school}`;
    const classPath = pathWithQuery('tables/AllRolesSchoolClassesShort', { '$filter': classFilter, '$select': 'Id, Name, OrganizationParticipantsType, OrganizationEmployeesType', '$orderby': 'Name' });
    const classes = arrayRows(await this.transport.request(operation, 'GET', classPath), operation);
    if (!classes.some(row => row.id === classId || row.Id === classId)) operationError(operation, 'class_not_found');
    const lessonFilter = `SchoolClassId eq ${schoolClass} and SchoolId eq ${school} and Deleted eq false`;
    const timeFilter = `SchoolId eq ${school} and Deleted eq false`;
    const [lessonValue, timeValue] = await Promise.all([
      this.transport.request(operation, 'GET', pathWithQuery('tables/TimeTableItems', { '$filter': lessonFilter })),
      this.transport.request(operation, 'GET', pathWithQuery('tables/LessonTimes', { '$filter': timeFilter }))
    ]);
    const lessons = arrayRows(lessonValue, operation);
    const lessonTimes = arrayRows(timeValue, operation);
    for (const lesson of lessons) {
      requiredId(lesson.id, operation);
      if (lesson.schoolId !== schoolId || lesson.schoolClassId !== classId) operationError(operation, 'unexpected_response');
      const day = lesson.dayOfWeek;
      if (!Number.isSafeInteger(day) || (day as number) < 1 || (day as number) > 7) operationError(operation, 'unexpected_response');
    }
    const teacherIds = [...new Set(lessons.map(row => row.teacherId).filter((value): value is string => typeof value === 'string' && idSchema.safeParse(value).success))];
    if (teacherIds.length > 50) operationError(operation, 'too_many_teachers');
    let absences: RecordData[] = [];
    if (teacherIds.length) {
      const teacherFilter = teacherIds.map(id => `TeacherId eq ${quoteId(id)}`).join(' or ');
      const absenceFilter = `Deleted eq false and schoolId eq ${school} and AbsentFrom lt ${new Date(weekEndInstant).toISOString()} and AbsentTo gt ${new Date(weekStartInstant).toISOString()} and (${teacherFilter})`;
      absences = arrayRows(await this.transport.request(operation, 'GET', pathWithQuery('tables/TeacherAbsences', { '$filter': absenceFilter })), operation);
    }
    const timesByLesson = new Map(lessonTimes.map(row => [row.lesson, row]));
    const changes: Array<{ lessonId: string; date: string; replacementType: unknown; absentFrom: string; absentTo: string; absenceId?: string }> = [];
    for (const lesson of lessons) {
      const lessonId = requiredId(lesson.id, operation);
      const day = lesson.dayOfWeek;
      const teacherId = lesson.teacherId;
      if (typeof teacherId !== 'string' || !idSchema.safeParse(teacherId).success) continue;
      const date = new Date(mondayDate.getTime() + ((day as number) - 1) * 86400000);
      const dateText = date.toISOString().slice(0, 10);
      const time = timesByLesson.get(lesson.lesson);
      if (!time) continue;
      const start = zonedInstant(dateText, lessonTime(time.startTime, operation), timeZone, operation);
      const end = zonedInstant(dateText, lessonTime(time.endTime, operation), timeZone, operation);
      if (end <= start) operationError(operation, 'invalid_lesson_time');
      for (const absence of absences) {
        if (absence.schoolId !== schoolId || absence.teacherId !== teacherId) continue;
        const absentFrom = instant(absence.absentFrom, operation);
        const absentTo = instant(absence.absentTo, operation);
        if (Date.parse(absentFrom) >= Date.parse(absentTo)) operationError(operation, 'unexpected_response');
        if (Date.parse(absentFrom) < end && Date.parse(absentTo) > start && start < weekEndInstant) {
          changes.push({ lessonId, date: dateText, replacementType: absence.replacementType ?? null, absentFrom, absentTo,
            ...(idSchema.safeParse(absence.id).success ? { absenceId: absence.id as string } : {}) });
        }
      }
    }
    return { schoolId, classId, weekStart, timeZone, lessons, lessonTimes, changes };
  }
  async activityFeed(schoolId: string, pupilId: string, top: number, skip: number) {
    const operation = 'activity_feed';
    const school = quoteId(schoolId), pupil = quoteId(pupilId);
    const filter = `Deleted eq false and ApplicationType eq 'SchoolFox' and (organizationId eq null or (organizationId eq ${school} and (pupilId eq ${pupil} or (classId eq null and pupilId eq null)))) and (actorType eq null or actorType eq 'Parent')`;
    const feed = list(await this.transport.request(operation, 'GET', this.transport.query('tables/ActivityFeedItems', filter, 'createdAt desc', top, skip)), operation);
    for (const row of feed.results) {
      if (row.organizationId !== undefined && row.organizationId !== null && row.organizationId !== schoolId) operationError(operation, 'school_mismatch');
    }
    return { ...feed, results: feed.results.filter(row => row.actionKey !== 'ACTIVITY_DISCUSSIONS_NEW_ATTACHMENT') };
  }
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> });
const failure = (error: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(error instanceof SchoolFoxError ? error.toJSON() : { operation: 'tool', code: 'invalid_input_or_internal_error' }) }], isError: true });
const safe = async (fn: () => Promise<unknown>) => { try { return result(await fn()); } catch (error) { return failure(error); } };
export function registerSchedulingTools(server: McpServer, client: SchedulingFeatureClient): void {
  const id = idSchema;
  server.registerTool('schoolfox_consultations', { description: 'List current consultations for one school.', inputSchema: z.object({ schoolId: id }).extend(pageSchema.shape), annotations: { readOnlyHint: true } }, ({ schoolId, top, skip }) => safe(() => client.consultations(schoolId, top, skip)));
  server.registerTool('schoolfox_consultation_detail', { description: 'Get one consultation, including returned pupils and hosts.', inputSchema: z.object({ schoolId: id, consultationId: id }), annotations: { readOnlyHint: true } }, ({ schoolId, consultationId }) => safe(() => client.consultationDetail(schoolId, consultationId)));
  server.registerTool('schoolfox_consultation_slots', { description: 'Get current slots for an exact consultation, host and pupil master data ID.', inputSchema: z.object({ schoolId: id, consultationId: id, hostId: id, pupilMasterDataId: id, from: dateTime, to: dateTime, appointmentId: id.optional() }), annotations: { readOnlyHint: true } }, ({ schoolId, consultationId, hostId, pupilMasterDataId, from, to, appointmentId }) => safe(() => client.consultationSlots(schoolId, consultationId, hostId, pupilMasterDataId, from, to, appointmentId)));
  server.registerTool('schoolfox_consultation_appointments', { description: 'List current consultation appointments for one school.', inputSchema: z.object({ schoolId: id }).extend(pageSchema.shape), annotations: { readOnlyHint: true } }, ({ schoolId, top, skip }) => safe(() => client.consultationAppointments(schoolId, top, skip)));
  server.registerTool('schoolfox_consultation_appointment_detail', { description: 'Get one consultation appointment by its exact ID.', inputSchema: z.object({ appointmentId: id }), annotations: { readOnlyHint: true } }, ({ appointmentId }) => safe(() => client.consultationAppointmentDetail(appointmentId)));
  server.registerTool('schoolfox_book_consultation', { description: 'Recheck the consultation and one active slot, then book it once. This creates a real appointment for the selected pupil.', inputSchema: z.object({ schoolId: id, consultationId: id, hostId: id, pupilMasterDataId: id, start: dateTime }), annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, ({ schoolId, consultationId, hostId, pupilMasterDataId, start }) => safe(() => client.bookConsultation(schoolId, consultationId, hostId, pupilMasterDataId, start)));
  server.registerTool('schoolfox_cancel_consultation', { description: 'Recheck exact appointment, school and pupil context, then cancel it once. This cancels a real appointment.', inputSchema: z.object({ schoolId: id, consultationId: id, appointmentId: id, pupilMasterDataId: id }), annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, ({ schoolId, consultationId, appointmentId, pupilMasterDataId }) => safe(() => client.cancelConsultation(schoolId, consultationId, appointmentId, pupilMasterDataId)));
  server.registerTool('schoolfox_timetable', { description: 'Get recurring class lessons, lesson times, and matching replacement changes for one ISO week in the selected IANA time zone. weekStart must be Monday.', inputSchema: z.object({ schoolId: id, classId: id, weekStart: monday, timeZone: z.string().min(3).max(100).default('Europe/Berlin') }), annotations: { readOnlyHint: true } }, ({ schoolId, classId, weekStart, timeZone }) => safe(() => client.timetable(schoolId, classId, weekStart, timeZone)));
  server.registerTool('schoolfox_activity_feed', { description: 'List the separate activity feed for one school and pupil. Action links are returned as data only.', inputSchema: z.object({ schoolId: id, pupilId: id }).extend(pageSchema.shape), annotations: { readOnlyHint: true } }, ({ schoolId, pupilId, top, skip }) => safe(() => client.activityFeed(schoolId, pupilId, top, skip)));
}
