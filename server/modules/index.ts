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
import { module as edi } from "./edi.ts";
import { module as wms } from "./wms.ts";
import { module as ops } from "./ops.ts";
import { module as lots } from "./lots.ts";
import { module as trade } from "./trade.ts";
import { module as configurator } from "./configurator.ts";
import { module as admin } from "./admin.ts";
import { module as onboarding } from "./onboarding.ts";
import { module as periods } from "./periods.ts";
import { module as jobs } from "./jobs.ts";
import { module as drill } from "./drill.ts";
import { module as vendorFiles } from "./vendor_files.ts";

export const MODULES: ErpModule[] = [setup, catalog, purchasing, inventory, pos, ar, workforce, fleet, shop, chart, crm, service, reports, group, edi, wms, ops, lots, trade, configurator, admin, vendorFiles, onboarding, drill, periods, jobs];
