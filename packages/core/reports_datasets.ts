// The dataset catalog for the report creator. A person never writes SQL:
// they pick a dataset from this list and fields from its list. Each dataset is
// one fixed query written here, scoped to the company by `$1` (entity id) in
// every table it reads, and each field is a named, typed column of it.
//
// The query builder in reports.ts only ever wraps these in
// `select ... from (<base>) d where ...`, naming fields by id from the list
// below, with every value a person typed passed as a parameter.

export type FieldType = "text" | "number" | "money" | "date" | "bool";

export type Field = {
  id: string;
  label: string;
  type: FieldType;
  /** false for ids, names and dates: they can be counted, not summed */
  agg?: boolean;
  hint?: string;
};

export type Dataset = {
  id: string;
  label: string;
  folder: string;
  description: string;
  /** roles that may define or run a report on it (owner always may) */
  roles: string[];
  /** shown only when one of these modules is on for the company (empty = always) */
  modules: string[];
  /** the date field a date-range prompt applies to by default */
  dateField: string | null;
  /** fields shown when drilling from a grouped row to its detail */
  detail: string[];
  /** a hidden column holding a journal entry id, for drilling to /books/entry */
  entryField?: string;
  fields: Field[];
  /** select ... with every field id as a column alias; must scope every table by $1 */
  sql: string;
};

const F = (id: string, label: string, type: FieldType, extra: Partial<Field> = {}): Field =>
  ({ id, label, type, agg: type === "money" || type === "number", ...extra });

const FINANCE = ["controller", "viewer"];
const SALES = ["controller", "viewer", "store_manager", "sales", "buyer"];

// The P&L sections the Books screen uses, by account code.
const SECTION = `case when ga.code like '4%' then 'Revenue' when ga.code like '5%' then 'Cost of merchandise'
                      when ga.code like '6%' then 'Operating expenses' else 'Other expenses' end`;
const VENDOR = `coalesce(nullif(v.dba, ''), v.legal_name)`;

