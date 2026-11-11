// The approval engine, built once and reused by every module after it.
//
// Four rules it enforces so no screen has to:
//   1. the maker can never be a checker, resolved by person not by role
//   2. a step names a role and resolves it to people at decision time
//   3. a decided request is immutable; a change opens a new one
//   4. an agent calls this through the same interface a person does

import { type Client, type Scope, audit, one, q } from "./db.ts";

export type SubjectType =
  | "invoice"
  | "vendor"
  | "vendor_bank_account"
  | "payment_run"
  | "journal_entry"
  | "fiscal_period"
  | "payroll_run"
  | "employee"
  | "employee_change";

export type Policy = {
  id: string;
  steps: { seq: number; role: string }[];
  requires_callback: boolean;
};

/** The policy with the highest threshold at or below the amount. */
export async function resolvePolicy(
  c: Client,
  entityId: string,
  subjectType: SubjectType,
  amountMinor: bigint | null
): Promise<Policy | null> {
  const rows = await q<Policy & { min_amount_minor: string }>(
    c,
    `select id, steps, requires_callback, min_amount_minor
       from approval_policy
      where entity_id = $1 and subject_type = $2 and active
        and min_amount_minor <= $3
      order by min_amount_minor desc
      limit 1`,
    [entityId, subjectType, (amountMinor ?? 0n).toString()]
  );
  return rows[0] ?? null;
}

export type OpenResult =
  | { required: false }
  | { required: true; requestId: string; steps: number };

/**
 * Open a request if policy calls for one. Returns {required:false} when the
 * amount sits below every threshold -- that is the automated path.
 */
export async function openRequest(
  c: Client,
  scope: Scope,
  input: {
    subjectType: SubjectType;
    subjectId: string;
    amountMinor?: bigint | null;
    makerId: string;
  }
): Promise<OpenResult> {
  const policy = await resolvePolicy(c, scope.entityId, input.subjectType, input.amountMinor ?? null);
  if (!policy) return { required: false };

  const req = await one<{ id: string }>(
    c,
    `insert into approval_request
       (tenant_id, entity_id, subject_type, subject_id, policy_id, amount_minor, maker_id)
     values ($1,$2,$3,$4,$5,$6,$7)
     returning id, entity_id`,
    [
      scope.tenantId,
      scope.entityId,
      input.subjectType,
      input.subjectId,
      policy.id,
      input.amountMinor?.toString() ?? null,
      input.makerId,
    ]
  );

  for (const step of policy.steps) {
    await c.query(
      `insert into approval_step (request_id, seq, required_role) values ($1,$2,$3)`,
      [req.id, step.seq, step.role]
    );
  }

  await audit(c, scope, {
    table: "approval_request",
    rowId: req.id,
    action: "insert",
    after: { subject: input.subjectType, steps: policy.steps.length },
    reason: "policy requires approval at this amount",
  });

  return { required: true, requestId: req.id, steps: policy.steps.length };
}

export class ApprovalError extends Error {}

/**
 * A grant for this company, or a client-wide one -- and a client-wide grant
 * counts only inside its own client, never at another client's company.
 */
async function holdsRole(c: Client, userId: string, entityId: string, role: string): Promise<boolean> {
  const rows = await q(
    c,
    `select 1 from role_grant g
       join app_user u on u.id = g.app_user_id
       join entity e on e.id = $3
      where g.app_user_id = $1 and g.role = $2
        and (g.entity_id = $3 or (g.entity_id is null and u.tenant_id = e.tenant_id))
      limit 1`,
    [userId, role, entityId]
  );
  return rows.length > 0;
}

/**
 * May the maker decide their own request's step? Only the owner, and only when
 * no one else active in the company holds the step's role, the owner role or
 * the controller role (a controller is a real second pair of eyes even where
 * the step names another role, so a company that has one keeps maker-checker).
 * The approval types this frees in a one-person company are every type the
 * engine routes: vendor, vendor_bank_account, invoice, payment_run,
 * payroll_run, employee, employee_change, journal_entry, fiscal_period.
 */
export async function mayDecideOwn(c: Client, userId: string, entityId: string, role: string): Promise<boolean> {
  if (!(await holdsRole(c, userId, entityId, "owner"))) return false;
  const others = await q(c, `
    select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = $2
     where u.id <> $1 and u.status = 'active' and g.role in ($3, 'owner', 'controller')
       and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = e.tenant_id))
     limit 1`, [userId, entityId, role]);
  return others.length === 0;
}

export type Decision = "approved" | "rejected";

