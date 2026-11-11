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
// The network itself is behind a transport interface, so a check can hand in
// its own. With none handed in, a pull uses the real clients in
// transports.ts: SFTP (ssh2) with the server key pinned on the first Test,
// and HTTPS through the vendor feeds' checked caller. A connection's password,
// private key or token is sealed in connection_secret (AES-256-GCM under
// ERP_SECRET_KEY, write-only), or read from ERP_SECRET_<REF> when its
// credential_ref is secret://... (the older way).
//
// An SFTP pull lists the folder, skips files already taken (same name, size
// and time), leaves files over the size cap on the server (quarantined by
// name, so a person sees them), and only after the run commits moves or
// deletes what it took, when the connection says to (default: leave them).

import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "node:crypto";
import { type Client, type Scope, q, one, audit, afterCommit, tx } from "./db.ts";
import {
  openSftp, httpGet, liveNetEnv, globAny, sftpPort, HostKeyError, TransportError, DEFAULT_MAX_MB, MAX_MB,
  type NetEnv, type SftpSession, type SftpTarget, type HttpAuth,
} from "./transports.ts";
export { HostKeyError, TransportError } from "./transports.ts";
import { globTest } from "./filekit.ts";

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
  /** set when the file was seen but not taken (over the size cap): stored by name, quarantined with this reason */
  refused?: string;
};

/** What a push channel was handed, before we decide to believe it. */
export type Offered = Arrival & {
  sender?: string;
  signature?: string;
  deliveryId?: string;
};

// ---------------------------------------------------------------- transports

export interface SftpTransport {
  list(opts: { host: string; port?: number; path: string; glob?: string; globs?: string[]; credentialRef: string }):
    Promise<{ name: string; size: number; modifiedAt: string }[]>;
  get(opts: { host: string; port?: number; path: string; name: string; credentialRef: string; maxBytes?: number }):
    Promise<Buffer>;
  archive?(opts: { host: string; port?: number; path: string; name: string; to: string; credentialRef: string }):
    Promise<void>;
  remove?(opts: { host: string; port?: number; path: string; name: string; credentialRef: string }): Promise<void>;
  close?(): void;
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
  return globTest(name, pattern);
}

export class ChannelRefused extends Error {}

