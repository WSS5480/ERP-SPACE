// jobs -- Setup, Scheduled jobs: what the scheduler runs, when it last ran and
// runs next, and how it went for this company (an owner never sees another
// company's notes). Operators see every company's in the Operator console.

import type { ErpModule } from "./kit.ts";
import { need } from "./kit.ts";
import { rolesOf } from "../actions.ts";
import { jobsView, runsView, runDetail, jobById } from "../scheduler.ts";

export const module: ErpModule = {
  id: "jobs",
  register({ coGet }) {
    const owner = async (c: Parameters<Parameters<typeof coGet>[1]>[0], co: Parameters<Parameters<typeof coGet>[1]>[1], p: string | null) => {
      need(p, "pick who you are acting as; scheduled jobs are the owner's to see");
      need((await rolesOf(c, co, p!)).has("owner"), "scheduled jobs are the owner's to see");
    };
    coGet("/admin/jobs", async (c, co, url, _m, p) => {
      await owner(c, co, p);
      const job = url.searchParams.get("job");
      return { jobs: await jobsView(c, co.id), runs: await runsView(c, co.id, job && jobById(job) ? job : null, 30) };
    });
    coGet("/admin/jobs/runs/([0-9a-fA-F-]{36})", async (c, co, _u, m, p) => {
      await owner(c, co, p);
      const r = await runDetail(c, m[2], co.id);
      need(r, "no such run");
      return r;
    });
  },
};
