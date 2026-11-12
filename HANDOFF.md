# HANDOFF: start here

Read this first if you are a new AI session picking up this repo. Update it **in the same commit as every change**: add a change-log line, any new decision, and the open items. When your session gets long, hand off to a fresh one, and keep this file current so the next session starts trained.

## Who you're working for, and how

- **Steve** is a software developer who sells this ERP to many unrelated retail businesses, from one storefront up to multi-company groups. It is **not** his own company's system.
  - The PA/TX stores, Enola/Palestine/Socorro and Buddy's are old sample data only.
  - The demo tenants are "Demo Furniture Co" and "Rio Freight". The product name is undecided and is written `{{PRODUCT}}` in the docs.
- **How to talk to him:** short, practical replies, with the reasoning included.
- **End every reply** with https://pentex-erp-api.onrender.com
- **Values to copy** (names, URLs, settings) each go in their own copy box, with no stray spaces.
- **Secrets:** never echo them. Steve sets passwords and keys himself on Render.
- **UI rules, every screen:**
  - Phone-first, wrapped cards and pickers. No sideways-scrolling tables.
  - Headers sit over their data: numbers right, text left.
  - Every summary number or tile drills to the detail behind it, with a Back button.
  - Strict CSP: no inline scripts or handlers.
- **Review before shipping.** Every build gets an independent agent review. Reviewers may change code only on their own branch, and must say so. You verify their changes before anything ships. Reviewers never push. Tell Steve if a reviewer broke that rule.
- **"Pentex"** may appear only in `render.yaml:9`, the onrender URL, and the `pentex_erp` cleanup in `scripts/migrate.ts`.
- **Never store card numbers.** Bank and finance account numbers: last 4 digits only.

## How it's built

- **Runtime:** Node 22 `--experimental-strip-types`, Postgres 16, vanilla JS UI under `server/ui` and `server/app.js`.
- **Module contract:** `docs/MODULES.md`. Read it before changing anything.
  - Money is bigint minor units.
  - Every query is entity-scoped.
  - Nothing is deleted.
  - Refusals are plain sentences.
  - `post()` posts by account code.
- **Database:**
  - Migrations: `db/migrations/NNNN_*.sql`. Highest live is 0065. 0066 (setup approvals) is on branch `mod-setupops`, reviewed, not merged.
  - Seeds: `db/seed/`. Highest is 0037 (on `mod-setupops`: the demo is live), then 0099.
  - The server migrates itself at startup; `scripts/migrate.ts` does the same job by hand.
- **Multi-tenant platform:**
  - The platform layer is `server/platform.ts`.
  - The operator console sees no customer data except in **support mode**, which needs a reason, shows a banner and is audited.
  - Customers sign in with email and password.
- **Scheduler:** runs inside the web server (`server/scheduler.ts`) every 60 seconds, behind an advisory lock.
  - Demo tenants never call outside systems.
  - Suspended tenants are skipped.

## Run, test, ship

```
export PGDATABASE=erp PGUSER=root PGHOST=/var/run/postgresql
npm ci            # ssh2 is required; the module runner fails loudly if a dependency is missing
bash db/apply.sh --reset --seed && npm run -s smoke:modules && npm run -s smoke
```

- **Expected results:** smoke 139/0. Module checks as of 7bce1e0: 2736/0; on `mod-setupops`: 2800/0.
- **If Postgres is down:** run `service postgresql start`.
- **Parallel work:** use git worktrees at `/home/claude/wt-<name>` on branch `mod-<name>`, each with its own DB `erp_<name>`.
- **Deploy:**
  ```
  git branch -f release retail-erp && git push origin release:main
  ```
  That autodeploys the Render service ERP-api (`srv-daokormgekts73cm3g90`, workspace `tea-d9vtr0u1egvs73fd7de0`).
- **Before every push:** a final upgrade simulation. Start the old commit's server with `ERP_SEED=placeholder`, then start the new server on the same DB.
- **Live environment:**
  - Free plan, on the shared APPS-db (schema `erp`). It is not reachable from here.
  - `ERP_SEED=placeholder` is set, meaning dev mode: 4-digit operator keys are allowed. Remove it at go-live.
  - `ERP_PUBLIC_URL` is set.
  - The free plan blocks outbound SMTP (Gmail). Email needs Starter, or SendGrid.

