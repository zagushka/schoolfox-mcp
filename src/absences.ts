import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { SchoolFoxError, idSchema, list, object, pageSchema, quoteId, requiredId, type RecordData } from './contracts.js';
import { SchoolFoxTransport } from './transport.js';

export const absenceReasons = ['ABSENCE_ILLNESS', 'ABSENCE_DOCTOR', 'ABSENCE_PRIVATE_APPOINTMENT', 'ABSENCE_FAMILY_REASONS', 'ABSENCE_OTHER'] as const;
const contextSchema = z.object({ schoolId: idSchema, classId: idSchema, pupilId: idSchema });
const datesSchema = contextSchema.extend({ reason: z.enum(absenceReasons), startDate: z.string().describe('ISO date YYYY-MM-DD when allDayEvent is true; otherwise an ISO timestamp with an explicit UTC offset or Z.'), endDate: z.string().describe('ISO date YYYY-MM-DD when allDayEvent is true; otherwise an ISO timestamp with an explicit UTC offset or Z. Must not precede startDate.'), allDayEvent: z.boolean().describe('True normalizes the selected local dates to 00:00:00 through 23:59:59; false requires offset timestamps and permits equal endpoints.'), timeZone: z.string().min(1).max(100).default('Europe/Berlin').describe('IANA timezone for all-day date conversion, for example Europe/Berlin. Timed timestamps use their explicit offsets.') });
export const absenceReportSchema = datesSchema.extend({ teacherIds: z.array(idSchema).max(200) });
export const absenceEditSchema = datesSchema.extend({ messageId: idSchema, changeNote: z.string().max(10000).optional() });
type Context = z.infer<typeof contextSchema>;
type Dates = z.infer<typeof datesSchema>;
const safeError = (error: unknown, operation: string) => error instanceof SchoolFoxError ? error.toJSON() : { operation, code: 'unexpected_response' };
const fail = (operation: string, code: string): never => { throw new SchoolFoxError(operation, code); };

function localInstant(day: string, end: boolean, timeZone: string, operation: string): string {
  const desired = new Date(`${day}T${end ? '23:59:59' : '00:00:00'}.000Z`).getTime();
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  let guess = desired;
  for (let i = 0; i < 5; i++) {
    const parts = formatter.formatToParts(new Date(guess));
    const part = (name: string) => Number(parts.find(p => p.type === name)!.value);
    const seen = new Date(0);
    seen.setUTCFullYear(part('year'), part('month') - 1, part('day'));
    seen.setUTCHours(part('hour'), part('minute'), part('second'), 0);
    const delta = desired - seen.getTime();
    if (delta === 0) return new Date(guess).toISOString();
    guess += delta;
  }
  return fail(operation, 'invalid_local_date');
}
function dates(input: Dates, operation: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_+\-/]*$/.test(input.timeZone)) fail(operation, 'invalid_time_zone');
  try { new Intl.DateTimeFormat('en-US', { timeZone: input.timeZone }); }
  catch { fail(operation, 'invalid_time_zone'); }
  const schema = input.allDayEvent ? z.iso.date() : z.iso.datetime({ offset: true });
  if (!schema.safeParse(input.startDate).success || !schema.safeParse(input.endDate).success) fail(operation, 'invalid_dates');
  const startDate = input.allDayEvent ? localInstant(input.startDate, false, input.timeZone, operation) : new Date(input.startDate).toISOString();
  const endDate = input.allDayEvent ? localInstant(input.endDate, true, input.timeZone, operation) : new Date(input.endDate).toISOString();
  if (Date.parse(startDate) > Date.parse(endDate)) fail(operation, 'invalid_interval');
  return { startDate, endDate, content: input.reason, allDayEvent: input.allDayEvent };
}

export class AbsenceFeatureClient {
  private readonly writingPupils = new Set<string>();

  private async writeGuard<T>(pupilId: string, operation: string, run: () => Promise<T>): Promise<T> {
    if (this.writingPupils.has(pupilId)) fail(operation, 'absence_write_in_progress');
    this.writingPupils.add(pupilId);
    try { return await run(); }
    finally { this.writingPupils.delete(pupilId); }
  }

  constructor(private readonly transport: SchoolFoxTransport, private readonly now: () => Date = () => new Date()) {}

  private async context(input: Context, operation: string, write = false) {
    contextSchema.parse(input);
    const value = await this.transport.request(operation, 'GET', `api/Common/Inventory?schoolId=${encodeURIComponent(input.schoolId)}`);
    if (!Array.isArray(value)) fail(operation, 'unexpected_response');
    const rows = (value as unknown[]).map(row => object(row, operation));
    const pupils = rows.filter(row => row.id === input.pupilId && row.itemType === 'Pupil' && row.schoolId === input.schoolId && row.schoolClassId === input.classId && row.isActive === true && row.deleted === false && row.applicationType === 'SchoolFox');
    if (pupils.length !== 1) fail(operation, 'pupil_context_unavailable');
    if (write) {
      const schools = rows.filter(row => row.id === input.schoolId && row.itemType === 'School' && row.applicationType === 'SchoolFox');
      if (schools.length !== 1 || !['PlusDemo', 'Plus', 'Max'].includes(String(schools[0]!.purchasedFeature))) fail(operation, 'absence_plan_unavailable');
    }
  }

