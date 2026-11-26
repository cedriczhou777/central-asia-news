import { DAILY_TARGET_ARTICLES, shaPattern, type Snapshot } from './plan-b-handoff';
import { issueWindow } from './plan-b-window';

const statuses = ['selected', 'revised', 'pending_source_check', 'pending_time_check',
  'rejected_old', 'rejected_duplicate', 'rejected_false', 'rejected_irrelevant', 'unselected_priority', 'unselected_capacity'] as const;
type DecisionStatus = typeof statuses[number];
const adoptedStatuses = new Set(['selected', 'revised']);
const heldStatuses = new Set(['pending_source_check','pending_time_check']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const evidenceNote = (value: unknown): value is Record<string, unknown> =>
  record(value) && typeof value.url==='string' && /^https:\/\//.test(value.url)
  && typeof value.description==='string' && value.description.trim().length>=8;

/** Per-source decisions are bound to the final hash by verifyEditorial. */
export function editorialFunnel(final: Snapshot, selected: string[], decisions: unknown, reviewer: string) {
  if (!record(decisions)) throw new Error('editorial_decision_ledger_required');
  const candidates = new Map(final.candidates.map(c => [c.id,c]));
  const adopted = new Set(selected);
  const counts = Object.fromEntries(statuses.map(state=>[state,0])) as Record<DecisionStatus,number>;
  const bySource:Record<string, Partial<Record<DecisionStatus,number>>> = Object.create(null);
  const adoptedEventStages = new Set<string>();
  for (const [id,item] of Object.entries(decisions)) {
    const candidate = candidates.get(id);
    if (!candidate || !record(item) || item.sourceHash!==candidate.sourceHash
        || item.revision!==candidate.revision || item.reviewedBy!==reviewer
        || !statuses.includes(item.editorialState as DecisionStatus)
        || typeof item.reason !== 'string' || item.reason.trim().length<8) {
      throw new Error('editorial_decision_identity_or_reason_invalid');
    }
    const state = item.editorialState as DecisionStatus;
    if (adoptedStatuses.has(state)!==adopted.has(id)) throw new Error('editorial_decision_selection_mismatch');
    const expected = adopted.has(id) ? 'selected' : heldStatuses.has(state) ? 'pending' : 'rejected';
    if (item.decision!==expected) throw new Error('editorial_decision_selection_mismatch');
    if (state==='unselected_capacity' && selected.length<20) throw new Error('editorial_capacity_before_limit');
    if (state==='unselected_priority' && selected.length<DAILY_TARGET_ARTICLES) throw new Error('editorial_priority_before_target');
    if (state==='rejected_old') {
      const proof=item.priorPublicationEvidence;
      const date=evidenceNote(proof) ? String(proof.publishedAt) : '';
      if (!evidenceNote(proof) || !/(?:Z|[+-]\d\d:\d\d)$/.test(date) || !(Date.parse(date)<issueWindow(final.issue).start)
          || proof.noNewFacts!==true) throw new Error('prior_publication_evidence_required');
    }
    if (state==='rejected_false' && !evidenceNote(item.contradictionEvidence)) {
      throw new Error('contradictory_source_evidence_required');
    }
    if (state==='rejected_duplicate') {
      if (typeof item.duplicateOf!=='string' || item.duplicateOf===id || !candidates.has(item.duplicateOf)
          || !record(decisions[item.duplicateOf])
          || (decisions[item.duplicateOf] as Record<string,unknown>).editorialState==='rejected_duplicate') {
        throw new Error('editorial_duplicate_reference_invalid');
      }
    }
    if (adopted.has(id)) {
      if (item.firstDisclosureVerified!==true || !Array.isArray(item.firstDisclosureEvidence)
          || !item.firstDisclosureEvidence.some(evidenceNote)) {
        throw new Error('selected_candidate_missing_first_disclosure_evidence');
      }
      if (typeof item.eventGroup==='string' && item.eventGroup.trim()) {
        if (typeof item.eventPhase!=='string' || !item.eventPhase.trim() || typeof item.newFact!=='string' || item.newFact.trim().length<8) {
          throw new Error('editorial_event_progress_evidence_missing');
        }
        const key=JSON.stringify([item.eventGroup.trim(),item.eventPhase.trim()]);
        if (adoptedEventStages.has(key)) throw new Error('same_issue_event_stage_duplicate');
        adoptedEventStages.add(key);
      }
    }
    counts[state]++;
    const sourceId=candidates.get(id)?.sourceId??'unknown';
    const source=bySource[sourceId]??={};
    source[state]=(source[state]??0)+1;
  }
  if (Object.keys(decisions).length!==candidates.size) throw new Error('editorial_decision_ledger_incomplete');
  return {inventory:candidates.size, directPass:counts.selected, revisedPass:counts.revised,
    pending:counts.pending_source_check+counts.pending_time_check,
    rejected:counts.rejected_old+counts.rejected_duplicate+counts.rejected_false+counts.rejected_irrelevant,
    finallyAdopted:adopted.size, states:counts, bySource};
}

type UsageObservation = {
  callId:string; stage:string; inputHash:string; duplicateInput:boolean;
  retry:boolean; failed:boolean; evidenceReused:boolean;
  inputTokens:number|null; outputTokens:number|null; workCredits:number|null;
};

/** Usage is optional. Unknown usage stays null rather than being inferred from bytes. */
export function summarizeUsage(raw: unknown, adopted: number) {
  if (!record(raw) || !Array.isArray(raw.observations)) return null;
  const callIds = new Set<string>();
  const inputs = new Set<string>();
  const observations:UsageObservation[] = [];
  const stages:Record<string,UsageObservation[]> = Object.create(null);
  const tokenCount = (value:unknown) => typeof value==='number' && Number.isSafeInteger(value) && value>=0 ? value : null;
  const sumMeasured = (values:Array<number|null>) =>
    values.every((value):value is number=>value!==null) ? values.reduce((sum,value)=>sum+value,0) : null;
  for (const row of raw.observations) {
    if (!record(row) || typeof row.callId!=='string' || !/^[\w.:-]{1,128}$/.test(row.callId) || callIds.has(row.callId)
        || !['triage','author','independent_review','fact_check'].includes(String(row.stage))
        || typeof row.inputHash!=='string' || !shaPattern.test(row.inputHash)) continue;
    callIds.add(row.callId);
    const stage = String(row.stage);
    const scope = stage+'/'+row.inputHash;
    const observation = {callId:row.callId, stage, inputHash:row.inputHash, duplicateInput:inputs.has(scope),
      retry:row.retry===true, failed:row.failed===true, evidenceReused:row.evidenceReused===true,
      inputTokens:tokenCount(row.inputTokens), outputTokens:tokenCount(row.outputTokens),
      workCredits:typeof row.workCredits==='number' && Number.isFinite(row.workCredits) && row.workCredits>=0 ? row.workCredits : null};
    inputs.add(scope);
    observations.push(observation);
    (stages[stage]??=[]).push(observation);
  }
  if (!observations.length) return null;
  const totals = (rows:typeof observations) => ({
    calls:rows.length, duplicateInputs:rows.filter(row=>row.duplicateInput).length,
    retries:rows.filter(row=>row.retry).length, failures:rows.filter(row=>row.failed).length,
    evidenceReuses:rows.filter(row=>row.evidenceReused).length,
    inputTokens:sumMeasured(rows.map(row=>row.inputTokens)), outputTokens:sumMeasured(rows.map(row=>row.outputTokens)),
    measuredCalls:rows.filter(row=>row.inputTokens!==null && row.outputTokens!==null).length,
    workCredits:sumMeasured(rows.map(row=>row.workCredits)),
  });
  const {calls:reportedCalls,...total} = totals(observations);
  return {reportedCalls, ...total, observations, duplicateInputRatio:total.duplicateInputs/reportedCalls,
    tokensPerAdopted:total.inputTokens!==null&&total.outputTokens!==null&&adopted>0
      ?(total.inputTokens+total.outputTokens)/adopted:null,
    creditsPerAdopted:total.workCredits!==null&&adopted>0?total.workCredits/adopted:null,
    stages:Object.fromEntries(Object.entries(stages).map(([stage,rows])=>[stage,totals(rows)]))};
}
