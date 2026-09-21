// How data gets in, for every source, over every channel.
//
// One pipeline, five channels, and a handler per kind of data. A new source
// is a registry row plus a handler; a new bank is a connection row. Nothing
// below knows what a bank statement is.
//
// The channels split two ways. Pull channels (sftp, api) go and look on a
// schedule. Push channels (manual_upload, email, webhook) are handed
// something and have to decide whether to believe it. That difference is
// where the security lives: a pull channel trusts a host we configured, a
// push channel trusts nobody until it checks.
//
// The network itself is behind a transport interface. That is deliberate --
// the parts worth testing are the listing, the globbing, the de-duplication,
// the quarantine path and the health accounting, and all of those are real
// here. Wiring an actual SSH or HTTP client is one object, supplied at the
// edge.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { type Client, type Scope, q, one, audit } from "./db.ts";

export type Channel = "manual_upload" | "sftp" | "email" | "api" | "webhook";
export type Mode = "pull" | "push";

export type Connection = {
  id: string;
  tenant_id: string;
  entity_id: string | null;
  source_code: string;
  channel: Channel;
  name: string;
  bank_account_id: string | null;
  config: Record<string, unknown>;
  credential_ref: string | null;
  schedule_cron: string | null;
  allowed_senders: string[] | null;
  status: string;
  consecutive_failures: number;
};

/** One thing that showed up, whatever carried it. */
export type Arrival = {
  origin: string;
  originDetail?: Record<string, unknown>;
  bytes: Buffer;
  contentType?: string;
  format?: string;
};

/** What a push channel was handed, before we decide to believe it. */
export type Offered = Arrival & {
  sender?: string;
  signature?: string;
  deliveryId?: string;
};

// ---------------------------------------------------------------- transports

export interface SftpTransport {
  list(opts: { host: string; port?: number; path: string; glob?: string; credentialRef: string }):
    Promise<{ name: string; size: number; modifiedAt: string }[]>;
  get(opts: { host: string; port?: number; path: string; name: string; credentialRef: string }):
    Promise<Buffer>;
  archive?(opts: { host: string; port?: number; path: string; name: string; to: string; credentialRef: string }):
    Promise<void>;
}

export interface HttpTransport {
  get(opts: { endpoint: string; query?: Record<string, string>; credentialRef: string }):
    Promise<{ status: number; body: Buffer; contentType?: string }>;
}

export type Transports = { sftp?: SftpTransport; http?: HttpTransport };

const NO_TRANSPORT = (kind: string) => () => {
  throw new Error(
    `no ${kind} transport configured. The pipeline is wired; supply a client at the edge.`
  );
};

// ------------------------------------------------------------------ handlers

export type Parsed = {
  /** normalized rows, meaningful only to the handler that produced them */
  rows: unknown[];
  /** what format the parser decided it was looking at */
  format: string;
  /** anything worth showing a person about this file */
  note?: string;
};

export interface SourceHandler {
  source: string;
  /** Turn bytes into rows, or throw with a reason a person can act on. */
  parse(bytes: Buffer, conn: Connection, arrival: Arrival): Promise<Parsed> | Parsed;
  /** Put the rows where they belong. Returns how many landed. */
  apply(c: Client, scope: Scope, parsed: Parsed, fileId: string, conn: Connection):
    Promise<number>;
}

const HANDLERS = new Map<string, SourceHandler>();

export function registerHandler(h: SourceHandler): void {
  HANDLERS.set(h.source, h);
}

export function handlerFor(source: string): SourceHandler | undefined {
  return HANDLERS.get(source);
}

/** Sources declared in the database but with nobody to consume them yet. */
export async function unhandledSources(c: Client): Promise<string[]> {
  const rows = await q<{ code: string }>(
    c,
    `select code from ingest_source
      where direction = 'inbound' and is_active
      order by code /* unscoped: the source catalogue is not per-entity */`
  );
  return rows.map((r) => r.code).filter((code) => !HANDLERS.has(code));
}

