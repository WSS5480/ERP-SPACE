# Retail modules — the contract

ERP is becoming an out-of-the-box **retail furniture ERP** that any
business can switch on: a furniture or appliance retailer, a general retailer,
a rent-to-own chain, or a trucking company. All of them share the finance
core in migrations 0001–0014 (GL, AP, banking, reconciliation, payroll), and
the retail modules below sit on top.

Sources we model features on: ERPNext (open source, used as a blueprint only;
no code is copied), STORIS, NetSuite, Furniture Wizard, Retail Vantage,
Renaissance, and our own CATALOG-APP (vendor feed import and mapping, freight
per store, budgeted order forms). See `docs/RESEARCH.md`.

## The shared spine (migration 0015, do not fork it)

| Table | What it is | Who writes it |
|---|---|---|
| `customer`, `customer_address` | one customer across every channel | POS, shop, A/R |
| `product` | one sellable SKU | catalog |
| `product_option_group`, `product_option` | customization (fabric, finish, size) | catalog |
| `sales_order`, `sales_order_line` | **the one order every channel writes** (`channel` = pos/web/phone/marketplace/b2b) | POS, shop |
| `customer_receipt` | every dollar received, any door (refund = negative) | POS, shop, A/R |
| `stock_level` / view `product_availability` | on hand, reserved, on order per product per location | **inventory only** |
| `doc_sequence` / `next_doc_no(entity, kind, prefix)` | gapless numbers | everyone |
| `sales_order_retotal(order)` | recompute order totals from lines | anyone who changes lines |

The `location.kind` column says store, warehouse, outlet, yard, office or web.
`location.geo` and `customer_address.geo` are `point(lng, lat)` for routing.

New roles: `store_manager, sales, cashier, buyer, warehouse, dispatcher,
driver, ar_clerk, hr, web_admin` (alongside `owner, controller, ap_clerk,
approver, viewer`). Owner passes every role check.

## Cross-module contract functions (keep these signatures)

| Function | File | Called by |
|---|---|---|
| `priceConfigured(c, entityId, productId, choices)` | `packages/core/pricing.ts` (catalog owns) | POS, shop, quotes |
| `reserveOrder(c, entityId, orderId)` | `packages/core/inventory.ts` (inventory owns) | POS, shop |
| `fulfilLines(c, entityId, orderId, lineIds)` → cost | `packages/core/inventory.ts` | POS carry-out, pickup, fleet delivery |
| `releaseLines`, `restock` | `packages/core/inventory.ts` | POS returns/cancels |
| `postReceipt(c, scope, receiptId)` | `packages/core/ar.ts` (A/R owns) | POS, shop, A/R payments |
| `invoiceFulfilment(c, scope, orderId, lineIds, cost)` | `packages/core/ar.ts` | POS, fleet delivery, pickup |
| `post(c, scope, {date, sourceType, sourceId, description, lines})` | `packages/core/posting.ts` | anyone posting to the GL |

A special order or a backorder is a sales order line in `line_status = 'on_order'`.
Purchasing turns those lines into vendor POs. POS never builds POs itself.

## Ground rules (same as the finance core; read README.md "The decisions")

1. Money is `bigint` minor units. Use `minor()` and `bps()` from `server/modules/kit.ts`. Never floats.
2. Every query names `entity_id = $n` (or says `/* unscoped: why */`). Pass SQL through `guard()` when you build it dynamically.
3. Nothing is deleted. Corrections are reversals, voids with reasons, or status changes.
4. The database enforces the rules that cost money if broken (check constraints and triggers), and the code says them in plain words too.
5. Errors a person will read are sentences. Throw `ModuleError` (via `need()`), which comes back as a 409 with the message as-is.
6. A module never writes another module's tables except through that module's exported functions in `packages/core/<module>.ts`. `stock_level` especially: only `packages/core/inventory.ts` changes it.
7. Postings to the GL go through the existing ledger (`journal_entry` / `journal_line`, see `packages/core/invoice.ts` `postToLedger` for the pattern). Revenue, COGS, deposits, A/R, inventory and freight each post to a GL account resolved by code from the tenant's chart, never a hard-coded id.
8. Phone first. Every screen must work on a phone: no sideways-scrolling tables for primary data. Wrap rows into cards on narrow screens and use pickers and dropdowns. Table headers align with their columns: numbers right, text left.

## A module is four files and a slot

