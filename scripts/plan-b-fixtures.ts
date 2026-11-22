import { COVERAGE_VERSION, type SourceCoverage } from '../src/lib/plan-b-handoff';

export function coverageFixture(country: SourceCoverage['country'], observedAt: string): SourceCoverage {
  return { version: COVERAGE_VERSION, country, observedAt, windowEnd:observedAt.slice(0,10) + 'T06:00:00+08:00',
    state:'observed', readableSources:['source-healthy'], gaps:[], pendingWork:[], reviewWork:[],
    queues:{ listing:0, article:0, lead:0 }, closedQueueWork:[],
    queueAccounting:Object.fromEntries(['listing','article','lead'].map(kind=>[kind,
      {total:0,pending:0,review:0,closed:0,identityHash:'0'.repeat(64)}])) as NonNullable<SourceCoverage['queueAccounting']> };
}
