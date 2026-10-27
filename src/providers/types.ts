import type { Proposal, Quote, BrainResult, PreparedExecution, Settlement } from '../domain.js';
export interface Providers {
  quote(cycleId: string, proposal: Proposal): Promise<Quote>;
  assess(cycleId: string, proposal: Proposal, quote: Quote): Promise<BrainResult>;
  prepare(cycleId: string, proposal: Proposal, quote: Quote): Promise<PreparedExecution>;
  broadcast(execution: PreparedExecution): Promise<void>;
  settle(
    cycleId: string,
    proposal: Proposal,
    quote: Quote,
    execution: PreparedExecution,
  ): Promise<Settlement>;
  receipt(cycleId: string, evidence: Record<string, unknown>): Promise<Record<string, unknown>>;
}