/** What the pipeline knows that a channel may use: files already taken, the size cap, a person's say-so. */
export type CollectHints = {
  /** an SFTP file already taken on this connection (same name, size and time): not downloaded again */
  known?: (f: { name: string; size: number; modifiedAt: string }) => boolean;
  onKnown?: (name: string) => void;
  maxBytes?: number;
  /** a person assigned held mail to this connection: the allow list was their decision */
  vouched?: boolean;
};

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
  secrets: (ref: string) => string = () => "",
  hints: CollectHints = {}
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
        if (!hints.vouched && !senderAllowed(o.sender, conn.allowed_senders)) {
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
      const globs = Array.isArray(conn.config.globs) ? (conn.config.globs as string[]) : t.glob ? [t.glob] : [];
      const sftp = transports.sftp;
      if (!sftp) NO_TRANSPORT("sftp")();
      const at = { host: t.host, port: t.port ? Number(t.port) : undefined, path: t.path, credentialRef: conn.credential_ref! };
      try {
        const listed = await sftp!.list({ ...at, glob: t.glob, globs });
        const out: Arrival[] = [];
        for (const f of listed) {
          if (!globAny(f.name, globs)) continue;
          const detail = { path: t.path, host: t.host, modifiedAt: f.modifiedAt, size: f.size, channel: "sftp" };
          if (hints.known?.(f)) { hints.onKnown?.(f.name); continue; }
          if (hints.maxBytes && f.size > hints.maxBytes) {
            out.push({ origin: f.name, originDetail: detail, bytes: Buffer.alloc(0), format: t.format,
              refused: `${f.name} is ${(f.size / 1048576).toFixed(1)} MB, over this connection's ${Math.round(hints.maxBytes / 1048576)} MB limit; it was left on the server` });
            continue;
          }
          let bytes: Buffer;
          try { bytes = await sftp!.get({ ...at, name: f.name, maxBytes: hints.maxBytes }); }
          catch (e) {
            if (e instanceof TransportError && /over \d+ MB/.test(e.message)) {
              out.push({ origin: f.name, originDetail: detail, bytes: Buffer.alloc(0), format: t.format, refused: e.message });
              continue;
            }
            throw e;
          }
          out.push({ origin: f.name, originDetail: detail, bytes, format: t.format });
        }
        return out;
      } finally {
        sftp!.close?.();
      }
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
      if (!res.body.length) return [];
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
    /** a person assigned held mail here; the sender check was theirs */
    vouched?: boolean;
  } = {}
): Promise<RunResult> {
  const conn = await loadConnection(c, connectionId);
  if (conn.status !== "active") {
    throw new Error(`${conn.name} is ${conn.status}, not active`);
  }
  // Vendor files bring their own reader; load it on first use (the scheduler imports nothing else).
  if (conn.source_code === "vendor_files" && !HANDLERS.has("vendor_files")) await import("./vendor_files.ts");

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
  const taken: string[] = [];

  try {
    let transports = opts.transports;
    let live = false;
    if (!transports && (conn.channel === "sftp" || conn.channel === "api")) {
      transports = await liveTransportsFor(c, conn);
      live = true;
    }
    const maxBytes = maxBytesOf(conn);
    const hints: CollectHints = { maxBytes, vouched: opts.vouched, onKnown: (n) => taken.push(n) };
    if (conn.channel === "sftp") {
      const had = await q<{ k: string; status: string }>(c, `
        select origin || '|' || byte_size || '|' || coalesce(origin_detail->>'modifiedAt', '') k, status
          from inbound_file where connection_id = $1 and not (origin_detail ? 'refused')
          /* unscoped: keyed by connection, which carries the entity */`, [conn.id]);
      const known = new Map(had.map((x) => [x.k, x.status]));
      // Known and done with (applied, or set aside by a person): moved or deleted like any taken file.
      // Known and still quarantined: not downloaded again, and left on the server -- no copy is kept here.
      const seenAs = new Map<string, string>();
      hints.known = (f) => {
        const st = f.modifiedAt ? known.get(`${f.name}|${f.size}|${f.modifiedAt}`) : undefined;
        if (st) seenAs.set(f.name, st);
        return !!st;
      };
      hints.onKnown = (n) => { const st = seenAs.get(n); if (st === "applied" || st === "ignored") taken.push(n); };
    }
    const arrivals = await collect(conn, opts.offered ?? [], transports ?? {}, opts.secrets, hints);
    seen = arrivals.length;

    for (const a of arrivals) {
      if (a.refused) {
        // Seen, not taken: kept by name so a person sees it, never downloaded.
        const d = a.originDetail ?? {};
        const digest = sha256(Buffer.from(`refused|${a.origin}|${d.size ?? ""}|${d.modifiedAt ?? ""}`));
        const r = await q<{ id: string }>(c, `
          insert into inbound_file (tenant_id, connection_id, run_id, source_code, origin, origin_detail, byte_size, sha256, format, status, quarantine_reason)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'quarantined',$10)
          on conflict (connection_id, sha256) do nothing returning id /* unscoped: connection carries the entity */`,
          [conn.tenant_id, conn.id, run.id, conn.source_code, a.origin, JSON.stringify({ ...d, refused: true }), Number(d.size ?? 0), digest, a.format ?? null, a.refused.slice(0, 500)]);
        if (r.length) { fresh++; failed++; quarantined.push({ origin: a.origin, reason: a.refused }); }
        continue;
      }
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
      // statement windows are normal, not an error. Taken off the server only
      // when that copy was applied or set aside; a quarantined one stays there.
      if (inserted.length === 0) {
        const prior = (await q<{ status: string }>(c, `select status from inbound_file where connection_id = $1 and sha256 = $2 /* unscoped: connection carries the entity */`, [conn.id, digest]))[0];
        if (prior && (prior.status === "applied" || prior.status === "ignored")) taken.push(a.origin);
        continue;
      }
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
        taken.push(a.origin);
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

    // Move or delete on the server only once the run is committed, so a file is never lost.
    const after = String(conn.config.after ?? "leave");
    if (live && conn.channel === "sftp" && (after === "move" || after === "delete") && taken.length) {
      const names = [...new Set(taken)];
      afterCommit(c, () => track(postRun(conn, run.id, names)));
    }

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

// ------------------------------------------------------- the real clients

let netEnvFn: () => Promise<NetEnv> = liveNetEnv;
/** Checks hand in their own network environment (allow-lists, a test CA's fetch); null puts the live one back. */
export function useNetEnv(fn: (() => Promise<NetEnv>) | null): void { netEnvFn = fn ?? liveNetEnv; }
export const netEnv = () => netEnvFn();

export const SECRET_NAMES = ["password", "privateKey", "passphrase", "token", "apiKey"] as const;
const SECRET_OK = new Set<string>(SECRET_NAMES);
/** The credential_ref of a connection whose secrets are sealed in connection_secret. */
export const SEALED = "sealed";

function sealFor(key: Buffer, connId: string, name: string, value: string) {
  const iv = randomBytes(12);
  const ci = createCipheriv("aes-256-gcm", key, iv);
  ci.setAAD(Buffer.from(`connection:${connId}:${name}`));
  const ct = Buffer.concat([ci.update(value, "utf8"), ci.final()]);
  return { iv, ct, tag: ci.getAuthTag() };
}
function unsealFor(key: Buffer, connId: string, name: string, iv: Buffer, ct: Buffer, tag: Buffer) {
  const d = createDecipheriv("aes-256-gcm", key, iv);
  d.setAAD(Buffer.from(`connection:${connId}:${name}`));
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

/** Write-only: a value sets or replaces, null clears, "" or the kept marker leaves it. Audited by name, never by value. */
export async function setConnectionSecrets(c: Client, s: Scope, connId: string, values: Record<string, string | null>, key: Buffer | null): Promise<string[]> {
  const conn = await loadConnection(c, connId);
  if (conn.entity_id !== s.entityId) throw new TransportError("no such connection");
  const changed: string[] = [];
  for (const [name, value] of Object.entries(values)) {
    if (!SECRET_OK.has(name)) throw new TransportError(`${name} is not a secret a connection keeps`);
    if (value === null) {
      const r = await q(c, `delete from connection_secret where connection_id = $1 and entity_id = $2 and name = $3 returning name`, [connId, s.entityId, name]);
      if (r.length) changed.push(`${name} cleared`);
      continue;
    }
    const v = String(value);
    if (!v || v === "•kept•") continue;
    if (v.length > 16000) throw new TransportError(`${name} is too long`);
    if (!key || key.length !== 32) throw new TransportError("add ERP_SECRET_KEY to the service's environment to store passwords and keys here");
    const box = sealFor(key, connId, name, v);
    await c.query(`
      insert into connection_secret (connection_id, tenant_id, entity_id, name, iv, ciphertext, tag, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8)
      on conflict (connection_id, name) do update set iv = excluded.iv, ciphertext = excluded.ciphertext, tag = excluded.tag,
        updated_by = excluded.updated_by, updated_at = now()`,
      [connId, conn.tenant_id, s.entityId, name, box.iv, box.ct, box.tag, s.actor.id || null]);
    changed.push(`${name} set`);
  }
  if (changed.length) await audit(c, s, { table: "connection_secret", rowId: connId, action: "update", after: { secrets: changed } });
  return changed;
}

/** Which secrets are set. Not a character of any of them. */
export async function connectionSecretNames(c: Client, entityId: string, connId: string): Promise<string[]> {
  return (await q<{ name: string }>(c, `select name from connection_secret where connection_id = $1 and entity_id = $2 order by name`, [connId, entityId])).map((r) => r.name);
}

/** Everything a connection signs in with: ERP_SECRET_<REF> for a secret:// reference, then its sealed secrets. */
export async function connectionCredentials(c: Client, conn: Connection, env: NetEnv): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const ref = conn.credential_ref ?? "";
  if (/^secret:\/\//i.test(ref)) {
    const raw = env.feeds.secret(ref).trim();
    if (raw.startsWith("{")) {
      try { Object.assign(out, JSON.parse(raw) as Record<string, string>); } catch { throw new TransportError("the connection's environment secret is not valid JSON"); }
    } else if (raw) Object.assign(out, conn.channel === "sftp" ? { password: raw } : { token: raw, apiKey: raw });
  }
  const rows = await q<{ name: string; iv: Buffer; ciphertext: Buffer; tag: Buffer }>(c,
    `select name, iv, ciphertext, tag from connection_secret where connection_id = $1 /* unscoped: keyed by connection, which carries the entity */`, [conn.id]);
  if (rows.length && (!env.secretKey || env.secretKey.length !== 32)) throw new TransportError("ERP_SECRET_KEY is not set on the server, so the stored passwords cannot be read");
  for (const r of rows) {
    try { out[r.name] = unsealFor(env.secretKey!, conn.id, r.name, r.iv, r.ciphertext, r.tag); }
    catch { throw new TransportError(`the stored ${r.name} cannot be read with this ERP_SECRET_KEY; type it again`); }
  }
  return out;
}

export function maxBytesOf(conn: Pick<Connection, "config">): number {
  const mb = Number(conn.config.maxMb ?? DEFAULT_MAX_MB);
  return Math.round((Number.isFinite(mb) && mb > 0 ? Math.min(mb, MAX_MB) : DEFAULT_MAX_MB) * 1048576);
}

// ---------------------------------------------------------- server keys

export type PinOwner = { kind: "connection" | "edi_partner" | "vendor_feed"; id: string; tenantId: string; entityId: string };
export type Pin = { host: string; port: number; key_type: string; fingerprint: string; pinned_at: string; pinned_by_name: string | null;
  offered_type: string | null; offered_fingerprint: string | null; offered_at: string | null };

export async function loadPin(c: Client, owner: Pick<PinOwner, "kind" | "id" | "entityId">): Promise<Pin | null> {
  return (await q<Pin>(c, `select host, port, key_type, fingerprint, pinned_at, pinned_by_name, offered_type, offered_fingerprint, offered_at
    from sftp_host_pin where owner_kind = $1 and owner_id = $2 and entity_id = $3`, [owner.kind, owner.id, owner.entityId]))[0] ?? null;
}

/** The recorded key, when it is for this host and port; a pin for another server counts for nothing. */
export const pinFor = (pin: Pin | null, host: string, port: number) =>
  pin && pin.host === host.trim().toLowerCase() && pin.port === port ? { fingerprint: pin.fingerprint, type: pin.key_type } : null;

export type SftpTestResult = {
  ok: boolean; words: string; fingerprint: string | null; keyType: string | null; firstTime: boolean; changed: boolean;
  recorded: string | null; files: number | null; sample: { name: string; size: number; modifiedAt: string }[];
};

/**
 * Connect, list, and show the server's key. The first good Test records the
 * key; a later Test that meets a different one records it as offered (for
 * the owner to trust) and changes nothing else.
 */
export async function testSftp(c: Client, s: Scope, owner: PinOwner, t: Omit<SftpTarget, "pinned">, dir: string, globs: string[], who: string): Promise<SftpTestResult> {
  const env = await netEnvFn();
  const port = sftpPort(t.port);
  const host = String(t.host ?? "").trim().toLowerCase();
  const pin = await loadPin(c, owner);
  const pinned = pinFor(pin, host, port);
  const res: SftpTestResult = { ok: false, words: "", fingerprint: null, keyType: null, firstTime: !pinned, changed: false, recorded: pinned?.fingerprint ?? null, files: null, sample: [] };
  let session: SftpSession | null = null;
  try {
    session = await openSftp(env, { ...t, host, port, pinned }, "learn");
    res.fingerprint = session.hostKey.fingerprint; res.keyType = session.hostKey.type;
    const files = await session.list(dir, globs);
    res.files = files.length; res.sample = files.slice(0, 10);
    if (!pinned) {
      await c.query(`
        insert into sftp_host_pin (tenant_id, entity_id, owner_kind, owner_id, host, port, key_type, fingerprint, pinned_by, pinned_by_name)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        on conflict (owner_kind, owner_id) do update set host = excluded.host, port = excluded.port, key_type = excluded.key_type, fingerprint = excluded.fingerprint,
          pinned_at = now(), pinned_by = excluded.pinned_by, pinned_by_name = excluded.pinned_by_name, offered_type = null, offered_fingerprint = null, offered_at = null`,
        [owner.tenantId, owner.entityId, owner.kind, owner.id, host, port, res.keyType, res.fingerprint, s.actor.id || null, who]);
      await audit(c, s, { table: "sftp_host_pin", rowId: owner.id, action: "insert",
        before: pin ? { host: pin.host, port: pin.port, fingerprint: pin.fingerprint } : undefined,
        after: { host, port, keyType: res.keyType, fingerprint: res.fingerprint, by: who } });
    } else if (pin?.offered_fingerprint) {
      await c.query(`update sftp_host_pin set offered_type = null, offered_fingerprint = null, offered_at = null where owner_kind = $1 and owner_id = $2 and entity_id = $3`,
        [owner.kind, owner.id, owner.entityId]);
    }
    res.ok = true;
    res.words = `${pinned ? "Connected; the server's key matches the one recorded." : "Connected. This server key is now recorded; a different key will be refused."} ${files.length} ${files.length === 1 ? "file matches" : "files match"} in ${dir || "the home folder"}.`;
  } catch (e) {
    if (e instanceof HostKeyError && e.kind === "changed" && e.seen) {
      res.changed = true; res.fingerprint = e.seen.fingerprint; res.keyType = e.seen.type;
      await c.query(`update sftp_host_pin set offered_type = $4, offered_fingerprint = $5, offered_at = now() where owner_kind = $1 and owner_id = $2 and entity_id = $3`,
        [owner.kind, owner.id, owner.entityId, e.seen.type, e.seen.fingerprint]);
      res.words = e.message;
    } else if (e instanceof TransportError) {
      res.words = e.message;
    } else throw e;
  } finally { session?.close(); }
  return res;
}

/** The owner trusts the key a Test was shown, by its fingerprint. Recorded in the audit trail with both keys. */
export async function trustOfferedKey(c: Client, s: Scope, owner: Pick<PinOwner, "kind" | "id" | "entityId">, fingerprint: string, who: string) {
  const pin = await loadPin(c, owner);
  if (!pin?.offered_fingerprint) throw new TransportError("there is no new server key waiting; press Test first to see what the server shows");
  if (pin.offered_fingerprint !== String(fingerprint ?? "").trim()) throw new TransportError("the server key has changed again since that Test; press Test and check the new one");
  await c.query(`update sftp_host_pin set key_type = offered_type, fingerprint = offered_fingerprint, pinned_at = now(), pinned_by = $4, pinned_by_name = $5,
      offered_type = null, offered_fingerprint = null, offered_at = null where owner_kind = $1 and owner_id = $2 and entity_id = $3`,
    [owner.kind, owner.id, owner.entityId, s.actor.id || null, who]);
  await audit(c, s, { table: "sftp_host_pin", rowId: owner.id, action: "update", reason: "owner trusted a new server key",
    before: { fingerprint: pin.fingerprint, keyType: pin.key_type }, after: { fingerprint: pin.offered_fingerprint, keyType: pin.offered_type, by: who } });
  return { fingerprint: pin.offered_fingerprint };
}

// ------------------------------------------------- transports for a row

/** The real SFTP and HTTP clients for one connection, signed in with its own secrets and held to its pinned key. */
export async function liveTransportsFor(c: Client, conn: Connection): Promise<Transports> {
  const env = await netEnvFn();
  const creds = await connectionCredentials(c, conn, env);
  const cfg = conn.config as Record<string, unknown>;
  if (conn.channel === "sftp") {
    if (!conn.entity_id) throw new TransportError(`${conn.name} is not attached to a company`);
    const port = sftpPort(cfg.port);
    const host = String(cfg.host ?? "").trim().toLowerCase();
    const pinned = pinFor(await loadPin(c, { kind: "connection", id: conn.id, entityId: conn.entity_id }), host, port);
    const target: SftpTarget = { host, port, user: String(cfg.user ?? creds.user ?? ""), password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase, pinned };
    return { sftp: sftpAdapter(env, target, maxBytesOf(conn)) };
  }
  if (conn.channel === "api") {
    const auth: HttpAuth = { mode: (["none", "basic", "bearer", "header"].includes(String(cfg.auth)) ? cfg.auth : "none") as HttpAuth["mode"],
      user: String(cfg.user ?? ""), headerName: String(cfg.headerName ?? "") };
    return { http: { get: (o) => httpGet(env, o.endpoint, o.query, auth, creds, Number(cfg.timeoutMs ?? 30000) || 30000) } };
  }
  return {};
}

/** One session, opened on first use and closed by collect (or the post-run step). */
export function sftpAdapter(env: NetEnv, target: SftpTarget, maxBytes: number): SftpTransport & { session(): Promise<SftpSession> } {
  let s: Promise<SftpSession> | null = null;
  const session = () => (s ??= openSftp(env, target, "require"));
  return {
    session,
    async list(o) { return (await session()).list(o.path, o.globs ?? (o.glob ? [o.glob] : [])); },
    async get(o) { return (await session()).get(o.path, o.name, o.maxBytes ?? maxBytes); },
    async archive(o) { await (await session()).move(o.path, o.name, o.to); },
    async remove(o) { await (await session()).remove(o.path, o.name); },
    close() { if (s) s.then((x) => x.close(), () => {}); s = null; },
  };
}

// ----------------------------------------------- after the run commits

const PENDING = new Set<Promise<void>>();
function track(p: Promise<void>): Promise<void> {
  PENDING.add(p);
  p.finally(() => PENDING.delete(p)).catch(() => {});
  return p;
}
/** Checks wait here for the post-run moves and deletes to finish. */
export async function postRunSettled(): Promise<void> {
  // The jobs start on the tick after the commit (db.tx), so let that tick pass first.
  await new Promise((r) => setImmediate(r));
  while (PENDING.size) await Promise.allSettled([...PENDING]);
}

/** Move or delete the files a committed run took. What failed is written on the run, in words; the files stay where they were. */
async function postRun(conn: Connection, runId: string, names: string[]): Promise<void> {
  const cfg = conn.config as Record<string, unknown>;
  const after = String(cfg.after ?? "leave");
  const problems: string[] = [];
  let done = 0;
  let t: (SftpTransport & { session(): Promise<SftpSession> }) | null = null;
  try {
    const c0 = await tx({ kind: "system", label: "after run" }, async (c) => {
      const env = await netEnvFn();
      const creds = await connectionCredentials(c, conn, env);
      const port = sftpPort(cfg.port);
      const host = String(cfg.host ?? "").trim().toLowerCase();
      const pinned = pinFor(await loadPin(c, { kind: "connection", id: conn.id, entityId: conn.entity_id! }), host, port);
      return { env, target: { host, port, user: String(cfg.user ?? creds.user ?? ""), password: creds.password, privateKey: creds.privateKey, passphrase: creds.passphrase, pinned } };
    });
    t = sftpAdapter(c0.env, c0.target, maxBytesOf(conn));
    const at = { host: String(cfg.host), path: String(cfg.path ?? ""), credentialRef: conn.credential_ref ?? "" };
    for (const name of names) {
      try {
        if (after === "move") await t.archive!({ ...at, name, to: String(cfg.moveTo ?? "") });
        else await t.remove!({ ...at, name });
        done++;
      } catch (e) { problems.push(`${name}: ${(e as Error).message}`); }
    }
  } catch (e) {
    problems.push((e as Error).message);
  } finally { t?.close?.(); }
  const note = problems.length
    ? `after the run, ${done} of ${names.length} files were ${after === "move" ? "moved" : "deleted"}; ${problems.slice(0, 3).join("; ")}`.slice(0, 1000)
    : null;
  await tx({ kind: "system", label: "after run" }, async (c) => {
    await q(c, `update ingest_run set error = coalesce($2, error) where id = $1 /* unscoped: run id is unique */`, [runId, note]);
  }).catch(() => { /* the run row is best effort here */ });
}
