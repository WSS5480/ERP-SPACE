-- 0040_edi_review.sql
-- Fixes to the EDI module (0036) after review. 0036 has been merged and may
-- be applied somewhere, so it is not edited; this carries the changes.
--
--   1. a bill line says how many it bills and at what price, so the match can
--      compare billed price to the PO price and cap billed quantity at what
--      was received less what was billed before
--   2. a vendor's price change (855 IP) changes the PO line and flags it for
--      the buyer to review
--   3. an inbound interchange's raw text is stored once, and each transaction
--      set's row points at it
--   4. what a transport handed us is remembered by its checksum, so a VAN
--      without an acknowledge address, or a file a move failed on, is not
--      taken in again every run
--   5. an ISA id pair is unique across the client's companies, so sibling
--      companies sharing a mailbox never take each other's files
--   6. 850 layout options per partner
--   7. EDI is off for companies with no trading partner

-- ------------------------------------------------------------- 1. the match
alter table invoice_line add column quantity numeric(12,3) check (quantity is null or quantity > 0);
alter table invoice_line add column unit_price_minor bigint;

-- --------------------------------------------------------- 2. price changes
alter table purchase_order_line add column price_changed_from bigint;
alter table purchase_order_line add column price_review_note text;

-- ------------------------------------------------------ 3. raw text, once
create table edi_interchange (
  id          uuid primary key default gen_random_uuid(),
  entity_id   uuid not null references entity(id),
  partner_id  uuid references edi_partner(id),
  direction   text not null check (direction in ('in','out')),
  isa_control text,
  sha256      text not null check (length(sha256) = 64),
  bytes       integer not null,
  filename    text,
  raw         text not null,
  created_at  timestamptz not null default now()
);
create index edi_interchange_entity on edi_interchange (entity_id, created_at desc);
alter table edi_document add column interchange_id uuid references edi_interchange(id);
alter table edi_document alter column raw drop not null;
alter table edi_document add constraint edi_document_raw_somewhere check (raw is not null or interchange_id is not null);

-- ------------------------------------------------- 4. what was pulled before
create table edi_pulled (
  entity_id  uuid not null references entity(id),
  partner_id uuid not null references edi_partner(id),
  sha256     text not null check (length(sha256) = 64),
  ref        text,                 -- the VAN's document id or the file name
  pulled_at  timestamptz not null default now(),
  primary key (partner_id, sha256)
);

-- ------------------------------------------- 5. ISA pairs across companies
create or replace function edi_partner_pair_unique() returns trigger
language plpgsql as $$
declare
  t uuid;
  other text;
begin
  if new.their_isa_id = '' or new.our_isa_id = '' then return new; end if;
  select tenant_id into t from entity where id = new.entity_id;
  select e.name into other
    from edi_partner p join entity e on e.id = p.entity_id
   where e.tenant_id = t and p.id <> new.id
     and p.our_isa_qual = new.our_isa_qual and upper(p.our_isa_id) = upper(new.our_isa_id)
     and p.their_isa_qual = new.their_isa_qual and upper(p.their_isa_id) = upper(new.their_isa_id)
   limit 1;
  if other is not null then
    raise exception 'another trading partner (in %) already pairs our ISA id %/% with %/%; each company needs its own ISA id with a vendor',
      other, new.our_isa_qual, new.our_isa_id, new.their_isa_qual, new.their_isa_id;
  end if;
  return new;
end $$;
create trigger edi_partner_pair_unique before insert or update on edi_partner
  for each row execute function edi_partner_pair_unique();

-- ----------------------------------------------------------- 6. 850 layout
-- {billTo:{name,code,address1,city,state,postal}, vendorN1:true, td5:{scac,routing,method}, fob:'PP',
--  shipByDays:n, cancelAfterDays:n, itemIds:['VN','BP','UP'], refs:['IA','CO'], contact:{name,phone,email}}
alter table edi_partner add column options jsonb not null default '{}'::jsonb;

-- ------------------------------------------------------- 7. off by default
update entity_module m set enabled = false, changed_at = now(), changed_by = 'migration 0040'
 where m.module = 'edi' and m.changed_by = 'migration 0036'
   and not exists (select 1 from edi_partner p where p.entity_id = m.entity_id);
