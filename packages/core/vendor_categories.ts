// Vendor categories: what kind of vendor each one is, so merchandise
// suppliers are kept apart from the power company and the landlord.
// The pick list is the client's (tenant-wide) and editable; a vendor
// carries one category for every company, and a company may override it
// for itself. A category may name the usual account for new vendors.

import { q, one, audit, type Client, type Scope } from "./db.ts";

export class VendorCategoryError extends Error {}
const need = (cond: unknown, msg: string): void => { if (!cond) throw new VendorCategoryError(msg); };
const T = "/* unscoped: categories and vendors are the client's, shared by its companies */";

/**
 * SQL for "this vendor_entity row (alias ve) is a merchandise vendor here":
 * merchandise by category, the company's override first, or it already has
 * products. Used by every screen where goods are bought.
 */
export const MERCH = (alias = "ve") =>
  `exists (select 1 from vendor_merchandise vm where vm.entity_id = ${alias}.entity_id and vm.vendor_id = ${alias}.vendor_id and vm.is_merchandise)`;

export async function isMerchandise(c: Client, entityId: string, vendorId: string): Promise<boolean> {
  return (await q(c, `select 1 from vendor_merchandise where entity_id = $1 and vendor_id = $2 and is_merchandise`, [entityId, vendorId])).length > 0;
}

export async function listCategories(c: Client, s: Scope) {
  return q(c, `
    select vc.id, vc.code, vc.label, vc.is_merchandise, vc.seq, vc.active, vc.default_gl_account_id, g.code gl_code, g.name gl_name,
           (select count(*) from vendor_entity ve join vendor v on v.id = ve.vendor_id
             where ve.entity_id = $2 and coalesce(ve.category_id, v.category_id) = vc.id) vendors
      from vendor_category vc left join gl_account g on g.id = vc.default_gl_account_id
     where vc.tenant_id = $1 order by vc.active desc, vc.seq, vc.label ${T}`, [s.tenantId, s.entityId]);
}

