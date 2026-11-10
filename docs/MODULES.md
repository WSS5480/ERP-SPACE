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
| lots (serial numbers and dye lots, label printing, finance company settlements; extends inventory, edi, catalog tags, ar) | 0045 | 0028 | Operations (Serials and lots, Labels), Back office (Finance settlements) |
| trade (trade and designer accounts, the trade portal, room projects and follow-ups, the designer as a commission role; extends crm, catalog, tax, ar, shop, workforce) | 0044 | 0027 | Retail (Trade accounts, Room projects) |

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
GL 2100 (everything except payments of the tax to the state, which are shown
apart). Certificates (`tax_exemption_certificate`) belong to a customer, name
a state and may expire; an expired one is refused. The web store and service
price tax through `stackForLine`/`computeLine` like POS. A line charged by
another door at a different amount keeps both (`tax_minor` charged,
`owed_minor` owed) and the filing flags it as tax under/over-collected. A ZIP
the state's local jurisdictions do not cover is taxed at the selling store's
stack (same state) or the state alone, with a note on the line and the ZIP
listed in the filing. Migration 0037 gives every existing store with a rate
its single-rate stand-in (`tax_make_standins()`), so a later statewide
jurisdiction never lowers it.

POS: `pos_setting.special_order_deposit_bps` (50%) and `stocked_deposit_bps`
(0%) are the least a sale must have paid at checkout; a store manager may go
below with a reason (`pos_override` kind 'deposit'). A quote may hold stock
(`pos_quote_hold`, `inventory.reserveLines`) when `quote_holds_allowed`, for
up to `quote_hold_max_days`; a manager extends it; it ends on expiry
(`scripts/run-due.ts`), conversion or cancel. Tear sheets
(`server/modules/tearsheet.ts`) are server-rendered print pages with no script;
a customer's copy is `/sheet/<token>` (only the hash is kept), sent through the
customer message log.

## Trade accounts, the trade portal, room projects (migration 0044, extends crm/catalog/tax/ar/shop/workforce)

A trade account (`trade_account`) is one business customer: a designer,
contractor, stager or hospitality buyer. It copies nothing: its terms and
credit limit are its customer's house account (`ar.setAccount`, net 30 by
default; only the controller sets a limit), its resale certificate is a
`tax_exemption_certificate` on that customer, and its prices are a price list.
A price list may now price whole categories by rule (`price_list_rule`, cost
plus X% or retail less Y%, a null category being the catch-all) through
`priceConfigured`; a product's own price on the list still wins, and nothing
goes above the ticket. Applying is public (`trade_application`); a store
manager or controller approves (making or reusing the customer by email) or
declines with a reason.

The portal is `/trade/<slug>/` on the web store's site: its own page and
script (`server/shop/trade.*`, no inline script), its API at
`/trade/<slug>/api/*` through `kit.publicRoute` (POSTs carry `x-erp-shop: 1`).
Sign-in is an emailed six-digit code (`trade_login_code`, only its hash kept,
10 minutes, five wrong tries, three per 15 minutes per account, plus a
per-address limit); the session is a random token in `x-trade-session`
(`trade_session`, hash kept, 12 hours, ended when the account is suspended).
Every portal read names the account; another account's order, project or
invoice reads as not found. Orders go through the web store's own checkout
(`shop.placeWebOrder` with `CheckoutIn.trade`): channel `b2b`, priced by the
account's list, on account (what is owed plus what is on order and unbilled
must fit the limit; billed at hand-over by `invoiceFulfilment` on the account's
terms) or by card. A resale order needs a current resale certificate
(`tax.certificateFor`); a delivery to a designer's client is taxed at the
destination like any delivery, and a certificate only exempts in its own state.
Invoices are paid by card through `ar.receivePayment`. Tear sheets are the
`/sheet/<token>` links (`tearsheet.createLink`).

Room projects (`packages/core/projects.ts`): per customer (seen from the
household) or trade account, with room size, doors and windows, style notes,
photos (data URLs, removed rows kept), a budget and the products considered,
quoted and bought; POS (customer card), CRM (`customer360.projects`) and the
portal read the same rows. Follow-ups go on `crm_task` once each per order or
project (`clienteling_followup`): a quote still open N days on (3), a care
check-in N days after delivery (30), a protection plan check-in (365); set in
`entity_setting` `clienteling.followups`, run by `scripts/run-due.ts`.

