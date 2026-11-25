import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { canonicalJson, sha256 } from '../src/lib/plan-b-handoff';
import { DATABASE_APPROVAL_PREFIX, databaseApprovalSignature, isIndependentDatabaseApprovalKey, reviewedDatabaseRecoveryOpen,
  REVIEWED_DATABASE_RECOVERY_END, REVIEWED_DATABASE_RECOVERY_ISSUE } from '../src/lib/reviewed-database-delivery';
import { contentHash, issueDate, packageCountries, requirePrivateImages, validatePackage } from '../src/lib/reviewed-package';

const [file, approver, reason, output] = process.argv.slice(2);
const key = process.env.REVIEWED_DATABASE_APPROVAL_KEY || '';
if (!file || !output || !approver?.trim() || !reason || reason.trim().length < 8 || !isIndependentDatabaseApprovalKey(key)) {
  throw new Error('Provide the approved package, operator, reason, protected signing key and a new private output file');
}
const release = validatePackage(JSON.parse(readFileSync(file, 'utf8')));
requirePrivateImages(release);
const issue = issueDate(release.version);
if (issue !== REVIEWED_DATABASE_RECOVERY_ISSUE) throw new Error('Package issue not admitted for this recovery');
const countries = packageCountries(release);
const authorizationId = randomUUID();
const now = Date.now();
if (!reviewedDatabaseRecoveryOpen(now)) throw new Error('Manual recovery signing window is closed');
const approval = { issue, version: release.version, contentHash: contentHash(release), countries,
  issuedBy: approver.trim(), reason: reason.trim(), approvedAt: new Date(now).toISOString(),
  expiresAt: new Date(Math.min(now + 60 * 60_000, REVIEWED_DATABASE_RECOVERY_END)).toISOString() };
const grant = { ...approval, signature: databaseApprovalSignature(key, authorizationId, approval) };
const command = { authorizationId, release };
writeFileSync(output, JSON.stringify({
  authorization: { issue_date: issue, country: 'global', kind: 'manual_authorization', record_key: DATABASE_APPROVAL_PREFIX + authorizationId,
    payload: grant, content_hash: sha256(canonicalJson(grant)), state: 'available' },
  requests: countries.map(country => ({ issue_date: issue, country, kind: 'manual_use', record_key: `db-delivery/${authorizationId}`,
    payload: command, content_hash: sha256(canonicalJson(command)), state: 'queued' })),
}, null, 2), { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ issue, version: release.version, countries, expiresAt: approval.expiresAt, envelopeWritten: true }));
