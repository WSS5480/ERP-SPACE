# Feature map — what the reference systems do, and what v1 must have

Compiled Nov 6 2026 from vendor pages, help docs, datasheets and reviews of
ERPNext (ERPN), STORIS (STO), NetSuite (NS), Furniture Wizard (FW),
RetailVantage (RV) and Renaissance (REN — RenComGroup's furniture e-commerce /
kiosk product; not an ERP). STORIS has the deepest public documentation;
FW and RV are thinly documented. Paraphrased; no vendor code or text copied.

## Must-have for v1, by module

**Catalog** — item master (SKU, vendor, vendor model, category, cost, retail, MAP); variants/options (fabric, finish, size, color); special-order templates per vendor/category with option dropdowns and price adders; kits/packages (5-pc set) with package vs component price; multi-carton pieces per item (count, cube, weight); price lists and scheduled promotions; price tags/labels/barcodes; images; vendor catalog CSV import with column mapping (our CATALOG-APP does this); drop/discontinued/floor-sample status; margin view.

**POS** — quote → sales order → invoice; special order auto-creates the PO (STO); deposits/partial payments; layaway; split tenders; financing tender; returns/exchanges with reason codes; delivery date at sale, several fulfillment types per order (take-with, pickup, delivery, direct ship); delivery fees and protection plans; salesperson(s) with split; signature + e-receipt; drawer open/close, Z report; tablet-first selling; manager overrides; audit of who changed a sale.

**Payroll / commissions** — plans on % of sale or % of margin, tiers; split sales; spiffs by SKU/vendor; chargeback on returns/cancels; earned on delivered or paid-in-full, not written; time clock; pay-period commission report feeding payroll; draw against commission; leaderboards. (Tax payroll stays behind the existing TaxProvider seam.)

**A/R** — customer and house accounts; deposits held as a liability until delivery; in-house installment contracts with amortization (STO only among the set); payment posting; statements; aging buckets; late fees; collections queue with promise-to-pay and callbacks, daily call list; letters/SMS/email; write-offs and recoveries; third-party finance tender with lender settlement reconciliation (Synchrony-type); lender cascade; repossession tracking.

**Warehouse** — multi-location stock (store, DC, floor); piece-level barcode tracking; aisles/racks/bins, putaway; receiving against PO with partials and a receiving calendar; transfers; allocation of stock to customer orders; available-to-promise with next PO ETA; damage/hold with repair and vendor claim (none of the six document this well — a differentiator); cycle counts; pick lists by truck route; as-is/clearance; adjustments with reasons; valuation.

**Fleet & delivery** — delivery calendar with zones and windows; capacity per truck/day (stops, pieces, cube, labor hours — STO); route builder with map and stop order; manifest incl. cash-on-delivery; driver phone app; proof of delivery (signature, photos, exceptions); customer texts (confirm, day-before, en route); customer self-scheduling (FW via Podium); service/repair calls on routes; will-call pickup; vehicle records tied to Geotab. STO does optimization via partners (DispatchTrack, Descartes) — we build it in.

**Purchasing** — vendor master; stock and special-order POs linked to the customer order; acknowledgment/ETA flowing back to the customer order (EDI 855); reorder points and auto-replenish suggestions; open-to-buy by category that moves when a sale closes; partial receipts and backorders; landed cost/freight allocation; vendor invoice matching (exists in AP); EDI-ready (855/856/810) via CSV first; vendor lead times.

**E-commerce / omnichannel** — catalog and stock feed; web orders land as the same order and customer record; real-time availability with delivery-date estimates; option configurator; BOPIS and deliver-from-DC; endless aisle on a store tablet (REN, RV); online finance application link; unified customer history; package pricing online; review/text hooks.

**Setup** — multi-company with separate GL per entity; multi-store; role permissions; furniture template preloaded (tenders, delivery zones, commission plans, chart of accounts); per-store tax; import wizards for items, customers, open A/R; branding per company/dba; audit log.

Sources: storis.com (POS, finance, delivery, EDI help docs), erpresearch.com (ERPNext modules), NetSuite retail and incentive-management datasheets, brokenrubik.com (NetSuite POS), Capterra/SoftwareAdvice/CIOReview/Podium (Furniture Wizard), SoftwareReview/TrustRadius/SDCExec/Furniture Today (RetailVantage), furninfo.com (Renaissance), fitsmallbusiness.com.
