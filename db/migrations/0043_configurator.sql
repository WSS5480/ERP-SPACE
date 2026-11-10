-- 0043_configurator.sql
-- The configurator: sectionals built from pieces, fabric and leather grades
-- with a swatch library, option rules (requires, excludes, only on these
-- pieces), and a condition grade on every as-is, floor-sample or returned
-- piece. It extends catalog (0017), POS (0020), inventory (0019) and the web
-- store (0024); it forks none of them.
--
-- Rules set here:
--   1. a sectional family is a product (kind 'configurable') with a row in
--      sectional_family; each of its pieces is its own SKU (own price, cost,
--      cube, weight and vendor SKU) with a row in sectional_piece that says
--      what kind of piece it is, its arms, its size and how many it seats
--   2. a sale of a sectional is one cfg_set made of ordinary order lines, one
--      per piece, so reservations, special-order POs, delivery cube and
--      returns all work piece by piece
--   3. a cover (swatch) belongs to one vendor grade table and one grade; the
--      grade prices each piece by an adder for its piece type, else a percent
--      uplift on the piece price
--   4. a condition grade is never edited: a new grading supersedes the last
--      one, which is kept; a manual price needs a reason and says who set it

-- ------------------------------------------------- grades and swatches --

create table fabric_grade_table (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  vendor_id  uuid references vendor(id),
  code       text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,23}$'),
  name       text not null,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  unique (entity_id, code)
);

-- A grade: A..Z, or whatever the vendor calls it (L1, PERF-2). With no adder
-- row for a piece type, the piece price goes up by uplift_bps.
create table fabric_grade (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  table_id        uuid not null references fabric_grade_table(id),
  code            text not null check (code ~ '^[A-Z0-9][A-Z0-9_-]{0,11}$'),
  label           text not null,
  uplift_bps      integer not null default 0 check (uplift_bps between 0 and 30000),
  cost_uplift_bps integer not null default 0 check (cost_uplift_bps between 0 and 30000),
  seq             smallint not null default 0,
  unique (table_id, code)
);

create table fabric_grade_adder (
  entity_id         uuid not null references entity(id),
  grade_id          uuid not null references fabric_grade(id),
  piece_type        text not null,
  price_adder_minor bigint not null default 0 check (price_adder_minor >= 0),
  cost_adder_minor  bigint not null default 0 check (cost_adder_minor >= 0),
  primary key (grade_id, piece_type)
);

create table swatch (
  id              uuid primary key default gen_random_uuid(),
  entity_id       uuid not null references entity(id),
  grade_table_id  uuid not null references fabric_grade_table(id),
  grade_code      text not null,
  code            text not null check (code ~ '^[a-z0-9][a-z0-9_-]{0,59}$'),
  cover_name      text not null,
  material        text not null default 'fabric' check (material in ('fabric','leather','vinyl','performance')),
  color_family    text not null default 'neutral' check (color_family in
                    ('neutral','white','gray','black','brown','beige','blue','green','red','orange','yellow','purple','pink','multi')),
  color           text,
  content         text,                        -- '100% polyester', 'top-grain leather'
  cleaning_code   text check (cleaning_code in ('W','S','WS','SW','X')),
  vendor_code     text,                        -- what the factory calls it, for the PO
  image_url       text check (image_url is null or image_url ~* '^https://'),
  hex             text check (hex is null or hex ~ '^#[0-9a-fA-F]{6}$'),
  discontinued_on date,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (entity_id, grade_table_id, code)
);
create index swatch_find on swatch (entity_id, grade_table_id, grade_code, color_family);

-- ----------------------------------------------------------- sectionals --

create table sectional_family (
  product_id          uuid primary key references product(id),
  entity_id           uuid not null references entity(id),
  min_pieces          smallint not null default 2 check (min_pieces between 1 and 12),
  max_pieces          smallint not null default 7 check (max_pieces between 1 and 12),
  bundle_discount_bps integer not null default 0 check (bundle_discount_bps between 0 and 5000),
  bundle_min_pieces   smallint not null default 3 check (bundle_min_pieces >= 1),
  grade_table_id      uuid references fabric_grade_table(id),
  stock_swatch_id     uuid references swatch(id),   -- the cover the pieces are stocked in; any other is made to order
  notes               text,
  active              boolean not null default true,
  created_by          uuid references app_user(id),
  created_at          timestamptz not null default now(),
  check (max_pieces >= min_pieces)
);

create table sectional_piece (
  id         uuid primary key default gen_random_uuid(),
  entity_id  uuid not null references entity(id),
  family_id  uuid not null references sectional_family(product_id),
  product_id uuid not null references product(id),
  code       text not null check (code ~ '^[a-z0-9][a-z0-9-]{0,39}$'),
  piece_type text not null check (piece_type in ('laf_sofa','raf_sofa','laf_loveseat','raf_loveseat','laf_chair','raf_chair',
               'armless_chair','armless_loveseat','wedge','corner','ottoman','laf_chaise','raf_chaise','console')),
  motion     text not null default 'none' check (motion in ('none','manual','power')),
  width_in   numeric(6,1) not null check (width_in > 0),
  depth_in   numeric(6,1) not null check (depth_in > 0),
  height_in  numeric(6,1) check (height_in > 0),
  seats      smallint not null default 0 check (seats between 0 and 6),
  seq        smallint not null default 0,
  active     boolean not null default true,
  unique (family_id, code),
  unique (family_id, product_id)
);

