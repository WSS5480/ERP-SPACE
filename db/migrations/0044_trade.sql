-- 0044_trade.sql
-- Trade and designer accounts, the trade portal, room projects (clienteling)
-- and the designer as a commission role. Extends crm (customers, tasks),
-- catalog (price lists), tax (exemption certificates), ar (terms and credit
-- limits), shop (the web payment path) and workforce (commissions).
--
-- Rules this file sets:
--   1. a trade account is one business customer; its terms and credit limit
--      are the customer's own (A/R), its resale certificate is a tax
--      exemption certificate on that customer, and its prices are a price list
--   2. a price list may price whole categories by rule: cost plus X% or
--      retail less Y%; a product's own price on the list still wins
--   3. portal sign-in codes and sessions are kept only as hashes, expire, and
--      a code dies after five wrong tries
--   4. a sale line's commission can be split between its primary rep and an
--      internal designer; an outside referral earns the trade account a
--      payable, given back when the line is returned
--   5. nothing is deleted: applications are decided, accounts are suspended,
--      project items and photos are marked removed

-- ------------------------------------------------------------------ role --
do $$
declare d text;
begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'role_grant_role_check';
  if d is not null and d not like '%''designer''%' then
    execute 'alter table role_grant drop constraint role_grant_role_check';
    execute 'alter table role_grant add constraint role_grant_role_check '
      || replace(d, 'ARRAY[', 'ARRAY[''designer''::text, ');
  end if;
end $$;

-- ------------------------------------------------- price lists by rule --
create table price_list_rule (
  id            uuid primary key default gen_random_uuid(),
  entity_id     uuid not null references entity(id),
  price_list_id uuid not null references price_list(id),
  category      text,                                   -- null: every category the list has no rule for
  basis         text not null check (basis in ('cost_plus','retail_less')),
  bps           integer not null check (bps between 0 and 100000),   -- 3500 = cost + 35%, or retail - 35%
  active        boolean not null default true,
  updated_by    text,
  updated_at    timestamptz not null default now(),
  check (basis <> 'retail_less' or bps <= 9000)
);
create unique index price_list_rule_one on price_list_rule (price_list_id, coalesce(category, '')) where active;

-- ------------------------------------------------------ applications --
create table trade_application (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  number         text not null,
  company_name   text not null check (length(trim(company_name)) between 2 and 120),
  kind           text not null check (kind in ('designer','contractor','stager','hospitality','other')),
  contact_name   text not null check (length(trim(contact_name)) between 2 and 80),
  email          text not null,
  phone          text,
  website        text,
  resale_number  text,
  resale_state   char(2) check (resale_state is null or resale_state ~ '^[A-Z]{2}$'),
  resale_expires date,
  address        jsonb not null default '{}',
  notes          text,
  status         text not null default 'pending' check (status in ('pending','approved','declined')),
  decided_by     uuid references app_user(id),
  decided_at     timestamptz,
  decision_note  text,
  trade_account_id uuid,
  ip_hash        text,
  created_at     timestamptz not null default now(),
  unique (entity_id, number),
  check (status = 'pending' or decided_at is not null),
  check (status <> 'declined' or length(trim(coalesce(decision_note, ''))) >= 3)
);
create index trade_application_status on trade_application (entity_id, status, created_at);

-- ------------------------------------------------------------ accounts --
create table trade_account (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  number         text not null,
  customer_id    uuid not null unique references customer(id),
  company_name   text not null,
  kind           text not null check (kind in ('designer','contractor','stager','hospitality','other')),
  contact_name   text not null,
  email          text not null,
  phone          text,
  status         text not null default 'active' check (status in ('active','suspended','closed')),
  price_list_id  uuid references price_list(id),
  referral_bps   integer not null default 0 check (referral_bps between 0 and 5000),
  referral_basis text not null default 'margin' check (referral_basis in ('sale','margin')),
  vendor_id      uuid references vendor(id),                   -- who referral commission is paid to
  rep_id         uuid references app_user(id),                 -- the house salesperson who looks after the account
  application_id uuid references trade_application(id),
  status_reason  text,
  approved_by    uuid references app_user(id),
  created_at     timestamptz not null default now(),
  unique (entity_id, number)
);
create unique index trade_account_email on trade_account (entity_id, lower(email));
alter table trade_application add constraint trade_application_account_fk foreign key (trade_account_id) references trade_account(id);

-- ------------------------------------------------- portal sign-in --
create table trade_login_code (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  trade_account_id uuid not null references trade_account(id),
  code_sha256      text not null,
  expires_at       timestamptz not null,
  attempts         integer not null default 0 check (attempts >= 0),
  used_at          timestamptz,
  ip_hash          text,
  created_at       timestamptz not null default now()
);
create index trade_login_code_account on trade_login_code (trade_account_id, created_at desc);

create table trade_session (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  trade_account_id uuid not null references trade_account(id),
  token_sha256     text not null unique,
  expires_at       timestamptz not null,
  revoked_at       timestamptz,
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now()
);

