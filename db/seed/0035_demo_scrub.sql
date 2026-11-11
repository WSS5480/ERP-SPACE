-- The demo is made up: no real towns, businesses, ZIP codes or area codes.
--
-- The earlier seed files were written around real places; rather than rewrite
-- them (a live database records them as already run), this file renames what
-- they made, for the demo tenants only. It runs after them on a fresh seed and
-- on every Reset demo. It is safe on a live database: it touches nothing
-- outside the two demo tenants, and running it twice changes nothing more.
--
--   Enola -> Riverside, Palestine -> Mesa Verde, Socorro -> Canyon Ridge,
--   Tyler -> Oak Hollow, Harrisburg -> Hillcrest, Camp Hill -> Maple Grove, ...
--   Buddy's Home Furnishings -> Riverside Home Furnishings (web store riverside-home)
--   real ZIP codes -> 001xx (not issued); area codes 717/903/915/956 -> 555
--
-- Left as they are: audit_event and platform_audit (kept as written, never
-- changed), journal entries and other append-only rows (corrections are
-- reversals; none of the seeded ones names a place), and furniture makers'
-- names on vendor rows (the vendor connections are built for those makers).

create or replace function pg_temp.demo_scrub(s text, zip_column boolean default false) returns text language plpgsql immutable as $f$
declare
  pairs text[][] := array[
    ['Buddy''s Home Furnishings', 'Riverside Home Furnishings'], ['Buddys Home Furnishings', 'Riverside Home Furnishings'],
    ['\mbuddys\M', 'riverside-home'], ['\mBuddy''s\M', 'Riverside'], ['\mBuddys\M', 'Riverside'],
    ['\mEnola\M', 'Riverside'], ['\mENOLA\M', 'RIVERSIDE'], ['\menola', 'riverside'],
    ['\mPalestine\M', 'Mesa Verde'], ['\mPALESTINE\M', 'MESAVERDE'], ['\mpalestine', 'mesaverde'],
    ['\mSocorro\M', 'Canyon Ridge'], ['\mSOCORRO\M', 'CANYONRIDGE'], ['\msocorro', 'canyonridge'],
    ['\mTyler\M', 'Oak Hollow'], ['\mTYLER\M', 'OAKHOLLOW'], ['\mtyler\M', 'oakhollow'],
    ['\mHarrisburg\M', 'Hillcrest'], ['\mharrisburg', 'hillcrest'],
    ['\mCamp Hill\M', 'Maple Grove'], ['\mMechanicsburg\M', 'Millbrook'], ['\mCarlisle\M', 'Stonebridge'],
    ['\mLemoyne\M', 'Brookside'], ['\mMarysville\M', 'Fairhaven'], ['\mLancaster\M', 'Greenfield'],
    ['\mEl Paso\M', 'Sun Valley'], ['\mELPASO\M', 'SUNVALLEY'], ['\mMcAllen\M', 'Palm Valley'], ['\mMCALLEN\M', 'PALMVALLEY'], ['\mmcallen', 'palmvalley'],
    ['\mPerry County\M', 'Ridge County'], ['\mWest Shore\M', 'Westside'], ['\mAnderson County\M', 'Juniper County'], ['\mANDERSON\M', 'JUNIPER'],
    ['\mKeystone\M', 'Hearthstone'], ['\mkeystone', 'hearthstone'], ['\mSusquehanna\M', 'Bluewater'], ['\msusquehanna', 'bluewater'],
    ['\mSheetz\M', 'Corner Fuel'], ['\mRutter''s\M', 'Quick Stop'],
    -- area codes: the 555 numbers keep their 555, under a 555 area code
    ['\m(717|903|915|956)(\)?[-. ]?555)', '555\2']
  ];
  -- ZIP codes the seeds used (all real): to 001xx, which the Postal Service does not issue. Only in a ZIP
  -- column, or a "postal"/"zip" key in an address, never in an amount that happens to have the same digits.
  zips text[][] := array[
    ['17025', '00125'], ['17011', '00111'], ['17043', '00143'], ['17053', '00153'], ['17055', '00155'],
    ['17101', '00101'], ['17109', '00109'], ['17110', '00110'], ['17013', '00113'],
    ['75801', '00181'], ['75802', '00182'], ['75803', '00183'], ['75701', '00171'], ['75702', '00172'],
    ['79927', '00127'], ['79901', '00191'], ['78501', '00151']
  ];
  i int; z text;