export const DATASETS: Dataset[] = [
  {
    id: "gl_lines", label: "General ledger lines", folder: "Finance", modules: [], roles: FINANCE,
    description: "Every posted journal line: date, account, store, where it came from, debit and credit.",
    dateField: "posted_on", detail: ["posted_on", "account", "store", "description", "debit", "credit"], entryField: "entry_id",
    fields: [
      F("posted_on", "Posting date", "date"), F("period", "Period", "text", { hint: "YYYY-MM" }),
      F("account_code", "Account code", "text"), F("account_name", "Account name", "text"), F("account", "Account", "text"),
      F("account_type", "Account type", "text"), F("store", "Store", "text"), F("source", "Source", "text"),
      F("description", "Description", "text"), F("memo", "Memo", "text"), F("bank_account", "Bank account", "text"),
      F("debit", "Debit", "money"), F("credit", "Credit", "money"), F("net", "Net (debit − credit)", "money"),
      F("entry_id", "Entry", "text", { agg: false }),
    ],
    sql: `select je.posting_date as posted_on, to_char(je.posting_date, 'YYYY-MM') as period,
                 ga.code as account_code, ga.name as account_name, ga.code || ' ' || ga.name as account,
                 ga.account_type, coalesce(po.name, 'Company') as store, je.source_type as source,
                 je.description, jl.memo, ba.name as bank_account,
                 jl.debit_minor as debit, jl.credit_minor as credit, jl.debit_minor - jl.credit_minor as net,
                 je.id::text as entry_id
            from journal_line jl
            join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
            join gl_account ga on ga.id = jl.gl_account_id
            left join profit_object po on po.id = jl.profit_object_id and po.entity_id = $1
            left join bank_account ba on ba.id = jl.bank_account_id and ba.entity_id = $1`,
  },
  {
    id: "pnl_lines", label: "Profit and loss lines", folder: "Finance", modules: [], roles: FINANCE,
    description: "Revenue and expense lines with the P&L sign (revenue up, costs up), by section, account and store. Ties to Books.",
    dateField: "posted_on", detail: ["posted_on", "account", "store", "description", "amount"], entryField: "entry_id",
    fields: [
      F("posted_on", "Posting date", "date"), F("section", "Section", "text"), F("account_code", "Account code", "text"),
      F("account", "Account", "text"), F("account_type", "Account type", "text"), F("store", "Store", "text"),
      F("source", "Source", "text"), F("description", "Description", "text"),
      F("amount", "Amount", "money", { hint: "revenue as credit − debit; costs as debit − credit" }),
      F("net_income", "Net income effect", "money", { hint: "revenue positive, costs negative" }),
      F("entry_id", "Entry", "text", { agg: false }),
    ],
    sql: `select je.posting_date as posted_on, ${SECTION} as section, ga.code as account_code, ga.code || ' ' || ga.name as account,
                 ga.account_type, coalesce(po.name, 'Company') as store, je.source_type as source, je.description,
                 case when ga.account_type = 'revenue' then jl.credit_minor - jl.debit_minor else jl.debit_minor - jl.credit_minor end as amount,
                 jl.credit_minor - jl.debit_minor as net_income,
                 je.id::text as entry_id
            from journal_line jl
            join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
            join gl_account ga on ga.id = jl.gl_account_id and ga.account_type in ('revenue', 'expense')
            left join profit_object po on po.id = jl.profit_object_id and po.entity_id = $1`,
  },
  {
    id: "trial_balance", label: "Trial balance", folder: "Finance", modules: [], roles: FINANCE,
    description: "Journal lines summed by account. Filter posting date on or before a day for a balance as of that day.",
    dateField: "posted_on", detail: ["posted_on", "account", "debit", "credit"], entryField: "entry_id",
    fields: [
      F("posted_on", "Posting date", "date"), F("account_code", "Account code", "text"), F("account", "Account", "text"),
      F("account_type", "Account type", "text"), F("normal_balance", "Normal balance", "text"),
      F("debit", "Debit", "money"), F("credit", "Credit", "money"), F("balance", "Balance (debit − credit)", "money"),
      F("entry_id", "Entry", "text", { agg: false }),
    ],
    sql: `select je.posting_date as posted_on, ga.code as account_code, ga.code || ' ' || ga.name as account, ga.account_type,
                 case ga.normal_balance when 'D' then 'Debit' else 'Credit' end as normal_balance,
                 jl.debit_minor as debit, jl.credit_minor as credit, jl.debit_minor - jl.credit_minor as balance,
                 je.id::text as entry_id
            from journal_line jl
            join journal_entry je on je.id = jl.journal_entry_id and je.entity_id = $1
            join gl_account ga on ga.id = jl.gl_account_id`,
  },
  {
    id: "sales_lines", label: "Sales order lines", folder: "Sales", modules: ["pos", "shop"], roles: SALES,
    description: "Every line written on a sales order, any channel, when it was ordered: what sold, who sold it, price, discount, cost and margin.",
    dateField: "ordered_on", detail: ["ordered_on", "order_number", "store", "product", "qty", "net", "line_status"],
    fields: [
      F("ordered_on", "Ordered on", "date"), F("order_number", "Order", "text"), F("channel", "Channel", "text"),
      F("store", "Store", "text"), F("salesperson", "Salesperson", "text"), F("customer", "Customer", "text"),
      F("sku", "SKU", "text"), F("product", "Product", "text"), F("category", "Category", "text"), F("vendor", "Vendor", "text"),
      F("brand", "Brand", "text"), F("qty", "Quantity", "number"), F("unit_price", "Unit price", "money"),
      F("gross", "Gross (qty × price)", "money"), F("discount", "Discount", "money"), F("net", "Net sales", "money"),
      F("tax", "Tax", "money"), F("cost", "Cost (est.)", "money", { hint: "cost when sold, else the product's standard cost" }),
      F("margin", "Margin", "money"), F("fulfillment", "Fulfillment", "text"), F("line_status", "Line status", "text"),
      F("order_status", "Order status", "text"),
    ],
    sql: `select so.ordered_at::date as ordered_on, so.number as order_number, so.channel,
                 lo.name as store, su.name as salesperson, cu.name as customer, l.sku, l.description as product,
                 p.category, ${VENDOR} as vendor, p.brand, l.qty,
                 l.unit_price_minor as unit_price, round(l.qty * l.unit_price_minor)::bigint as gross, l.discount_minor as discount,
                 round(l.qty * l.unit_price_minor)::bigint - l.discount_minor as net, l.tax_minor as tax,
                 round(l.qty * coalesce(pl.unit_cost_minor, p.cost_minor, 0))::bigint as cost,
                 round(l.qty * l.unit_price_minor)::bigint - l.discount_minor - round(l.qty * coalesce(pl.unit_cost_minor, p.cost_minor, 0))::bigint as margin,
                 coalesce(pl.fulfillment, so.fulfillment) as fulfillment, l.line_status, so.status as order_status
            from sales_order_line l
            join sales_order so on so.id = l.sales_order_id and so.entity_id = $1
            left join pos_line pl on pl.sales_order_line_id = l.id and pl.entity_id = $1
            left join product p on p.id = l.product_id and p.entity_id = $1
            left join vendor v on v.id = p.vendor_id
            left join location lo on lo.id = so.location_id and lo.entity_id = $1
            left join app_user su on su.id = so.salesperson_id
            left join customer cu on cu.id = so.customer_id and cu.entity_id = $1
           where l.entity_id = $1 and coalesce(pl.role, 'item') = 'item'`,
  },
  {
    id: "sales_posted", label: "Sales posted (invoiced and returned)", folder: "Sales", modules: ["pos", "shop"], roles: [...SALES, "ar_clerk"],
    description: "Sales as the books see them: each invoiced line when it was handed over or delivered, and each return when it came back. Its net ties to the revenue posted for sales and returns.",
    dateField: "posted_on", detail: ["posted_on", "document", "store", "product", "qty", "net"], entryField: "entry_id",
    fields: [
      F("posted_on", "Posted on", "date"), F("kind", "Kind", "text"), F("document", "Invoice or return", "text"),
      F("order_number", "Order", "text"), F("channel", "Channel", "text"), F("channel_group", "Web or store", "text"),
      F("store", "Store", "text"), F("salesperson", "Salesperson", "text"), F("customer", "Customer", "text"),
      F("sku", "SKU", "text"), F("product", "Product", "text"), F("category", "Category", "text"), F("vendor", "Vendor", "text"),
      F("revenue_account", "Revenue account", "text"), F("qty", "Quantity", "number"), F("net", "Net sales", "money"),
      F("tax", "Tax", "money"), F("cost", "Cost (est.)", "money", { hint: "cost when sold, else the product's standard cost" }),
      F("margin", "Margin", "money"), F("entry_id", "Entry", "text", { agg: false }),
    ],
    sql: `select ci.invoice_date as posted_on, 'sale' as kind, ci.number as document, so.number as order_number, so.channel,
                 case when so.channel = 'web' then 'Web' else 'Store' end as channel_group,
                 lo.name as store, su.name as salesperson, cu.name as customer, il.sku,
                 coalesce(sl.description, il.description) as product, p.category, ${VENDOR} as vendor, il.revenue_code as revenue_account,
                 il.qty, il.net_minor as net, il.tax_minor as tax,
                 round(il.qty * coalesce(pl.unit_cost_minor, p.cost_minor, 0))::bigint as cost,
                 il.net_minor - round(il.qty * coalesce(pl.unit_cost_minor, p.cost_minor, 0))::bigint as margin,
                 ci.journal_entry_id::text as entry_id
            from customer_invoice_line il
            join customer_invoice ci on ci.id = il.invoice_id and ci.entity_id = $1 and ci.kind = 'sale'
            left join sales_order_line sl on sl.id = il.sales_order_line_id and sl.entity_id = $1
            left join sales_order so on so.id = ci.sales_order_id and so.entity_id = $1
            left join pos_line pl on pl.sales_order_line_id = sl.id and pl.entity_id = $1
            left join product p on p.id = sl.product_id and p.entity_id = $1
            left join vendor v on v.id = p.vendor_id
            left join location lo on lo.id = ci.location_id and lo.entity_id = $1
            left join app_user su on su.id = so.salesperson_id
            left join customer cu on cu.id = ci.customer_id and cu.entity_id = $1
           where il.entity_id = $1
          union all
          select je.posting_date, 'return', so.number, orig.number, so.channel,
                 case when so.channel = 'web' or orig.channel = 'web' then 'Web' else 'Store' end,
                 lo.name, su.name, cu.name, l.sku, l.description, p.category, ${VENDOR},
                 case when p.kind in ('fee', 'service') then '4030' when p.kind = 'warranty' then '4040' else '4900' end,
                 l.qty, round(l.qty * l.unit_price_minor)::bigint, 0::bigint,
                 round(l.qty * coalesce(p.cost_minor, 0))::bigint,
                 round(l.qty * l.unit_price_minor)::bigint - round(l.qty * coalesce(p.cost_minor, 0))::bigint,
                 je.id::text
            from sales_order_line l
            join pos_line pl on pl.sales_order_line_id = l.id and pl.entity_id = $1 and pl.role = 'item' and pl.original_line_id is not null
            join sales_order so on so.id = l.sales_order_id and so.entity_id = $1
            join journal_entry je on je.entity_id = $1 and je.source_type = 'refund' and je.source_id = so.id
            left join pos_order px on px.sales_order_id = so.id and px.entity_id = $1
            left join sales_order orig on orig.id = px.original_order_id and orig.entity_id = $1
            left join product p on p.id = l.product_id and p.entity_id = $1
            left join vendor v on v.id = p.vendor_id
            left join location lo on lo.id = so.location_id and lo.entity_id = $1
            left join app_user su on su.id = so.salesperson_id
            left join customer cu on cu.id = so.customer_id and cu.entity_id = $1
           where l.entity_id = $1 and l.line_status = 'returned'`,
  },
  {
    id: "orders", label: "Sales orders", folder: "Sales", modules: ["pos", "shop"], roles: SALES,
    description: "One row per order, any channel: totals, what has been paid and what is still owed.",
    dateField: "ordered_on", detail: ["ordered_on", "order_number", "channel", "store", "customer", "total", "balance"],
    fields: [
      F("ordered_on", "Ordered on", "date"), F("order_number", "Order", "text"), F("channel", "Channel", "text"),
      F("channel_group", "Web or store", "text"), F("store", "Store", "text"), F("salesperson", "Salesperson", "text"),
      F("customer", "Customer", "text"), F("status", "Status", "text"), F("fulfillment", "Fulfillment", "text"),
      F("promised_on", "Promised on", "date"), F("lines", "Lines", "number"), F("subtotal", "Subtotal", "money"),
      F("discount", "Discount", "money"), F("tax", "Tax", "money"), F("fees", "Fees", "money"), F("total", "Total", "money"),
      F("paid", "Paid", "money"), F("balance", "Balance owed", "money"),
    ],
    sql: `select so.ordered_at::date as ordered_on, so.number as order_number, so.channel,
                 case when so.channel = 'web' then 'Web' else 'Store' end as channel_group,
                 lo.name as store, su.name as salesperson, cu.name as customer, so.status, so.fulfillment, so.promised_on,
                 (select count(*) from sales_order_line x where x.sales_order_id = so.id and x.entity_id = $1)::int as lines,
                 so.subtotal_minor as subtotal, so.discount_minor as discount, so.tax_minor as tax, so.fees_minor as fees,
                 so.total_minor as total, so.paid_minor as paid, so.total_minor - so.paid_minor as balance
            from sales_order so
            left join location lo on lo.id = so.location_id and lo.entity_id = $1
            left join app_user su on su.id = so.salesperson_id
            left join customer cu on cu.id = so.customer_id and cu.entity_id = $1
           where so.entity_id = $1`,
  },
  {
    id: "receipts", label: "Receipts by tender", folder: "Sales", modules: ["pos", "shop", "ar"],
    roles: ["controller", "viewer", "store_manager", "cashier", "ar_clerk"],
    description: "Every dollar received at any door, by tender. Refunds are negative.",
    dateField: "received_on", detail: ["received_on", "number", "store", "tender", "customer", "amount"],
    fields: [
      F("received_on", "Received on", "date"), F("number", "Receipt", "text"), F("store", "Store", "text"),
      F("channel", "Channel", "text"), F("tender", "Tender", "text"), F("customer", "Customer", "text"),
      F("order_number", "Order", "text"), F("reference", "Reference", "text"), F("received_by", "Taken by", "text"),
      F("voided", "Voided", "bool"), F("amount", "Amount", "money"),
    ],
    sql: `select r.received_at::date as received_on, r.number, lo.name as store, r.channel, r.method as tender,
                 cu.name as customer, so.number as order_number, r.reference, u.name as received_by,
                 r.voided_at is not null as voided, r.amount_minor as amount
            from customer_receipt r
            left join location lo on lo.id = r.location_id and lo.entity_id = $1
            left join customer cu on cu.id = r.customer_id and cu.entity_id = $1
            left join sales_order so on so.id = r.sales_order_id and so.entity_id = $1
            left join app_user u on u.id = r.received_by
           where r.entity_id = $1`,
  },
  {
    id: "ar_open", label: "Receivables: open items and aging", folder: "Finance", modules: ["ar"],
    roles: ["controller", "viewer", "ar_clerk", "store_manager"],
    description: "What customers owe today: each open invoice, each financing contract and any cash not yet applied, aged by days past due.",
    dateField: "due_on", detail: ["customer", "document", "store", "due_on", "days_past_due", "open"],
    fields: [
      F("customer", "Customer", "text"), F("kind", "Kind", "text"), F("document", "Invoice or contract", "text"),
      F("store", "Store", "text"), F("invoice_date", "Dated", "date"), F("due_on", "Due on", "date"),
      F("days_past_due", "Days past due", "number"), F("bucket", "Aging bucket", "text"), F("bucket_order", "Bucket order", "number", { agg: false }),
      F("original", "Original amount", "money"), F("open", "Open balance", "money"),
    ],
    sql: `with items as (
            select cu.name as customer, i.kind, i.number as document, lo.name as store, i.invoice_date, i.due_date as due_on,
                   i.total_minor as original, sum(l.amount_minor) as open
              from ar_ledger l join customer_invoice i on i.id = l.invoice_id and i.entity_id = $1
              left join customer cu on cu.id = i.customer_id and cu.entity_id = $1
              left join location lo on lo.id = i.location_id and lo.entity_id = $1
             where l.entity_id = $1 and l.occurred_on <= current_date
             group by i.id, cu.name, lo.name having sum(l.amount_minor) <> 0
            union all
            select cu.name, 'contract', k.number, lo.name, k.opened_at::date,
                   (select min(x.due_on) from ar_contract_installment x where x.contract_id = k.id and x.entity_id = $1
                       and x.status = 'due' and x.principal_minor > x.paid_principal_minor),
                   k.principal_minor, sum(l.amount_minor)
              from ar_ledger l join ar_contract k on k.id = l.contract_id and k.entity_id = $1
              join customer cu on cu.id = k.customer_id and cu.entity_id = $1
              left join location lo on lo.id = k.location_id and lo.entity_id = $1
             where l.entity_id = $1 and l.occurred_on <= current_date
             group by k.id, cu.name, lo.name having sum(l.amount_minor) <> 0
            union all
            select coalesce(cu.name, 'Cash sales (no customer)'), 'unapplied', null, lo.name, null, null, null, sum(l.amount_minor)
              from ar_ledger l
              left join customer cu on cu.id = l.customer_id and cu.entity_id = $1
              left join location lo on lo.id = l.location_id and lo.entity_id = $1
             where l.entity_id = $1 and l.occurred_on <= current_date and l.invoice_id is null and l.contract_id is null
             group by l.customer_id, cu.name, l.location_id, lo.name having sum(l.amount_minor) <> 0)
          select customer, kind, document, store, invoice_date, due_on,
                 case when kind = 'unapplied' or due_on is null then 0 else greatest(0, current_date - due_on) end as days_past_due,
                 case when kind = 'unapplied' then 'Unapplied'
                      when due_on is null or current_date - due_on <= 0 then 'Current'
                      when current_date - due_on <= 30 then '1–30'
                      when current_date - due_on <= 60 then '31–60'
                      when current_date - due_on <= 90 then '61–90' else 'Over 90' end as bucket,
                 case when kind = 'unapplied' then 6 when due_on is null or current_date - due_on <= 0 then 1
                      when current_date - due_on <= 30 then 2 when current_date - due_on <= 60 then 3
                      when current_date - due_on <= 90 then 4 else 5 end as bucket_order,
                 original, open
            from items /* entity_id = $1 inside every branch */`,
  },
  {
    id: "customers", label: "Customers", folder: "Sales", modules: [], roles: [...SALES, "ar_clerk", "web_admin"],
    description: "One row per customer: home store, orders, lifetime sales and what they owe.",
    dateField: "created_on", detail: ["number", "customer", "home_store", "orders", "lifetime_sales", "balance"],
    fields: [
      F("number", "Customer number", "text"), F("customer", "Customer", "text"), F("kind", "Kind", "text"),
      F("status", "Status", "text"), F("home_store", "Home store", "text"), F("email", "Email", "text"), F("phone", "Phone", "text"),
      F("marketing_ok", "Marketing allowed", "bool"), F("created_on", "Customer since", "date"), F("last_order_on", "Last order", "date"),
      F("orders", "Orders", "number"), F("lifetime_sales", "Lifetime sales", "money"), F("credit_limit", "Credit limit", "money"),
      F("balance", "Owes now", "money"),
    ],
    sql: `select cu.number, cu.name as customer, cu.kind, cu.status, lo.name as home_store, cu.email, cu.phone, cu.marketing_ok,
                 cu.created_at::date as created_on,
                 (select max(so.ordered_at)::date from sales_order so where so.entity_id = $1 and so.customer_id = cu.id) as last_order_on,
                 (select count(*) from sales_order so where so.entity_id = $1 and so.customer_id = cu.id and so.status not in ('draft', 'cancelled'))::int as orders,
                 coalesce((select sum(ci.subtotal_minor) from customer_invoice ci where ci.entity_id = $1 and ci.customer_id = cu.id and ci.kind = 'sale'), 0)::bigint as lifetime_sales,
                 cu.credit_limit_minor as credit_limit,
                 coalesce((select sum(l.amount_minor) from ar_ledger l where l.entity_id = $1 and l.customer_id = cu.id), 0)::bigint as balance
            from customer cu
            left join location lo on lo.id = cu.home_location_id and lo.entity_id = $1
           where cu.entity_id = $1`,
  },
  {
    id: "products_stock", label: "Products and stock by location", folder: "Inventory", modules: ["catalog", "inventory"],
    roles: ["controller", "viewer", "buyer", "warehouse", "store_manager", "sales"],
    description: "Each product at each location: on hand, reserved, available, on order, its value, and when it last sold.",
    dateField: "last_sold_on", detail: ["sku", "product", "location", "on_hand", "available", "last_sold_on"],
    fields: [
      F("sku", "SKU", "text"), F("product", "Product", "text"), F("kind", "Kind", "text"), F("category", "Category", "text"),
      F("vendor", "Vendor", "text"), F("brand", "Brand", "text"), F("status", "Product status", "text"),
      F("location", "Location", "text"), F("location_kind", "Location kind", "text"),
      F("price", "Price", "money"), F("unit_cost", "Average cost", "money"),
      F("on_hand", "On hand", "number"), F("reserved", "Reserved", "number"), F("available", "Available", "number"),
      F("on_order", "On order", "number"), F("stock_value", "Value at cost", "money"), F("retail_value", "Value at price", "money"),
      F("last_sold_on", "Last sold", "date"),
      F("idle_days", "Days without a sale", "number", { hint: "since the last sale, or since the product was added if it never sold" }),
    ],
    sql: `select p.sku, p.name as product, p.kind, p.category, ${VENDOR} as vendor, p.brand, p.status,
                 lo.name as location, lo.kind as location_kind, p.price_minor as price,
                 coalesce(case when ic.qty > 0 then round(ic.value_minor / ic.qty) end, p.cost_minor)::bigint as unit_cost,
                 coalesce(a.on_hand, 0) as on_hand, coalesce(a.reserved, 0) as reserved, coalesce(a.available, 0) as available,
                 coalesce(a.on_order, 0) as on_order,
                 round(coalesce(a.on_hand, 0) * coalesce(case when ic.qty > 0 then ic.value_minor / ic.qty end, p.cost_minor, 0))::bigint as stock_value,
                 round(coalesce(a.on_hand, 0) * p.price_minor)::bigint as retail_value,
                 ls.last_sold_on,
                 (current_date - coalesce(ls.last_sold_on, p.created_at::date))::int as idle_days
            from product p
            left join product_availability a on a.product_id = p.id and a.entity_id = $1
            left join location lo on lo.id = a.location_id and lo.entity_id = $1
            left join inv_cost ic on ic.product_id = p.id and ic.entity_id = $1
            left join vendor v on v.id = p.vendor_id
            left join lateral (select max(so.ordered_at)::date as last_sold_on
                                 from sales_order_line l join sales_order so on so.id = l.sales_order_id and so.entity_id = $1
                                where l.entity_id = $1 and l.product_id = p.id and l.qty > 0
                                  and l.line_status in ('fulfilled', 'reserved', 'open', 'on_order')
                                  and so.status not in ('draft', 'cancelled')) ls on true
           where p.entity_id = $1`,
  },
  {
    id: "inventory_value", label: "Inventory valuation", folder: "Inventory", modules: ["inventory"],
    roles: ["controller", "viewer", "buyer", "warehouse"],
    description: "What the stock is worth at average cost, product by product: the figure behind the inventory account.",
    dateField: null, detail: ["sku", "product", "category", "qty", "value"],
    fields: [
      F("sku", "SKU", "text"), F("product", "Product", "text"), F("category", "Category", "text"), F("vendor", "Vendor", "text"),
      F("brand", "Brand", "text"), F("qty", "Quantity", "number"), F("value", "Value at cost", "money"),
      F("unit_cost", "Average cost", "money"), F("retail_value", "Value at price", "money"),
    ],
    sql: `select p.sku, p.name as product, p.category, ${VENDOR} as vendor, p.brand, ic.qty, ic.value_minor as value,
                 case when ic.qty > 0 then round(ic.value_minor / ic.qty)::bigint end as unit_cost,
                 round(ic.qty * p.price_minor)::bigint as retail_value
            from inv_cost ic
            join product p on p.id = ic.product_id and p.entity_id = $1
            left join vendor v on v.id = p.vendor_id
           where ic.entity_id = $1`,
  },
  {
    id: "po_lines", label: "Purchase order lines", folder: "Purchasing", modules: ["purchasing"],
    roles: ["controller", "viewer", "buyer", "warehouse", "store_manager"],
    description: "What has been ordered from vendors, what has arrived, and what is still to come.",
    dateField: "ordered_on", detail: ["po_number", "vendor", "description", "qty", "received", "open_qty", "expected_on"],
    fields: [
      F("po_number", "PO", "text"), F("ordered_on", "Ordered on", "date"), F("vendor", "Vendor", "text"), F("kind", "PO kind", "text"),
      F("status", "PO status", "text"), F("ship_to", "Ship to", "text"), F("category", "Category", "text"), F("sku", "Vendor SKU", "text"),
      F("description", "Description", "text"), F("expected_on", "Expected on", "date"), F("ack_status", "Acknowledgment", "text"),
      F("special_order", "For a customer", "bool"), F("qty", "Ordered", "number"), F("received", "Received", "number"),
      F("cancelled", "Cancelled", "number"), F("open_qty", "Still to come", "number"), F("unit_cost", "Unit cost", "money"),
      F("extended", "Ordered value", "money"), F("open_value", "Value still to come", "money"),
    ],
    sql: `select po.number as po_number, po.ordered_on, ${VENDOR} as vendor, po.kind, po.status, lo.name as ship_to,
                 pl.category, pl.vendor_sku as sku, pl.description, coalesce(pl.expected_on, po.expected_on) as expected_on,
                 pl.ack_status,
                 exists (select 1 from po_line_sales_line x where x.entity_id = $1 and x.purchase_order_line_id = pl.id and x.active) as special_order,
                 pl.quantity as qty, coalesce(r.received, 0) as received, pl.cancelled_qty as cancelled,
                 greatest(0, pl.quantity - pl.cancelled_qty - coalesce(r.received, 0)) as open_qty,
                 pl.unit_price_minor as unit_cost, round(pl.quantity * pl.unit_price_minor)::bigint as extended,
                 round(greatest(0, pl.quantity - pl.cancelled_qty - coalesce(r.received, 0)) * pl.unit_price_minor)::bigint as open_value
            from purchase_order_line pl
            join purchase_order po on po.id = pl.purchase_order_id and po.entity_id = $1
            left join vendor v on v.id = po.vendor_id
            left join location lo on lo.id = po.ship_to_location_id and lo.entity_id = $1
            left join lateral (select sum(gl.quantity) as received from goods_receipt_line gl
                                 join goods_receipt g on g.id = gl.goods_receipt_id
                                where gl.purchase_order_line_id = pl.id) r on true
           where pl.entity_id = $1`,
  },
  {
    id: "vendor_spend", label: "Vendor spend (bills)", folder: "Purchasing", modules: [], roles: ["controller", "viewer", "ap_clerk", "buyer"],
    description: "Every bill line entered in payables: vendor, what it was for (merchandise category or expense account), store and amount.",
    dateField: "bill_date", detail: ["bill_date", "vendor", "reference", "spend_category", "amount"],
    fields: [
      F("bill_date", "Bill date", "date"), F("due_date", "Due date", "date"), F("vendor", "Vendor", "text"),
      F("reference", "Bill number", "text"), F("kind", "Bill kind", "text"), F("status", "Status", "text"),
      F("spend_category", "Spend category", "text", { hint: "the PO line's merchandise category, else the expense account" }),
      F("account", "Account", "text"), F("store", "Store", "text"), F("description", "Description", "text"),
      F("amount", "Amount", "money"),
    ],
    sql: `select i.invoice_date as bill_date, i.due_date, ${VENDOR} as vendor, i.reference, i.kind, i.status,
                 coalesce(pol.category, ga.name, 'Uncoded') as spend_category, ga.code || ' ' || ga.name as account,
                 po.name as store, il.description, il.amount_minor as amount
            from invoice_line il
            join invoice i on i.id = il.invoice_id and i.entity_id = $1
            left join vendor v on v.id = i.vendor_id
            left join gl_account ga on ga.id = il.gl_account_id
            left join profit_object po on po.id = il.profit_object_id and po.entity_id = $1
            left join purchase_order_line pol on pol.id = il.purchase_order_line_id and pol.entity_id = $1
           where i.entity_id = $1 and i.status not in ('rejected', 'void', 'voided')`,
  },
  {
    id: "payroll", label: "Payroll register", folder: "People", modules: [], roles: ["controller", "hr"],
    description: "Each person on each payroll run: hours, gross, taxes, deductions, net and what it cost the company.",
    dateField: "pay_date", detail: ["pay_date", "employee", "store", "gross", "net"],
    fields: [
      F("pay_date", "Pay date", "date"), F("period_start", "Period start", "date"), F("period_end", "Period end", "date"),
      F("pay_group", "Pay group", "text"), F("run_status", "Run status", "text"), F("employee", "Employee", "text"),
      F("employee_no", "Employee number", "text"), F("position", "Position", "text"), F("store", "Store", "text"),
      F("department", "Department", "text"), F("regular_hours", "Regular hours", "number"), F("overtime_hours", "Overtime hours", "number"),
      F("gross", "Gross pay", "money"), F("employee_tax", "Employee taxes", "money"), F("employer_tax", "Employer taxes", "money"),
      F("deductions", "Deductions", "money"), F("net", "Net pay", "money"), F("total_cost", "Cost to company", "money"),
    ],
    sql: `select pp.pay_date, pp.starts_on as period_start, pp.ends_on as period_end, pg.name as pay_group, pr.status as run_status,
                 e.first_name || ' ' || e.last_name as employee, e.employee_no, e.position, po.name as store, d.name as department,
                 l.regular_hours, l.overtime_hours, l.gross_minor as gross, l.employee_tax_minor as employee_tax,
                 l.employer_tax_minor as employer_tax, l.deductions_minor as deductions, l.net_minor as net,
                 l.gross_minor + l.employer_tax_minor as total_cost
            from payroll_line l
            join payroll_run pr on pr.id = l.payroll_run_id and pr.entity_id = $1
            join pay_period pp on pp.id = pr.pay_period_id
            join pay_group pg on pg.id = pp.pay_group_id and pg.entity_id = $1
            join employee e on e.id = l.employee_id and e.entity_id = $1
            left join profit_object po on po.id = l.profit_object_id and po.entity_id = $1
            left join department d on d.id = l.department_id`,
  },
  {
    id: "commissions", label: "Commissions", folder: "People", modules: ["workforce"], roles: ["controller", "hr", "store_manager"],
    description: "Every commission, spiff and chargeback earned: who, on which order, the basis, the rate and the amount.",
    dateField: "earned_on", detail: ["earned_on", "salesperson", "kind", "order_number", "amount"],
    fields: [
      F("earned_on", "Earned on", "date"), F("salesperson", "Salesperson", "text"), F("kind", "Kind", "text"),
      F("status", "Status", "text"), F("store", "Store", "text"), F("order_number", "Order", "text"),
      F("split_pct", "Split %", "number"), F("sale", "Sale", "money"), F("cost", "Cost", "money"), F("basis", "Basis", "money"),
      F("rate_pct", "Rate %", "number"), F("amount", "Commission", "money"),
    ],
    sql: `select ce.earned_on, u.name as salesperson, ce.kind, ce.status, lo.name as store, so.number as order_number,
                 ce.split_bps / 100.0 as split_pct, ce.sale_minor as sale, ce.cost_minor as cost, ce.basis_minor as basis,
                 ce.rate_bps / 100.0 as rate_pct, ce.amount_minor as amount
            from commission_event ce
            left join app_user u on u.id = ce.app_user_id
            left join location lo on lo.id = ce.location_id and lo.entity_id = $1
            left join sales_order so on so.id = ce.sales_order_id and so.entity_id = $1
           where ce.entity_id = $1`,
  },
  {
    id: "deliveries", label: "Delivery stops", folder: "Operations", modules: ["fleet"],
    roles: ["controller", "viewer", "dispatcher", "store_manager"],
    description: "Every delivery and pickup stop: when, who drove, whether it arrived inside its window, and what went wrong.",
    dateField: "scheduled_on", detail: ["scheduled_on", "number", "driver", "customer", "status", "on_time"],
    fields: [
      F("scheduled_on", "Scheduled on", "date"), F("number", "Stop", "text"), F("kind", "Kind", "text"), F("status", "Status", "text"),
      F("from_location", "From", "text"), F("zone", "Zone", "text"), F("time_window", "Window", "text"), F("route", "Route", "text"),
      F("driver", "Driver", "text"), F("vehicle", "Truck", "text"), F("customer", "Customer", "text"), F("order_number", "Order", "text"),
      F("pieces", "Pieces", "number"), F("cube_ft", "Cubic feet", "number"),
      F("timed", "Done with a window", "bool", { hint: "completed and booked into a time window: what on-time is measured on" }),
      F("on_time", "Arrived on time", "bool"), F("late_minutes", "Minutes late", "number"),
      F("exception", "Exception", "text"),
    ],
    sql: `select s.scheduled_on, s.number, s.kind, s.status, lo.name as from_location, z.name as zone,
                 coalesce(w.label, to_char(w.starts, 'HH24:MI') || '–' || to_char(w.ends, 'HH24:MI')) as time_window,
                 r.number as route, du.name as driver, vh.unit_no as vehicle, cu.name as customer, so.number as order_number,
                 s.pieces, s.cube_ft,
                 (s.completed_at is not null and w.ends is not null) as timed,
                 case when s.completed_at is null or w.ends is null then null
                      else (s.arrived_at at time zone tz.tz)::time <= w.ends end as on_time,
                 case when s.completed_at is null or w.ends is null then null
                      else greatest(0, extract(epoch from ((s.arrived_at at time zone tz.tz)::time - w.ends)) / 60)::int end as late_minutes,
                 coalesce(s.exception_reason, s.exception) as exception
            from delivery_stop s
            cross join (select coalesce((select time_zone from fleet_setting where entity_id = $1), 'America/Chicago') as tz) tz
            left join delivery_window w on w.id = s.window_id and w.entity_id = $1
            left join delivery_zone z on z.id = s.zone_id and z.entity_id = $1
            left join delivery_route r on r.id = s.route_id and r.entity_id = $1
            left join app_user du on du.id = r.driver_id
            left join vehicle vh on vh.id = r.vehicle_id and vh.entity_id = $1
            left join location lo on lo.id = s.dc_location_id and lo.entity_id = $1
            left join customer cu on cu.id = s.customer_id and cu.entity_id = $1
            left join sales_order so on so.id = s.sales_order_id and so.entity_id = $1
           where s.entity_id = $1`,
  },
  {
    id: "routes", label: "Delivery routes", folder: "Operations", modules: ["fleet"], roles: ["controller", "viewer", "dispatcher"],
    description: "One row per truck route: driver, truck, stops, planned and driven miles and minutes.",
    dateField: "route_on", detail: ["route_on", "route", "driver", "stops", "planned_miles", "actual_miles"],
    fields: [
      F("route_on", "Route date", "date"), F("route", "Route", "text"), F("status", "Status", "text"), F("from_location", "From", "text"),
      F("driver", "Driver", "text"), F("helper", "Helper", "text"), F("vehicle", "Truck", "text"), F("stops", "Stops", "number"),
      F("planned_miles", "Planned miles", "number"), F("actual_miles", "Miles driven", "number"),
      F("planned_minutes", "Planned minutes", "number"),
    ],
    sql: `select r.route_on, r.number as route, r.status, lo.name as from_location, du.name as driver, hu.name as helper,
                 vh.unit_no as vehicle,
                 (select count(*) from delivery_stop s where s.entity_id = $1 and s.route_id = r.id and s.status <> 'cancelled')::int as stops,
                 r.planned_miles, coalesce(r.actual_miles, case when r.end_odometer is not null then r.end_odometer - r.start_odometer end) as actual_miles,
                 r.planned_minutes
            from delivery_route r
            left join app_user du on du.id = r.driver_id
            left join app_user hu on hu.id = r.helper_id
            left join vehicle vh on vh.id = r.vehicle_id and vh.entity_id = $1
            left join location lo on lo.id = r.dc_location_id and lo.entity_id = $1
           where r.entity_id = $1`,
  },
  {
    id: "web_carts", label: "Web store carts", folder: "Sales", modules: ["shop"], roles: ["controller", "viewer", "web_admin", "store_manager"],
    description: "Every cart started on the web store: what was in it, whether it became an order, and when it was last touched.",
    dateField: "started_on", detail: ["started_on", "site", "items", "subtotal", "converted", "order_number"],
    fields: [
      F("started_on", "Started on", "date"), F("updated_on", "Last touched", "date"), F("site", "Site", "text"),
      F("has_email", "Left an email", "bool"), F("items", "Items", "number"), F("subtotal", "Cart subtotal", "money"),
      F("converted", "Became an order", "bool"), F("order_number", "Order", "text"), F("order_total", "Order total", "money"),
    ],
    sql: `select c.created_at::date as started_on, c.updated_at::date as updated_on,
                 s.display_name as site, c.email is not null and c.email <> '' as has_email, c.item_count as items,
                 c.subtotal_minor as subtotal, c.sales_order_id is not null as converted, so.number as order_number,
                 so.total_minor as order_total
            from shop_cart c
            left join shop_site s on s.id = c.site_id and s.entity_id = $1
            left join sales_order so on so.id = c.sales_order_id and so.entity_id = $1
           where c.entity_id = $1`,
  },
];

export const DATASET = new Map(DATASETS.map((d) => [d.id, d]));