// ------------------------------------------------------------------ channels

export const sha256 = (b: Buffer): string => createHash("sha256").update(b).digest("hex");

/**
 * A sender is allowed if it matches an entry exactly, or matches a
 * `@domain.com` entry. Case-insensitive, whitespace-tolerant, because real
 * mail headers are neither.
 */
export function senderAllowed(sender: string | undefined, allowed: string[] | null): boolean {
  if (!sender) return false;
  const s = sender.trim().toLowerCase();
  const addr = s.includes("<") ? s.slice(s.lastIndexOf("<") + 1, s.lastIndexOf(">")) : s;
  for (const raw of allowed ?? []) {
    const a = raw.trim().toLowerCase();
    if (!a) continue;
    if (a.startsWith("@")) {
      if (addr.endsWith(a)) return true;
    } else if (addr === a) {
      return true;
    }
  }
  return false;
}

/** Constant-time HMAC check for webhook deliveries. */
export function signatureValid(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.replace(/^sha256=/, "").trim(), "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Glob with `*` and `?` only, which is all any bank has ever needed. */
export function globMatch(name: string, pattern?: string): boolean {
  if (!pattern) return true;
  const rx = new RegExp(
    "^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$",
    "i"
  );
  return rx.test(name);
}

export class ChannelRefused extends Error {}

/**
 * Collect from a pull channel, or validate and accept from a push one.
 * Throws ChannelRefused when a push channel does not believe what it was
 * handed -- that is a rejection at the door, not a quarantine, because
 * nothing about it should be stored.
 */
export async function collect(
  conn: Connection,
  offered: Offered[] = [],
  transports: Transports = {},
  secrets: (ref: string) => string = () => ""
): Promise<Arrival[]> {
  switch (conn.channel) {
    case "manual_upload":
      return offered.map(({ origin, originDetail, bytes, contentType, format }) => ({
        origin,
        originDetail: { ...originDetail, channel: "manual_upload" },
        bytes,
        contentType,
        format,
      }));

    case "email": {
      const out: Arrival[] = [];
      for (const o of offered) {
        if (!senderAllowed(o.sender, conn.allowed_senders)) {
          throw new ChannelRefused(
            `${o.sender ?? "an unidentified sender"} is not on the allow list for ${conn.name}`
          );
        }
        out.push({
          origin: o.origin,
          originDetail: { ...o.originDetail, sender: o.sender, channel: "email" },
          bytes: o.bytes,
          contentType: o.contentType,
          format: o.format,
        });
      }
      return out;
    }

    case "webhook": {
      const secret = conn.credential_ref ? secrets(conn.credential_ref) : "";
      const out: Arrival[] = [];
      for (const o of offered) {
        if (secret && !signatureValid(o.bytes, o.signature, secret)) {
          throw new ChannelRefused(`signature did not verify for ${conn.name}`);
        }
        out.push({
          origin: o.origin || o.deliveryId || "webhook",
          originDetail: { ...o.originDetail, deliveryId: o.deliveryId, channel: "webhook" },
          bytes: o.bytes,
          contentType: o.contentType ?? "application/json",
          format: o.format ?? "json",
        });
      }
      return out;
    }

    case "sftp": {
      const t = conn.config as Record<string, string>;
      const sftp = transports.sftp;
      if (!sftp) NO_TRANSPORT("sftp")();
      const listed = await sftp!.list({
        host: t.host,
        port: t.port ? Number(t.port) : undefined,
        path: t.path,
        glob: t.glob,
        credentialRef: conn.credential_ref!,
      });
      const out: Arrival[] = [];
      for (const f of listed) {
        if (!globMatch(f.name, t.glob)) continue;
        const bytes = await sftp!.get({
          host: t.host,
          port: t.port ? Number(t.port) : undefined,
          path: t.path,
          name: f.name,
          credentialRef: conn.credential_ref!,
        });
        out.push({
          origin: f.name,
          originDetail: { path: t.path, host: t.host, modifiedAt: f.modifiedAt, channel: "sftp" },
          bytes,
          format: t.format,
        });
      }
      return out;
    }

    case "api": {
      const t = conn.config as Record<string, string>;
      const http = transports.http;
      if (!http) NO_TRANSPORT("http")();
      const res = await http!.get({
        endpoint: t.endpoint,
        query: (conn.config.query as Record<string, string>) ?? undefined,
        credentialRef: conn.credential_ref!,
      });
      if (res.status >= 400) {
        throw new Error(`${t.endpoint} answered ${res.status}`);
      }
      return [
        {
          origin: `${t.endpoint} @ ${new Date().toISOString()}`,
          originDetail: { endpoint: t.endpoint, status: res.status, channel: "api" },
          bytes: res.body,
          contentType: res.contentType,
          format: t.format ?? "json",
        },
      ];
    }
  }
}

// ------------------------------------------------------------------ the run

export type RunResult = {
  runId: string;
  seen: number;
  fresh: number;
  failed: number;
  outcome: "ok" | "partial" | "failed";
  quarantined: { origin: string; reason: string }[];
};

export async function loadConnection(c: Client, id: string): Promise<Connection> {
  return await one<Connection>(
    c,
    `select id, tenant_id, entity_id, source_code, channel, name, bank_account_id,
            config, credential_ref, schedule_cron, allowed_senders, status,
            consecutive_failures
       from connection where id = $1 /* unscoped: a connection may be tenant-wide */`,
    [id]
  );
}

/**
 * One attempt at one connection. Records what it saw, what was new, and what
 * it could not understand. A file that fails to parse is quarantined with the
 * reason; it is never silently dropped and never retried into a loop.
 */
export async function ingest(
  c: Client,
  scope: Scope,
  connectionId: string,
  opts: {
    trigger?: "schedule" | "manual" | "webhook" | "retry";
    offered?: Offered[];
    transports?: Transports;
    secrets?: (ref: string) => string;
    storage?: (a: Arrival, digest: string) => string;
  } = {}
): Promise<RunResult> {
  const conn = await loadConnection(c, connectionId);
  if (conn.status !== "active") {
    throw new Error(`${conn.name} is ${conn.status}, not active`);
  }

  const run = await one<{ id: string }>(
    c,
    `insert into ingest_run (connection_id, trigger, actor_kind, ran_by)
     values ($1, $2, $3, $4) returning id
     /* unscoped: keyed by connection, which carries the entity */`,
    [connectionId, opts.trigger ?? "manual", scope.actor.kind, scope.actor.id ?? null]
  );

  const quarantined: RunResult["quarantined"] = [];
  let seen = 0;
  let fresh = 0;
  let failed = 0;

  try {
    const arrivals = await collect(conn, opts.offered ?? [], opts.transports ?? {}, opts.secrets);
    seen = arrivals.length;

    for (const a of arrivals) {
      const digest = sha256(a.bytes);

      const inserted = await q<{ id: string }>(
        c,
        `insert into inbound_file
           (tenant_id, connection_id, run_id, source_code, origin, origin_detail,
            byte_size, sha256, content_type, format, storage_ref)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (connection_id, sha256) do nothing
         returning id /* unscoped: connection carries the entity */`,
        [
          conn.tenant_id,
          conn.id,
          run.id,
          conn.source_code,
          a.origin,
          JSON.stringify(a.originDetail ?? {}),
          a.bytes.byteLength,
          digest,
          a.contentType ?? null,
          a.format ?? null,
          opts.storage ? opts.storage(a, digest) : null,
        ]
      );

      // Already had these exact bytes on this connection. Overlapping
      // statement windows are normal, not an error.
      if (inserted.length === 0) continue;
      fresh++;
      const fileId = inserted[0].id;

      const handler = HANDLERS.get(conn.source_code);
      if (!handler) {
        await quarantine(c, fileId, `no handler is registered for ${conn.source_code} yet`);
        quarantined.push({ origin: a.origin, reason: "no handler" });
        failed++;
        continue;
      }

      try {
        const parsed = await handler.parse(a.bytes, conn, a);
        await q(
          c,
          `update inbound_file
              set status = 'parsed', parsed_at = now(), rows_parsed = $2, format = $3
            where id = $1 /* unscoped: file id is unique */`,
          [fileId, parsed.rows.length, parsed.format]
        );
        const applied = await handler.apply(c, scope, parsed, fileId, conn);
        await q(
          c,
          `update inbound_file set status = 'applied', applied_at = now(), rows_parsed = $2
            where id = $1 /* unscoped: file id is unique */`,
          [fileId, applied]
        );
        await audit(c, scope, {
          table: "inbound_file",
          rowId: fileId,
          action: "transition",
          after: { status: "applied", rows: applied, format: parsed.format },
          sourceRef: a.origin,
        });
      } catch (e) {
        const reason = e instanceof Error ? e.message : String(e);
        await quarantine(c, fileId, reason);
        quarantined.push({ origin: a.origin, reason });
        failed++;
      }
    }

    const outcome: RunResult["outcome"] = failed === 0 ? "ok" : fresh > failed ? "partial" : "failed";

    await q(
      c,
      `update ingest_run
          set finished_at = now(), files_seen = $2, files_new = $3,
              files_failed = $4, outcome = $5
        where id = $1 /* unscoped: run id is unique */`,
      [run.id, seen, fresh, failed, outcome]
    );

    await q(
      c,
      `update connection
          set last_attempt_at = now(),
              last_success_at = now(),
              last_error = null,
              consecutive_failures = 0
        where id = $1 /* unscoped: connection id is unique */`,
      [connectionId]
    );

    return { runId: run.id, seen, fresh, failed, outcome, quarantined };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await q(
      c,
      `update ingest_run set finished_at = now(), outcome = 'failed', error = $2
        where id = $1 /* unscoped: run id is unique */`,
      [run.id, msg]
    );
    await q(
      c,
      `update connection
          set last_attempt_at = now(), last_error = $2,
              consecutive_failures = consecutive_failures + 1,
              status = case when consecutive_failures + 1 >= 5 then 'failed' else status end
        where id = $1 /* unscoped: connection id is unique */`,
      [connectionId, msg]
    );
    throw e;
  }
}

async function quarantine(c: Client, fileId: string, reason: string): Promise<void> {
  await q(
    c,
    `update inbound_file
        set status = 'quarantined', quarantine_reason = $2
      where id = $1 /* unscoped: file id is unique */`,
    [fileId, reason.slice(0, 500)]
  );
}

/** Clear a quarantined file once a person has decided what it was. */
export async function releaseQuarantine(
  c: Client,
  scope: Scope,
  fileId: string,
  disposition: "ignored" | "received",
  why: string
): Promise<void> {
  if (!why.trim()) throw new Error("clearing a quarantine needs a reason");
  await q(
    c,
    `update inbound_file set status = $2, quarantine_reason = null
      where id = $1 and status = 'quarantined' /* unscoped: file id is unique */`,
    [fileId, disposition]
  );
  await audit(c, scope, {
    table: "inbound_file",
    rowId: fileId,
    action: "transition",
    after: { status: disposition },
    reason: why,
  });
}

// ------------------------------------------------------------------ the view

export async function health(c: Client, entityId: string) {
  return await q(
    c,
    `select name, source_code, channel, verdict, days_since_success, consecutive_failures, last_error
       from connection_health
      where entity_id = $1 or entity_id is null
      order by case verdict when 'failing' then 0 when 'never run' then 1
                            when 'stale' then 2 else 3 end, name`,
    [entityId]
  );
}

export async function openQuarantine(c: Client, entityId: string) {
  return await q(
    c,
    `select connection_name, source_code, channel, origin, quarantine_reason, days_open
       from quarantined_files where entity_id = $1 order by days_open desc`,
    [entityId]
  );
}
