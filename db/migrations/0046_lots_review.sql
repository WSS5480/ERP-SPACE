-- Review fixes for serials, labels and finance settlements (extends 0045).
--
-- Finance settlements:
--   * a financed sale can be funded in parts (funded_gross_minor: the part of
--     the sale the lender has paid for so far) and refunded to the customer in
--     full or in part (refunded_minor, one financed_sale_refund row per refund
--     receipt), so what the lender owes is amount - refunded - funded gross;
--   * a sale fully refunded and settled with the lender is 'refunded';
--   * a settlement row the lender paid but that matches no sale is set aside
--     into 2195 Unapplied finance deposits ('suspense') until it is applied;
--   * nothing that looks like a card number (13 or more digits in a row) is
--     kept on a settlement row.

alter table financed_sale add column funded_gross_minor bigint not null default 0 check (funded_gross_minor >= 0);
alter table financed_sale add column refunded_minor bigint not null default 0 check (refunded_minor >= 0);
alter table financed_sale add constraint financed_sale_refund_le check (refunded_minor <= amount_minor);
alter table financed_sale add constraint financed_sale_funded_le check (funded_gross_minor <= amount_minor);
update financed_sale set funded_gross_minor = amount_minor where status = 'funded';
alter table financed_sale drop constraint financed_sale_status_check;
alter table financed_sale add constraint financed_sale_status_check check (status in ('awaiting_funding','funded','charged_off','refunded'));

create table financed_sale_refund (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  financed_sale_id uuid not null references financed_sale(id),
  receipt_id       uuid not null unique references customer_receipt(id),
  amount_minor     bigint not null check (amount_minor > 0),
  created_at       timestamptz not null default now()
);
create index financed_sale_refund_sale on financed_sale_refund (financed_sale_id);

alter table finance_remit_line drop constraint finance_remit_line_status_check;
alter table finance_remit_line add constraint finance_remit_line_status_check check (status in ('posted','exception','dismissed','suspense'));
alter table finance_remit_line add column suspense_entry_id uuid references journal_entry(id);
alter table finance_remit_line add constraint finance_remit_line_no_pan check (
  coalesce(auth_code, '') !~ '[0-9]{13,}' and coalesce(reason, '') !~ '[0-9]{13,}' and coalesce(plan_code, '') !~ '[0-9]{13,}' and coalesce(exception, '') !~ '[0-9]{13,}');

do $$
declare t record; cur text;
begin
  for t in select id, name from tenant where exists (select 1 from gl_account g where g.tenant_id = tenant.id and g.code = '1110') loop
    select account_type into cur from gl_account where tenant_id = t.id and code = '2195';
    if cur is null then
      insert into gl_account (tenant_id, code, name, account_type, normal_balance) values (t.id, '2195', 'Unapplied finance deposits', 'liability', 'C');
    elsif cur <> 'liability' then
      raise notice 'client % (%): account 2195 is a % account, not Unapplied finance deposits; setting settlement rows aside will refuse until it is renumbered', t.name, t.id, cur;
      continue;
    end if;
    insert into entity_gl_account (entity_id, gl_account_id)
    select e.id, g.id from entity e join gl_account g on g.tenant_id = e.tenant_id and g.code = '2195' where e.tenant_id = t.id
    on conflict do nothing;
  end loop;
end $$;
