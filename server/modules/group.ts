// group module -- group accounting across a client's companies. See docs/MODULES.md for the contract.
// Routes under /api/c/<company>/group/... The rules live in packages/core/group.ts;
// this file checks who may do what and reads the request.
//
// Who: the group view, the net check and settling are for the owner, or a
// controller in every company they cover. Billing a sibling needs a
// controller in both companies; a one-sided entry, a controller in this one.
import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, minor } from "./kit.ts";
import { scopeOf } from "../actions.ts";
import * as g from "../../packages/core/group.ts";
import { PostingError } from "../../packages/core/posting.ts";
import { InventoryError } from "../../packages/core/inventory.ts";
import { CatalogError } from "../../packages/core/catalog.ts";
import { ArError } from "../../packages/core/ar.ts";
import { TransitionError } from "../../packages/core/invoice.ts";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + "01";

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof g.GroupError || e instanceof PostingError || e instanceof InventoryError || e instanceof CatalogError
      || e instanceof ArError || e instanceof TransitionError) throw new ModuleError(e.message);
    throw e;
  }
}

/** Money and bigints out as strings, so the screen reads them exactly. */
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));

const idList = (v: string | null): string[] => (v ?? "").split(",").map((x) => uuid(x.trim())).filter(Boolean) as string[];