| Piece | Path |
|---|---|
| schema | `db/migrations/00NN_<id>.sql` (your number below; forward-only) |
| demo data | `db/seed/00NN_<id>.sql` (loaded only with `ERP_SEED=placeholder`) |
| rules | `packages/core/<id>.ts` (pure functions taking a `Client`) |
| API | `server/modules/<id>.ts`, `register(kit)` using `kit.coGet` / `kit.coPost` / `kit.publicRoute` |
| screens | `server/ui/<id>.js`, uses `window.ERP` helpers and `ERP.register(...)` |
| checks | `scripts/modules/<id>.ts`, exports `run(t)` (see `scripts/modules/harness.ts`) |

Routes: `kit.coGet('/pos/tickets', fn)` serves `GET /api/c/<company>/pos/tickets`.
`kit.coPost` runs in one transaction as the acting person; use
`requireRole(c, co, a, ['cashier'], 'ringing a sale')`. `kit.publicRoute`
is **only** for the web store: no auth, and POSTs must carry `x-erp-shop: 1`.

Screens: `ERP.register('pos', 'Point of sale', 'cash', async (sub) => node, 'Retail')`.
Groups shown in the nav are `Back office` (existing), `Retail`,
`Operations` and `Setup`. Use `ERP.coApi(path)`, `ERP.post(path, body)`,
`ERP.el`, `ERP.section`, `ERP.head`, `ERP.tbl`, `ERP.item`, `ERP.tile`,
`ERP.openDialog`, `ERP.act`, `ERP.money` (minor units in, "$1,234.00" out).
Data is placed with textContent only, never innerHTML.

## Slots

| Module | Migration | Seed | Nav group |
|---|---|---|---|
| setup (industry packs, store/warehouse setup) | 0016 | 0010 | Setup |
| catalog | 0017 | 0011 | Retail |
| purchasing (owner buying program) | 0018 | 0012 | Retail |
| inventory (warehousing and tracking) | 0019 | 0013 | Operations |
| pos | 0020 | 0014 | Retail |
| ar (complete receivables) | 0021 | 0015 | Back office |
| workforce (time clock, commissions → payroll) | 0022 | 0016 | Back office |
| fleet (vehicles, delivery routing) | 0023 | 0017 | Operations |
| shop (omnichannel web store + customizer) | 0024 | 0018 | Retail |
| reports (report creator and editor) | 0031 | none | Back office |
| group (multi-company: consolidation, inter-company documents, net-to-zero and settle) | 0035 | 0021 | Back office |
| edi (vendor EDI X12, API ordering, store orders; extends purchasing) | 0036, 0040 | none | Setup (Vendor EDI), Retail (Store orders) |
| wms (containers and freight, goods in transit, prep queue; extends inventory and purchasing) | 0038 | 0024 | Operations (Containers and prep) |
| tax and selling rules (extends setup, pos, ar, reports) | 0037 | 0023 | Setup (Sales tax), Back office (Reports → Sales tax filing) |
| ops (truck loading manifest and lanes, haul-away and recycling, vendor debit memos, time off and holidays; extends fleet, payables, workforce) | 0039, 0041 | 0025 | Operations (Loading dock, Haul-away), Back office (Debit memos, Time off) |

## Sales tax, deposits, quote holds, tear sheets (migration 0037, extends setup/pos/ar/reports)

`packages/core/tax.ts` owns sales tax. A sale is taxed by a stack of
jurisdictions (`tax_jurisdiction`: state, county, city, special district),
each with dated rates (`tax_rate`) and its own say on delivery fees, labor and
protection plans, applying to a whole state, one ZIP or one store
(`tax_area`). The place is where the goods are handed over: the store for
take-with and pickup, the ship-to address for delivery and direct ship when
`tax_setting.sourcing` is destination (the default). A store with no
jurisdictions keeps its single `location.tax_rate_bps` as one 'combined'
jurisdiction, so one jurisdiction always gives the old rate. Each line's tax
is kept per jurisdiction in `sales_order_line_tax`; `ar.invoiceFulfilment`
marks the rows posted when 2100 is credited (allocating lines written by other
doors), and POS returns write reversing rows. `tax.filing` ties the period to
GL 2100. Certificates (`tax_exemption_certificate`) belong to a customer, name
a state and may expire; an expired one is refused. The web store and service
still read `location.tax_rate_bps`, which tax.ts keeps equal to the store's
stack.

POS: `pos_setting.special_order_deposit_bps` (50%) and `stocked_deposit_bps`
(0%) are the least a sale must have paid at checkout; a store manager may go
below with a reason (`pos_override` kind 'deposit'). A quote may hold stock
(`pos_quote_hold`, `inventory.reserveLines`) when `quote_holds_allowed`, for
up to `quote_hold_max_days`; a manager extends it; it ends on expiry
(`scripts/run-due.ts`), conversion or cancel. Tear sheets
(`server/modules/tearsheet.ts`) are server-rendered print pages with no script;
a customer's copy is `/sheet/<token>` (only the hash is kept), sent through the
customer message log.