-- ------------------------------------------------------ room projects --
create table room_project (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  number           text not null,
  customer_id      uuid not null references customer(id),       -- the customer (or the trade account's customer)
  household_id     uuid references crm_household(id),
  trade_account_id uuid references trade_account(id),
  name             text not null check (length(trim(name)) between 1 and 80),
  client_name      text,                                        -- a designer's end client
  client_address   jsonb not null default '{}',                 -- {line1, line2, city, state, postal}
  ship_address_id  uuid references customer_address(id),
  length_in        numeric(7,1) check (length_in is null or length_in > 0),
  width_in         numeric(7,1) check (width_in is null or width_in > 0),
  height_in        numeric(7,1) check (height_in is null or height_in > 0),
  openings         jsonb not null default '[]',                 -- [{kind:'door'|'window', wall, widthIn, heightIn, note}]
  style_notes      text,
  budget_minor     bigint check (budget_minor is null or budget_minor >= 0),
  status           text not null default 'open' check (status in ('open','won','closed')),
  salesperson_id   uuid references app_user(id),
  quoted_at        timestamptz,                                 -- the portal or staff priced it as a quote
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (entity_id, number)
);
create index room_project_customer on room_project (entity_id, customer_id);
create index room_project_trade on room_project (entity_id, trade_account_id) where trade_account_id is not null;

create table room_project_photo (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  project_id  uuid not null references room_project(id),
  data_url    text not null check (data_url ~ '^data:image/(png|jpeg|webp);base64,' and length(data_url) <= 1500000),
  caption     text,
  removed_at  timestamptz,
  created_at  timestamptz not null default now()
);

create table room_project_item (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  project_id  uuid not null references room_project(id),
  product_id  uuid not null references product(id),
  choices     jsonb not null default '[]',
  qty         integer not null default 1 check (qty between 1 and 50),
  stage       text not null default 'considered' check (stage in ('considered','quoted','bought')),
  sales_order_id uuid references sales_order(id),
  note        text,
  removed_at  timestamptz,
  created_at  timestamptz not null default now()
);
create index room_project_item_project on room_project_item (project_id);

create table room_project_order (
  entity_id      uuid not null references entity(id),
  project_id     uuid not null references room_project(id),
  sales_order_id uuid not null references sales_order(id),
  linked_at      timestamptz not null default now(),
  primary key (project_id, sales_order_id)
);

-- One automatic follow-up per rule per order (or project): running it again never makes a second.
create table clienteling_followup (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  rule           text not null check (rule in ('quote_no_sale','care_checkin','protection_checkin')),
  sales_order_id uuid references sales_order(id),
  project_id     uuid references room_project(id),
  task_id        uuid references crm_task(id),
  created_at     timestamptz not null default now(),
  check (sales_order_id is not null or project_id is not null)
);
create unique index clienteling_followup_order on clienteling_followup (rule, sales_order_id) where sales_order_id is not null;
create unique index clienteling_followup_project on clienteling_followup (rule, project_id) where project_id is not null;

-- --------------------------------------------------- line commissions --
-- A line's own split, which replaces the order's salespeople for that line.
-- A line's split is replaced, never edited: the old rows stay, marked replaced.
create table sales_order_line_split (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  sales_order_line_id uuid not null references sales_order_line(id),
  app_user_id         uuid not null references app_user(id),
  role                text not null check (role in ('primary','designer')),
  split_bps           integer not null check (split_bps between 1 and 10000),
  set_by              uuid references app_user(id),
  set_at              timestamptz not null default now(),
  replaced_at         timestamptz
);
create unique index sales_order_line_split_live on sales_order_line_split (sales_order_line_id, app_user_id) where replaced_at is null;

-- An outside designer who brought the client in.
create table sales_order_line_referral (
  id                  uuid primary key default gen_random_uuid(),
  sales_order_line_id uuid not null references sales_order_line(id),
  entity_id           uuid not null references entity(id),
  trade_account_id    uuid not null references trade_account(id),
  rate_bps            integer not null check (rate_bps between 1 and 5000),
  basis               text not null check (basis in ('sale','margin')),
  set_by              uuid references app_user(id),
  set_at              timestamptz not null default now(),
  replaced_at         timestamptz
);
create unique index sales_order_line_referral_live on sales_order_line_referral (sales_order_line_id) where replaced_at is null;

create table trade_referral_event (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  trade_account_id    uuid not null references trade_account(id),
  vendor_id           uuid references vendor(id),
  sales_order_id      uuid not null references sales_order(id),
  sales_order_line_id uuid not null references sales_order_line(id),
  kind                text not null check (kind in ('earned','clawback')),
  sale_minor          bigint not null,
  cost_minor          bigint not null default 0,
  basis_minor         bigint not null,
  rate_bps            integer not null,
  amount_minor        bigint not null,              -- signed: a clawback is negative
  earned_on           date not null,
  journal_entry_id    uuid references journal_entry(id),
  bill_id             uuid references invoice(id),  -- the vendor bill it was paid through
  created_at          timestamptz not null default now(),
  unique (sales_order_line_id, kind)
);
create index trade_referral_event_account on trade_referral_event (entity_id, trade_account_id, bill_id);
