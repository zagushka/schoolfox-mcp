import { z } from 'zod';

export const idSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/, 'Invalid ID');
export const pageSchema = z.object({ top: z.number().int().min(1).max(50).default(25), skip: z.number().int().min(0).max(1000).default(0) });
export const recordSchema = z.record(z.string(), z.unknown());
export type RecordData = z.infer<typeof recordSchema>;

export class SchoolFoxError extends Error {
  constructor(public operation: string, public code: string, public status?: number) {
    super(`${operation}: ${code}${status ? ` (${status})` : ''}`);
  }
  toJSON() { return { operation: this.operation, code: this.code, ...(this.status ? { status: this.status } : {}) }; }
}
export function object(value: unknown, operation: string): RecordData {
  const result = recordSchema.safeParse(value);
  if (!result.success) throw new SchoolFoxError(operation, 'unexpected_response');
  return result.data;
}
export function requiredId(value: unknown, operation: string): string {
  const result = idSchema.safeParse(value);
  if (!result.success) throw new SchoolFoxError(operation, 'unexpected_response');
  return result.data;
}
export function list(value: unknown, operation: string): { results: RecordData[]; count: number } {
  const obj = object(value, operation);
  if (!Array.isArray(obj.results) || !Number.isSafeInteger(obj.count) || (obj.count as number) < 0) throw new SchoolFoxError(operation, 'unexpected_response');
  const results = obj.results.map(x => {
    const row = object(x, operation);
    requiredId(row.id, operation);
    return row;
  });
  return { results, count: obj.count as number };
}
export function quoteId(id: string): string { return `'${idSchema.parse(id)}'`; }
export function pupilFromMessage(row: RecordData): string | undefined {
  return typeof row.pupilId === 'string' ? row.pupilId : typeof row.PupilId === 'string' ? row.PupilId : undefined;
}