export const module: ErpModule = {
  id: "group",
  register(kit) {
    const { coGet, coPost } = kit;
    const sc = (co: Company, a: Actor) => scopeOf(co, a);

    // ---- overview: the companies, the settings, links, the net check and recent documents
    coGet("/group", (c: Client, co, _u, _m, personId) => refuse(async () => {
      // Only what this person may see: the companies they are owner or controller of.
      const mine = await g.viewable(c, co.tenantId, personId);
      const all = await g.companies(c, co.tenantId);
      const ids = mine.map((x) => x.id);
      const net = ids.length ? await g.netCheck(c, co.tenantId, ids) : null;
      const links = await g.links(c, co.tenantId);
      return plain({
        total: all.length, companies: mine, viewable: mine, canSeeAll: mine.length === all.length,
        settings: ids.length ? await g.settings(c, co.tenantId) : null,
        links: { ...links, companies: mine, pairs: links.pairs.filter((p) => ids.includes(p.companyId) && ids.includes(p.siblingId)) },
        net, documents: ids.length ? await g.documents(c, co.tenantId, ids, 40) : [], settlements: ids.length ? await g.settlements(c, co.tenantId, ids, 10) : [],
      });
    }));

    // ---- the group view: P&L for a range, balance sheet as of a day, side by side with the combined total
    coGet("/group/view", (c, co, url, _m, personId) => refuse(async () => {
      const all = await g.companies(c, co.tenantId);
      const pick = idList(url.searchParams.get("companies"));
      const ids = pick.length ? pick : all.map((x) => x.id);
      await g.requireGroupRole(c, co.tenantId, personId, ids, "the group view");
      const from = DAY.test(url.searchParams.get("from") ?? "") ? url.searchParams.get("from")! : monthStart();
      const to = DAY.test(url.searchParams.get("to") ?? "") ? url.searchParams.get("to")! : today();
      const asOf = DAY.test(url.searchParams.get("asOf") ?? "") ? url.searchParams.get("asOf")! : to;
      return plain(await g.consolidate(c, co.tenantId, { companyIds: ids, from, to, asOf }));
    }));

    coGet("/group/net", (c, co, _u, _m, personId) => refuse(async () => {
      const mine = await g.viewable(c, co.tenantId, personId);
      need(mine.length, "the inter-company check is for the owner and the companies' controllers");
      return plain(await g.netCheck(c, co.tenantId, mine.map((x) => x.id)));
    }));

    // ---- Home: shown to the owner and this company's controller when a pair is off
    coGet("/group/home", (c, co, _u, _m, personId) => refuse(async () => {
      const mine = await g.viewable(c, co.tenantId, personId);
      if (!mine.some((x) => x.id === co.id) || mine.length < 2) return { show: false, pairs: [], untracked: [] };
      const n = await g.netCheck(c, co.tenantId, mine.map((x) => x.id));
      const pairs = n.pairs.filter((p) => !p.balanced);
      const untracked = n.ties.filter((x) => !x.ties);
      return plain({ show: pairs.length > 0 || untracked.length > 0, pairs, untracked });
    }));

    // ---- where stock can go across companies (the inventory transfer form uses this)
    // Only to someone who may move stock there: the owner, or a controller in this company and that one.
    coGet("/group/locations", (c, co, _u, _m, personId) => refuse(async () => {
      const mine = (await g.viewable(c, co.tenantId, personId)).map((x) => x.id);
      if (!mine.includes(co.id)) return { locations: [] };
      const all = await g.siblingLocations(c, { tenantId: co.tenantId, entityId: co.id, actor: { kind: "user", label: "read" } });
      return { locations: all.filter((l) => mine.includes(String(l.entity_id))) };
    }));

    coPost("/group/settings", async (c, co, a, b) => {
      const all = await g.companies(c, co.tenantId);
      await refuse(() => g.requireGroupRole(c, co.tenantId, a.personId, all.map((x) => x.id), "setting the transfer price"));
      const pct = Number(b.markupPct ?? 0);
      const cap = b.writeoffCap === undefined || b.writeoffCap === null || b.writeoffCap === "" ? null : minor(b.writeoffCap);
      return plain(await refuse(() => g.saveSettings(c, sc(co, a), { basis: str(b.basis, 20), markupBps: Number.isFinite(pct) ? Math.round(pct * 100) : NaN,
        writeoffCapMinor: cap })));
    });

    coPost("/group/links", async (c, co, a) => {
      const all = await g.companies(c, co.tenantId);
      await refuse(() => g.requireGroupRole(c, co.tenantId, a.personId, all.map((x) => x.id), "linking the companies as customers and vendors"));
      return refuse(() => g.ensureLinks(c, sc(co, a)));
    });

    // ---- Bill a sibling company (a service: delivery, warehousing, shared staff)
    coPost("/group/bill", async (c, co, a, b) => {
      const to = uuid(b.to);
      need(to && to !== co.id, "pick the company being billed");
      await refuse(() => g.requireGroupRole(c, co.tenantId, a.personId, [co.id, to], "billing a sister company"));
      return plain(await refuse(() => g.billSibling(c, sc(co, a), { toId: to, description: str(b.description, 300), amountMinor: minor(b.amount),
        locationId: uuid(b.locationId), toLocationId: uuid(b.toLocationId) })));
    });

    // ---- One side only (the other company books its side later)
    coPost("/group/adjust", async (c, co, a, b) => {
      await requireRole(c, co, a, ["controller"], "a one-sided inter-company entry");
      const other = uuid(b.counterparty);
      need(other, "pick the other company");
      return plain(await refuse(() => g.adjust(c, sc(co, a), { counterpartyId: other, kind: str(b.kind, 10), amountMinor: minor(b.amount),
        offsetCode: str(b.offsetCode, 20) || null, reason: str(b.reason, 300) })));
    });

    // ---- Settle a pair: a payment between the two companies, clearing both sides
    coPost("/group/settle", async (c, co, a, b) => {
      const other = uuid(b.with);
      const first = uuid(b.a) ?? co.id;
      need(other && other !== first, "pick the other company");
      await refuse(() => g.requireGroupRole(c, co.tenantId, a.personId, [first, other], "settling between two companies"));
      const amt = b.amount === undefined || b.amount === null || b.amount === "" ? null : minor(b.amount);
      return plain(await refuse(() => g.settle(c, sc(co, a), { aId: first, bId: other, amountMinor: amt, reason: str(b.reason, 300) || null })));
    });
  },
};
