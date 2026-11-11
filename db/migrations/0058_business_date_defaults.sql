-- The last UTC dates (review of 0053): column defaults and four views.
--
-- 1. Date columns that defaulted to current_date (the database's UTC day)
--    take the company's business date instead when an insert leaves them out:
--    the default goes and a BEFORE INSERT trigger fills the column from
--    business_today(<the row's company>). An insert that names the date keeps it.
-- 2. The views ap_aging, sweep_status, connection_health and statement_gaps
--    count days from each company's business date. Rebuilt from their own
--    definitions here, so a database whose view differs is left as it is
--    (with a notice) rather than broken.
--
-- Additive and safe on a live database: no rows change.

create or replace function fill_business_date() returns trigger
language plpgsql as $$
-- TG_ARGV[0]: the date column; TG_ARGV[1]: the column naming the company
declare j jsonb := to_jsonb(new);
begin
  if j ->> tg_argv[0] is null and j ->> tg_argv[1] is not null then
    new := jsonb_populate_record(new, jsonb_build_object(tg_argv[0], business_today((j ->> tg_argv[1])::uuid)));
  end if;
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
      ('customer_invoice', 'invoice_date', 'entity_id'), ('customer_invoice', 'due_date', 'entity_id'),
      ('ar_ledger', 'occurred_on', 'entity_id'), ('maintenance_schedule', 'last_done_on', 'entity_id'),
      ('fuel_log', 'filled_on', 'entity_id'), ('ic_document', 'doc_date', 'from_entity_id'),
      ('ic_settlement', 'settled_on', 'payer_entity_id'), ('ic_markup_move', 'occurred_on', 'entity_id')) v(t, col, ent)
  loop
    if exists (select 1 from information_schema.columns where table_schema = current_schema() and table_name = r.t and column_name = r.col) then
      execute format('alter table %I alter column %I drop default', r.t, r.col);
      execute format('drop trigger if exists %I on %I', r.t || '_' || r.col || '_business_date', r.t);
      execute format('create trigger %I before insert on %I for each row execute function fill_business_date(%L, %L)',
        r.t || '_' || r.col || '_business_date', r.t, r.col, r.ent);
    end if;
  end loop;
end $$;

do $$
declare def text; fixed text; v record;
begin
  for v in select * from (values
      ('ap_aging', array['CURRENT_DATE - i.due_date'], array['business_today(i.entity_id) - i.due_date']),
      ('sweep_status', array['bt.due_on < CURRENT_DATE'], array['bt.due_on < business_today(bt.entity_id)']),
      ('connection_health', array['CURRENT_DATE - last_success_at::date'],
                            array['business_today(c.entity_id) - (c.last_success_at AT TIME ZONE business_tz(c.entity_id))::date']),
      ('statement_gaps', array['GREATEST(CURRENT_DATE - 30', '(CURRENT_DATE - 1)', 'CURRENT_DATE - d AS days_ago'],
                         array['GREATEST(business_today(ba.entity_id) - 30', '(business_today(a.entity_id) - 1)', 'business_today(days.entity_id) - d AS days_ago'])
    ) x(name, olds, news)
  loop
    if to_regclass(v.name) is null then continue; end if;
    def := pg_get_viewdef(v.name::regclass, true);
    fixed := def;
    for i in 1 .. array_length(v.olds, 1) loop
      fixed := replace(fixed, v.olds[i], v.news[i]);
    end loop;
    if fixed ~ 'CURRENT_DATE' then
      raise notice 'view % is not as expected; it keeps CURRENT_DATE', v.name;
    else
      execute format('create or replace view %I as %s', v.name, rtrim(fixed, '; ' || chr(10)));
    end if;
  end loop;
end $$;
