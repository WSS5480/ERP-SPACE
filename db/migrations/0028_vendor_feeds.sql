-- 0028_vendor_feeds.sql
-- Vendor API setup: a vendor has any number of separate API endpoints, each
-- a "feed" with one purpose -- products, pricing, quantities, freight,
-- images, order submission, acknowledgments -- and its own address, method,
-- request and response shape, paging, SKU batching, authentication, field
-- mapping and schedule. Ashley issues separate keys per API, so each feed
-- carries its OWN credential_ref; the secret itself lives only in the
-- environment as ERP_SECRET_<REF>.
--
-- Replaces the single vendor_connection row per vendor (0017), whose rows are
-- migrated into feeds here and then switched off. vendor_connection stays as
-- history; nothing reads it after this.
--
-- Precedence when two feeds touch the same field: a vendor's active PRICING
-- feed owns cost, MAP and MSRP. While one exists, a products feed sets them
-- only on products it creates, never on products already on file.

create table vendor_feed (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  vendor_id       uuid not null references vendor(id),
  purpose         text not null check (purpose in ('products','pricing','quantities','freight','images','orders','acknowledgments')),
  name            text not null,
  template        text not null default 'blank',      -- where it started: ashley, generic_json, csv_https, blank
  kind            text not null default 'api' check (kind in ('api','sftp','email','manual')),
  method          text not null default 'GET' check (method in ('GET','POST')),
  url             text not null default '',
  request_format  text not null default 'query' check (request_format in ('query','json','xml')),
  query_params    jsonb not null default '{}'::jsonb,  -- name -> value template, e.g. {"ShipTo":"{{shipTo}}"}
  headers         jsonb not null default '{}'::jsonb,  -- non-secret headers only (SOAPAction, Accept)
  body_template   text,                                -- JSON or XML/SOAP with {{placeholders}}
  response_format text not null default 'json' check (response_format in ('json','xml','csv')),
  records_path    text,                                -- JSON path (data.items) or XML element name (itemAdvice)
  paging          jsonb not null default '{"mode":"none"}'::jsonb,
  batching        jsonb not null default '{}'::jsonb,  -- {"size":40,"delayMs":1000}: models per call
  auth            jsonb not null default '{"mode":"none"}'::jsonb,
  credential_ref  text check (credential_ref is null or credential_ref ~ '^secret://[a-z0-9/_-]+$'),   -- environment secret, optional
  secrets_from_feed_id uuid references vendor_feed(id),                 -- use another feed's typed keys (same key, several APIs)
  mapping         jsonb not null default '{}'::jsonb,  -- our field -> vendor field
  options         jsonb not null default '{}'::jsonb,  -- customer, shipTo, shipTos, priceRule, xml unwrap/pick/pairs, sftp/email settings
  etl             jsonb not null default '[]'::jsonb,  -- computed columns before mapping: [{out, a, op, b}]
  schedule_cron   text check (schedule_cron is null or schedule_cron ~ '^\S+(\s+\S+){4}$'),
  every_hours     integer check (every_hours between 1 and 720),
  active          boolean not null default true,
  rate_limit_ms   integer not null default 0 check (rate_limit_ms between 0 and 60000),
  timeout_ms      integer not null default 30000 check (timeout_ms between 100 and 120000),
  last_run_at     timestamptz,
  last_ok         boolean,
  last_note       text,
  consecutive_failures integer not null default 0,
  created_at      timestamptz not null default now(),
  unique (entity_id, vendor_id, name),
  check (purpose <> 'orders' or (schedule_cron is null and every_hours is null))
);
create index vendor_feed_vendor on vendor_feed (entity_id, vendor_id, purpose);

-- Settings are not secrets. A key that looks like one, or a header that
-- would carry one, is refused here as well as in code.
create or replace function vendor_feed_no_secrets() returns trigger
language plpgsql as $$
declare
  part text;
  k text;
  v jsonb;
