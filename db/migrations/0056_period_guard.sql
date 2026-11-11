-- The closed-period guard, tightened (review of 0053).
--
-- 1. An entry's period must be its own company's, and must hold its posting
--    date: before this, a direct insert could file an October date under an
--    open November period and land in closed October's books.
-- 2. The period row is read FOR SHARE, so a posting and a month-end close
--    cannot pass each other: a close (closeMonth takes the row FOR UPDATE)
--    waits for postings in flight, and a posting that arrives while a close
--    is running waits for it and then sees the month closed.
-- 3. Lines cannot be added to an entry whose period is closed (entries are
--    immutable, but appending a balanced pair of lines was still possible).
-- 4. A closed period changes status only with a reason on the period log in
--    the same transaction (periods.ts writes it), so a plain UPDATE cannot
--    reopen a month without the owner's reason being kept.
--
-- Additive: replaces two functions and adds two triggers.

create or replace function journal_period_open() returns trigger
language plpgsql as $$
declare v_status text; v_start date; v_end date; v_entity uuid;
begin
  select status, starts_on, ends_on, entity_id into v_status, v_start, v_end, v_entity
    from fiscal_period where id = new.period_id for share;
  if v_status = 'closed' then
    raise exception 'the books for % are closed, so nothing can be posted on %. An owner can reopen the month in Books, Periods (with a reason), or post it on a day in an open month.',
      to_char(v_start, 'FMMonth YYYY'), new.posting_date
      using errcode = 'check_violation';
  end if;
  if v_entity is distinct from new.entity_id then
    raise exception 'the period % is not this company''s', new.period_id using errcode = 'check_violation';
  end if;
  if new.posting_date < v_start or new.posting_date > v_end then
    raise exception 'an entry dated % cannot be filed in the period % to %', new.posting_date, v_start, v_end using errcode = 'check_violation';
  end if;
  return new;
end $$;

create or replace function journal_line_period_open() returns trigger
language plpgsql as $$
declare v_status text;
begin
  select p.status into v_status from journal_entry je join fiscal_period p on p.id = je.period_id
   where je.id = new.journal_entry_id for share of p;
  if v_status = 'closed' then
    raise exception 'that entry is in a closed month; post a new entry in an open month instead' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists journal_line_period_open_trg on journal_line;
create trigger journal_line_period_open_trg before insert on journal_line
  for each row execute function journal_line_period_open();

create or replace function fiscal_period_reopen_logged() returns trigger
language plpgsql as $$
begin
  if old.status = 'closed' and new.status <> 'closed' and not exists (
       select 1 from period_event e where e.period_id = new.id and e.kind = 'reopened' and e.at = now()) then
    raise exception 'a closed month reopens from Books, Periods, by the owner with a reason' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists fiscal_period_reopen_logged_trg on fiscal_period;
create trigger fiscal_period_reopen_logged_trg before update of status on fiscal_period
  for each row execute function fiscal_period_reopen_logged();
