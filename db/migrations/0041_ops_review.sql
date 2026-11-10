-- 0041_ops_review.sql
-- Fixes from the operations review:
--   * chargeback debit memos are approved by someone other than whoever entered
--     the cost (below a setting they open by themselves; default $0, so none)
--   * a backfill: every vendor chargeback already posted to 1150 becomes a
--     debit memo, so the vendor's balance includes it
--   * trade-ins credit 4095 (contra-revenue), and each jurisdiction says
--     whether a trade-in reduces its taxable sales (default: it does not)
--   * a haul-away line belongs to its own stop's invoice
--   * holidays can be cancelled (their blackouts released, unpaid holiday pay
--     cancelled); a holiday that lands on approved leave gives the hours back
--   * the decider of a leave request differs from whoever entered it
-- Nothing is deleted.

-- ------------------------------------------------------- payables setting --
create table payables_setting (
  entity_id                    uuid primary key references entity(id),
  memo_auto_approve_below_minor bigint not null default 0 check (memo_auto_approve_below_minor >= 0),
  set_by                       uuid references app_user(id),
  set_at                       timestamptz not null default now()
);

-- the person whose cost made a chargeback memo is its maker: they do not approve it
alter table vendor_debit_memo drop constraint vendor_debit_memo_check;
alter table vendor_debit_memo add constraint vendor_debit_memo_maker_checker
  check (decided_by is null or created_by is null or decided_by <> created_by);
alter table vendor_debit_memo add column auto_approved boolean not null default false;

-- ------------------------------------------------------------ backfill --
-- Every chargeback to a vendor already in 1150 with no memo becomes an open
-- memo carrying its own posting (it was approved when it was posted).
create or replace function ops_backfill_chargeback_memos() returns integer
language plpgsql as $$
declare r record; made integer := 0;
begin
  for r in
    select sc.id, sc.entity_id, e.tenant_id, st.vendor_id, st.id ticket_id, st.number, sc.amount_minor, sc.kind, sc.note,
           sc.journal_entry_id, sc.created_by, sc.created_at::date on_day,
           (select g.code from journal_line jl join gl_account g on g.id = jl.gl_account_id
             where jl.journal_entry_id = sc.journal_entry_id and jl.credit_minor > 0 order by jl.seq limit 1) offset_code
      from service_cost sc join service_ticket st on st.id = sc.ticket_id join entity e on e.id = sc.entity_id
     where sc.charge_to = 'vendor' and sc.journal_entry_id is not null and st.vendor_id is not null
       and not exists (select 1 from vendor_debit_memo m where m.service_cost_id = sc.id)
     order by sc.created_at
  loop
    insert into vendor_debit_memo (tenant_id, entity_id, vendor_id, number, source, reason, amount_minor, offset_code, memo_date, status,
                                   service_cost_id, service_ticket_id, journal_entry_id, created_by, auto_approved)
    values (r.tenant_id, r.entity_id, r.vendor_id, next_doc_no(r.entity_id, 'debit_memo', 'DM-'), 'service_chargeback',
            left('Service ' || r.number || ': ' || replace(r.kind, '_', ' ') || coalesce(' — ' || r.note, '') || ' (from before debit memos)', 300),
            r.amount_minor, coalesce(r.offset_code, '6150'), r.on_day, 'open', r.id, r.ticket_id, r.journal_entry_id, r.created_by, true);
    made := made + 1;
  end loop;
  return made;
end $$;
select ops_backfill_chargeback_memos();

-- ------------------------------------------------------------ trade-ins --
do $$
declare t record; cur text;
begin
  for t in select id, name from tenant where exists (select 1 from gl_account g where g.tenant_id = tenant.id and g.code = '4000') loop
    select account_type into cur from gl_account where tenant_id = t.id and code = '4095';
    if cur is null then
      insert into gl_account (tenant_id, code, name, account_type, normal_balance) values (t.id, '4095', 'Trade-in allowances', 'revenue', 'D');
    elsif cur <> 'revenue' then
      raise notice 'client % (%): account 4095 is a % account, not the trade-in contra-revenue account; trade-ins will refuse to post until it is renumbered', t.name, t.id, cur;
      continue;
    end if;
    insert into entity_gl_account (entity_id, gl_account_id)
    select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id and g.code = '4095' where e.tenant_id = t.id
    on conflict do nothing;
  end loop;
end $$;

-- A line may say which revenue account it credits (a trade-in: 4095).
alter table sales_order_line add column revenue_code text check (revenue_code is null or revenue_code ~ '^[0-9]{3,6}$');
-- A trade-in that reduces taxable sales carries negative tax; nothing else does.
alter table sales_order_line drop constraint sales_order_line_tax_minor_check;
alter table sales_order_line add constraint sales_order_line_tax_minor_check check (tax_minor >= 0 or revenue_code = '4095');

alter table tax_jurisdiction add column trade_in_reduces_taxable boolean not null default false;

-- ------------------------------------------------- haul-away on its stop --
alter table stop_haul_away add column invoiced_at timestamptz;

-- --------------------------------------------------------------- holidays --
alter table delivery_blackout add column released_at timestamptz;
alter table delivery_blackout add column release_reason text;
alter table delivery_blackout add constraint delivery_blackout_release_reason check (released_at is null or coalesce(trim(release_reason),'') <> '');

alter table company_holiday drop constraint company_holiday_entity_id_day_key;
alter table company_holiday add column cancelled_at timestamptz;
alter table company_holiday add column cancelled_by uuid references app_user(id);
alter table company_holiday add column cancel_reason text;
create unique index company_holiday_live_day on company_holiday (entity_id, day) where cancelled_at is null;
alter table company_holiday add constraint company_holiday_cancel_reason check (cancelled_at is null or coalesce(trim(cancel_reason),'') <> '');

-- A leave day given back (a holiday landed on it, or the day was taken back): not paid, not counted.
alter table leave_request_day add column returned_at timestamptz;
alter table leave_request_day add column returned_reason text;
alter table leave_request_day add column holiday_id uuid references company_holiday(id);

-- ----------------------------------------------------- leave maker-checker --
create or replace function leave_request_rules() returns trigger
language plpgsql as $$
declare who uuid;
begin
  if new.status in ('approved','declined') and new.status is distinct from old.status then
    select app_user_id into who from employee where id = new.employee_id and entity_id = new.entity_id;
    if who is not null and new.decided_by = who then
      raise exception 'nobody approves or declines their own time off; another manager does';
    end if;
    if new.decided_by is not null and new.decided_by = new.requested_by then
      raise exception 'whoever entered a time-off request does not decide it; another manager does';
    end if;
  end if;
  return new;
end $$;

-- a chargeback memo turned down or voided moves its cost back to service expense (6150); that entry is kept here
alter table vendor_debit_memo add column reversal_entry_id uuid references journal_entry(id);
