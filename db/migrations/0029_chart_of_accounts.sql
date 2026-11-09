-- 0029_chart_of_accounts.sql
-- The chart of accounts becomes something a person keeps: rollup parents
-- for reports, header (non-postable) accounts, descriptions, active or not,
-- and a CSV import that previews before it changes anything.
--
-- Rules set here, by the database as well as the code:
--   1. an account that has postings keeps its code and its type; a new
--      account takes future postings instead
--   2. nothing is deleted; an account is deactivated, and an inactive or
--      header account takes no new postings
--   3. a parent is a header account of the same type, in the same chart,
--      and no account is its own ancestor

alter table gl_account add column parent_id   uuid references gl_account(id);
alter table gl_account add column description text;
alter table gl_account add column active      boolean not null default true;
alter table gl_account add column created_at  timestamptz not null default now();
alter table gl_account add column updated_at  timestamptz not null default now();
alter table gl_account add constraint gl_account_code_shape check (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$');
alter table gl_account add constraint gl_account_not_own_parent check (parent_id is null or parent_id <> id);
create index gl_account_parent on gl_account (tenant_id, parent_id);

create or replace function gl_account_rules() returns trigger
language plpgsql as $$
declare
  p record;
  hops int := 0;
  cur uuid;
begin
  if tg_op = 'DELETE' then
    raise exception 'accounts are never deleted; deactivate it instead';
  end if;
  if tg_op = 'UPDATE' and (new.code <> old.code or new.account_type <> old.account_type)
     and exists (select 1 from journal_line where gl_account_id = old.id) then
    raise exception 'account % has postings, so its code and type stay as they are; make a new account and move future postings to it', old.code;
  end if;
  if new.parent_id is not null then
    select tenant_id, account_type, is_postable into p from gl_account where id = new.parent_id;
    if p.tenant_id is distinct from new.tenant_id then
      raise exception 'the parent account is in another chart';
    end if;
    if p.is_postable then
      raise exception 'a parent account is a header (it takes no postings of its own)';
    end if;
    if p.account_type <> new.account_type then
      raise exception 'a parent account has the same type as the accounts under it';
    end if;
    cur := new.parent_id;
    while cur is not null loop
      if cur = new.id then
        raise exception 'an account cannot sit under itself';
      end if;
      hops := hops + 1;
      if hops > 20 then raise exception 'the parent chain is more than 20 levels deep'; end if;
      select parent_id into cur from gl_account where id = cur;
    end loop;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger gl_account_rules before insert or update or delete on gl_account
  for each row execute function gl_account_rules();

-- Inactive and header accounts take no new postings.
create or replace function journal_line_account_open() returns trigger
language plpgsql as $$
declare a record;
begin
  select code, active, is_postable into a from gl_account where id = new.gl_account_id;
  if not a.active then
    raise exception 'account % is inactive; post to the account that replaced it', a.code;
  end if;
  if not a.is_postable then
    raise exception 'account % is a header for reports; post to one of the accounts under it', a.code;
  end if;
  return new;
end $$;
create trigger journal_line_account_open before insert on journal_line
  for each row execute function journal_line_account_open();

-- CSV imports of the chart: previewed row by row, applied once.
create table chart_import_run (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenant(id),
  entity_id   uuid not null references entity(id),     -- the company it was run from
  filename    text,
  status      text not null default 'previewed' check (status in ('previewed','applied','abandoned')),
  rows        integer not null default 0,
  added       integer not null default 0,
  updated     integer not null default 0,
  unchanged   integer not null default 0,
  refused     integer not null default 0,
  created_by  uuid references app_user(id),
  created_at  timestamptz not null default now(),
  applied_by  uuid references app_user(id),
  applied_at  timestamptz,
  check ((status = 'applied') = (applied_at is not null))
);

create table chart_import_row (
  run_id   uuid not null references chart_import_run(id),
  entity_id uuid not null references entity(id),
  row_no   integer not null,
  code     text,
  action   text not null check (action in ('add','update','same','refuse')),
  fields   jsonb not null default '{}'::jsonb,
  changes  jsonb not null default '{}'::jsonb,
  message  text,
  primary key (run_id, row_no)
);
