// The approval engine, built once and reused by every module after it.
//
// Four rules it enforces so no screen has to:
//   1. the maker can never be a checker, resolved by person not by role
//   2. a step names a role and resolves it to people at decision time
//   3. a decided request is immutable; a change opens a new one
//   4. an agent calls this through the same interface a person does

import { type Client, type Scope, audit, one, q, inSupport } from "./db.ts";

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

/** Said when an operator in support mode, acting as the owner, would self-approve. */
export const SUPPORT_SELF_APPROVAL =
  "support mode never self-approves for the owner: the owner decides their own request, signed in as themselves";

/**
 * Why may this person not decide their own request here (null: they may)?
 * Only the owner, and only when no one else active in the company holds the
 * owner role, the controller role or one of the roles that could decide it (a
 * controller is a real second pair of eyes even where the step names another
 * role, so a company that has one keeps maker-checker). Never an operator in
 * support mode acting as the owner. The database says the same in
 * self_approve_refusal() (migration 0063), which every self_approved row is
 * checked against.
 */
export async function selfApprovalRefusal(c: Client, entityId: string, userId: string, roles: string[]): Promise<string | null> {
  if (await inSupport(c)) return SUPPORT_SELF_APPROVAL;
  if (!(await holdsRole(c, userId, entityId, "owner"))) return "only the owner may approve their own request";
  const others = await q(c, `
    select 1 from role_grant g join app_user u on u.id = g.app_user_id join entity e on e.id = $2
     where u.id <> $1 and u.status = 'active' and g.role = any (array['owner', 'controller'] || $3::text[])
       and (g.entity_id = $2 or (g.entity_id is null and u.tenant_id = e.tenant_id))
     limit 1`, [userId, entityId, roles]);
  return others.length ? "someone else in this company can approve it, so the maker may not" : null;
}

/**
 * May the maker decide their own request's step? (selfApprovalRefusal is null.)
 * The approval types this frees in a one-person company are every type the
 * engine routes: vendor, vendor_bank_account, invoice, payment_run,
 * payroll_run, employee, employee_change, journal_entry, fiscal_period; and,
 * outside the engine, stock counts, A/R write-offs, debit memos and time off.
 */
export async function mayDecideOwn(c: Client, userId: string, entityId: string, role: string | string[]): Promise<boolean> {
  return (await selfApprovalRefusal(c, entityId, userId, Array.isArray(role) ? role : [role])) === null;
}

/**
 * A flow outside the engine decides its own maker's request: null when the
 * decider is not the maker (the flow's usual rules apply), true when the maker
 * may decide it as a self-approval, and a refusal (thrown) otherwise.
 */
export async function selfApprovalFor(c: Client, entityId: string, deciderId: string, makerIds: (string | null | undefined)[], roles: string[], refusal: string): Promise<boolean> {
  if (!makerIds.some((m) => m && m === deciderId)) return false;
  const why = await selfApprovalRefusal(c, entityId, deciderId, roles);
  if (why === SUPPORT_SELF_APPROVAL) throw new ApprovalError(SUPPORT_SELF_APPROVAL);
  if (why) throw new ApprovalError(refusal);
  return true;
}

/** Audit the maker's own decision (every flow writes the same row). */
export async function auditSelfApproval(c: Client, scope: Scope, table: string, rowId: string, after: Record<string, unknown>) {
  await audit(c, scope, { table, rowId, action: "transition", reason: "self-approved: no other approver", after });
}

// ------------------------------------------------- typed confirmation --

/**
 * Self-approving money going out of the door needs the owner to type what it
 * is: the payee's name for new vendor bank details, the total for a payment or
 * payroll run. Null when the subject needs no typed confirmation.
 */
export type SelfConfirm = { kind: "payee"; prompt: string; expect: string; accept: string[] } | { kind: "amount"; prompt: string; expect: string; minor: string };

