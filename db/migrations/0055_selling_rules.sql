-- Selling rules a company sets for itself (Setup, Sales tax, Selling rules):
-- the tenders its registers take. The discount limit, quote life and layaway
-- terms were already columns of pos_setting; they are now editable there, and
-- a company with no pos_setting row yet takes its pack's values
-- (pos.discount_limit_bps, pos.quote_days, pos.layaway_days, pos.deposit_min_bps,
-- pos.tenders in entity_setting) before the built-in defaults.
-- Additive only: null tenders means every tender the POS knows.

alter table pos_setting add column if not exists tenders text[];
do $$ begin
  alter table pos_setting add constraint pos_setting_tenders_known check (
    tenders is null or (cardinality(tenders) >= 1 and tenders <@ array['cash','card','check','financing','gift_card','store_credit']::text[]));
exception when duplicate_object then null; end $$;