  private checkMessage(row: RecordData, input: Context, operation: string) {
    if (row.schoolId !== input.schoolId || row.schoolClassId !== input.classId || row.pupilId !== input.pupilId) fail(operation, 'message_context_mismatch');
  }

  async list(input: Context & { top: number; skip: number }) {
    const operation = 'absences';
    const { top, skip } = pageSchema.parse(input);
    await this.context(input, operation);
    const filter = `Deleted eq false and SchoolClassId eq ${quoteId(input.classId)} and PupilId eq ${quoteId(input.pupilId)}`;
    const page = list(await this.transport.request(operation, 'GET', this.transport.query('tables/Messages', filter, 'UpdatedAt desc', top, skip)), operation);
    for (const row of page.results) this.checkMessage(row, input, operation);
    return { results: page.results.filter(row => row.messageType === 'Absence' && row.deleted !== true && row.isArchived !== true), sourceMessageCount: page.count, top, skip };
  }

  private async fetchDetail(input: Context & { messageId: string }, operation: string) {
    const id = idSchema.parse(input.messageId);
    const row = object(await this.transport.request(operation, 'GET', `tables/Messages/${id}`), operation);
    if (requiredId(row.id, operation) !== id) fail(operation, 'unexpected_response');
    this.checkMessage(row, input, operation);
    if (row.messageType !== 'Absence' || row.deleted === true || row.isArchived === true) fail(operation, 'absence_unavailable');
    return row;
  }

  async detail(input: Context & { messageId: string }) {
    await this.context(input, 'absence_detail');
    return this.fetchDetail(input, 'absence_detail');
  }

  private async teachers(classId: string, operation: string) {
    const value = await this.transport.request(operation, 'GET', `api/SchoolClasses/${idSchema.parse(classId)}/Teachers`);
    if (!Array.isArray(value)) fail(operation, 'unexpected_response');
    const teachers = new Map<string, { teacherId: string; firstName?: string; lastName?: string }>();
    for (const valueRow of value as unknown[]) {
      const row = object(valueRow, operation);
      const teacherId = requiredId(row.teacherId, operation);
      if (row.classId !== undefined && row.classId !== classId) fail(operation, 'teacher_context_mismatch');
      if (row.deleted === true || row.isActive === false) continue;
      if (!teachers.has(teacherId)) teachers.set(teacherId, { teacherId, ...(typeof row.firstName === 'string' ? { firstName: row.firstName } : {}), ...(typeof row.lastName === 'string' ? { lastName: row.lastName } : {}) });
    }
    return [...teachers.values()];
  }

  async options(input: Context) {
    await this.context(input, 'absence_options');
    return { reasons: [...absenceReasons], teachers: await this.teachers(input.classId, 'absence_options') };
  }

  private async overlap(input: Context, normalized: ReturnType<typeof dates>, operation: string, messageId?: string) {
    const query = new URLSearchParams({ pupilId: input.pupilId, startDate: normalized.startDate, endDate: normalized.endDate, ...(messageId ? { ignoreMessageId: messageId } : {}) });
    const value = await this.transport.request(operation, 'GET', `api/Messages/HasAbsence?${query}`);
    if (typeof value !== 'boolean') fail(operation, 'unexpected_response');
    if (value) fail(operation, 'absence_overlap');
  }

  async report(raw: z.input<typeof absenceReportSchema>) {
    const input = absenceReportSchema.parse(raw);
    return this.writeGuard(input.pupilId, 'report_absence', () => this.reportWrite(input));
  }

  private async reportWrite(input: z.infer<typeof absenceReportSchema>) {
    const operation = 'report_absence';
    const normalized = dates(input, operation);
    await this.context(input, operation, true);
    const teachers = await this.teachers(input.classId, operation);
    const teacherIds = [...new Set(input.teacherIds)];
    if (teacherIds.some(id => !teachers.some(teacher => teacher.teacherId === id))) fail(operation, 'teacher_not_available');
    await this.overlap(input, normalized, operation);
    const body = { ...normalized, messageType: 'Absence', topic: 'Absence', instantMessagesAllowed: true, schoolId: input.schoolId, schoolClassId: input.classId, applicationVersion: '10.10.0', recipientsType: teachers.length === 1 || teacherIds.length === teachers.length ? 'All' : 'NotAll' };
    let messageId: string | undefined;
    try {
      const saved = object(await this.transport.request(operation, 'POST', 'tables/Messages', body), operation);
      messageId = requiredId(saved.id, operation);
      for (const [field, expected] of Object.entries({ schoolId: input.schoolId, schoolClassId: input.classId, pupilId: input.pupilId, messageType: 'Absence' })) {
        if (saved[field] !== undefined && !(field === 'pupilId' && saved[field] === null) && saved[field] !== expected) fail(operation, 'message_context_mismatch');
      }
    } catch (error) {
      return { ...(messageId ? { messageId } : {}), stage: 'save', delivery: 'unknown', retrySafe: false, error: safeError(error, operation) };
    }
    try {
      await this.transport.request(operation, 'POST', `api/Messages/${messageId}/Pupils/${input.pupilId}/TeacherRecipients?sendAbsenceNotifications=true`, teacherIds);
    } catch (error) {
      return { messageId, delivery: 'incomplete', retrySafe: false, error: error instanceof SchoolFoxError ? error.toJSON() : { operation, code: 'unexpected_response' } };
    }
    return { messageId, delivery: 'sent' };
  }

