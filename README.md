# Pentex ERP — session one

Foundation, vendor master, accounts payable, banking and payroll.
TypeScript, Postgres, no framework. This is the schema and the core rules,
verified against a real database. There is no API and no UI yet; that is
session two.

The running record of this build — what was asked, what was decided, what was
built and what had to be redone — is the "Build log" tab of the ERP Blueprint
doc at https://claude.ai/code/artifact/97c84336-b718-407b-a478-6412f5f6e149.
It gains a row at the end of every working session. Add to that doc rather
than starting another one.

## Running it

Needs Postgres 14 or newer and Node 22.6 or newer.

```bash
createdb erp
export PGDATABASE=erp            # or set DATABASE_URL
npm install
./db/apply.sh --reset --seed     # migrations, then the placeholder seed
npm run smoke                    # 124 checks against the live database
```

`db/apply.sh` is forward-only. If a migration file changes after it has been
applied, the script refuses and tells you to write a new one. That is
deliberate — a schema you can quietly edit is a schema nobody can trust.

## What is here

```
db/migrations/   0001 foundation   tenants, entities, dimensions, chart, periods, people, audit
                 0002 approvals    the engine every later module reuses
                 0003 vendors      vendor master, per-entity terms, versioned banking
                 0004 payables     intake, purchase orders, receipts, invoices, payment runs
                 0005 ledger       journal entries, the balance rule, trial balance
                 0006 banking      bank accounts, statements, cash position
                 0007 payroll      time, gross, the register, deductions, remittance, comp exposure
                 0008 bank/location accounts per store at different banks; cash by account
                 0009 concentration one operating account per company; deposit-only branches, sweeps
                 0010 sweep methods what each bank will automate, and what a person still has to do
                 0011 reconciliation the POS feed, the statement, and what matched what
                 0012 connections  how data gets in and out: sources, channels, files, health
                 0013 statement intake statements in four dialects, de-duplicated and traced
db/seed/         0001 placeholder Pentex data
                 0002 its company banks, pay group, employees and deductions
                 0003 a second client in another industry, so isolation is tested
                 0004 a deposit account per store at three different banks, and their sweep rules
                 0005 a week of POS takings and the statement that answers it
                 0006 one connection of every channel, across three banks
packages/core/   money, db and scoping, approvals, the invoice lifecycle, banking, payroll,
                 reconciliation, connections, statements
scripts/smoke.ts the end-to-end run
```

## The decisions the code makes for you

**Money is `bigint` minor units.** Never a float. `money.ts` is the only
place that parses or formats it.

**Every query names `entity_id`, or says why not.** `db.guard()` refuses a
select that does neither. A screen that forgets to filter returns nothing,
rather than another company's payables.

**Tenant sits above entity.** Companies you own consolidate. Clients of a
service tier never do. That boundary is a column now; retrofitting it later
is a rewrite of every query.

**The profit object is configurable.** A store here, a truck for a haulier,
a job for a services business. The ledger never knows which, so a second
vertical adds tables and a posting adapter rather than forking the close.

**Nothing is deleted and nothing is edited.** Journal entries are immutable
— corrections post a reversal. `audit_event` refuses UPDATE and DELETE at
the database, not by convention.

**The maker is never the checker**, resolved by person rather than by role,
so granting yourself a second role changes nothing. Enforced twice: in
`approvals.ts` where you can read it, and by a trigger that catches anything
going round the code.

**Approval policy is data.** Thresholds and step order live in rows, so they
differ per entity without a deploy.

**Merchandise and operating payables take different paths.** Operating
invoices match a template and a tolerance band. Merchandise always has a
purchase order and a receipt, matches unit by unit, and cannot pay while a
line is short. One ledger, opposite automation.

**One operating account per company, and the database holds you to it.** A
partial unique index allows at most one active operating account per entity.
Everything is paid from there: one account to reconcile daily, one ACH
origination relationship, one exposure limit, one positive-pay file.

**Stores keep local accounts, but they are deposit-only.** A branch account
takes the day's takings at whichever bank is on that corner and sweeps into
the operating account. A deposit account cannot be named by a payment run at
all, and a sweep cannot concentrate anywhere but the operating account.
Money comes in wherever is convenient and leaves from exactly one place.

**The sweep method is a property of the bank, not a preference.** Three of
them, and the rule cannot claim one the accounts cannot perform:

- `bank_zba` — the bank concentrates overnight, same institution. We
  originate nothing and post nothing; confirming it against the statement
  does that.
- `ach_pull` — we originate the debit. Needs the branch bank to allow debits
  and an authorisation on file. Sent and posted when planned.
- `manual` — nobody automates it, so it gets a due date, a named owner and
  an overdue list. A rule with no owner is refused outright, because an
  unowned manual step is one that silently stops happening.

**Nothing posts for a movement that has not happened.** A transfer carries
no ledger entry until it is sent or settled, enforced by trigger. Until the
bank's sweep clears, the money still shows at the branch — which is the
honest answer, and the difference between a reconciliation that ties and one
that has a hole in it three weeks later.

**A journal line names the bank account it moved, not just the cash code.**
This is the correction in migration 0008. Deriving bank balances from the GL
account works right up until three stores at three banks all roll into 1010,
and then it silently cannot tell them apart. The seed keeps that exact case
— three deposit accounts sharing one cash code — as a standing test.

**A payment run names the account it draws on.** Drawing on another
company's bank, disbursing from a deposit account, or originating ACH from
an account not enabled for it are all refused by the database rather than by
a screen.

**The store dimension records where a cost belongs, not which bank sends
the money.** Those are different questions, and conflating them is how a
multi-location company ends up with six bank relationships nobody can
reconcile.

