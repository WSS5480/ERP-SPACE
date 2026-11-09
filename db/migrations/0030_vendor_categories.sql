-- 0030_vendor_categories.sql
-- Vendors grouped by what they are: merchandise suppliers apart from the
-- power company, the landlord and the fuel card. A pick list per tenant,
-- editable, seeded with the usual dozen. A vendor carries one category for
-- every company; a company may override it for itself.
--
-- Only merchandise vendors (or vendors that already have products) appear
-- where goods are bought: Catalog vendors, the buying order form, special
-- orders, vendor API setup, replenishment. A category may name the account
-- new vendors of that kind are usually coded to.

create table vendor_category (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenant(id),
  code                  text not null check (code ~ '^[a-z][a-z0-9_]{1,39}$'),
  label                 text not null,
  is_merchandise        boolean not null default false,
  default_gl_account_id uuid references gl_account(id),
  seq                   smallint not null default 0,
  active                boolean not null default true,
  unique (tenant_id, code)
);

alter table vendor add column category_id uuid references vendor_category(id);
alter table vendor_entity add column category_id uuid references vendor_category(id);   -- this company's own view, when it differs

-- The default categories, for every tenant now and every tenant made later.
create or replace function vendor_category_defaults(p_tenant uuid) returns void
language plpgsql as $$
begin
  insert into vendor_category (tenant_id, code, label, is_merchandise, seq)
  select p_tenant, x.code, x.label, x.code = 'merchandise', x.seq
    from (values ('merchandise','Merchandise',1), ('utilities','Utilities',2), ('rent_lease','Rent and leases',3),
                 ('services','Services and repairs',4), ('freight','Freight and logistics',5), ('insurance','Insurance',6),
                 ('taxes','Taxes and government',7), ('payroll_benefits','Payroll and benefits',8), ('technology','Technology',9),
                 ('marketing','Marketing',10), ('fleet','Fleet and fuel',11), ('other','Other',12)) as x(code, label, seq)
  on conflict (tenant_id, code) do nothing;
  -- the usual account for each, where the chart has it
  update vendor_category c set default_gl_account_id = g.id
    from (values ('merchandise','2050'), ('utilities','6410'), ('rent_lease','6400'), ('services','6200'), ('freight','5030'),
                 ('insurance','6500'), ('taxes','6800'), ('payroll_benefits','6120'), ('technology','6800'), ('marketing','6800'),
                 ('fleet','6300'), ('other','6800')) as d(code, gl)
    join gl_account g on g.code = d.gl and g.tenant_id = p_tenant
   where c.tenant_id = p_tenant and c.code = d.code and c.default_gl_account_id is null;
end $$;

create or replace function tenant_vendor_categories() returns trigger
language plpgsql as $$
begin
  perform vendor_category_defaults(new.id);
  return new;
end $$;
create trigger tenant_vendor_categories after insert on tenant
  for each row execute function tenant_vendor_categories();

select vendor_category_defaults(id) from tenant /* unscoped: a migration over every tenant */;

-- A category belongs to the vendor's own tenant.
create or replace function vendor_category_same_tenant() returns trigger
language plpgsql as $$
begin
  if new.category_id is not null
     and (select tenant_id from vendor_category where id = new.category_id) is distinct from new.tenant_id then
    raise exception 'that category belongs to another client';
  end if;
  return new;
end $$;
create trigger vendor_category_same_tenant before insert or update of category_id on vendor
  for each row execute function vendor_category_same_tenant();

create or replace function vendor_entity_category_same_tenant() returns trigger
language plpgsql as $$
begin
  if new.category_id is not null
     and (select tenant_id from vendor_category where id = new.category_id) is distinct from (select tenant_id from vendor where id = new.vendor_id) then
    raise exception 'that category belongs to another client';
  end if;
  return new;
end $$;
create trigger vendor_entity_category_same_tenant before insert or update of category_id on vendor_entity
  for each row execute function vendor_entity_category_same_tenant();

-- Vendors already on file: products make a merchandise vendor; otherwise
-- the name and the account its bills code to say which kind it is.
update vendor v set category_id = c.id
  from vendor_category c
 where c.tenant_id = v.tenant_id and v.category_id is null
   and c.code = case
     when exists (select 1 from product p where p.vendor_id = v.id) then 'merchandise'
     when v.legal_name ~* '(power|light|electric|energy|water|gas co|utilit|sewer|waste|telephone|internet|cable)' then 'utilities'
     when v.legal_name ~* '(fuel|petroleum|oil co|tire|auto parts|fleet)' then 'fleet'
     when v.legal_name ~* '(realty|properties|property|landlord|leasing|plaza|mall)' then 'rent_lease'
     when v.legal_name ~* '(insurance|assurance|underwriters|mutual)' then 'insurance'
     when v.legal_name ~* '(freight|logistics|trucking|transport|shipping|carrier)' then 'freight'
     when v.legal_name ~* '(county|city of|state of|comptroller|department of|tax)' then 'taxes'
     when v.legal_name ~* '(repair|maintenance|cleaning|services|janitorial|plumbing|hvac)' then 'services'
     when exists (select 1 from vendor_entity ve join gl_account g on g.id = ve.default_gl_account_id
                   where ve.vendor_id = v.id and g.code in ('1210','1300','2050')) then 'merchandise'
     else 'other' end
 /* unscoped: a migration over every tenant's vendors */;

-- Whether a vendor sells goods to this company: merchandise by category
-- (the company's override first) or simply because it has products here.
create view vendor_merchandise as
  select ve.entity_id, ve.vendor_id,
         coalesce(cc.code, vc.code) category_code,
         (coalesce(cc.is_merchandise, vc.is_merchandise, false)
           or exists (select 1 from product p where p.entity_id = ve.entity_id and p.vendor_id = ve.vendor_id)) is_merchandise
    from vendor_entity ve join vendor v on v.id = ve.vendor_id
    left join vendor_category vc on vc.id = v.category_id
    left join vendor_category cc on cc.id = ve.category_id;