begin
  if s is null then return null; end if;
  for i in 1 .. array_length(pairs, 1) loop
    s := regexp_replace(s, pairs[i][1], pairs[i][2], 'g');
  end loop;
  for i in 1 .. array_length(zips, 1) loop
    z := zips[i][1];
    if zip_column then s := regexp_replace(s, '\m' || z || '(-\d{4})?\M', zips[i][2], 'g'); end if;
    s := regexp_replace(s, '("(postal|zip|postal_code|zip_code)"\s*:\s*")' || z || '(-\d{4})?"', '\1' || zips[i][2] || '"', 'g');
  end loop;
  return s;
end $f$;

do $scrub$
declare
  ten uuid[] := array['11111111-1111-1111-1111-111111111111', 'dddd0000-0000-0000-0000-00000000000d']::uuid[];
  ents uuid[];
  hit text := '(enola|palestine|socorro|buddy|tyler|harrisburg|camp hill|mechanicsburg|carlisle|lemoyne|marysville|lancaster|el ?paso|mcallen|perry county|west shore|anderson|keystone|susquehanna|sheetz|rutter|17025|17011|17043|17053|17055|17101|17109|17110|17013|75801|75802|75803|75701|75702|79927|79901|78501|717|903|915|956)';
  r record; w text; n int; total int := 0;
begin
  select array_agg(id) into ents from entity where tenant_id = any(ten);
  if ents is null then return; end if;
  for r in
    select c.table_name, c.column_name, c.data_type,
           exists (select 1 from information_schema.columns x where x.table_schema = c.table_schema and x.table_name = c.table_name and x.column_name = 'entity_id') has_e,
           exists (select 1 from information_schema.columns x where x.table_schema = c.table_schema and x.table_name = c.table_name and x.column_name = 'tenant_id') has_t
      from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
     where c.table_schema = current_schema() and t.table_type = 'BASE TABLE'
       and (c.data_type in ('text', 'character varying', 'jsonb') or (c.data_type = 'ARRAY' and c.udt_name in ('_text', '_varchar')))
       and c.table_name not in ('audit_event', 'platform_audit', 'schema_migration', 'journal_entry', 'journal_line', 'period_event', 'server_error', 'job_run', 'job_run_item')
       and c.column_name not in ('password_hash', 'token_hash', 'unsub_token', 'session_hash')
     order by 1, 2
  loop
    if r.table_name in ('tenant', 'entity') then
      w := format('%I = any($2)', case when r.table_name = 'tenant' then 'id' else 'id' end);
      if r.table_name = 'tenant' then w := 'id = any($1)'; end if;
    elsif r.has_e and r.has_t then w := '(entity_id = any($2) or tenant_id = any($1))';
    elsif r.has_e then w := 'entity_id = any($2)';
    elsif r.has_t then w := 'tenant_id = any($1)';
    else continue;
    end if;
    begin
      if r.data_type = 'ARRAY' then
        -- a list (a zone's ZIP codes): each value on its own; a column of ZIP codes changes them
        execute format('update %I set %I = (select array_agg(pg_temp.demo_scrub(v, %L) order by o) from unnest(%I) with ordinality u(v, o)) where %s and array_to_string(%I, %L) ~* %L',
          r.table_name, r.column_name, (r.column_name ~ '(postal|zip)'), r.column_name, w, r.column_name, ' ', hit) using ten, ents;
      elsif r.data_type = 'jsonb' then
        execute format('update %I set %I = pg_temp.demo_scrub(%I::text)::jsonb where %s and %I::text ~* %L and pg_temp.demo_scrub(%I::text) <> %I::text',
          r.table_name, r.column_name, r.column_name, w, r.column_name, hit, r.column_name, r.column_name) using ten, ents;
      else
        execute format('update %I set %I = pg_temp.demo_scrub(%I, %L) where %s and %I ~* %L and pg_temp.demo_scrub(%I, %L) <> %I',
          r.table_name, r.column_name, r.column_name, (r.column_name ~ '(postal|zip)'), w, r.column_name, hit, r.column_name, (r.column_name ~ '(postal|zip)'), r.column_name) using ten, ents;
      end if;
      get diagnostics n = row_count;
      total := total + n;
    exception when others then
      raise notice 'demo scrub: %.% left as it is (%)', r.table_name, r.column_name, sqlerrm;
    end /* the column */;
  end loop;
  raise notice 'demo scrub: % value(s) renamed', total;
end $scrub$;