/**
 * Decide the next open step. Returns the request status afterwards.
 * The database backstops rules 1 and 3; this is the readable version.
 */
export async function decide(
  c: Client,
  scope: Scope,
  input: {
    requestId: string;
    actorId: string;
    decision: Decision;
    note?: string;
    callbackLogged?: boolean;
  }
): Promise<"open" | "approved" | "rejected"> {
  const req = await one<{
    id: string;
    status: string;
    maker_id: string;
    entity_id: string;
    subject_type: string;
    subject_id: string;
    requires_callback: boolean;
  }>(
    c,
    `select r.id, r.status, r.maker_id, r.entity_id, r.subject_type, r.subject_id,
            coalesce(p.requires_callback,false) as requires_callback
       from approval_request r
       left join approval_policy p on p.id = r.policy_id
      where r.id = $1 and r.entity_id = $2`,
    [input.requestId, scope.entityId]
  );

  if (req.status !== "open") throw new ApprovalError(`request is already ${req.status}`);

  const steps = await q<{ id: string; seq: number; required_role: string; decision: string | null }>(
    c,
    `select s.id, s.seq, s.required_role, s.decision
       from approval_step s
       join approval_request r on r.id = s.request_id and r.entity_id = $2
      where s.request_id = $1
      order by s.seq`,
    [input.requestId, scope.entityId]
  );

  const next = steps.find((s) => s.decision === null);
  if (!next) throw new ApprovalError("no step is waiting");

  // The maker is never the checker -- unless they are the owner and nobody else in the company
  // could decide this step (a one-person store would otherwise wait forever). Checked again by the database.
  let selfApproved = false;
  if (req.maker_id === input.actorId) {
    if (!(await mayDecideOwn(c, input.actorId, req.entity_id, next.required_role)))
      throw new ApprovalError("the maker cannot approve their own request");
    selfApproved = true;
  }

  if (!selfApproved && !(await holdsRole(c, input.actorId, req.entity_id, next.required_role)))
    throw new ApprovalError(`actor does not hold the role ${next.required_role} for this entity`);

  if (req.requires_callback && input.decision === "approved" && !input.callbackLogged)
    throw new ApprovalError(
      "this subject needs a callback to a number already on file, logged before approval"
    );

  await c.query(
    `update approval_step
        set decision = $2, actor_id = $3, decided_at = now(), note = $4,
            callback_logged_at = case when $5 then now() else null end, self_approved = $6
      where id = $1`,
    [next.id, input.decision, input.actorId, input.note ?? null, input.callbackLogged ?? false, selfApproved]
  );
  if (selfApproved) {
    await audit(c, scope, { table: "approval_request", rowId: input.requestId, action: "transition",
      reason: "self-approved: no other approver",
      after: { subject: req.subject_type, subjectId: req.subject_id, step: next.seq, role: next.required_role, decision: input.decision } });
  }

  let status: "open" | "approved" | "rejected" = "open";
  if (input.decision === "rejected") status = "rejected";
  else if (steps.every((s) => s.id === next.id || s.decision === "approved")) status = "approved";

  if (status !== "open") {
    await c.query(`update approval_request set status = $2, decided_at = now() where id = $1`, [
      input.requestId,
      status,
    ]);
  }

  await audit(c, scope, {
    table: "approval_step",
    rowId: next.id,
    action: "transition",
    after: { decision: input.decision, requestStatus: status },
    reason: input.note,
  });

  return status;
}

/** Could this person decide the request's waiting step now (the same rules decide() applies)? For screens that offer an Approve button. */
export async function canDecideNow(c: Client, entityId: string, requestId: string, personId: string | null): Promise<boolean> {
  if (!personId) return false;
  const r = (await q<{ maker_id: string; status: string }>(c, `select maker_id, status from approval_request where id = $1 and entity_id = $2`, [requestId, entityId]))[0];
  if (!r || r.status !== "open") return false;
  const steps = await q<{ required_role: string; decision: string | null; actor_id: string | null }>(c, `
    select s.required_role, s.decision, s.actor_id from approval_step s join approval_request r on r.id = s.request_id and r.entity_id = $2
     where s.request_id = $1 order by s.seq`, [requestId, entityId]);
  const next = steps.find((s) => s.decision === null);
  if (!next) return false;
  if (r.maker_id === personId) return mayDecideOwn(c, personId, entityId, next.required_role);
  if (steps.some((s) => s.actor_id === personId)) return false;
  return holdsRole(c, personId, entityId, next.required_role);
}