export async function saveCategory(c: Client, s: Scope, x: { id?: string | null; code?: string; label: string; isMerchandise?: boolean;
  defaultGl?: string | null; active?: boolean; seq?: number }): Promise<string> {
  const label = String(x.label ?? "").trim();
  need(label && label.length <= 60, "a category needs a name");
  let gl: string | null | undefined = undefined;
  if (x.defaultGl !== undefined) {
    if (!x.defaultGl) gl = null;
    else {
      const g = (await q<{ id: string; active: boolean; is_postable: boolean; code: string }>(c,
        `select id, active, is_postable, code from gl_account where tenant_id = $1 and (code = $2 or id::text = $2) ${T}`, [s.tenantId, x.defaultGl]))[0];
      need(g, `there is no account ${x.defaultGl} in this chart`);
      need(g.active && g.is_postable, `${g.code} is ${g.active ? "a header" : "inactive"}; pick an account that takes postings`);
      gl = g.id;
    }
  }
  if (x.id) {
    const cur = (await q<{ id: string; code: string; label: string; is_merchandise: boolean; active: boolean }>(c,
      `select id, code, label, is_merchandise, active from vendor_category where id = $1 and tenant_id = $2 ${T}`, [x.id, s.tenantId]))[0];
    need(cur, "no such category");
    if (x.active === false && cur.active) {
      const n = (await q<{ n: string }>(c, `select count(*) n from vendor v left join vendor_entity ve on ve.vendor_id = v.id
         where v.tenant_id = $1 and (v.category_id = $2 or ve.category_id = $2) ${T}`, [s.tenantId, x.id]))[0].n;
      need(n === "0", `${n} vendor${n === "1" ? " is" : "s are"} in ${cur.label}; move ${n === "1" ? "it" : "them"} first`);
    }
    if (x.isMerchandise === false && cur.code === "merchandise") throw new VendorCategoryError("the Merchandise category is what the buying screens show; it stays merchandise");
    await c.query(`update vendor_category set label = $3, is_merchandise = coalesce($4, is_merchandise), default_gl_account_id = case when $5 then $6::uuid else default_gl_account_id end,
                     active = coalesce($7, active), seq = coalesce($8, seq) where id = $1 and tenant_id = $2`,
      [x.id, s.tenantId, label, x.isMerchandise ?? null, gl !== undefined, gl ?? null, x.active ?? null, x.seq ?? null]);
    await audit(c, s, { table: "vendor_category", rowId: x.id, action: "update", before: cur, after: { label, isMerchandise: x.isMerchandise, defaultGl: x.defaultGl, active: x.active } });
    return x.id;
  }
  const code = (x.code?.trim() || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  need(/^[a-z][a-z0-9_]{1,39}$/.test(code), "a category code starts with a letter, like home_office");
  need(!(await q(c, `select 1 from vendor_category where tenant_id = $1 and code = $2 ${T}`, [s.tenantId, code])).length, `there is already a category ${code}`);
  const r = await one<{ id: string }>(c, `insert into vendor_category (tenant_id, code, label, is_merchandise, default_gl_account_id, seq)
     values ($1,$2,$3,$4,$5,coalesce($6,(select coalesce(max(seq),0)+1 from vendor_category where tenant_id = $1))) returning id ${T}`,
    [s.tenantId, code, label, x.isMerchandise ?? false, gl ?? null, x.seq ?? null]);
  await audit(c, s, { table: "vendor_category", rowId: r.id, action: "insert", after: { code, label, isMerchandise: x.isMerchandise ?? false } });
  return r.id;
}

async function categoryOf(c: Client, tenantId: string, idOrCode: string) {
  const r = (await q<{ id: string; code: string; label: string; active: boolean; default_gl_account_id: string | null }>(c,
    `select id, code, label, active, default_gl_account_id from vendor_category where tenant_id = $1 and (code = $2 or id::text = $2) ${T}`, [tenantId, idOrCode]))[0];
  need(r, "pick one of the vendor categories");
  need(r.active, `${r.label} is retired; pick another category`);
  return r;
}

/** Set a vendor's category: for every company (the default), or for this company only. */
export async function setVendorCategory(c: Client, s: Scope, vendorId: string, category: string | null, opts: { thisCompanyOnly?: boolean } = {}) {
  const v = (await q<{ id: string; name: string; category_id: string | null }>(c,
    `select v.id, coalesce(v.dba, v.legal_name) as name, v.category_id from vendor v join vendor_entity ve on ve.vendor_id = v.id
      where v.id = $1 and ve.entity_id = $2`, [vendorId, s.entityId]))[0];
  need(v, "that vendor is not set up for this company");
  if (opts.thisCompanyOnly) {
    const cat = category ? await categoryOf(c, s.tenantId, category) : null;
    await c.query(`update vendor_entity set category_id = $3 where vendor_id = $1 and entity_id = $2`, [vendorId, s.entityId, cat?.id ?? null]);
    await audit(c, s, { table: "vendor_entity", rowId: vendorId, action: "update", after: { categoryHere: cat?.code ?? null } });
    return { vendor: v.name, category: cat?.label ?? null, scope: "this company" };
  }
  need(category, "pick a category");
  const cat = await categoryOf(c, s.tenantId, category!);
  await c.query(`update vendor set category_id = $2 where id = $1 and tenant_id = $3 ${T}`, [vendorId, cat.id, s.tenantId]);
  await audit(c, s, { table: "vendor", rowId: vendorId, action: "update", before: { category_id: v.category_id }, after: { category: cat.code } });
  return { vendor: v.name, category: cat.label, scope: "every company" };
}

/** A category by id or code, with its usual account: new vendors of the kind code there unless told otherwise. */
export const categoryInfo = categoryOf;

/** Fill each category's usual account from the chart where it is still blank (setup packs call this after adding accounts). */
export async function fillCategoryDefaults(c: Client, tenantId: string): Promise<void> {
  await c.query(`select vendor_category_defaults($1) /* unscoped: the client's categories */`, [tenantId]);
}
