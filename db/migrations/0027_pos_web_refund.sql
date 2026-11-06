-- 0027_pos_web_refund.sql
-- A web order returned at a store is refunded through the card processor
-- that took the money, not through the register's card terminal. Each refund
-- is a row here, against the web payment it reverses; the negative receipt it
-- posts is a 'web' receipt with no register session, so the register's card
-- batch still matches what its own terminal settled.

create table pos_card_refund (
  id               uuid primary key default gen_random_uuid(),
  entity_id        uuid not null references entity(id),
  shop_payment_id  uuid not null references shop_payment(id),
  return_order_id  uuid not null references sales_order(id),
  receipt_id       uuid not null references customer_receipt(id),
  provider         text not null,
  refund_ref       text not null,
  amount_minor     bigint not null check (amount_minor > 0),
  refunded_by      uuid references app_user(id),
  created_at       timestamptz not null default now()
);
create index pos_card_refund_payment on pos_card_refund (shop_payment_id);