**Reconciliation matches the POS feed, and the matchers run in order of
certainty.** The POS says what was taken at each store each day and roughly
when it should land; the bank says what actually arrived. A run tries the
certain answers first and only then the clever ones — a known transfer, a
payment we originated, an exact amount, an amount inside a fee tolerance,
then several days' takings settled as one credit. Running them in that order
means the cheap explanation is never displaced by a plausible one, and no
expectation can be claimed twice — a unique index on the matched item
enforces that, not the matching code.

**The output of a reconciliation is the unmatched list.** The matched lines
are not the result; they are the part nobody needs to look at. What the run
produces is a short list of questions — a credit nobody expected, a deposit
that never arrived — with how many days each has been open. A run that
matches everything and hides one $40 adjustment inside a tolerance band is
worse than one that leaves it on the list.

**Card fees are posted, not absorbed.** A settlement arriving short of the
takings is matched to the day it belongs to and the difference is posted to
the fee account named on that bank account. The variance never disappears
into the cash line, which is how processing cost stops being visible.

**Everything enters through one pipeline.** Five channels — a person
uploading a file, an SFTP directory polled on a schedule, an allow-listed
email address, an API we call, a webhook they call — and one handler per kind
of data behind them. A new bank is a row. A new kind of data is a row plus a
parser. Nothing else moves.

**A channel is refused if it cannot be what it claims.** A pull channel with
no schedule, a push channel carrying one, an SFTP or API connection with no
credential reference, an email address with no allowed senders: all refused at
the database. The email rule is the one that matters most — an address anyone
can send to is not a connection, it is an invoice-fraud inbox.

**No secret is stored, only a reference to one.** Config is checked on write
and refuses any key that looks like a password, token or private key.

**The same bytes twice is one ingest, and the same transaction twice is one
line.** Statement lines are fingerprinted on account, date, amount and
reference, so the daily file that repeats the last three days — which is most
of them — adds only what is new. The run reports what it saw and what was
actually fresh.

**Nothing fails silently.** A file that cannot be parsed is quarantined with
the reason in plain words, sits on a list with its age, and needs a person and
a reason to clear. A statement for the wrong account is caught at the door
rather than three weeks later in a variance nobody can explain.

**A feed that stopped is a row, not an absence.** `connection_health` calls a
connection healthy, stale, failing or never run; `statement_gaps` lists the
business days an active account has no statement for. The failure mode of an
automated back office is not an error, it is silence.

**Payroll owns everything above the tax line.** Time, gross with overtime,
the register, deductions, approval, release and the posting. Tax calculation
and filing sit behind one interface — `TaxProvider` — because the rates move
constantly and the penalties land on the employer. The illustrative provider
in the box is flat-rate and says so in its own name; swapping it for the real
one is that single seam.

**Deducted is reconciled against remitted.** Retirement deferrals, premiums
and garnishments each get a remittance row with a due date the moment the
register is built. Late retirement deferrals are a Department of Labor
matter, not a bookkeeping slip.

**Nothing in payroll is industry-specific.** It runs for a store group, a
haulier or a services firm; only the profit object means something else.

## What the smoke run proves

A hundred and twenty-four checks, each asserting the failure as well as the success.

An invoice under the threshold clears every gate and posts with nobody
touching it. One over the threshold stops, refuses its own maker, refuses
the wrong role, and clears for the right approver. A re-send under a new
invoice number is held as a probable duplicate. An unbalanced journal entry,
a posting into a closed period, an edit to the audit log and an edit to a
ledger entry are all refused. Accounts payable ties to what was posted, and
the trial balance balances.

A payment run without a bank account is refused, as is one drawing on
another company's bank, one disbursing from a branch deposit account, and
one originating ACH from an account that cannot. A second operating account
is refused outright. A day's takings into two branch accounts sweep into the
operating account by the method each bank supports — one the bank does
itself, one we originate, one left on the controller's list — leave the
branches at zero once confirmed, post balanced transfers, and show up as
nothing uncollected. A
payroll register builds from approved timecards with overtime at time and a
half, waits for an approval, refuses to be released by whoever built it,
posts a balanced entry, schedules three deduction payees, and drops workers'
comp exposure out as a report rather than a scramble.

A statement arrives four ways and lands the same: a BAI2 file uploaded by
hand, a CSV emailed by a bank that offers nothing else, OFX polled from an
API, and a BAI2 file collected from an SFTP directory where the pattern
correctly ignores another company's file sitting beside it. Re-sending the
same file changes nothing. An overlapping window adds one day, not three. A
stranger's email never reaches storage, a photo and a wrong-account statement
both land in quarantine with reasons, and clearing one takes a person and a
sentence.

A week of store takings is reconciled against the bank without a person: a
cash deposit matches exactly, a card settlement matches net of $24.40 in
fees that are posted to their own account rather than absorbed, and two days
banked together match as a batch. Three of four lines explain themselves.
The fourth — a $40 credit adjustment nobody expected — is left on the list,
which is the point; a person closes it, and the record says who. Trying to
match the same expectation twice is refused by the database.

And a second client company, in a different industry on the same install,
sees none of the first's data — its profit objects are trucks, and the same
tables read as Truck and Settlements rather than Store and Back balances.

## Placeholders to replace before anything real is posted

- `db/seed/0001_pentex.sql` — the entity, the three locations and the
  34-account chart are a starting point, not your records
- approval thresholds are set at $1,000 and $10,000 as an example
- `tin_ref` and `account_ref` are keys into a secrets store that does not
  exist yet; only the last four digits are held here, deliberately

## Next

Session two is auth, the API and the first screens, on top of exactly these
rules. Nothing above needs to move for that.
