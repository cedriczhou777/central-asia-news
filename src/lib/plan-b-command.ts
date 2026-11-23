import { isCountry, type PlanBCountry } from './plan-b-handoff';
import { verifyEditorial } from './plan-b-editorial';
import { checkpointInput, type WorkCheckpoint } from './plan-b-checkpoint';
import { getState, saveEditorial, saveWorkCheckpoint, type SnapshotReceipt } from './plan-b-store';
import { archiveEditorial } from './plan-b-worker';
import { planBClock, planBHandlesIssue, PLAN_B_CLOCK } from './plan-b-window';

export class PlanBCommandRejected extends Error {}
function evidence<T>(check:()=>T):T{
  try{return check();}catch(error){throw new PlanBCommandRejected(error instanceof Error?error.message:'invalid_handoff');}
}

/** Both transports use exactly this window, source, CAS and independent-review gate. */
export async function applyPlanBCommand(issue:string,country:PlanBCountry,checkpoint:boolean,value:unknown) {
  const clock=planBClock();
  const allowed=checkpoint?planBHandlesIssue(issue)&&clock.minute>=PLAN_B_CLOCK.workAt&&clock.minute<PLAN_B_CLOCK.deadlineAt:clock.finalizationAllowed;
  if(!isCountry(country)||issue!==clock.issue||!allowed)throw new PlanBCommandRejected('handoff_outside_production_window');
  const rows=await getState(issue,country);
  if(checkpoint){
    const input=evidence(()=>checkpointInput(value,rows));
    if(rows.some(row=>row.step==='editorial'&&row.state==='ready'))throw new PlanBCommandRejected('editorial_already_accepted');
    const prior=input.row.receipt?.workCheckpoint as WorkCheckpoint|undefined;
    if(prior?.checkpointHash===input.checkpointHash&&prior.stage===input.stage)return {state:'duplicate',checkpoint:prior,editorialApproved:false};
    const archived=await archiveEditorial(issue,country,input.document);
    const saved:WorkCheckpoint={snapshotHash:input.snapshotHash,checkpointHash:input.checkpointHash,stage:input.stage,archived,savedAt:new Date().toISOString()};
    await saveWorkCheckpoint(input.row,saved);
    return {state:'checkpoint_saved',checkpoint:saved,editorialApproved:false};
  }
  const frozen=rows.find(row=>row.step==='final'&&row.state==='ready')?.receipt as SnapshotReceipt|undefined;
  if(!frozen)throw new PlanBCommandRejected('freeze_incomplete');
  const checked=evidence(()=>verifyEditorial(value,frozen.snapshot));
  const {value:content,...binding}=checked;
  const existing=rows.find(row=>row.step==='editorial');
  if(existing){
    if(existing.receipt?.editorialHash!==binding.editorialHash)throw new PlanBCommandRejected('signed_revision_conflict');
    return {state:'duplicate',...binding};
  }
  if(!planBClock().finalizationAllowed)throw new PlanBCommandRejected('handoff_outside_production_window');
  const archived=await archiveEditorial(issue,country,content);
  const state=await saveEditorial(issue,country,{...binding,archived,acceptedAt:new Date().toISOString(),
    actualModel:null,actualReasoning:null,actualSpeed:null,actualCredits:null});
  return {state,...binding};
}
