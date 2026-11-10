-- 0036_edi.sql
-- Vendor EDI and API ordering, as an extension of purchasing.
--
-- A vendor that trades by EDI is a trading partner: its and our ISA and GS
-- identifiers, the X12 version, test or production, which documents go each
-- way and by which channel (EDI, the vendor's API, email or a file), how
-- files travel (manual upload/download, a drop folder, a VAN or service such
-- as SPS Commerce over HTTPS, SFTP or AS2), and how its item numbers map to
-- ours. A partner may ALSO have API ordering at once (Ashley: the 850 by EDI,
-- status by API); the per-document channel says which one each document uses.
--
-- Every document in or out is one row in edi_document, with its raw text, a
-- parsed summary, its status and links to the PO and the bill. A bad one is
-- quarantined with a reason and nothing from it is applied. A transaction set
-- whose control numbers were seen before is logged as ignored and not applied
-- again.
--
-- Store orders mirror the catalog app's flow: a store builds a cart per
-- vendor against the vendor's freight minimums, submits it, a district
-- manager or the purchasing director approves it, and approving places the
-- PO, which goes to the vendor by the partner's channel.
--
-- Rules set here:
--   1. no secret is stored in settings (a trigger refuses secret-looking keys);
--      passwords and keys are AES-256-GCM sealed in edi_partner_secret
--   2. a quarantined document always carries its reason
--   3. one inbound transaction set per sender and control numbers is applied
--   4. whoever submits a store order cannot approve it
--   5. nothing is deleted: documents, shipments and store orders change status

-- ------------------------------------------------------------ the module --
-- Re-created with every module id there is, including 'group' (0035).
alter table entity_module drop constraint if exists entity_module_module_check;
alter table entity_module add constraint entity_module_module_check
  check (module in ('catalog','purchasing','inventory','pos','ar','workforce','fleet','shop','service','reports','crm','group','edi'));

-- Companies that buy get EDI and store orders.
insert into entity_module (entity_id, module, enabled, changed_by)
select distinct entity_id, 'edi', true, 'migration 0036' from entity_module
 where module = 'purchasing' and enabled
on conflict do nothing;

-- ------------------------------------------------------ trading partners --

create table edi_partner (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  vendor_id        uuid not null references vendor(id),
  edi_enabled      boolean not null default false,
  our_isa_qual     text not null default 'ZZ' check (our_isa_qual ~ '^[0-9A-Z]{2}$'),
  our_isa_id       text not null default '' check (length(our_isa_id) <= 15),
  their_isa_qual   text not null default 'ZZ' check (their_isa_qual ~ '^[0-9A-Z]{2}$'),
  their_isa_id     text not null default '' check (length(their_isa_id) <= 15),
  our_gs_id        text not null default '' check (length(our_gs_id) <= 15),
  their_gs_id      text not null default '' check (length(their_gs_id) <= 15),
  version          text not null default '004010' check (version in ('004010','005010')),
  usage            text not null default 'T' check (usage in ('T','P')),     -- test or production (ISA15)
  element_sep      text not null default '*' check (length(element_sep) = 1),
  segment_term     text not null default '~' check (length(segment_term) = 1),
  subelement_sep   text not null default '>' check (length(subelement_sep) = 1),
  repetition_sep   text not null default '^' check (length(repetition_sep) = 1),
  -- per document, the channel it travels by: edi, api (the vendor feed for that purpose), email, file or off
  documents        jsonb not null default '{"850":"edi","855":"edi","856":"edi","810":"edi","832":"off","846":"off","freight":"off","997":"edi"}'::jsonb,
  transport        text not null default 'manual' check (transport in ('manual','dropfolder','van','sftp','as2')),
  transport_config jsonb not null default '{}'::jsonb,   -- host, user, folders, URLs, auth mode; never a secret
  send_on_approval boolean not null default true,         -- an approved store order's PO goes out by itself
  next_isa_control bigint not null default 1 check (next_isa_control between 1 and 999999999),
  next_gs_control  bigint not null default 1 check (next_gs_control between 1 and 999999999),
  next_st_control  bigint not null default 1 check (next_st_control between 1 and 999999999),
  last_poll_at     timestamptz,
  last_poll_ok     boolean,
  last_poll_note   text,
  updated_by       uuid references app_user(id),
  updated_at       timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (entity_id, vendor_id),
  check (element_sep <> segment_term and element_sep <> subelement_sep and segment_term <> subelement_sep),
  check (not edi_enabled or (our_isa_id <> '' and their_isa_id <> ''))
);
create unique index edi_partner_their_id on edi_partner (entity_id, their_isa_qual, their_isa_id) where their_isa_id <> '';

create or replace function edi_partner_no_secrets() returns trigger
language plpgsql as $$
declare k text;
begin
  for k in select jsonb_object_keys(new.transport_config) loop
    if lower(k) ~ '(password|passwd|secret|private_?key|api_?key|token|credential|passphrase)' then
      raise exception 'transport settings may not hold %; type it into the secret boxes instead', k;
    end if;
  end loop;
  return new;
end $$;
create trigger edi_partner_no_secrets before insert or update on edi_partner
  for each row execute function edi_partner_no_secrets();

-- Write-only secrets, bound to their partner and name.
create table edi_partner_secret (
  entity_id  uuid not null references entity(id),
  partner_id uuid not null references edi_partner(id),
  name       text not null check (name in ('sftpPassword','sftpKey','vanApiKey','vanToken','vanPassword','as2Password')),
  iv         bytea not null check (octet_length(iv) = 12),
  ciphertext bytea not null,
  tag        bytea not null check (octet_length(tag) = 16),
  last2      text not null,
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (partner_id, name)
);

-- The vendor's item number to ours. Products already carry vendor_sku; a
-- mapping row covers the vendor numbers that differ (EDI-only item ids, UPCs).
create table edi_item_map (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  partner_id  uuid not null references edi_partner(id),
  vendor_item text not null check (vendor_item = upper(vendor_item) and vendor_item <> ''),
  product_id  uuid not null references product(id),
  upc         text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (partner_id, vendor_item)
);

-- ---------------------------------------------------------- the documents --

create table edi_document (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  partner_id        uuid references edi_partner(id),
  vendor_id         uuid references vendor(id),
  direction         text not null check (direction in ('in','out')),
  doc_type          text not null check (doc_type in ('850','855','856','810','832','846','997','unknown')),   -- unknown: a file too broken to say
  channel           text not null default 'edi' check (channel in ('edi','api')),
  isa_control       text,
  gs_control        text,
  st_control        text,
  usage             text check (usage in ('T','P')),
  status            text not null check (status in ('queued','sent','received','applied','quarantined','acknowledged','rejected','ignored','failed')),
  reason            text,                       -- why quarantined, failed, rejected or ignored, in plain words
  raw               text not null,              -- the whole interchange (or API body) as it was
  summary           jsonb not null default '{}'::jsonb,
  filename          text,
  purchase_order_id uuid references purchase_order(id),
  invoice_id        uuid references invoice(id),
  related_id        uuid references edi_document(id),   -- a 997 and the document it answers
  attempts          integer not null default 0,
  last_attempt_at   timestamptz,
  applied_at        timestamptz,
  acknowledged_at   timestamptz,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  check (status not in ('quarantined','failed','rejected','ignored') or coalesce(btrim(reason), '') <> '')
);
create index edi_document_list on edi_document (entity_id, direction, created_at desc);
create index edi_document_po on edi_document (purchase_order_id);
create index edi_document_due on edi_document (status) where status = 'queued';
-- One live inbound transaction set per sender and control numbers.
create unique index edi_document_once on edi_document (entity_id, partner_id, doc_type, isa_control, gs_control, st_control)
  where direction = 'in' and status not in ('quarantined','ignored') and isa_control is not null;

-- ------------------------------------------------------ ship notices (856) --

create table po_shipment (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  purchase_order_id uuid not null references purchase_order(id),
  asn_number        text not null,
  shipped_on        date,
  expected_on       date,                       -- when it should arrive
  carrier           text,
  tracking          text,
  status            text not null default 'in_transit' check (status in ('in_transit','received','cancelled')),
  source            text not null default 'edi' check (source in ('edi','api','manual')),
  document_id       uuid references edi_document(id),
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  unique (entity_id, purchase_order_id, asn_number)
);
create table po_shipment_line (
  id                     uuid primary key default gen_random_uuid(),
  entity_id              uuid not null references entity(id),
  shipment_id            uuid not null references po_shipment(id),
  purchase_order_line_id uuid not null references purchase_order_line(id),
  quantity               numeric(12,3) not null check (quantity > 0)
);
create index po_shipment_line_pol on po_shipment_line (purchase_order_line_id);

-- Shipped and still on the road, per PO line.
create view po_line_shipping as
  select pol.entity_id, pol.purchase_order_id, pol.id purchase_order_line_id,
         coalesce(s.shipped, 0) shipped_qty,
         greatest(coalesce(s.shipped, 0) - coalesce(r.received, 0), 0) in_transit_qty,
         s.last_shipped_on, s.carrier, s.tracking
    from purchase_order_line pol
    left join lateral (select sum(sl.quantity) shipped, max(sh.shipped_on) last_shipped_on,
                              (array_agg(sh.carrier order by sh.created_at desc))[1] carrier,
                              (array_agg(sh.tracking order by sh.created_at desc))[1] tracking
                         from po_shipment_line sl join po_shipment sh on sh.id = sl.shipment_id
                        where sl.purchase_order_line_id = pol.id and sh.status <> 'cancelled') s on true
    left join lateral (select sum(g.quantity) received from goods_receipt_line g where g.purchase_order_line_id = pol.id) r on true
   where pol.entity_id is not null;

-- --------------------------------------------- store orders (catalog app) --

-- Freight minimums by vendor, category or brand, by pieces or by cost.
create table vendor_freight_min (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  vendor_id   uuid not null references vendor(id),
  scope       text not null default 'all' check (scope in ('all','category','brand')),
  scope_value text,
  measure     text not null check (measure in ('qty','cost')),
  minimum     bigint not null check (minimum > 0),       -- pieces, or cost in minor units
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  check ((scope = 'all') = (scope_value is null))
);
create index vendor_freight_min_vendor on vendor_freight_min (entity_id, vendor_id) where active;

create table store_order (
  id                uuid primary key default gen_random_uuid(),
  entity_id         uuid not null references entity(id),
  number            text not null,
  location_id       uuid not null references location(id),
  vendor_id         uuid not null references vendor(id),
  status            text not null default 'draft' check (status in ('draft','submitted','approved','rejected','cancelled')),
  note              text,
  created_by        uuid references app_user(id),
  created_at        timestamptz not null default now(),
  submitted_by      uuid references app_user(id),
  submitted_at      timestamptz,
  decided_by        uuid references app_user(id),
  decided_at        timestamptz,
  decision_note     text,
  purchase_order_id uuid references purchase_order(id),
  unique (entity_id, number),
  check (status <> 'rejected' or coalesce(btrim(decision_note), '') <> ''),
  check (status <> 'approved' or purchase_order_id is not null),
  check (decided_by is null or submitted_by is null or decided_by <> submitted_by)
);
create index store_order_queue on store_order (entity_id, status, created_at desc);

create table store_order_line (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  store_order_id uuid not null references store_order(id),
  product_id     uuid not null references product(id),
  qty            numeric(10,2) not null check (qty > 0),
  note           text,
  active         boolean not null default true,     -- a line taken off the cart is switched off, not deleted
  created_at     timestamptz not null default now()
);
create index store_order_line_order on store_order_line (store_order_id) where active;

-- An order sent by EDI is logged with the other sends.
alter table po_transmission drop constraint if exists po_transmission_method_check;
alter table po_transmission add constraint po_transmission_method_check check (method in ('email','file','api','edi'));
