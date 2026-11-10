// The price of a product as configured. POS, the web customizer and quotes
// all call this, so a sofa in navy velvet costs the same at the register as
// it does online. Owned by the catalog module; extend it (promotions, price
// lists, packages), but keep this signature.

import { q, type Client } from "./db.ts";

export class PricingError extends Error {}

export type Choice = { group: string; option: string | string[] };   // codes
export type Configured = {
  productId: string;
  sku: string;
  name: string;
  kind: string;
  unitPriceMinor: bigint;      // base + option deltas
  unitCostMinor: bigint;
  leadDays: number;            // longest option lead time
  description: string;         // "Hudson sofa, made to order — 96" sofa, Velvet, navy, Walnut"
  config: Record<string, { code: string; label: string; vendorCode: string | null; deltaMinor: string }[]>;
  // Added by the catalog module. unitPriceMinor above is always the price to charge.
  ticketMinor?: bigint;        // base + option deltas at the ticket price, before lists and promotions
  priceList?: string | null;   // the list whose price was used, if any
  promotion?: { id: string; name: string; savingsMinor: bigint } | null;
  mapMinor?: bigint | null;    // minimum advertised price, for tags and the web
  kit?: { componentTotalMinor: bigint; components: { productId: string; sku: string; name: string; qty: number; priceMinor: bigint }[] } | null;
};

export type PriceOpts = {
  priceList?: string | null;   // price_list.code, e.g. 'CONTRACT'
  on?: string | null;          // YYYY-MM-DD the price is for; today when absent
};

type Promo = { id: string; name: string; kind: string; pct_bps: number | null; amount_minor: string | null; respect_map: boolean };

/** The price a promotion gives on a configured price; never below zero, and not below MAP when it respects MAP. */
export function promoPrice(p: Promo, configured: bigint, baseTicket: bigint, mapMinor: bigint | null): bigint {
  let out: bigint;
  if (p.kind === "percent") out = configured - (configured * BigInt(p.pct_bps ?? 0) + 5000n) / 10000n;
  else if (p.kind === "amount_off") out = configured - BigInt(p.amount_minor ?? "0");
  else out = BigInt(p.amount_minor ?? "0") + (configured - baseTicket);   // fixed base price, options still add
  if (p.respect_map && mapMinor != null) {
    const floor = mapMinor + (configured - baseTicket);
    if (out < floor) out = floor;
  }
  return out < 0n ? 0n : out;
}

