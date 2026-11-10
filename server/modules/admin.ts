// Admin: which services each company shows (Admin, Services) and every
// connection to the outside in one place (Admin, Connections), with the log of
// what was emailed and texted.
//
// Who: the owner and controllers manage services and connections; the web
// admin manages the web store's and marketing's connections. Nobody else sees
// a connection's settings, and nobody ever sees a secret: a GET says "set".

import type { ErpModule, Client, Company, Actor } from "./kit.ts";
import { ModuleError, need, requireRole, requireRoleEverywhere, str, uuid } from "./kit.ts";
import { rolesOf } from "../actions.ts";
import { applyPack } from "../../packages/core/setup.ts";
import * as svc from "../../packages/core/services.ts";
import * as msg from "../../packages/core/messaging.ts";

const MANAGE = ["owner", "controller"];

async function refuse<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) { if (e instanceof svc.ServiceError || e instanceof msg.ConnectionError) throw new ModuleError(e.message); throw e; }
}

async function companiesOf(c: Client, co: Company) {
  return (await c.query<{ id: string; name: string }>(`select id, name from entity where tenant_id = $1 and status <> 'closed' order by name /* unscoped: the client's open companies */`, [co.tenantId])).rows;
}

async function viewerRoles(c: Client, co: Company, p: string | null, doing: string) {
  need(p, `pick who you are acting as; ${doing} is for the owner or a controller`);
  return rolesOf(c, co, p!);
}

/** Connections: owner and controller for every kind; web_admin for the web store's and marketing's. Place 'client' needs it in every company. */
async function mayConnect(c: Client, co: Company, a: Actor, kindId: string, scope: string) {
  const kind = msg.kindById(kindId);
  need(kind, "there is no such connection");
  const roles = kind!.web ? [...MANAGE, "web_admin"] : MANAGE;
  const doing = `setting up ${kind!.name.toLowerCase()}`;
  if (scope === "client") await requireRoleEverywhere(c, co, a, roles, `${doing} for the whole client`);
  else await requireRole(c, co, a, roles, doing);
  return { place: { tenantId: co.tenantId, entityId: scope === "client" ? null : co.id }, kind: kind! };
}