create table sectional_layout (
  id        uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entity(id),
  family_id uuid not null references sectional_family(product_id),
  code      text not null check (code ~ '^[a-z0-9][a-z0-9-]{0,59}$'),
  name      text not null,
  pieces    text[] not null check (cardinality(pieces) between 1 and 12),
  popular   boolean not null default true,
  seq       smallint not null default 0,
  active    boolean not null default true,
  unique (family_id, code)
);

-- One sold sectional: the configured line, made of ordinary order lines.
create table cfg_set (
  id                    uuid primary key default gen_random_uuid(),
  entity_id             uuid not null references entity(id),
  number                text not null,
  sales_order_id        uuid not null references sales_order(id),
  family_id             uuid not null references sectional_family(product_id),
  channel               text not null check (channel in ('pos','aisle','web')),
  layout_code           text,
  layout_name           text not null,
  cover                 jsonb not null default '{}'::jsonb,
  width_in              numeric(7,1) not null,
  depth_in              numeric(7,1) not null,
  seats                 smallint not null,
  pieces                smallint not null check (pieces > 0),
  list_minor            bigint not null check (list_minor >= 0),
  bundle_discount_minor bigint not null default 0 check (bundle_discount_minor >= 0),
  total_minor           bigint not null check (total_minor >= 0),
  diagram               jsonb not null default '{}'::jsonb,   -- the rectangles the SVG is drawn from
  created_by            uuid references app_user(id),
  created_at            timestamptz not null default now(),
  unique (entity_id, number)
);
create index cfg_set_order on cfg_set (entity_id, sales_order_id);

create table cfg_set_line (
  entity_id           uuid not null references entity(id),
  set_id              uuid not null references cfg_set(id),
  sales_order_line_id uuid not null unique references sales_order_line(id),
  position            smallint not null check (position >= 1),
  piece_code          text not null,
  piece_type          text not null,
  primary key (set_id, sales_order_line_id)
);

-- ----------------------------------------------------- option rules --
-- A generic rule engine over a product's option groups: choosing option A
-- requires one of B, excludes C, or is only allowed on these piece types.
-- option_code null means any option of the group; target_options empty
-- means any option of the target group.

create table product_option_rule (
  id             uuid primary key default gen_random_uuid(),
  entity_id      uuid not null references entity(id),
  product_id     uuid not null references product(id),
  group_code     text not null,
  option_code    text,
  kind           text not null check (kind in ('requires','excludes','only_on')),
  target_group   text,
  target_options text[] not null default '{}',
  piece_types    text[] not null default '{}',
  message        text,
  active         boolean not null default true,
  created_by     uuid references app_user(id),
  created_at     timestamptz not null default now(),
  check ((kind = 'only_on') = (target_group is null)),
  check (kind <> 'only_on' or cardinality(piece_types) > 0)
);
create index product_option_rule_product on product_option_rule (entity_id, product_id) where active;

-- -------------------------------------------------- condition grades --

create table condition_grade_rule (
  entity_id  uuid not null references entity(id),
  grade      text not null check (grade in ('new','like_new','good','fair','damaged')),
  pct_bps    integer not null check (pct_bps between 0 and 10000),   -- share of retail the piece sells for
  updated_by uuid references app_user(id),
  updated_at timestamptz not null default now(),
  primary key (entity_id, grade)
);

create table inv_condition (
  id                   uuid primary key default gen_random_uuid(),
  entity_id            uuid not null references entity(id),
  unit_id              uuid not null,
  label                text not null,
  product_id           uuid not null references product(id),
  source               text not null check (source in ('as_is','floor_sample','return')),
  grade                text not null check (grade in ('new','like_new','good','fair','damaged')),
  notes                text,
  photos               text[] not null default '{}',
  retail_minor         bigint not null check (retail_minor >= 0),
  pct_bps              integer not null,
  auto_price_minor     bigint not null check (auto_price_minor >= 0),
  override_price_minor bigint check (override_price_minor >= 0),
  override_reason      text,
  price_minor          bigint not null check (price_minor >= 0),
  graded_by            uuid references app_user(id),
  graded_at            timestamptz not null default now(),
  superseded_at        timestamptz,
  check ((override_price_minor is null) = (override_reason is null)),
  check (override_reason is null or length(trim(override_reason)) > 0)
);
create unique index inv_condition_current on inv_condition (entity_id, unit_id) where superseded_at is null;
create index inv_condition_product on inv_condition (entity_id, product_id) where superseded_at is null;

create or replace function inv_condition_keep() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'a condition grading is never deleted; grade the piece again'; end if;
  if new.grade <> old.grade or new.price_minor <> old.price_minor or new.unit_id <> old.unit_id
     or new.override_price_minor is distinct from old.override_price_minor then
    raise exception 'a condition grading is not changed; grade the piece again';
  end if;
  return new;
end $$;
create trigger inv_condition_keep before update or delete on inv_condition
  for each row execute function inv_condition_keep();

create or replace function cfg_set_keep() returns trigger
language plpgsql as $$
begin
  raise exception 'a sold sectional is never deleted; void or return its pieces';
end $$;
create trigger cfg_set_keep before delete on cfg_set for each row execute function cfg_set_keep();
create trigger cfg_set_line_keep before delete on cfg_set_line for each row execute function cfg_set_keep();