export async function priceConfigured(c: Client, entityId: string, productId: string, choices: Choice[] = [], popts: PriceOpts = {}): Promise<Configured> {
  const p = (await q<{ id: string; sku: string; name: string; kind: string; price_minor: string; cost_minor: string; status: string;
                       map_minor: string | null; vendor_id: string | null; category: string | null }>(c,
    `select id, sku, name, kind, price_minor, cost_minor, status, map_minor, vendor_id, category
       from product where id = $1 and entity_id = $2`,
    [productId, entityId]))[0];
  if (!p) throw new PricingError("no such product");
  if (p.status === "discontinued") throw new PricingError(`${p.name} is discontinued`);
  if (p.status === "draft") throw new PricingError(`${p.name} is a draft and not for sale yet`);
  const on = popts.on && /^\d{4}-\d{2}-\d{2}$/.test(popts.on) ? popts.on : null;

  const groups = await q<{ id: string; code: string; label: string; required: boolean; multi: boolean }>(c,
    `select id, code, label, required, multi from product_option_group where entity_id = $1 and product_id = $2 order by seq`,
    [entityId, productId]);
  const opts = await q<{ group_id: string; code: string; label: string; price_delta_minor: string; cost_delta_minor: string; lead_days: number; vendor_code: string | null }>(c,
    `select o.group_id, o.code, o.label, o.price_delta_minor, o.cost_delta_minor, o.lead_days, o.vendor_code
       from product_option o where o.entity_id = $1 and o.active
        and o.group_id in (select id from product_option_group where entity_id = $1 and product_id = $2)`,
    [entityId, productId]);

  let price = BigInt(p.price_minor), cost = BigInt(p.cost_minor), lead = 0;
  const config: Configured["config"] = {};
  const labels: string[] = [];
  const byGroup = new Map(choices.map((ch) => [ch.group, Array.isArray(ch.option) ? ch.option : [ch.option]]));
  for (const g of groups) {
    const picked = (byGroup.get(g.code) ?? []).filter(Boolean);
    if (!picked.length) {
      if (g.required) throw new PricingError(`choose a ${g.label.toLowerCase()}`);
      continue;
    }
    if (!g.multi && picked.length > 1) throw new PricingError(`choose one ${g.label.toLowerCase()}`);
    config[g.code] = [];
    for (const code of picked) {
      const o = opts.find((x) => x.group_id === g.id && x.code === code);
      if (!o) throw new PricingError(`${code} is not a ${g.label.toLowerCase()} for ${p.name}`);
      price += BigInt(o.price_delta_minor);
      cost += BigInt(o.cost_delta_minor);
      lead = Math.max(lead, o.lead_days);
      config[g.code].push({ code: o.code, label: o.label, vendorCode: o.vendor_code, deltaMinor: o.price_delta_minor });
      labels.push(o.label);
    }
    byGroup.delete(g.code);
  }
  if (byGroup.size) throw new PricingError(`${p.name} has no option group ${[...byGroup.keys()].join(", ")}`);
  if (price < 0n) throw new PricingError("options cannot take the price below zero");

  // The ticket price, then a price list if one was asked for, then the best
  // live promotion. The lowest wins; promotions never stack.
  const baseTicket = BigInt(p.price_minor);
  const ticket = price;
  const optionsDelta = ticket - baseTicket;
  let final = ticket;
  let listUsed: string | null = null;
  if (popts.priceList) {
    const li = (await q<{ price_minor: string; code: string }>(c, `
      select i.price_minor, l.code from price_list l join price_list_item i on i.price_list_id = l.id
       where l.entity_id = $1 and l.code = $2 and l.active and i.product_id = $3
         and coalesce($4::date, current_date) between coalesce(l.starts_on, '-infinity') and coalesce(l.ends_on, 'infinity')`,
      [entityId, String(popts.priceList).toUpperCase(), productId, on]))[0];
    if (li) {
      const v = BigInt(li.price_minor) + optionsDelta;
      if (v < final) { final = v; listUsed = li.code; }
    } else {
      // No price of its own on the list: the list's rule for the product's category (or its catch-all rule),
      // cost plus a markup or retail less a discount, on the configured cost and ticket.
      const rule = (await q<{ basis: string; bps: number; code: string }>(c, `
        select r.basis, r.bps, l.code from price_list l join price_list_rule r on r.price_list_id = l.id and r.entity_id = l.entity_id and r.active
         where l.entity_id = $1 and l.code = $2 and l.active and (r.category = $3 or r.category is null)
           and coalesce($4::date, current_date) between coalesce(l.starts_on, '-infinity') and coalesce(l.ends_on, 'infinity')
         order by (r.category is null) limit 1`, [entityId, String(popts.priceList).toUpperCase(), p.category, on]))[0];
      if (rule) {
        const c0 = cost < 0n ? 0n : cost;
        const v = rule.basis === "cost_plus" ? c0 + (c0 * BigInt(rule.bps) + 5000n) / 10000n
          : ticket - (ticket * BigInt(rule.bps) + 5000n) / 10000n;
        if (v < final) { final = v < 0n ? 0n : v; listUsed = rule.code; }
      }
    }
  }
  const mapMinor = p.map_minor == null ? null : BigInt(p.map_minor);
  const promos = await q<Promo>(c, `
    select id, name, kind, pct_bps, amount_minor, respect_map from promotion
     where entity_id = $1 and active and coalesce($2::date, current_date) between starts_on and ends_on
       and (product_id = $3 or (product_id is null
            and (vendor_id is null or vendor_id = $4) and (category is null or category = $5)))`,
    [entityId, on, productId, p.vendor_id, p.category]);
  let promotion: Configured["promotion"] = null;
  for (const pr of promos) {
    const v = promoPrice(pr, ticket, baseTicket, mapMinor);
    if (v < final) { final = v; promotion = { id: pr.id, name: pr.name, savingsMinor: ticket - v }; listUsed = null; }
  }

  let kit: Configured["kit"] = null;
  if (p.kind === "kit") {
    const comps = await q<{ product_id: string; sku: string; name: string; qty: string; price_minor: string; cost_minor: string }>(c, `
      select k.component_id product_id, x.sku, x.name, k.qty, x.price_minor, x.cost_minor
        from product_kit_component k join product x on x.id = k.component_id and x.entity_id = $1
       where k.entity_id = $1 and k.kit_id = $2 order by k.seq, x.sku`, [entityId, productId]);
    let total = 0n;
    const components = comps.map((k) => {
      const each = BigInt(k.price_minor);
      total += BigInt(Math.round(Number(k.qty) * Number(each)));
      return { productId: k.product_id, sku: k.sku, name: k.name, qty: Number(k.qty), priceMinor: each };
    });
    kit = { componentTotalMinor: total, components };
  }

  return {
    productId: p.id, sku: p.sku, name: p.name, kind: p.kind, unitPriceMinor: final, unitCostMinor: cost < 0n ? 0n : cost,
    leadDays: lead, description: labels.length ? `${p.name} — ${labels.join(", ")}` : p.name, config,
    ticketMinor: ticket, priceList: listUsed, promotion, mapMinor, kit,
  };
}
