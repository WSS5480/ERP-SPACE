// Drill-downs: GET /api/c/<company>/drill/<list>?page=&<params> returns the
// rows behind a figure on a tile (packages/core/drill.ts). Read-only, scoped
// to the company in the address (companyFor refuses another tenant's), paged,
// and every refusal is a sentence.
import type { ErpModule } from "./kit.ts";
import { ModuleError } from "./kit.ts";
import { rolesOf } from "../actions.ts";
import * as drill from "../../packages/core/drill.ts";

export const module: ErpModule = {
  id: "drill",
  register(kit) {
    kit.coGet("/drill/([a-z0-9-]{1,40})", async (c, co, url, m, personId) => {
      const input: Record<string, string | null> = {};
      for (const [k, v] of url.searchParams) if (k !== "page") input[k] = v;
      const pageRaw = url.searchParams.get("page");
      const page = pageRaw == null || pageRaw === "" ? 1 : Number(pageRaw);
      try {
        return await drill.list(c, co.id, m[2], input, page, personId ? await rolesOf(c, co, personId) : null, personId);
      } catch (e) {
        if (e instanceof drill.DrillError) throw new ModuleError(e.message);
        throw e;
      }
    });
  },
};
