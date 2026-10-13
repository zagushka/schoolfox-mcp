import { SchoolFoxError, object, requiredId, type RecordData } from './contracts.js';

export interface Identity { id: string; fullUsername: string; }
export function replyBody(groupValue: unknown, identity: Identity | undefined, messageId: string, pupilId: string, text: string): RecordData {
  if (!identity) throw new SchoolFoxError('reply', 'login_identity_required');
  const group = object(groupValue, 'reply');
  if (requiredId(group.id, 'reply') === '') throw new SchoolFoxError('reply', 'invalid_group');
  if (group.messageId !== messageId || group.pupilId !== pupilId) throw new SchoolFoxError('reply', 'group_mismatch');
  if (group.isActive !== true) throw new SchoolFoxError('reply', 'reply_unavailable');
  const schoolClassId = requiredId(group.schoolClassId, 'reply');
  if (typeof group.pupilFullName !== 'string' || !group.pupilFullName.trim()) throw new SchoolFoxError('reply', 'missing_pupil_name');
  return { MessageId: messageId, PupilId: pupilId, SchoolClassId: schoolClassId, IsActive: true,
    Content: text, InstantMessageGroupId: group.id, PupilFullName: group.pupilFullName, CreatorFullName: identity.fullUsername };
}
export function confirmationBody(messageValue: unknown, identity: Identity | undefined, pupilId: string, recipientId: string, now: Date): RecordData {
  if (!identity) throw new SchoolFoxError('confirm', 'login_identity_required');
  const message = object(messageValue, 'confirm');
  if (message.signatureRequired !== false) throw new SchoolFoxError('confirm', 'signature_or_permission_unverified');
  const info = message.info;
  if (!Array.isArray(info)) throw new SchoolFoxError('confirm', 'missing_recipient_records');
  const matches = info.map(x => object(x, 'confirm')).filter(x => x.id === recipientId && x.pupilId === pupilId);
  if (matches.length !== 1) throw new SchoolFoxError('confirm', 'recipient_not_unique');
  const recipient = matches[0]!;
  requiredId(recipient.id, 'confirm'); requiredId(recipient.pupilId, 'confirm');
  if (recipient.signedByUserId || recipient.signingDate) throw new SchoolFoxError('confirm', 'already_confirmed');
  if (recipient.userId !== identity.id) throw new SchoolFoxError('confirm', 'recipient_user_mismatch');
  return { ...recipient, signedByUserId: identity.id, signingDate: now.toISOString() };
}
