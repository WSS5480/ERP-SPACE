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
};

export async function priceConfigured(c: Client, entityId: string, productId: string, choices: Choice[] = []): Promise<Configured> {
  const p = (await q<{ id: string; sku: string; name: string; kind: string; price_minor: string; cost_minor: string; status: string }>(c,
    `select id, sku, name, kind, price_minor, cost_minor, status from product where id = $1 and entity_id = $2`,
    [productId, entityId]))[0];
  if (!p) throw new PricingError("no such product");
  if (p.status === "discontinued") throw new PricingError(`${p.name} is discontinued`);

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
  return {
    productId: p.id, sku: p.sku, name: p.name, kind: p.kind, unitPriceMinor: price, unitCostMinor: cost < 0n ? 0n : cost,
    leadDays: lead, description: labels.length ? `${p.name} — ${labels.join(", ")}` : p.name, config,
  };
}
