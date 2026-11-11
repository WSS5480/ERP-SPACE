-- Drill-downs (packages/core/drill.ts): indexes for the lists that read whole
-- tables by company. reconciliation_match has no entity_id of its own; it
-- reaches its company through the statement line's bank account, so the
-- path is indexed instead (line by account, match by line exists already).
-- Indexes only: no data changes.

-- Service → Service cost, 30 days: service_cost by company and time
create index if not exists service_cost_entity_created on service_cost (entity_id, created_at);

-- Reconcile → Matched: matches reached by company through the statement line's bank account
create index if not exists bank_statement_line_account on bank_statement_line (bank_account_id);
create index if not exists reconciliation_match_created on reconciliation_match (created_at);

-- Reconcile → Card fees posted: runs by company
create index if not exists reconciliation_run_entity on reconciliation_run (entity_id, bank_account_id, ran_at);
create index if not exists reconciliation_match_run on reconciliation_match (run_id);