  async edit(raw: z.input<typeof absenceEditSchema>) {
    const input = absenceEditSchema.parse(raw);
    return this.writeGuard(input.pupilId, 'edit_absence', () => this.editWrite(input));
  }

  private async editWrite(input: z.infer<typeof absenceEditSchema>) {
    const operation = 'edit_absence';
    const normalized = dates(input, operation);
    await this.context(input, operation, true);
    const detail = await this.fetchDetail(input, operation);
    const identity = this.transport.requireIdentity(operation);
    if (detail.isOwned !== true || detail.createdBy !== identity.id) fail(operation, 'absence_edit_forbidden');
    let properties: RecordData = {};
    if (detail.messageProperties !== undefined && detail.messageProperties !== null) {
      let value = detail.messageProperties;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch { fail(operation, 'unexpected_response'); }
      }
      properties = object(value, operation);
    }
    if (properties.Changes !== undefined && !Array.isArray(properties.Changes)) fail(operation, 'unexpected_response');
    const changes = (properties.Changes ?? []) as unknown[];
    await this.overlap(input, normalized, operation, input.messageId);
    if (this.transport.requireIdentity(operation).id !== detail.createdBy) fail(operation, 'absence_edit_forbidden');
    const body: RecordData = { ...detail, ...normalized, messageProperties: JSON.stringify({ ...properties, Changes: [...changes, { Date: this.now().toISOString(), ...(input.changeNote !== undefined ? { Text: input.changeNote } : {}) }] }) };
    delete body.info; delete body.recipientsNames;
    try {
      const response = object(await this.transport.request(operation, 'PATCH', `api/Messages/${input.messageId}`, body), operation);
      if (requiredId(response.id, operation) !== input.messageId) fail(operation, 'unexpected_response');
    } catch (error) {
      return { messageId: input.messageId, updated: 'unknown', retrySafe: false, error: safeError(error, operation) };
    }
    return { messageId: input.messageId, updated: true };
  }
}

const safe = async (fn: () => Promise<unknown>) => {
  try { const value = await fn(); return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }; }
  catch (error) { return { content: [{ type: 'text' as const, text: JSON.stringify(error instanceof SchoolFoxError ? error.toJSON() : { operation: 'tool', code: 'invalid_input_or_internal_error' }) }], isError: true }; }
};
export function registerAbsenceTools(server: McpServer, client: AbsenceFeatureClient): void {
  server.registerTool('schoolfox_absences', { description: 'List absence messages in one bounded message page for an exact active pupil. sourceMessageCount counts all source messages, not absences.', inputSchema: contextSchema.extend(pageSchema.shape), annotations: { readOnlyHint: true } }, input => safe(() => client.list(input)));
  server.registerTool('schoolfox_absence_detail', { description: 'Get an active absence message in exact school, class and pupil context. General detail GET read-state effects remain unverified.', inputSchema: contextSchema.extend({ messageId: idSchema }), annotations: { readOnlyHint: false } }, input => safe(() => client.detail(input)));
  server.registerTool('schoolfox_absence_options', { description: 'List five absence reason codes and deduplicated class teacher choices for an exact active pupil. Does not select recipients.', inputSchema: contextSchema, annotations: { readOnlyHint: true } }, input => safe(() => client.options(input)));
  server.registerTool('schoolfox_report_absence', { description: 'Report a real pupil absence once after context, plan, teacher and overlap checks. Requires explicit teacherIds (empty allowed). All-day ISO dates use selected IANA timeZone; timed ISO timestamps require UTC offsets. Save and delivery are separate writes; incomplete delivery returns the saved messageId, while a lost save response can return an unknown outcome without an ID. Check delivery and retrySafe; never blindly retry.', inputSchema: absenceReportSchema, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } }, input => safe(() => client.report(input)));
  server.registerTool('schoolfox_edit_absence', { description: 'Edit a real owned absence once after fresh context, creator, plan and overlap checks. Preserve recipients and append optional changeNote to change history. An uncertain PATCH returns the messageId, updated: unknown and retrySafe: false. Does not cancel an absence.', inputSchema: absenceEditSchema, annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false } }, input => safe(() => client.edit(input)));
}
