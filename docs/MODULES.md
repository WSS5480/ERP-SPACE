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
3. Nothing is deleted. Corrections are reversals, voids with reasons, or status changes. The one exception is the demo reset (`packages/core/platform_demo.ts`, see Platform), guarded to the demo tenants.
4. The database enforces the rules that cost money if broken (check constraints and triggers), and the code says them in plain words too.
5. Errors a person will read are sentences. Throw `ModuleError` (via `need()`), which comes back as a 409 with the message as-is.
6. A module never writes another module's tables except through that module's exported functions in `packages/core/<module>.ts`. `stock_level` especially: only `packages/core/inventory.ts` changes it.
7. Postings to the GL go through the existing ledger (`journal_entry` / `journal_line`, see `packages/core/invoice.ts` `postToLedger` for the pattern). Revenue, COGS, deposits, A/R, inventory and freight each post to a GL account resolved by code from the tenant's chart, never a hard-coded id.
8. Phone first. Every screen must work on a phone: no sideways-scrolling tables for primary data. Wrap rows into cards on narrow screens and use pickers and dropdowns. Table headers align with their columns: numbers right, text left.

## A module is four files and a slot

| Piece | Path |
|---|---|
| schema | `db/migrations/00NN_<id>.sql` (your number below; forward-only) |
| demo data | `db/seed/00NN_<id>.sql` (the demo tenants only; loaded by `apply.sh --seed`, by `ERP_SEED=placeholder`, and by the Operator console's Reset demo, so it must never touch another tenant) |
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
| trade (trade and designer accounts, the trade portal, room projects and follow-ups, the designer as a commission role; extends crm, catalog, tax, ar, shop, workforce) | 0044, 0047 | 0027 | Retail (Trade accounts, Room projects) |
| configurator (sectionals, fabric/leather grades and swatches, option rules, condition grades; extends catalog, pos, inventory, shop, edi) | 0043 | 0026 | Retail (Sectionals), Operations (As-is grades) |
| admin (service switches and presets, single-store rule, connections, outbound message log) | 0049 | none | Setup (Services, Connections) |
| platform (customers, sign-in, support mode, tenant API tokens, the demo) | 0051 | 0032 (marks the demo) | Platform (Operator console), Account |
| onboarding (setup checklist, opening stock import, bank opening balance, tax rates checked) | 0052 | none | Setup (Setup checklist), a Home card |
| periods (periods that open on their own, month-end and year-end close), store-local dates | 0053 | 0034 | Back office (Books → Periods) |
| scheduler and server errors (in-server jobs, run log, error references) | 0054 | none | Setup (Scheduled jobs), Operator console |
| selling rules (discount limit, quote life, layaway terms, tenders); demo made up | 0055 | 0035 | Setup (Sales tax → Selling rules) |
| vendor_files (SFTP and HTTPS transports, vendor file connections, vendor email, SFTP/email-in vendor feeds, EDI over SFTP; one-person approvals) | 0057, 0061, 0062 | none | Setup (Connections → Vendor files), Retail (Catalog → Vendors → Catalog connections) |
| drill (the rows behind every tile; read-only lists) | none | none | no screen of its own |
| self-approval follow-through (support mode, typed confirmation, owner digest, counts / write-offs / debit memos / time off, run release, bill gates) | 0063, 0064 | none | a Home card (Self-approvals) |

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

Review fixes (migration 0047, Nov 10 2026). An on-account order locks the
customer row before it sums what is on order, so two at once cannot both pass
the limit. Apply, ask-for-a-code and check-a-code answer the same whether or
not the email has an account (apply never shows a number; staff see it). Client
addresses: `ERP_TRUSTED_PROXY_HOPS` is how many proxies append to
x-forwarded-for (see Platform, review fixes: default 2 on Render, 0 elsewhere);
anything a client wrote to the left of those entries is ignored; 0 uses the
socket address. Codes, checks and applications are also limited per email.
Routes may take a bigger JSON body (`coPost`/`publicRoute` option `maxBody`);
only the room photo routes do (3 MB), and both screens resize photos to 1600 px
JPEG 0.8. A session ends after two idle hours. "Once paid" referral means the
line's invoice is paid (on account, through A/R) or the order is paid in full,
and uses the cost recorded on the line. A cost-plus rule on an item with no
cost falls back to the list's retail-less rule, else retail; rules never price
below cost unless `price_list.allow_below_cost`. Sectional builds take the
account's list per piece (`configurator.priceBuild(..., { priceList })`). A
portal invoice payment carries a key from the page (`trade_invoice_payment`):
the customer and invoice are locked and the balance checked before the card is
asked, and the same key twice is refused before any charge. A designer (or rep)
with no commission plan cannot be given a line split.

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
## Configurator (migration 0043, extends catalog/pos/inventory/shop/edi)

`packages/core/configurator.ts` owns it; `pricing.ts` owns the option rule engine.

**Sectionals.** A family is a `configurable` product with a `sectional_family` row
(fewest and most pieces, bundle discount, grade table, the stocked cover). Each piece
is its own `stock` SKU (price, cost, cube, weight, vendor SKU) with a `sectional_piece`
row: its kind (LAF/RAF sofa, loveseat, chair; armless chair/loveseat; wedge; corner;
ottoman; LAF/RAF chaise; console), motion (none/manual/power), width, depth, seats.
A layout reads left to right as you face it: both ends are arms facing out, pieces
join only on armless sides, at most two corners/wedges, ottomans stand free.
`sectional_layout` names the popular ones and is checked when saved. `priceBuild` gives
the parts: piece price + the cover's grade adder for that piece type (else the grade's
% uplift) + the piece's options, less the bundle discount spread by value; the overall
width, depth, seats and the plan's rectangles (`geometry`; `layoutSvg` for print). POS
(`insertLines`), the endless aisle (`aisleHandoff`) and the web (`priceLines` /
`placeWebOrder`) write one line per piece and `recordSet` (`cfg_set`, `cfg_set_line`).
A piece in a cover other than the stocked one, or with an option, is `on_order` from
the start; purchasing makes one PO line per piece, keeping `config.cover` and
`config.cfg` (cost in the grade, option factory codes). Voiding one piece voids the set;
`partialSetWarning` is returned by `fleet.bookStop` (`setWarning`) and
`pos.fulfilAtCounter`; returns are by line, i.e. by piece.