const fmtUsd = (minor: bigint) => {
  const neg = minor < 0n; const v = neg ? -minor : minor;
  const d = (v / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}$${d}.${(v % 100n).toString().padStart(2, "0")}`;
};
const squash = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
/** Dollars and cents a person typed ("$1,284.55", "1284.55", "1284.5", "1284") in minor units, or null. */
export function typedMinor(s: string): bigint | null {
  const t = String(s ?? "").replace(/[$,\s]/g, "");
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(t);
  if (!m) return null;
  return BigInt(m[1]) * 100n + BigInt((m[2] ?? "0").padEnd(2, "0"));
}

export async function selfConfirmFor(c: Client, entityId: string, requestId: string): Promise<SelfConfirm | null> {
  const r = (await q<{ subject_type: string; subject_id: string; amount_minor: string | null }>(c,
    `select subject_type, subject_id, amount_minor from approval_request where id = $1 and entity_id = $2`, [requestId, entityId]))[0];
  if (!r) return null;
  if (r.subject_type === "vendor_bank_account") {
    const v = (await q<{ dba: string | null; legal_name: string }>(c, `
      select v.dba, v.legal_name from vendor_bank_account b join vendor v on v.id = b.vendor_id
       where b.id = $1 and b.vendor_id in (select vendor_id from vendor_entity where entity_id = $2)`, [r.subject_id, entityId]))[0];
    if (!v) return null;
    const name = v.dba || v.legal_name;
    return { kind: "payee", prompt: "Type the payee's name to approve your own bank change", expect: name,
             accept: [...new Set([v.dba, v.legal_name].filter((x): x is string => !!x).map(squash))] };
  }
  if (r.subject_type === "payment_run" || r.subject_type === "payroll_run") {
    let total = r.amount_minor;
    if (total == null) {
      total = r.subject_type === "payment_run"
        ? (await one<{ t: string }>(c, `select coalesce(sum(p.amount_minor), 0)::text t from payment p join payment_run pr on pr.id = p.payment_run_id and pr.entity_id = $2 where pr.id = $1`, [r.subject_id, entityId])).t
        : (await one<{ t: string }>(c, `select coalesce(net_minor, 0)::text t from payroll_run where id = $1 and entity_id = $2`, [r.subject_id, entityId])).t;
    }
    return { kind: "amount", prompt: `Type the ${r.subject_type === "payment_run" ? "run's total" : "payroll's total"} to approve your own run`,
             expect: fmtUsd(BigInt(total)), minor: String(total) };
  }
  return null;
}

/** Does what the person typed match? */
export function confirmMatches(conf: SelfConfirm, typed: unknown): boolean {
  const s = typeof typed === "string" ? typed : "";
  if (conf.kind === "payee") return !!s.trim() && conf.accept.includes(squash(s));
  const m = typedMinor(s);
  return m !== null && m === BigInt(conf.minor);
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
    /** what the owner typed to confirm their own approval (payee name, or the run's total) */
    confirm?: unknown;
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
  let confirmed: SelfConfirm | null = null;
  if (req.maker_id === input.actorId) {
    const why = await selfApprovalRefusal(c, req.entity_id, input.actorId, [next.required_role]);
    if (why === SUPPORT_SELF_APPROVAL) throw new ApprovalError(SUPPORT_SELF_APPROVAL);
    if (why) throw new ApprovalError("the maker cannot approve their own request");
    selfApproved = true;
    if (input.decision === "approved") {
      confirmed = await selfConfirmFor(c, req.entity_id, input.requestId);
      if (confirmed && !confirmMatches(confirmed, input.confirm)) {
        throw new ApprovalError(confirmed.kind === "payee"
          ? `to approve your own bank change, type the payee's name as it is on file: ${confirmed.expect}`
          : `to approve your own run, type its total exactly: ${confirmed.expect}`);
      }
    }
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
      after: { subject: req.subject_type, subjectId: req.subject_id, step: next.seq, role: next.required_role, decision: input.decision,
               ...(confirmed ? { typedConfirmation: confirmed.kind, confirmedAs: confirmed.expect } : {}) } });
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