export const module: ErpModule = {
  id: "admin",
  register({ coGet, coPost }) {
    // ------------------------------------------------------------ services
    coGet("/admin/services", async (c, co, _u, _m, p) => {
      const r = await viewerRoles(c, co, p, "Services");
      need(r.has("owner") || r.has("controller"), "Services is for the owner or a controller");
      return svc.servicesView(c, co.id, co.tenantId);
    });

    coPost("/admin/services/switch", async (c, co, a, b) => refuse(async () => {
      const id = str(b.service, 30);
      need(svc.serviceById(id), "pick one of the services");
      const all = b.allCompanies === true;
      if (all) await requireRoleEverywhere(c, co, a, MANAGE, "switching a service for every company");
      else await requireRole(c, co, a, MANAGE, "switching a service on or off");
      const ids = all ? (await companiesOf(c, co)).map((x) => x.id) : [co.id];
      return { ...(await svc.setService(c, ids, id, b.enabled === true, a.personName)), state: await svc.effectiveServices(c, co.id) };
    }));

    // What a preset would switch off that still has open records; the screen shows it before asking.
    coGet("/admin/services/preset-check", async (c, co, u, _m, p) => refuse(async () => {
      const r = await viewerRoles(c, co, p, "Services");
      need(r.has("owner") || r.has("controller"), "Services is for the owner or a controller");
      const targets = u.searchParams.get("all") === "1" ? await companiesOf(c, co) : [{ id: co.id, name: co.name }];
      return { open: await svc.presetCheck(c, targets, String(u.searchParams.get("preset") ?? "").slice(0, 30)) };
    }));

    coPost("/admin/services/preset", async (c, co, a, b) => refuse(async () => {
      const id = str(b.preset, 30);
      need(svc.PRESETS.some((p) => p.id === id), "pick one of the presets");
      const all = b.allCompanies === true;
      const held = all ? (await requireRoleEverywhere(c, co, a, MANAGE, "applying a preset to every company"), await rolesOf(c, co, a.personId))
        : await requireRole(c, co, a, MANAGE, "applying a preset");
      const targets = all ? await companiesOf(c, co) : [{ id: co.id, name: co.name }];
      const open = await svc.presetCheck(c, targets, id);
      need(!open.length || b.confirm === true,
        `This preset switches off services that still have open records: ${open.map((o) => `${o.name} (${o.count} ${o.what}${targets.length > 1 ? `, ${o.company}` : ""})`).join("; ")}. Nothing is lost, but those screens hide. Confirm to go ahead.`);
      const pack = svc.presetPack(id);
      const notes: string[] = [];
      for (const t of targets) {
        // The pack adds accounts, pick lists and defaults (only ever adds); only the owner applies one.
        if (pack && held.has("owner")) await applyPack(c, { tenantId: co.tenantId, entityId: t.id, actor: { kind: "user", id: a.personId, label: a.personName } }, pack.id, a.personName);
        await svc.applyPresetSwitches(c, t.id, id, a.personName);
      }
      if (pack && !held.has("owner")) notes.push(`The switches are set. The ${pack.name.toLowerCase()} accounts and defaults were not added: applying a setup pack is the owner's.`);
      return { preset: id, companies: targets.length, notes, openHidden: open, state: await svc.effectiveServices(c, co.id) };
    }));

    coPost("/admin/services/layout", async (c, co, a, b) => refuse(async () => {
      await requireRole(c, co, a, ["owner"], "choosing single store or several stores");
      return { layout: await svc.setLayout(c, co.id, str(b.mode, 10), a.personName) };
    }));

    // --------------------------------------------------------- connections
    coGet("/admin/connections", async (c, co, _u, _m, p) => {
      const r = await viewerRoles(c, co, p, "Connections");
      need(r.has("owner") || r.has("controller") || r.has("web_admin"), "Connections is for the owner, a controller or the web admin");
      return { kinds: await msg.connectionsView(c, co.tenantId, co.id, r), secretKey: !!msg.msgEnv().secretKey };
    });

    coPost("/admin/connections/save", async (c, co, a, b) => refuse(async () => {
      const scope = str(b.scope, 10) === "client" ? "client" : "company";
      const { place } = await mayConnect(c, co, a, str(b.kind, 30), scope);
      const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {});
      return msg.saveConnection(c, place, str(b.kind, 30), str(b.provider, 30), obj(b.settings), obj(b.secrets), { personId: a.personId, personName: a.personName, fromEntityId: co.id });
    }));

    coPost("/admin/connections/test", async (c, co, a, b) => refuse(async () => {
      const scope = str(b.scope, 10) === "client" ? "client" : "company";
      const { place } = await mayConnect(c, co, a, str(b.kind, 30), scope);
      return msg.testConnection(c, place, co.id, str(b.kind, 30), str(b.to, 200), { personId: a.personId, personName: a.personName, fromEntityId: co.id });
    }));

    coPost("/admin/connections/off", async (c, co, a, b) => refuse(async () => {
      const scope = str(b.scope, 10) === "client" ? "client" : "company";
      const { place } = await mayConnect(c, co, a, str(b.kind, 30), scope);
      return msg.turnOff(c, place, str(b.kind, 30), { personId: a.personId, personName: a.personName, fromEntityId: co.id });
    }));

    // ---------------------------------------------------------- message log
    coGet("/admin/messages", async (c, co, _u, _m, p) => {
      const r = await viewerRoles(c, co, p, "the message log");
      need(r.has("owner") || r.has("controller") || r.has("web_admin"), "the message log is for the owner, a controller or the web admin");
      // The web admin sees only what the web store and marketing sent.
      const webOnly = !r.has("owner") && !r.has("controller");
      return { webOnly, messages: await msg.messageLog(c, co.id, 200, webOnly ? msg.WEB_PURPOSES : null), email: await msg.isConnected(c, co.id, "email"), sms: await msg.isConnected(c, co.id, "sms") };
    });

    coPost("/admin/messages/([0-9a-fA-F-]{36})/resend", async (c, co, a, _b, m) => refuse(async () => {
      await requireRole(c, co, a, MANAGE, "sending a message again");
      const id = uuid(m[2]);
      need(id, "there is no such message");
      return msg.resend(c, co.id, id!, { personId: a.personId, personName: a.personName, fromEntityId: co.id });
    }));
  },
};
