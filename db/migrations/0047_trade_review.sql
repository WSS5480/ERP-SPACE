-- 0047_trade_review.sql
-- Review fixes for the trade module (0044):
--   1. a price list's rules never price below cost unless the list allows it
--   2. a portal invoice payment carries the page's key: the same payment twice is refused before any card is charged
--   3. room photos may be larger (a resized 1600 px JPEG), within the 3 MB the photo routes accept

alter table price_list add column if not exists allow_below_cost boolean not null default false;

create table trade_invoice_payment (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  trade_account_id uuid not null references trade_account(id),
  idem_key         text not null check (idem_key ~ '^[A-Za-z0-9_-]{8,64}$'),
  invoice_id       uuid not null references customer_invoice(id),
  receipt_id       uuid references customer_receipt(id),
  amount_minor     bigint,
  created_at       timestamptz not null default now(),
  unique (trade_account_id, idem_key)
);

alter table room_project_photo drop constraint if exists room_project_photo_data_url_check;
alter table room_project_photo add constraint room_project_photo_data_url_check
  check (data_url ~ '^data:image/(png|jpeg|webp);base64,' and length(data_url) <= 2900000);
