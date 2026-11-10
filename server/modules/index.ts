// Every retail module, in load order. A module is one file here, one migration
// range in db/migrations, one script in server/ui, and checks in scripts/smoke.
// Adding a module is one line in this list.
import type { ErpModule } from "./kit.ts";
import { module as setup } from "./setup.ts";
import { module as catalog } from "./catalog.ts";
import { module as purchasing } from "./purchasing.ts";
import { module as inventory } from "./inventory.ts";
import { module as pos } from "./pos.ts";
import { module as ar } from "./ar.ts";
import { module as workforce } from "./workforce.ts";
import { module as fleet } from "./fleet.ts";
import { module as shop } from "./shop.ts";
import { module as chart } from "./chart.ts";
import { module as crm } from "./crm.ts";
import { module as service } from "./service.ts";
import { module as reports } from "./reports.ts";
import { module as group } from "./group.ts";

export const MODULES: ErpModule[] = [setup, catalog, purchasing, inventory, pos, ar, workforce, fleet, shop, chart, crm, service, reports, group];