## Group accounting

A client (tenant) can run several companies (entities). `packages/core/group.ts`
owns what spans them. Inter-company accounts, by code, in every pack: 1195 Due
from related companies, 2190 Due to related companies, 4090 Inter-company
sales, 5090 Inter-company cost of sales. Every group posting to 1195/2190 is
also an `ic_ledger` row naming the other company, so a pair's balances tie to
the GL by construction. A sale or charge to a sibling is a pair of documents:
a `customer_invoice` in the seller (`ar.invoiceSibling`, no `ar_ledger` row, so
the aging still ties to 1100) and an approved bill in the buyer
(`invoice.billFromSibling`), both carrying `ic_document_id`; such bills never go
in a payment run, Group settles them. A transfer to a sibling's location
(`inventory.createTransfer` / `shipTransfer`) leaves at average cost and lands
there at transfer price in one step (`inventory.landAcross`); same-company
transfers are unchanged. Who: the owner, or a controller in every company
covered (`group.requireGroupRole`) -- that includes creating or shipping a
transfer to a sibling, which a warehouse role alone cannot do.

Markup on goods between siblings is tracked in `ic_markup_move`: in when the
goods land, out at the share of the buyer's stock that leaves (inventory's
`costOut` releases it on a sale, write-off or count loss; a move between the
buyer's own locations keeps it; a transfer on to another sibling carries it).
The group view takes the part still in stock out of inventory and earnings,
and the part that left the group out of cost of goods.

Settle: when both books agree, pay what is owed or less (less leaves the rest
open, documents part-paid oldest first); more is refused. When they disagree,
the payment is the payer's own figure and the difference goes to 6800, which
needs a reason and the owner, or a difference within the group's write-off
limit (set by the owner). A one-sided entry to 6800 follows the same limit.

Decision (Nov 10 2026): an inter-company code (1195, 2190, 4090, 5090, 6800)
already in a client's chart with a different type is never reused. Migration
0035 leaves it, raises a NOTICE naming the client and code, and the group
module refuses to post for that client, saying which account to renumber.

## Containers, goods in transit and prep (wms)

`packages/core/wms.ts` goes through the modules it extends. A container
(stages booked → departed → at port → customs cleared → on rail/drayage →
delivered to DC → unloaded, each with expected and actual days) carries PO
lines with quantities; its DC day moves the lines, the PO and the customers'
special orders through `purchasing.setLineEta`. Freight, drayage, duty,
tariff and port fees are spread over its lines by cube, value, weight or
quantity into `po_landed_cost` (one row per PO line, `basis = 'line'`; a
re-spread retires old rows with `active = false`), so `reallocate` and
receiving value the goods with them. Unloading (in part) is
`inventory.receivePurchaseOrder` per PO. An 856 whose TD3 names a container
attaches to it, or opens it. `inv_in_transit` (view) is what is on the road:
shipped-not-received PO quantities and same-company transfers in transit;
ATP, POS search and the endless aisle read it. Settings:
`inventory.transfers_two_step` (off: a transfer lands when it ships),
`inventory.in_transit_gl` ('1300' default, or '1310': Dr 1310 Cr 1300 on
ship, reversed on receipt; the account is kept on the transfer),
`inventory.transfer_days`, `wms.prep_gate` (off, warn, refuse). Prep jobs
are queued on receipt (and before a delivery is booked) from `wms_prep_rule`
by product or category; a problem goes to `inventory.reportDamage` with its
photos (https links or pictures taken on the phone, as service tickets keep
them). Fleet's `bookStop` and the pick-list route go through `wms.prepGate`.

## Reports

A person never writes SQL. `packages/core/reports_datasets.ts` is the
catalog: each dataset is one fixed query scoped by `$1` (the company) in
every table it reads, with typed fields and the roles that may use it.
`packages/core/reports.ts` checks a definition against that catalog
(dataset, field, operator, aggregate and bucket ids from fixed lists;
formulas are column ids, numeric field ids, numbers and `+ - * / ( )` only;
every value a bound parameter), then runs it with a 10-second statement
timeout and row caps (200 a page, 10,000 an export, 2,000 a snapshot). Roles
are checked when a report is saved and again on every run, including a
scheduled one, which runs as whoever set the schedule. A module that adds
data worth reporting on adds a dataset to the catalog, not a screen.

## Running it

```bash
export PGDATABASE=erp PGUSER=root PGHOST=/var/run/postgresql
./db/apply.sh --reset --seed
npm run smoke            # the finance core, 139 checks, must stay green
npm run smoke:modules    # the retail modules
```