## Change log (newest first)

- 2026-11-12: setup-mode approvals before go-live (branch `mod-setupops`, 0066 + seed 0037): ERP setup approves new vendors and new hires only; ends at Go live, first trading entry, or 60 days after the first; countdown chip on the console and in the support banner; the install token needs `x-erp-reason`; Go live only signed in as the owner, after ticking the list shown; digest names each line and shows a hire's pay. Review fixes: no API tokens, invite links or owners minted from support mode (a live hole), old support-made tokens flagged.
- 2026-11-12: HANDOFF.md added.
- 2026-11-11, 7bce1e0: self-approval for one-owner stores across every flow; release needs a releasing role; owner digest.
- 2026-11-11, 39fd9ce: SFTP, HTTPS pulls, vendor email-in, EDI over SFTP, catalog template and xlsx import.
- 2026-11-11, f17cb17: periods and close, store-local dates, scheduler, error refs, CI, selling rules, demo scrub; drill-downs.
- 2026-11-11, be370da: platform layer (customers, isolation, support mode), setup checklist, opening balances.
- Earlier: Phase 1 and 2 modules, Admin services and connections (see `git log`).

## Decisions (date: decision, and why)

- 2026-11-11: dev mode keeps 4-digit operator keys while `ERP_SEED=placeholder`, because Steve is still in development.
- 2026-11-11: no paid Render plan until development is done. Gmail waits on Starter.
- 2026-11-11: opening stock posts on an as-of date the user picks, so it doesn't land in the wrong month.
- 2026-11-11: vendor email applies automatically only with an SPF pass aligned to the From address. Forwarded mail is held for one-tap review, to block faked price files.
- 2026-11-11: an owner may self-approve only when no other active owner, controller or step-role holder exists. Never in support mode. Bank details, payments and payroll need the typed payee or total. Everything self-approved appears in the daily digest.
- 2026-11-11: releasing a run needs a releasing role: owner, controller, approver or A/P clerk for payments; owner, controller or HR for payroll.
- 2026-11-12: before go-live, an operator in support mode may approve setup items only: new vendors and new hires. The owner reviews them at Go-live. Steve asked for it for every new customer.
- 2026-11-12: journal entries and periods dropped from the setup types, because no flow opens those requests.
- 2026-11-12: setup mode ends at whichever comes first: Go live, the first trading entry (money in or out, a sale, a bill, payroll...), or 60 days after the first setup approval. So a customer who trades or stalls does not keep the window open.
- 2026-11-12: Go live is recorded once and can never be undone (append-only table), because the computed go-live step can flip back when a tie-out fails.
- 2026-11-12: Go live only by the owner signed in as themselves, never support mode or any token, after ticking the exact list shown. The review is the owner's, so nobody else can press it.
- 2026-11-12: support mode and the install token never mint an identity that is not support mode: no API token create or rotate, no invites or invite links, no new owners. Such an identity could self-approve or go live as the owner. Revoking stays allowed.
- 2026-11-12: the Operator console shows an invite link only when email is not connected (the onboarding case), and logs that it was shown. Otherwise the link goes to the person's inbox only.
- 2026-11-12: the install-wide token needs an `x-erp-reason` header for setup approvals, so every one carries a reason like a support session's.

## Open items

- Merge `mod-setupops` into `retail-erp` and ship (0066, seed 0037). After deploying, check the Operator console for any "API tokens made in support mode" still active, and revoke them with the owner.
- Residual: before email is connected, the Operator console still shows the owner's invite link (logged as `invite.link_shown`). Whoever holds it can set the owner's password. Connect platform email (`ERP_PLATFORM_MAIL_COMPANY`) so invites go to the owner's inbox only.

- Product name and domain: waiting on Steve.
- Paid Render setup (Starter plus its own database) and email: waiting on Steve.
- AS2 for EDI is not built (use a VAN for now).
- Anyone in a company can still build a payment or payroll run; only releasing is role-checked.
- In an owner-plus-controller company, the owner's own vendor can't be approved. The step needs the owner role.
- Typecheck has about 190 errors and doesn't block CI.
- Card processor, payroll tax provider and marketplaces are not built.