Commission (`packages/core/trade_commission.ts`): a line's own split
(`sales_order_line_split`, primary rep plus internal designer, role
`designer`) replaces the order's salespeople for that line in
`workforce.accrueCommissions`, on each person's plan basis (gross margin or
sale); a return line follows the line it returns. An outside referral
(`sales_order_line_referral`) earns the trade account its rate as
`trade_referral_event` rows, Dr 6130 Cr 2160 through `post()`, when the line is
delivered (or once paid: `trade.referral_on`), given back on a return or a
cancel; `billReferrals` turns what is owed into a bill from the account's
vendor, coded to 2160, through the payables gates.

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
quantity (all-zero weights fall back to quantity). Each line's share rides on
that container's own units (`wms_container_line.landed_minor`): unloading
adds it to the units that come off (`ReceiveLine.extraMinor`, Dr 1300 Cr 2050),
and a cost added later revalues the units still on hand (Dr 1300) and sends
the part for units already gone to 5000, against 2050 (`inventory.revalue`).
The shares are also written to `po_landed_cost` per PO line (`basis = 'line'`,
re-spreads retire rows with `active = false`) for payables; `reallocate`
leaves them out of `landed_minor`. A vendor's cut or a cancelled PO trims the
containers (`wms.trimForPoLine`), and a container with nothing outstanding
finishes. An 856 whose TD3 names a container attaches to it, or opens it; a
link that cannot be made (unloaded, line already on another container) is a
note on the document, never a quarantine. `inv_in_transit` (view) is what is
on the road, capped by what is still on order; ATP, POS search and the
endless aisle read it. Settings: `inventory.transfers_two_step` and
`inventory.in_transit_gl` ('1310': Dr 1310 Cr 1300 on ship, reversed on
receipt; '1300': the value stays in 1300 and moves between stores' columns on
receipt). Every company that existed at migration 0038, and the furniture and
appliance packs, are two-step through 1310; only a new company made without a
pack starts one-step in 1300. `inventory.transfer_days`; `wms.prep_gate`
(off, warn, refuse). Prep jobs are queued on receipt from `wms_prep_rule` by
product or category; a problem goes to `inventory.reportDamage` with its
photos. `wms.gateOrQueue` is checked at delivery booking, the pick list,
loading (`loading.loadPiece`, per piece), `startRoute` and `completeStop`;
labelled units are checked one by one, unlabelled stock by quantity free of
prep at the location. Prep that was never queued is queued in its own
transaction, so a refusal does not lose it.

## Serials, dye lots, labels and finance settlements (lots, migration 0045)

Serials and lots live on `inv_piece` (`serial_no`, `lot_code`; every carton of
a unit carries the unit's values) and are written only by `inventory.ts`.
A product says how it is matched on an order with `product.lot_class`
(`dye_lot` for upholstery and leather, `finish_batch` for wood case goods,
`batch`) and `lot_group` (the cover or finish; empty means collection and
color, see `LOT_KEY_SQL`). Receiving takes `units: [{serial, lot}]` and a line
`lot`; with nothing scanned it uses what the vendor's 856 said
(`inv_expected_serial`, filled from MAN SN / LIN SN / REF SE serials and
LIN LT / REF LT / MAN LT lots). Non-serialized stock keeps its lot on
`goods_receipt_line.lot_code`. The pick list and `inventory.reservePieces`
take one lot per cover or finish on an order (`unitsByLot`), warn when lots
mix (`lotMix`, `lotWarnings` on the pick list), and in strict mode
(`inventory.lot_strict`) refuse a reservation or a hand allocation that would
mix, while the pick list leaves the line short. Serial and lot show on pick
lists, the loading manifest and the delivery record (`route().stops[].lines[].units`).
`inventory.searchSerials` is the recall and service search.

Labels (`packages/core/labels.ts`): carton, bin and price-tag labels as ZPL,
as a .zpl download, sent to a network printer, or as a no-script print page
(HTML with SVG Code 128, sized by `@page` for a Dymo or desktop printer).
Code 128 comes from `catalog.code128` (one implementation). Templates
(`label_template`) set size, dpi and fields per company and kind. Batch
sources: a goods receipt, the prep queue, a route's manifest, scanned pieces,
bins, SKUs. Network printing is SSRF-narrow: only printers the owner set up
(`label_printer`), only private IPv4/IPv6 literals (checked in code and by a
check constraint), ports 9100-9109, named by id; a request carrying an
address is refused. Price tags print a `condition_grade` only when that column
exists on product.

Finance settlements (`packages/core/ar_settlement.ts`, part of A/R's
third-party finance): each lender has a remittance CSV mapping, a bank
account, a fee tolerance and a chargeback mode. Rows match a `financed_sale`
by approval (auth) code, else the account's last four (never the full number)
with the amount and date. Funding posts Dr cash (the lender's bank account,
else 1050), Dr 6910 the fee, Dr 1115 the holdback, Cr 1110 the sale; a
holdback release Dr cash Cr 1115; a chargeback either reopens the sale
(Dr 1110, the fee given back through 6910) or goes to 6915; a reopened
chargeback can be written off to 6915 by a controller, with a reason. Fees
are checked against the plan's rate (`finance_plan.fee_bps`, by the file's
plan code when given) and flagged past the tolerance. Rows that match nothing
are exceptions, settled by a person (matched to a sale, or set aside with a
reason). When nothing is open and the posted cash equals one unmatched bank
line of the lender's account near the deposit day, the settlement's cash
lines are matched to it through `reconcile.matchManually`.

Review fixes (migration 0046): a row with an approval code never falls back
to a sale carrying a different one, and several candidates are an
exception. A sale may be funded in parts (`funded_gross_minor`); what the
lender owes is amount - `refunded_minor` - funded gross. A refund to the
lender's card (a negative 'financing' receipt) credits its financed sale
through `ar.postReceipt` (`financed_sale_refund`), and the lender's later
reversal clears it (status 'refunded') rather than reopening it; in expense
mode only what is still owed goes to 6915. A row the lender paid that is set
aside posts Dr cash Cr 2195 Unapplied finance deposits ('suspense'), and
applying it later moves it from 2195 to the sale. `lenderAging` reports its
difference from 1110. Card or account numbers (13-19 digits) are kept as the
last four only and never echoed. The lot group also carries the cover or
finish chosen on the order line (`LINE_LOT_KEY_SQL`). The print page needs
the printing roles (the acting person rides in `?as=`) and is logged; a
printer's port is 9100 unless the owner allows others in `labels.printer_ports`.

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
