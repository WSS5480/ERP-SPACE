-- 0019_vendor_categories.sql
-- PLACEHOLDER: the demo vendors sorted into categories, and each category's
-- usual account now that the demo charts exist.

begin;

select vendor_category_defaults(id) from tenant /* unscoped: seed over every demo tenant */;

update vendor v set category_id = c.id
  from vendor_category c, (values
    ('Valley Power and Light', 'utilities'), ('Lone Star Fuel Services', 'fleet'), ('Bridgeway Repairs', 'services'),
    ('Meridian Supply', 'merchandise'), ('Ashley Furniture Industries', 'merchandise'), ('Coaster Company of America', 'merchandise'),
    ('Global Furniture USA', 'merchandise'), ('Custom Upholstery Works', 'merchandise')) as m(name, code)
 where v.legal_name = m.name and c.tenant_id = v.tenant_id and c.code = m.code;

-- Anything else a seed added: merchandise when it has products, otherwise other.
update vendor v set category_id = c.id
  from vendor_category c
 where v.category_id is null and c.tenant_id = v.tenant_id
   and c.code = case when exists (select 1 from product p where p.vendor_id = v.id) then 'merchandise' else 'other' end;

commit;