begin
  foreach part in array array['query_params','headers','options','paging','batching','auth'] loop
    v := case part when 'query_params' then new.query_params when 'headers' then new.headers when 'options' then new.options
                   when 'paging' then new.paging when 'batching' then new.batching else new.auth end;
    for k in select jsonb_object_keys(v) loop
      if lower(k) ~ '(password|passwd|secret|private_key|privatekey|api_key|apikey|token|credential|signature)' then
        raise exception '% may not hold %; store it in the secret and reference it', replace(part, '_', ' '), k;
      end if;
      if part = 'headers' and lower(k) ~ '(authorization|cookie|key|token|secret|password)' then
        raise exception 'the % header carries a secret; choose it under Authentication instead', k;
      end if;
    end loop;
  end loop;
  if coalesce(new.body_template, '') ~* '(<(s?password|keycode)>[^<{]+<)' then
    raise exception 'the request template holds a literal secret; use {{cred.<name>}} placeholders instead';
  end if;
  return new;
end $$;
create trigger vendor_feed_no_secrets before insert or update on vendor_feed
  for each row execute function vendor_feed_no_secrets();

-- Keys and passwords typed into the screen: AES-256-GCM under ERP_SECRET_KEY,
-- bound to their feed and name. Write-only: the screen gets the last two
-- characters back, never the value.
create table vendor_feed_secret (
  entity_id  uuid not null references entity(id),
  feed_id    uuid not null references vendor_feed(id),
  name       text not null check (name in ('apiKey','token','password','clientSecret','atpKeyCode','atpPassword','sftpPassword')),
  iv         bytea not null check (octet_length(iv) = 12),
  ciphertext bytea not null,
  tag        bytea not null check (octet_length(tag) = 16),
  last2      text not null,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (feed_id, name)
);

-- "Stop runs": a request a running pull checks between calls.
create table vendor_feed_stop (
  entity_id    uuid not null references entity(id),
  feed_id      uuid primary key references vendor_feed(id),
  requested_at timestamptz not null default now(),
  requested_by uuid references app_user(id)
);

-- Runs: one per feed per run now; the old connection column stays for history.
alter table vendor_feed_run alter column connection_id drop not null;
alter table vendor_feed_run add column feed_id uuid references vendor_feed(id);
alter table vendor_feed_run add column purpose text;
alter table vendor_feed_run add column added integer not null default 0;
alter table vendor_feed_run add column changed integer not null default 0;
alter table vendor_feed_run add constraint vendor_feed_run_owner check (connection_id is not null or feed_id is not null);
create index vendor_feed_run_feed on vendor_feed_run (feed_id, started_at desc);

-- What a vendor said its prices were, and from when. The pricing feed adds
-- rows; the row in effect today sets the product's cost, MAP and MSRP.
create table vendor_price_history (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  vendor_id        uuid not null references vendor(id),
  vendor_sku       text not null,
  product_id       uuid references product(id),
  cost_minor       bigint not null check (cost_minor >= 0),
  map_minor        bigint check (map_minor >= 0),
  msrp_minor       bigint check (msrp_minor >= 0),
  promo_cost_minor bigint check (promo_cost_minor >= 0),
  effective_from   date,
  effective_to     date,
  feed_id          uuid references vendor_feed(id),
  recorded_at      timestamptz not null default now(),
  check (effective_to is null or effective_from is null or effective_to >= effective_from)
);
create index vendor_price_history_sku on vendor_price_history (entity_id, vendor_id, vendor_sku, recorded_at desc);

-- Ship notices (856) come back through the acknowledgment import as well.
-- (purchase_order_line.ack_status already covers what a notice can say.)

-- ------------------------------------------------ migrate old connections --
-- Each old API connection becomes one feed per thing it did. Old secrets
-- (one JSON object holding every key) keep working: the migrated feeds point
-- at the same reference and authenticate the way the connection did ('auto').

insert into vendor_feed (entity_id, vendor_id, purpose, name, template, method, url, request_format, query_params, response_format,
                         paging, auth, credential_ref, mapping, options, schedule_cron, active, last_run_at, last_ok, last_note)
select k.entity_id, k.vendor_id, 'products', k.name || ' · products', 'migrated', 'GET', k.config->>'url', 'query',
       coalesce(k.config->'params', '{}'::jsonb), 'json',
       case when coalesce((k.config->>'pageSize')::int, 0) > 0
            then jsonb_build_object('mode','page','size',(k.config->>'pageSize')::int,
                                    'pageParam',coalesce(k.config->>'pageParam','page'),'sizeParam',coalesce(k.config->>'limitParam','limit'))
            else '{"mode":"none"}'::jsonb end,
       case when coalesce(k.config->>'authUrl','') <> '' then jsonb_build_object('mode','oauth2','authUrl',k.config->>'authUrl')
            else '{"mode":"auto"}'::jsonb end,
       k.credential_ref, k.mapping, '{}'::jsonb, k.schedule_cron, k.active, k.last_run_at, k.last_ok, k.last_note
  from vendor_connection k
 where k.kind = 'api' and coalesce(k.config->>'url','') <> '';

