// Vendor files (Admin, Connections, Vendor files tab; also the vendor's card
// in Catalog, Vendors): SFTP and HTTPS pulls and vendor email, carrying
// catalogs, prices, inventory and EDI documents. See packages/core/vendor_files.ts.
//
// Who: the owner, a controller or a buyer reads and sets them up; trusting a
// changed SFTP server key is the owner's alone. Secrets are write-only: a
// read says which are set, never what they are.

import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, str, uuid, lookOnly } from "./kit.ts";
import { rolesOf, scopeOf } from "../actions.ts";
import * as vf from "../../packages/core/vendor_files.ts";
import { TransportError, HostKeyError } from "../../packages/core/transports.ts";
import { secretKeyFromEnv, FeedError } from "../../packages/core/vendor_feeds.ts";

const MANAGE = ["owner", "controller", "buyer"];
const ID = "([0-9a-fA-F-]{36})";

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof vf.VendorFilesError || e instanceof TransportError || e instanceof HostKeyError || e instanceof FeedError) throw new ModuleError(e.message);
    throw e;
  }
}

async function mayRead(c: Client, co: Company, p: string | null) {
  need(p, "pick who you are acting as; vendor files are for the owner, a controller or a buyer");
  const r = await rolesOf(c, co, p!);
  need(r.has("owner") || MANAGE.some((x) => r.has(x)), "vendor files are for the owner, a controller or a buyer");
}

const secretsOf = (b: Record<string, unknown>) => Object.fromEntries(Object.entries((b.secrets && typeof b.secrets === "object" ? b.secrets : {}) as Record<string, unknown>)
  .map(([k, v]) => [k, v === null ? null : String(v ?? "")]));

export const module: ErpModule = {
  id: "vendor_files",
  register({ coGet, coPost }) {
    coGet("/vendor-files", async (c, co, _u, _m, p) => { await mayRead(c, co, p); return vf.overview(c, co, !lookOnly(c)); });
    coGet(`/vendor-files/${ID}`, async (c, co, url, m, p) => {
      await mayRead(c, co, p);
      const st = str(url.searchParams.get("status"), 20);
      return refuse(() => vf.detail(c, co.id, m[2], ["quarantined", "applied", "ignored", "parsed", "received"].includes(st) ? st : null));
    });
    coGet(`/vendor-files/vendor/${ID}`, async (c, co, _u, m, p) => { await mayRead(c, co, p); return refuse(() => vf.vendorMail(c, co, m[2], !lookOnly(c))); });

    coPost("/vendor-files/save", async (c, co, a, b) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "setting up vendor files");
      const d = (b.connection && typeof b.connection === "object" ? b.connection : {}) as vf.Draft;
      if (d.id) need(uuid(d.id), "no such vendor connection");
      return { id: await vf.saveConnection(c, scopeOf(co, a), d, secretsOf(b), secretKeyFromEnv()) };
    }));
    coPost(`/vendor-files/${ID}/status`, async (c, co, a, b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "turning a vendor connection on or off");
      return vf.setStatus(c, scopeOf(co, a), m[2], str(b.status, 10));
    }));
    coPost(`/vendor-files/${ID}/test`, async (c, co, a, _b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "testing a vendor connection");
      return vf.testConnection(c, scopeOf(co, a), m[2], a.personName);
    }));
    coPost(`/vendor-files/${ID}/run`, async (c, co, a, _b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "running a vendor connection");
      return vf.runNow(c, scopeOf(co, a), m[2]);
    }));
    coPost(`/vendor-files/${ID}/trust-key`, async (c, co, a, b, m) => refuse(async () => {
      await requireRole(c, co, a, ["owner"], "trusting a changed SFTP server key");
      return vf.trustKey(c, scopeOf(co, a), m[2], str(b.fingerprint, 80), a.personName);
    }));
    coPost(`/vendor-files/files/${ID}/dismiss`, async (c, co, a, b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "setting a quarantined file aside");
      return vf.dismissFile(c, scopeOf(co, a), m[2], str(b.reason, 500));
    }));
    coPost(`/vendor-files/held/${ID}/assign`, async (c, co, a, b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "assigning held vendor mail");
      return vf.assignHeld(c, scopeOf(co, a), m[2], { connectionId: uuid(b.connectionId), feedId: uuid(b.feedId) }, b.addSender === true, a.personName);
    }));
    coPost(`/vendor-files/held/${ID}/set-aside`, async (c, co, a, b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "setting held vendor mail aside");
      return vf.setAsideHeld(c, scopeOf(co, a), m[2], str(b.reason, 500), a.personName);
    }));
  },
};

export type { Actor };
