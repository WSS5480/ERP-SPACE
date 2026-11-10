-- Delivery booked at the sale, confirmed and locked by the delivery manager.
--
-- The salesperson picks a day and window at the register; the stop is booked
-- when the sale is placed, as "waiting to confirm". A dispatcher or store
-- manager confirms it, and can lock a day: a locked day takes no new bookings
-- and no moves from sales or the customer link, only from the managers.
-- Stops booked by a manager are confirmed from the start.

alter table delivery_stop add column confirmed_at timestamptz;
alter table delivery_stop add column confirmed_by uuid references app_user(id);
alter table delivery_stop add column booked_from text not null default 'dispatch'
  check (booked_from in ('dispatch','sale','customer_link'));

-- What was already on the books was booked by dispatch: count it confirmed.
update delivery_stop set confirmed_at = created_at, confirmed_by = created_by /* unscoped: one-time backfill */
 where confirmed_at is null and status <> 'cancelled';

create table delivery_day_lock (
  id           uuid primary key default gen_random_uuid(),
  entity_id    uuid not null references entity(id),
  day          date not null,
  locked_by    uuid references app_user(id),
  locked_at    timestamptz not null default now(),
  unlocked_by  uuid references app_user(id),
  unlocked_at  timestamptz,
  unlock_reason text,
  check (unlocked_at is null or coalesce(trim(unlock_reason),'') <> '')
);
create unique index delivery_day_lock_live on delivery_day_lock (entity_id, day) where unlocked_at is null;

-- The day and window the salesperson picked, kept on the sale until it is booked (or for a quote).
alter table pos_order add column delivery_day date;
alter table pos_order add column delivery_window_id uuid references delivery_window(id);