insert into vendor_feed (entity_id, vendor_id, purpose, name, template, method, url, request_format, headers, response_format, records_path,
                         batching, auth, credential_ref, options, schedule_cron, active, timeout_ms)
select k.entity_id, k.vendor_id, 'quantities', k.name || ' · quantities (ATP)', 'ashley_atp', 'POST',
       coalesce(nullif(k.config->>'atpUrl',''), 'https://aws.ashleyfurniture.com/atpinquiryservice_aws/atpinquiry.asmx'), 'xml',
       '{"SOAPAction":"\"http://api.AshleyFurniture.com/AtpInquiryService_AWS/AtpInquiry/ATPRequest\""}'::jsonb, 'xml', 'itemAdvice',
       jsonb_build_object('size', coalesce((k.config->>'atpBatch')::int, 40), 'delayMs', coalesce((k.config->>'atpSleepMs')::int, 1000)),
       '{"mode":"none"}'::jsonb, k.credential_ref,
       jsonb_build_object('customer', coalesce(nullif(k.config->>'atpCustomer',''), k.config->>'customer'), 'shipTo', k.config->>'atpShipTo',
                          'duns', coalesce(nullif(k.config->>'atpDuns',''), '052738531'), 'unwrap', 'ATPRequestResult',
                          'pick', '{"element":"itemAvailability","attr":"availability","equals":"current"}'::jsonb,
                          'pairs', '[{"name":"systemReferenceDescription","value":"systemReferenceValue"}]'::jsonb),
       k.schedule_cron, k.active, 90000
  from vendor_connection k
 where k.kind = 'api' and coalesce((k.config->>'atpOn')::boolean, false);

insert into vendor_feed (entity_id, vendor_id, purpose, name, template, method, url, request_format, query_params, response_format, records_path,
                         paging, auth, credential_ref, options, schedule_cron, active)
select k.entity_id, k.vendor_id, 'freight', k.name || ' · freight', 'migrated', 'GET', k.config->>'freightUrl', 'query',
       '{"Customer":"{{customer}}","ShipTo":"{{shipTo}}","IncludeTentative":"False"}'::jsonb, 'json', 'entities',
       jsonb_build_object('mode','page','size',coalesce((k.config->>'freightPageSize')::int, 250),'pageParam','Page','sizeParam','Limit'),
       case when coalesce(k.config->>'authUrl','') <> '' then jsonb_build_object('mode','oauth2','authUrl',k.config->>'authUrl')
            else '{"mode":"auto"}'::jsonb end,
       k.credential_ref, jsonb_build_object('customer', k.config->>'customer', 'shipTos', coalesce(k.config->'shipTos','{}'::jsonb)),
       k.schedule_cron, k.active
  from vendor_connection k
 where k.kind = 'api' and coalesce((k.config->>'freightOn')::boolean, false) and coalesce(k.config->>'freightUrl','') <> '';

insert into vendor_feed (entity_id, vendor_id, purpose, name, template, method, url, request_format, response_format, auth, credential_ref, options, active)
select k.entity_id, k.vendor_id, 'orders', k.name || ' · orders', 'migrated', 'POST', k.config->>'poUrl', 'json', 'json',
       case when coalesce(k.config->>'authUrl','') <> '' then jsonb_build_object('mode','oauth2','authUrl',k.config->>'authUrl')
            else '{"mode":"auto"}'::jsonb end,
       k.credential_ref, jsonb_build_object('customer', k.config->>'customer', 'shipTos', coalesce(k.config->'shipTos','{}'::jsonb)), k.active
  from vendor_connection k
 where k.kind = 'api' and coalesce(k.config->>'poUrl','') <> '';

-- The feeds run from here on; the old rows stop being scheduled.
update vendor_connection set active = false, schedule_cron = null where kind = 'api' /* unscoped: a migration over every company */;
