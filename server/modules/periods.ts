// periods -- Books, Periods: the months and their status, the month-end
// checklist and close, reopening (the owner, with a reason), the year-end
// close to retained earnings. packages/core/periods.ts holds the rules.
//
// Who: the owner and controllers see the periods, open a month by hand and
// close months and years. Only the owner reopens a closed month or year.

import type { ErpModule, Client, Company } from "./kit.ts";
import { ModuleError, need, requireRole, str } from "./kit.ts";
import { rolesOf, scopeOf } from "../actions.ts";
import * as P from "../../packages/core/periods.ts";
import { PostingError } from "../../packages/core/posting.ts";

const WHO = ["owner", "controller"];

async function plain<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof P.PeriodError || e instanceof PostingError) throw new ModuleError(e.message); throw e; }
}

async function canSee(c: Client, co: Company, p: string | null) {
  need(p, "pick who you are acting as; the periods are for the owner or a controller");
  const held = await rolesOf(c, co, p!);
  need(held.has("owner") || WHO.some((r) => held.has(r)), "the periods are for the owner or a controller");
}

export const module: ErpModule = {
  id: "periods",
  register({ coGet, coPost }) {
    coGet("/books/periods", async (c, co, _u, _m, p) => { await canSee(c, co, p); return P.list(c, co.id); });
    coGet("/books/periods/([0-9a-fA-F-]{36})/checklist", async (c, co, _u, m, p) => {
      await canSee(c, co, p);
      return plain(() => P.checklist(c, co.tenantId, co.id, m[2]));
    });
    coPost("/books/periods/open", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "opening a month");
      return plain(() => P.openMonth(c, scopeOf(co, a), str(b.month, 10), str(b.reason, 500)));
    });
    coPost("/books/periods/([0-9a-fA-F-]{36})/close", async (c, co, a, b, m) => {
      await requireRole(c, co, a, WHO, "closing a month");
      return plain(() => P.closeMonth(c, scopeOf(co, a), m[2], { override: b.override === true, reason: str(b.reason, 500) }));
    });
    coPost("/books/periods/([0-9a-fA-F-]{36})/reopen", async (c, co, a, b, m) => {
      await requireRole(c, co, a, ["owner"], "reopening a closed month");
      return plain(() => P.reopenMonth(c, scopeOf(co, a), m[2], str(b.reason, 500)));
    });
    coPost("/books/years/close", async (c, co, a, b) => {
      await requireRole(c, co, a, WHO, "closing the year");
      return plain(() => P.closeYear(c, scopeOf(co, a), str(b.fyEnd, 10), { override: b.override === true, reason: str(b.reason, 500) }));
    });
    coPost("/books/years/reopen", async (c, co, a, b) => {
      await requireRole(c, co, a, ["owner"], "reopening a closed year");
      return plain(() => P.reopenYear(c, scopeOf(co, a), str(b.fyEnd, 10), str(b.reason, 500)));
    });
  },
};