**Grades and swatches.** `fabric_grade_table` per vendor, `fabric_grade` (A–Z or the
vendor's code, % uplift), `fabric_grade_adder` (per piece type), `swatch` (cover name,
grade, material, color family, content, cleaning code W/S/WS/X, vendor code, photo
address served through the catalog's photo proxy `imageByUrl`, discontinued date).

**Option rules.** `product_option_rule`: option A `requires` one of B, `excludes` C, or
is `only_on` some piece types. `priceConfigured` checks requires/excludes on every
product; `priceBuild` checks all three per piece (a power piece counts as `recline:
power`).

**Condition grades.** `gradePiece` keeps every grading (`inv_condition`, never edited):
New / Like new / Good / Fair / Damaged, notes, photos, price = the company's % of
retail (`condition_grade_rule`, controller), or a store manager's price with a reason.
An as-is piece's tag price follows (`inventory.setAsIsPrice`). Report: `asIsReport` and
the `as_is_condition` dataset.

**Vendor catalog (best effort, never stops an import).** X12 832, per LIN item:
`REF*ZZ*<family model>*SECTIONAL [name]`, `REF*ZZ*<piece words>*PIECE` (LAF SOFA, RAF
LOVESEAT, ARMLESS CHAIR, WEDGE...), `REF*ZZ*<manual|power>*MOTION`, `REF*ZZ*<n>*SEATS`,
`MEA` width/depth/height, and `CTP*<grade>*GRD*<adder>` per grade. A cover is an item
with `REF*ZZ*<grade>*SWATCH`, `PID*F*73` color, `REF*ZZ*<family>*COLOR`,
`REF*ZZ*<content>*CONTENT`, `REF*ZZ*<code>*CLEAN`, `REF*ZZ*<date>*DISCONTINUED`; it is not
made a product. The vendor products feed reads columns `sectional_family`, `piece_type`,
`motion`, `width_in`, `depth_in`, `seats`, and cover rows `swatch_code` + `grade`
(`extrasFromRows`). Families are made once per vendor model (a draft until priced);
covers go into the vendor's grade table (made from its SKU prefix).

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

## Drill-downs: every figure opens what is behind it (Nov 11 2026)

Standing rule: every summary number, tile, count and total opens the detail it
was added up from, with Back returning to where you were (filters, typed text
and scroll intact) and the phone's Back doing the same. `server/app.js` has the
one helper: `E.drill(title, load)` keeps the screen's own nodes and pushes a
history entry; `E.drillItems` (rows the screen already has), `E.drillList(key,
title, params, { expect })` (a server list, paged) and `E.drillSum` (the count
and total, with a warning when they no longer match the tile). From inside a
dialog the detail opens over it. A drill row that goes on to another screen is
parked, so Back returns to the list. `E.opener(kind, fn)` says what a row opens
(bill, entry, order, product, ticket, lead, customer, edi). A labelled figure
is `fact(k, v, onClick)`. Each history entry carries its position; Forward
re-opens a drill closed with Back, and an entry that can no longer be shown (a
detail over a dialog that has closed, from before a reload or another company)
is stepped over in the direction of travel. Switching company or signing out
drops every drill. Back to a parked drill sets an explicit flag naming the
address it expects; the hashchange to that address only moves the route.

Lists over the books' whole history (`gl-lines`, `bank-lines`) open on the
fiscal year's first day and carry what came before as one opening figure
(`since=` a day or `all`), so opening + rows = the tile. Each page comes with
the whole list's count and total from one query. `db/migrations/0060` indexes
the lists that read by company. Dates in `drill.ts` are marked
`store-local date: harden` for the posting-date work on mod-harden.

Where no list existed, `packages/core/drill.ts` adds one: `GET
/api/c/<co>/drill/<key>?page=&...` (`server/modules/drill.ts`), read-only, one
fixed query per list scoped by `$1`, 50 rows a page with the count and total of
every row, refusals in sentences, the same role rules as the screen it drills
from. Each list mirrors the query behind its tile; `scripts/modules/drilldown.ts`
checks every list adds up to its tile and that another tenant's company is
refused. A new tile gets a drill; a new list gets a check.

## Running it

```bash
export PGDATABASE=erp PGUSER=root PGHOST=/var/run/postgresql
./db/apply.sh --reset --seed
npm run smoke            # the finance core, 139 checks, must stay green
npm run smoke:modules    # the retail modules
```

## Admin: services and connections (migration 0049)

`packages/core/services.ts` is the service catalog: every switchable service
(`MODULE_IDS`, one `entity_module` row each) with its plain name, group, parent
and screens (`SCREEN_SERVICE`); every `E.register` names its service in
`module`. A switch hides a service's screens, Home cards (`E.homeCard(fn,
{ module })`) and menu entries; it never stops it: data, jobs, postings and
API routes keep working. `/setup/modules` returns what shows
(`effectiveServices`: the switch, every parent on, and the layout rule: Group
needs a second company, store orders a second location; owner override
`admin.layout` = auto/single/multi). `setup.enabledModules` stays the raw
switches; a 0049 service with no row follows the module it rode on
(`SERVICE_SEED`). Presets map to the packs (single/multi-store retail →
retail, furniture → furniture, delivery → trucking, back office → none).
Store pickers marked `E.storePicker(select)` hide when they have one choice.

`packages/core/messaging.ts` owns `admin_connection` (per company, or the
whole client with `entity_id` null; the company's row wins), its sealed
`admin_connection_secret` (AES-256-GCM, AAD connection:name, never returned)
and `outbound_message` (status, provider id, error; codes stored redacted and
never resent). Email: its own SMTP client (EHLO, STARTTLS, AUTH PLAIN/LOGIN,
dot-stuffing, timeouts, public addresses only unless ERP_SMTP_ALLOW_PRIVATE=1,
no-TLS only with ERP_SMTP_ALLOW_PLAIN=1) or SendGrid/Postmark/Mailgun/Resend
through `vendor_feeds.call`. Wired: trade sign-in codes (`trade.ConnectedMailer`),
`purchasing.sendPO` email, fleet customer messages and tear sheets (text when a
text provider is connected, else email, else the old log), scheduled reports.
With nothing connected each keeps its old behaviour (logged, not sent). SMS:
Twilio or a generic HTTPS provider. Maps: Census, Google or Mapbox feed
`geocode.geocodeAddress`. Webhooks: a signed test only (X-ERP-Signature
t=,v1=HMAC-SHA256 of "t.body"); order events are not sent yet. Card
processors other than the test one, card terminals, Plaid, accounting and
payroll exports, marketplaces and ad platforms store keys only.

Review fixes (migration 0050, Nov 10 2026). Messages a public page causes
(trade sign-in codes, web order confirmations, delivery texts from the
self-schedule link) are queued in the transaction and sent after commit
(`db.afterCommit`, `messaging.queueEmail/queueSms`, drained by
`drainQueued`, also from `scripts/run-due.ts`); a code is held only in memory
until it goes, so a known and an unknown email answer alike. SMTP has an
overall deadline per send and its own STARTTLS timer; the port is always
checked; `ERP_SMTP_ALLOW_HOSTS` limits the servers. Client-wide connection
saves, tests and turn-offs need the role in every company and are audited by
name only. A failed PO email keeps its log row through the savepoint rollback
(`relog`). Existing companies that saw Group or Store orders keep
`admin.layout = multi` (`admin_keep_layout()`). A preset that would hide
services with open records lists them and needs `confirm`. Also through
messaging now: CRM campaigns (consent checked again at send), store order
decisions to the submitter, vendor feed alerts, A/R collections texts and
emails. Review requests (`RecordOnlyReviews`) and letters stay record-only.

## Platform: the ERP sold to many businesses (migration 0051)

The ERP is a product the developer sells to many retail businesses. A
**tenant** (client) is one customer; its **entities** are its companies. The
sample data (Demo Furniture Co, Rio Freight) is the **demo**, not anyone's
books. `tenant.kind` is `customer` or `demo`, `tenant.status` is `active` or
`suspended` (nobody of theirs signs in, their tokens stop, nothing is deleted),
`tenant.plan` is a label for billing.

**Two kinds of user.**

- *Platform operators* (the developer team): `ERP_LOGINS="name:password,..."`
  in Render, a password of 10+ characters or `scrypt$...` from
  `scripts/hash-password.ts`; the old 4-digit keys are refused with a sentence
  saying what to set. Signing in with a name and `ERP_API_TOKEN` also makes an
  operator. An operator sees the Operator console and **no company** until
  they enter a tenant in **support mode** (a reason is required;
  `platform_support_session`, `platform_audit` rows for start, every change
  and end; the audit trail labels changes `name (support) as person`; a banner
  shows the whole time). "Act as" exists only there.
- *Customer users*: `platform_login`, one per `app_user`, in ONE tenant. Email
  (unique across the install) and a scrypt password (N 16384, r 8, p 1, a
  16-byte salt of its own: `scrypt$N$r$p$salt$hash`), 10+ characters.
  Invites (7 days), password resets (1 hour) and emailed six-digit sign-in
  codes (10 minutes, 5 tries) are single-use `platform_login_token` rows, only
  the sha256 kept; the email is queued through `messaging.queueEmail` with the
  token redacted in `outbound_message` (purposes `platform_invite`,
  `platform_reset`, `platform_code`), through the email connection of
  `ERP_PLATFORM_MAIL_COMPANY` when set, else the customer's own. With none
  connected the operator copies the invite link from the console. Links point
  at `ERP_PUBLIC_URL`, else `RENDER_EXTERNAL_URL`, never the request's Host.
  A customer sees only the companies of their tenant where they hold a role
  (all of them with a client-wide grant), always as themselves, with their own
  roles. A tenant owner (a client-wide owner grant) may **preview** another of
  their people's view with `x-erp-as`: reads only; a change is refused.
  `session_version` ends every older session on a password change, reset,
  disable or suspension.

**Review fixes (Nov 10 2026).** Brakes live in `platform_signin_attempt`
(sha256 keys, no emails or addresses), so a restart keeps them. An emailed
code: 5 tries per code, 3 codes per 15 minutes and 5 a day per sign-in, and
10 wrong codes a day stop codes for that sign-in (the password still works).
The client address comes from `server/client_ip.ts`: `ERP_TRUSTED_PROXY_HOPS`
(default 2 on Render, where Cloudflare's edge and Render's proxy each append
to x-forwarded-for; 0 elsewhere, the socket) picks the entry that many from
the right; `ERP_CLIENT_IP_HEADER=cf-connecting-ip` prefers Cloudflare's header.
The start-up log says which (the temporary first-sign-in hop-count line was
removed, Nov 11 2026). A demo prospect's sign-in is look-only and never sees other
prospects (`views.people` leaves them out; acting as someone else is refused).
A tenant owner's invite answers the same whether or not the email signs in to
another customer (no link is shown to owners; the clash goes on the platform
log; operators are told plainly); people with no sign-in yet read as invited.
`scripts/run-due.ts`, scheduled reports and the outbox skip suspended
customers. One live email connection per mailbox address (unique index).
A preview or prospect read is marked look-only (`kit.lookOnly(c)`); the label
print page then writes no log row. Removed operators' cookies stop at once;
signing out ends a customer's session on the server. Customer cards' figures
open what is behind them, with Back. The demo's companies keep the setup
checklist dismissed across a reset (seed 0033).

**Sessions** are the same signed cookie, now carrying the kind (`o`/`c`), the
login and its version, or the support session. **Sign-in brakes** are per name
(or email) and client address (5 wrong tries lock that pair for 15 minutes)
and per address (growing delay; 40 wrong tries refuse that address for 15
minutes). There is no install-wide lock, so made-up names cannot lock out a
real login, and a correct password from another address always works.

**Every company route** (`coGet`, `coPost`, and so every module route; the
install-wide feed routes, which now take `?co=` or the person's default;
connections; `/api/clients`; `/api/companies`) resolves the company from the
URL through `companyFor()` and answers "no such company" (404) when the
session may not open it, before the body is read. `scripts/modules/platform.ts`
walks every registered `/api/c/<co>/...` route (GET and POST) as a customer
against another tenant's company and the demo's. There is no global default
company: a customer opens on their last company (`platform_login.last_entity_id`)
or their first; `ERP_ENTITY_ID` is only the default for the system token or an
operator who may open it. A feed connection with no company is refused, never
filed into some other company. The request log shows link tokens (tear sheets,
unsubscribe, self-schedule) as `[token]`.

**API tokens per tenant** (`platform_api_token`): an owner makes, rotates and
revokes named tokens (`erpt_...`), shown once, kept as sha256 with a short
prefix. A token opens only its tenant's companies and acts only as its
tenant's people. `ERP_API_TOKEN` stays the install-wide system token.

**Operator console** (`server/ui/platform.js`, `/api/platform/*`): customers
(companies, stores, sign-ins, people, services on, last activity, plan,
status); create a customer (tenant, first company with one store and its
operating account, the chosen setup pack through `setup.applyPack`, the owner
person with a client-wide owner grant, an invite; no sample data); suspend and
reactivate; enter support mode; new invite links; demo sign-ins for prospects
(owner of the demo, 1 to 30 days, the password shown once; they end on time
and survive a demo reset); Reset demo. The **Account** screen
(`/api/tenant/*`) is where an owner invites people, turns sign-ins on and off
and manages API tokens, and where anyone changes their password.

**Demo reset** (`packages/core/platform_demo.ts`), the documented exception to
"nothing is deleted": in one transaction, only for `DEMO_TENANTS` marked
`kind = 'demo'`, it collects the demo's rows from the catalog (tenant_id or
entity_id, then anything whose foreign key leads to those), refuses if any row
outside the demo points at one, lifts the append-only triggers for that
transaction only, deletes children before parents, reruns every `db/seed`
file, and refuses if any row it wrote is outside the demo (by xmin).
`audit_event` and `platform_audit` are never touched. A seed file is therefore
written for the demo tenants only (0019, 0024, 0028 and 0030 were narrowed to
them).

**Seeds vs production.** Production no longer needs `ERP_SEED=placeholder`:
migration 0051 marks the seeded tenants as the demo, so a live database keeps
its sample data as the demo and nothing else; new customers start clean.
`./db/apply.sh --reset --seed` still builds the test database (seed 0032 marks
the demo there).
## Onboarding: the setup checklist (migration 0052)

`packages/core/onboarding.ts`. The checklist is worked out from the company's
data on every read; nothing stores a tick. Steps: company details (legal name,
EIN, address, state, fiscal year), stores and warehouses, business type and
services (single or multi-store counted), chart of accounts (a pack or an
imported chart, and every code in `POSTS_TO` for the services that are on;
the onboarding checks grep `code: "NNNN"` in packages/core so the list stays
complete), sales tax, users and roles (required only with more than one
location), connections (email tested; texts if Delivery is on; card payments
if POS or the web store is on), vendors (a feed or EDI partner if Buying or EDI
is on), products (a price-tag label if Labels is on), opening balances (open
A/R if Receivables is on, opening stock if Warehouse is on, a bank balance),
delivery, web store / trade portal, and the go-live check (1300 vs stock, 2100
vs tax by jurisdiction, 1110 vs the lenders' aging, inter-company net). Steps
for a service that is off do not show. A step may be skipped with a reason
(`onboarding_skip`, never deleted; the go-live check cannot be skipped). The
Home card shows for the owner and controllers until the list is complete or
hidden (`onboarding_dismissal`).

Sales tax: every rate starts unchecked (`tax_rate.checked_by/checked_at`),
whether a seed, a migration stand-in or typed in; a person confirms them on
the Sales tax screen (`tax.confirmRates`, owner or controller), which first
makes the stand-in for stores still on a single rate.

Opening stock: a CSV (sku, location code, bin code, qty, unit_cost, serial,
lot) with an as-of day in an open period is previewed into
`opening_stock_run/row`; a row whose SKU already has stock or movements at
its location is flagged ("already has N on hand; this adds to it") and
applying needs `confirm`; the import is refused once the company has posted
sales, and while the Warehouse service is off. Applying it calls
`inventory.adjust` with reason `opening_balance`, the row's unit cost and
`postOn` = the as-of day (Dr 1300 / Cr 3000), one savepoint per row. The
`opening_balance` adjustment reason is the owner's or a controller's. A SKU at a location comes in from an
opening import once. A bank account's opening balance posts Dr its cash
account / Cr 3000 once (`opening_bank_balance`). Packs never add tax rates,
locations or sample data.

Review fixes (Nov 11 2026). The add-a-company form requires a setup pack or
preset (`createCompany` input `setup`: `pack:<id>` or `preset:<id>`), applied
in the same transaction. The trucking pack switches Finance settlements off
(`Pack.off`): hauling is billed on terms, so no finance-company accounts in its
chart. Sales tax is optional while a company has no store or outlet. Every
pack, on a fresh company, has nothing missing in the chart and can reach a
complete checklist without skips (checked). Companies with journal entries
when 0052 runs get a dismissal, so trading customers do not see the Home card.
The Home card counts without the tie-outs, and runs them before it would hide.
Time zones: the time clock falls back to the delivery settings' zone and
delivery to the time clock's, before the built-in defaults.

## Periods, business dates, the scheduler and server errors (migrations 0053–0055)

**Business dates** (`packages/core/clock.ts`). Every business date -- a posting,
a document, a due date, aging, a report's "as of" -- is the store's local day:
`today(c, scope or entityId, locationId?)`. Never `new Date().toISOString()`
or SQL `current_date` for one; SQL uses `business_today(entity, location)`.
Timestamps stay UTC. The zone is `location.time_zone`, else the time clock's
zone for that store, else `entity.time_zone`, else the time clock's or the
delivery settings' company zone, else the store's (or company's) state
(`state_time_zone`, all 50 states and DC; `STATE_TZ` in code), else New York
(`business_tz()` in SQL is the one definition). A check may pin the clock
(`pinClock`); `db.tx` then sets `erp.now`, which `erp_now()` reads. Company
details and each store's form set the zones. Text quiet hours use the
customer's state, else the company's zone.

Behaviour change (kept on purpose, Nov 11 2026): with no zone set anywhere
for a store -- not on the store, the company, the time clock or the delivery
settings -- the time clock and delivery now use the zone of the store's (or
company's) state before New York. Before 0053 they fell back to New York (time
clock) or Chicago (delivery) whatever the state. A company in Texas with no
zone set therefore now clocks and routes in Central time.

**Periods** (`packages/core/periods.ts`). `post()` finds the period through
`periodFor`: a month with no period opens on its own when the date is this
month or up to two months ahead of the company's business date, or an earlier
month of its current fiscal year (a `period_event` row says so); a month
further ahead never opens on its own, even inside the fiscal year; anything else is refused with a sentence
saying what to do (an owner or controller opens a month by hand in Books,
Periods, with a reason). The daily period job keeps three months ahead open for
every company of a customer that is not suspended. Every other writer of
`journal_entry` (bills, payroll, transfers, bank fees, booked bank lines, the
sample data) also goes through `periodFor`.

Month-end close (owner or controller): the checklist lists bills and payroll
dated in the month and not yet in the books, drawer sessions still open, bank
lines not matched to its end, and the 1300 / 2100 / 1110 / inter-company
tie-outs (`onboarding.tieOuts`); each item carries its rows and the screen that
fixes it. A month with items still open closes only with `override` and a
reason. A closed month refuses postings, in code and by the database trigger,
in a sentence. Reopening is the owner's, with a reason (audit and period log).
`period_event` is append-only.

Year-end close (owner or controller): one `closing` journal on the year's last
day moves every revenue and expense balance (by profit object) to retained
earnings -- 3900, or the equity account named in `books.retained_earnings_code`
-- and closes the year's months. A second close of the same year returns the
first (`fiscal_year_close`, one live row per year). Reopening any month of a
closed year, or the year, reverses the closing journal; closing again makes a
new one. Packs carry 3900.

**Scheduler** (`server/scheduler.ts`). The web server runs due jobs every
minute (`ERP_SCHEDULER_TICK_SEC`; `ERP_SCHEDULER=off` stops it): each tick takes
`pg_try_advisory_lock(7406312)` on its own connection or skips, so two
instances never run a job twice. Jobs: periods (daily), connections, vendor
feeds, marketing, EDI (15 minutes), quote holds, scheduled reports (hourly),
outbox sweep (15 minutes). Each run is a `job_run` with its outcome (ok,
partial, failed), its error, and what it did per company (`job_run_item`); a
run that throws is also a server error. Suspended customers are skipped by each
job's own query. `scripts/run-due.ts` runs what is due through the same code
(`--all` runs everything). Owners see Setup, Scheduled jobs (their company's
part of each run only); operators see every company's in the Operator console
and can run a job now.

**Server errors** (`server/errors.ts`). A failure that is not a refusal is
answered "Something went wrong on our side (ref ABC123)" and kept in
`server_error` under that reference, redacted (tokens, secrets, emails, card
and account numbers; ids kept). Unhandled rejections are recorded and the
service carries on; an uncaught exception is recorded and the process exits
for Render to restart. `ERP_ALERT_WEBHOOK` (optional) gets one redacted line
per error, at most one a minute and twenty an hour. Operators look a reference
up in the Operator console.

**Selling rules** (Setup, Sales tax, Selling rules; store manager or
controller): deposits, quote holds, the discount limit, how long a quote is
good for, the layaway deposit, length and number of payments, and the tenders
the registers take (`pos_setting`). POS, quotes and layaway read them. A
company with no row yet takes its pack's values. Pack settings now read when a
company has none of its own: `pos.*`, `ar.late_fee` (A/R settings),
`fleet.service_minutes` (delivery settings), `catalog.special_order_lead_days`
(a vendor with no lead time). Not wired (they are rows a person sets up):
`fleet.windows` (windows belong to zones), `workforce.commission` (plans are
rows), `ar.aging_buckets` (the aging keeps its fixed 30/60/90 columns).

**Campaigns** go through the outbox: the message and its `outbound_message`
row commit together and the outbox sends it once after the commit; a provider
refusal marks the campaign message failed.

**The demo is made up.** Seed 0035 renames the earlier seeds' real towns,
businesses, ZIP codes (to 001xx) and area codes (to 555) in the demo tenants
only (Riverside, Mesa Verde, Canyon Ridge, Oak Hollow, Hillcrest, Maple Grove;
the web store is `riverside-home`). Audit rows and journal entries keep what
they were written with; furniture makers' names on vendors stay (their
connections are built for them).

**CI** (`.github/workflows/ci.yml`): Postgres 16, `apply.sh --reset --seed`,
smoke and smoke:modules on every push and pull request; `npm run typecheck`
runs alongside, not blocking until it is clean. CI never deploys.

### Review fixes (Nov 11 2026, migrations 0056, 0058, 0059; seed 0036)

- The year-end closing entry (`source_type = 'closing'`) is left out of the
  P&L: Books, Home, Group consolidation and the `pnl_lines` dataset.
- 0056: a posting reads its period row FOR SHARE, so it cannot pass a
  month-end close (which takes it FOR UPDATE); an entry's period must be its
  company's and hold its date; lines cannot be added to an entry in a closed
  month; a closed month changes status only with a 'reopened' log row in the
  same transaction (periods.ts writes the log row first).
- Two year closes of the same company at once: one waits for the other
  (advisory lock) and returns its close; a clash says so in a sentence.
- Reopening a month of a closed year says first that the year's closing entry
  is reversed and the year's last month stays open until the year closes again.
- A failing pull connection's failure is recorded outside the rolled-back
  transaction, so it backs off and stops after five failures. The job log keeps
  90 days. Operator "Run now" queues the job and answers at once; the console
  watches the job log for the result.
- 0058: date columns that defaulted to the UTC day (customer_invoice,
  ar_ledger, maintenance_schedule, fuel_log, ic_document, ic_settlement,
  ic_markup_move) take the company's business date by trigger; the views
  ap_aging, sweep_status, connection_health and statement_gaps count from it.
- The demo never calls a real outside system on a schedule: 0059 (live) and
  seed 0036 (every reset) set its vendor feeds to on demand, turn its EDI off
  and pause its pull connections, and the scheduler skips the demo's feeds, EDI
  and pulls ("demo: skipped"). A person can still run one by hand.
- Error log redaction also covers phone numbers, passwords in URLs and
  `api_key=`. After an uncaught exception the server stops taking requests
  (`server.close()`) and the process exits within 10 seconds.
## Vendor files: SFTP, HTTPS and email transports (migration 0057)

Vendors deliver catalogs, prices, inventory and EDI documents three ways
besides their APIs: an SFTP drop, a plain HTTPS address, and email. All three
are real now.

**Transports** (`packages/core/transports.ts`, behind the pipeline in
`connections.ts`; `views.TRANSPORTS` is `{ sftp: true, http: true }`).
SFTP is the `ssh2` package (pure JavaScript, the one dependency added).
Password or private key (with passphrase); secrets are sealed in
`connection_secret` (AES-256-GCM under `ERP_SECRET_KEY`, AAD
`connection:<id>:<name>`, write-only; a read says which are set). The host is
checked and resolved once and the checked address dialled: no private,
loopback or link-local address unless it is on `ERP_SFTP_ALLOW_HOSTS`. Port
22, or the connection's own port when it is 1024 or above. Timeouts to
connect (`ERP_SFTP_CONNECT_TIMEOUT_MS`, 20 s) and per operation
(`ERP_SFTP_OP_TIMEOUT_MS`, 60 s); a size cap per file (20 MB, at most 50).
Listing is by pattern (`*` and `?`); a file already taken (same name, size,
time) is not downloaded again, the same bytes are never applied twice
(`inbound_file` sha256), and a file over the cap is quarantined by name and
left on the server. After a run commits, files are left (default), moved to a
folder (a clash gets a time stamp) or deleted (`connection.config.after`).
Outbound puts write `name.part` and rename it, and never overwrite.
HTTPS ("api" channel) is `vendor_feeds.call`: https only, every hop checked,
redirects by hand, 10 MB, a timeout; auth none, basic, bearer or a key header.
`ERP_FEEDS_ALLOW_HOSTS` lets listed hosts sit on a private network (still
https); checks use it for a local test server. The live fetch does its own DNS
lookup, checks every address there and dials the address it checked (no DNS
rebinding between check and call), and counts the body while it streams,
cutting the call at 10 MB whatever Content-Length says.

**Host keys** (`sftp_host_pin`, for a connection, an EDI partner or a vendor
feed). The first good Test records the server's key (SHA256, as OpenSSH
prints it) and who recorded it; a run with no recorded key is refused ("press
Test"), and a different key is refused before any password is sent, in a
sentence naming both keys. A Test that meets a new key records it as offered;
only the owner may trust it, by the fingerprint the Test showed, and that is
an audit row with both keys. Changing the host or port is a changed key too:
the Test shows the new server's key as offered, and only the owner can trust
it (the pin then moves to the new host and port). An SFTP upload that cannot
take its final name removes its `.part` file.

**Vendor file connections** (`packages/core/vendor_files.ts`, source
`vendor_files`, `server/modules/vendor_files.ts` at `/vendor-files/*`): one
per vendor server (or address, or sender list), carrying catalog, prices,
inventory and/or EDI documents, each picked out by a file pattern (an X12
file is known by its content). A zip is opened and each file routed. Catalog
goes through `applyCatalogRows` (cost into the price history), prices through
`recordVendorPrices`, inventory through `recordAvailability`, EDI through
`edi.receiveFile` for the vendor's trading partner (its inbox, 997s and
quarantine). A file is applied whole or not at all (a savepoint); one that
cannot be read is quarantined with the reason. Pulls run through the existing
`ingest()` (the scheduler's run-due path and `POST /api/connections/:id/run`
need nothing new). Owner, controller or buyer; trusting a key is the owner's.

**Vendor feeds by SFTP and email** (`vendor_feeds.runFeed`, kinds `sftp` and
`email`). Catalog → Vendors → Catalog connections offers API, SFTP, email-in
and file import. An SFTP feed reads new files on its schedule
(`runDueVendorFeeds` takes `api` and `sftp` feeds); an email-in feed is handed
the attachment. Either way the file (CSV, TSV, XLSX, JSON, or a zip of them)
runs through the feed's ETL and field mapping like an API answer;
`vendor_feed_file` remembers each file by checksum so none is applied twice.

**Inbound email.** Set `ERP_INBOUND_EMAIL_ADDRESS` to the mail service's
inbound address (Postmark: `abc123@inbound.postmarkapp.com`) and point its
inbound webhook at `https://erp:<ERP_EMAIL_INBOUND_TOKEN>@<your host>/inbound/email`
(Postmark → Server → Settings → Inbound → Webhook URL). Postmark turns the
user and password in that URL into an `Authorization: Basic` header, so the
token never travels in the address or the request log. Other services send
`Authorization: Bearer <token>`. A `?token=` in the address is refused. Each
company gets `local+<key>@domain` (shown in Admin → Connections → Vendor
files) and each vendor its own (shown on its card and in Catalog connections);
`inbound_mailbox` holds the keys. A customer points a vendor at it: ask the vendor to send there. (A forwarding rule in their own mailbox also delivers, but forwarded mail is held for review: see below.)
A message is routed by mailbox key (the tenant and company, never anything the
message claims) and then by sender to the one email connection or email-in
feed that lists it (an exact address before an @domain; a feed may also
require a subject or attachment pattern).

Mail is applied automatically only when the receiving mail server confirms the
sender: its own (topmost) Received-SPF says pass and the envelope sender's
domain is the From domain (or a sub- or parent domain of it). Everything else
is **held for one-tap review, never applied automatically**: forwarded mail
(the envelope is the forwarder) and mail sent through a mailing service (the
envelope is the service), SPF or DMARC failures, unknown senders, and a sender
two places list. Held mail remembers where its sender would have sent it, so
**Apply** runs it through that connection's or feed's own mapping in one tap;
**Assign** sends it elsewhere (optionally adding the sender); **Set aside**
keeps the record with a reason. A vendor can be set to **Always hold** every
message for review (Admin → Connections → Vendor files → Mail held → Review by
vendor). There is no rule that trusts a sender automatically. A client holds
at most 200 messages or 500 MB of held content at once (past that the record
is kept without the file), and the daily `held_mail` job drops held files
after 60 days, keeping each record. Data attachments only (CSV, TSV, TXT,
XLSX, JSON, X12/EDI, zip); logos and PDFs are listed as left out. Mail to an
address that is no company's falls through to the older `config.mailbox`
routes (bank statements).

**EDI over SFTP** (`edi.transportFor`): their outbox folder is read (optional
pattern, optional archive folder), our documents are put in their inbox
folder; Test SFTP and trust-key on the partner. AS2 is still not built (it
needs S/MIME signing and encryption, MDN receipts and certificate management:
a library such as `node-forge` plus an HTTP receiver with MDN replies). A VAN
remains the way to reach AS2-only partners.

**Catalog import template.** `GET /catalog/import/template.csv` (the
`IMPORT_FIELDS` names in order) and `template.xlsx` (`server/static`, a
Catalog sheet with an Instructions sheet; the checks hold its headings to
`IMPORT_FIELDS`). The importer takes `.xlsx` (its Catalog sheet, else the
first; rows are read in one linear pass, at most 50,000, and Excel date
cells come out as YYYY-MM-DD) as well as CSV. The example row (model
B1234-38) is left out on every channel: manual import, SFTP, HTTPS, email and
every vendor feed. The template's barcode (UPC) column is text-formatted as a
whole column, so leading zeros survive.

**One-person companies and approvals (migration 0061).** The maker is never
the checker, except that the owner may decide their own request's step when
nobody else active in the company holds that step's role or the owner role;
the step is marked `self_approved` and an audit row says "self-approved: no
other approver". The database trigger enforces the same rule. This frees every
type the approval engine routes: vendor, vendor_bank_account (its callback is
still required), invoice, payment_run, payroll_run, employee,
employee_change, journal_entry and fiscal_period. Catalog → Vendors lists a
vendor waiting on approval with "Waiting for approval" and an Approve button
for whoever may decide it; Add vendor from Catalog offers merchandise
categories only (the server refuses others).

**Self-approval, followed through (migration 0063, Nov 11 2026).** One rule,
in SQL `self_approve_refusal(entity, user, roles)` / `may_self_approve(...)` and
in code `approvals.selfApprovalRefusal` / `mayDecideOwn` (checked to agree): the
maker may decide their own request only as the owner, only when no other
active person in the company holds owner, controller or one of the roles that
could decide it, and never from support mode. 0061's approval-step guard now
calls it. Support mode: `db.tx` carries the support session (`erp.support`)
for every coPost an operator makes, and coGet marks the read
(`db.markSupport`), so the code, the Approvals screen and the database all
refuse an operator acting as the owner ("support mode never self-approves for
the owner"). Typed confirmation: self-approving new vendor bank details needs
the payee's name typed (DBA or legal name, any case), a payment or payroll run
its total (`$1,234.56`, `1234.56` or `1234`); the server checks it
(`decide(..., { confirm })`), the Approvals screen asks for it
(`askTypedConfirm`), and the audit row says it was typed. Rejecting your own
needs nothing typed. The four flows outside the engine that dead-ended in a
one-person company now carry `self_approved` and a trigger
(`self_approved_guard(<roles>)`) and relax their maker-checker check to
`... or self_approved`: stock counts (`inv_count`, store_manager), A/R
write-offs (`ar_writeoff`, controller), vendor debit memos
(`vendor_debit_memo`, controller or approver) and time off
(`leave_request`, hr or store_manager; the owner's own time off included).
Each writes "self-approved: no other approver" to the audit trail
(`approvals.auditSelfApproval`) and shows "(self-approved)" in its history;
the count and write-off lists say `self_ok` when the maker may decide it.
Roles taken away are kept in `role_removal` (deferred triggers on
`role_grant` delete and `app_user` leaving active: a "set roles" that keeps a
role logs nothing; append-only). The daily `owner_digest` job
(`packages/core/owner_digest.ts`) makes one `owner_notification` per company
per business day with every self-approval of the last 24 hours and any role
removed in the 24 hours before one; it shows on the owner's Home
(Self-approvals, drills to its lines with Back, each line opens its record)
and is emailed to the owners through the outbox only when the company has
email connected. Demo and suspended customers are skipped.

The last two one-person dead ends (migration 0064) follow the same rule,
audit row, "(self-approved)" marking and support-mode refusal. A payment or
payroll run may be released by its own builder only as the owner when nobody
else in the company could release it (no other owner or controller, nor an
approver or A/P clerk for payment runs, nor HR for payroll:
`approvals.RUN_RELEASERS`); the run's total is typed, the run is marked
`self_released`, and `self_released_guard(<roles>)` with the relaxed
`*_two_people` checks holds the same line in the database. A bill stopped at
the gates may be let through by whoever entered it only as the owner when no
other owner or controller is here (`approvals.GATE_SIGN_OFF`); nothing is
typed. The bill now records `accepted_by`, `accepted_at` and `self_accepted`,
and `invoice_accept_guard` enforces both rules in the database: not the
enterer, unless it is that self-accepted case. The count, run and bill screens
offer the action (`self_ok`, `self_accept_ok`) only when the rule allows it.
Both go into the owner digest (flows `release` and `gate`).

Phones: long words (emails, addresses, key fingerprints) wrap
(`overflow-wrap:anywhere`) in row notes, leads, result boxes, dialog titles,
labels and buttons, in the app and in the web store and trade portal.

The reports check's "rows in every dataset" no longer depends on the finance
smoke: the demo's seeds have no vendor bills, so `vendor_spend` had rows only
when `npm run smoke` had run on that database since its last reset. The check
now brings its own bill and rolls it back.

