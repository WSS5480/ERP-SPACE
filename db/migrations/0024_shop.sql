-- 0024_shop.sql
-- The web store: one storefront per company, the carts shoppers leave
-- behind, the card payments the store takes, and the messages and review
-- requests it would send. A web order is not a table here -- it is the same
-- sales_order every channel writes (channel 'web'), so the back office,
-- the warehouse and A/R see it without knowing it came from the web.
--
-- Rules this file sets:
--   1. a storefront is public by its slug, so the slug is unique across the install
--   2. pickup stores, the web location and the tax location belong to the site's own company
--   3. the store keeps a card token and last four, never a card number (checked by the database)
--   4. messages and review requests are recorded, not sent, until a provider is plugged in

create table shop_site (
  id                  uuid primary key default gen_random_uuid(),
  entity_id           uuid not null references entity(id),
  slug                text not null unique
                        check (slug ~ '^[a-z0-9][a-z0-9-]{1,39}$' and slug not in ('assets','api','admin')),
  display_name        text not null check (length(trim(display_name)) between 1 and 80),
  tagline             text,
  brand_primary       text not null default '#1f2a44' check (brand_primary ~ '^#[0-9a-fA-F]{6}$'),
  brand_accent        text not null default '#b8964b' check (brand_accent ~ '^#[0-9a-fA-F]{6}$'),
  -- A same-origin path or a data: image. The page's CSP blocks other hosts' images,
  -- and the server will not fetch arbitrary URLs on a shopper's behalf.
  logo_url            text check (logo_url is null or logo_url ~ '^(/[A-Za-z0-9/._-]*|data:image/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+)$'),
  web_location_id     uuid not null references location(id),       -- where delivered/shipped web sales are credited
  tax_location_id     uuid references location(id),                -- whose rate applies when the fulfilling location has none
  pickup_location_ids uuid[] not null default '{}',
  delivery_fee_minor  bigint not null default 0 check (delivery_fee_minor >= 0),
  free_delivery_over_minor bigint check (free_delivery_over_minor is null or free_delivery_over_minor > 0),
  delivery_days       smallint not null default 5 check (delivery_days between 0 and 60),    -- business days, DC to door
  ship_fee_minor      bigint not null default 0 check (ship_fee_minor >= 0),
  ship_days           smallint not null default 4 check (ship_days between 0 and 60),
  mto_base_days       smallint not null default 35 check (mto_base_days between 0 and 365),  -- made to order, before option lead days
  backorder_days      smallint not null default 21 check (backorder_days between 0 and 365),
  fee_product_id      uuid references product(id),                 -- the fee SKU delivery and shipping post as
  financing_url       text check (financing_url is null or financing_url ~ '^https://[^\s<>"]+$'),
  policies            text,
  payment_provider    text not null default 'test' check (payment_provider in ('test')),
  sms_provider        text not null default 'record' check (sms_provider in ('record')),
  review_provider     text not null default 'record' check (review_provider in ('record')),
  status              text not null default 'draft' check (status in ('draft','live')),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index shop_site_entity on shop_site (entity_id);

-- The site's locations must be the site's own company's.
create or replace function shop_site_rules() returns trigger
language plpgsql as $$
begin
  if not exists (select 1 from location where id = new.web_location_id and entity_id = new.entity_id) then
    raise exception 'the web location must belong to the same company as the store';
  end if;
  if new.tax_location_id is not null
     and not exists (select 1 from location where id = new.tax_location_id and entity_id = new.entity_id) then
    raise exception 'the tax location must belong to the same company as the store';
  end if;
  if exists (select 1 from unnest(new.pickup_location_ids) pid
              where not exists (select 1 from location l where l.id = pid and l.entity_id = new.entity_id)) then
    raise exception 'every pickup store must belong to the same company as the store';
  end if;
  if new.fee_product_id is not null
     and not exists (select 1 from product where id = new.fee_product_id and entity_id = new.entity_id) then
    raise exception 'the fee product must belong to the same company as the store';
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger shop_site_rules before insert or update on shop_site
  for each row execute function shop_site_rules();

-- A shopper's cart, saved as they shop so the back office can see carts left
-- behind. The id is the client's own cart id; the same id becomes the order's
-- external_ref, which is what makes a double submit one order.
create table shop_cart (
  site_id       uuid not null references shop_site(id),
  id            text not null check (id ~ '^[A-Za-z0-9_-]{8,64}$'),
  entity_id     uuid not null references entity(id),
  email         text check (email is null or email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  lines         jsonb not null default '[]'::jsonb,
  item_count    integer not null default 0 check (item_count >= 0),
  subtotal_minor bigint not null default 0 check (subtotal_minor >= 0),
  sales_order_id uuid references sales_order(id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (site_id, id)
);
create index shop_cart_open on shop_cart (entity_id, updated_at desc) where sales_order_id is null;

-- What the card processor said. The token is the processor's, never the card.
create table shop_payment (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  site_id        uuid not null references shop_site(id),
  sales_order_id uuid not null references sales_order(id),
  receipt_id     uuid references customer_receipt(id),
  provider       text not null,
  token_ref      text not null check (token_ref !~ '[0-9]{12,}'),
  brand          text,
  last4          char(4) check (last4 ~ '^[0-9]{4}$'),
  auth_ref       text not null,
  amount_minor   bigint not null check (amount_minor > 0),
  status         text not null check (status in ('authorized','captured','voided','refunded')),
  created_at     timestamptz not null default now()
);
create index shop_payment_order on shop_payment (entity_id, sales_order_id);

-- Texts and emails the store would send. With the 'record' provider nothing
-- leaves the building; the row is the seam a real provider plugs into.
create table shop_message (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  site_id        uuid references shop_site(id),
  sales_order_id uuid references sales_order(id),
  customer_id    uuid references customer(id),
  channel        text not null check (channel in ('sms','email')),
  to_ref         text not null,                 -- masked: "***-***-0101"
  template       text not null,
  body           text not null,
  provider       text not null,
  status         text not null default 'recorded' check (status in ('recorded','sent','failed')),
  created_at     timestamptz not null default now()
);
create index shop_message_entity on shop_message (entity_id, created_at desc);

-- Asking a buyer to review what they bought, and what they said if they did.
create table shop_review (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  product_id     uuid not null references product(id),
  sales_order_id uuid references sales_order(id),
  customer_id    uuid references customer(id),
  provider       text not null,
  status         text not null default 'requested' check (status in ('requested','received','published','rejected')),
  rating         smallint check (rating between 1 and 5),
  title          text,
  body           text,
  external_ref   text,
  created_at     timestamptz not null default now(),
  unique (sales_order_id, product_id)
);
create index shop_review_product on shop_review (entity_id, product_id, status);
