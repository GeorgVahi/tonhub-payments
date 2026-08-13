import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AdminOverview,
  AdminPage,
  AdminSection,
} from "../../backend/src/admin/repository";

const sections: Array<{ id: AdminSection; label: string }> = [
  { id: "orders", label: "Orders" },
  { id: "movements", label: "Movements" },
  { id: "recovery", label: "Recovery" },
  { id: "sweeps", label: "Sweeps" },
  { id: "webhooks", label: "Webhooks" },
  { id: "audit", label: "Audit" },
];

function Field({ label, value, mono = false }: {
  label: string;
  value: unknown;
  mono?: boolean;
}) {
  const text = value === null || value === undefined || value === "" ? "—" : String(value);
  return (
    <div className="admin-field">
      <dt>{label}</dt>
      <dd className={mono ? "mono" : undefined}>{text}</dd>
    </div>
  );
}

function Status({ value }: { value: string }) {
  return <span className={`status status--${value.toLowerCase()}`}>{value.replaceAll("_", " ")}</span>;
}

function Csrf({ token }: { token: string }) {
  return <input type="hidden" name="csrfToken" value={token} />;
}

function AdminShell({
  username,
  active,
  csrfToken,
  title,
  notice,
  children,
}: {
  username: string;
  active?: AdminSection;
  csrfToken: string;
  title: string;
  notice?: string | null;
  children: ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>{`${title} · Tonhub Payments Admin`}</title>
        <link rel="stylesheet" href="/admin/styles.css" />
      </head>
      <body>
        <div className="admin-shell">
          <header className="topbar">
            <a className="brand" href="/admin"><span>TP</span> Operations</a>
            <div className="operator">
              <span>Signed in as <strong>{username}</strong></span>
              <form method="post" action="/admin/logout">
                <Csrf token={csrfToken} />
                <button className="button button--quiet" type="submit">Sign out</button>
              </form>
            </div>
          </header>
          <nav className="tabs" aria-label="Admin sections">
            <a className={!active ? "active" : undefined} href="/admin">Overview</a>
            {sections.map((section) => (
              <a
                key={section.id}
                className={active === section.id ? "active" : undefined}
                href={`/admin/${section.id}`}
              >
                {section.label}
              </a>
            ))}
          </nav>
          <main>
            <div className="page-heading">
              <div><span className="eyebrow">Merchant control plane</span><h1>{title}</h1></div>
              <span className="live-dot">Live database</span>
            </div>
            {notice ? <div className="notice" role="status">{notice}</div> : null}
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}

function RecoveryCard({ record, csrfToken }: { record: any; csrfToken: string }) {
  return (
    <article className="record record--alert">
      <div className="record__header">
        <div><span className="eyebrow">{record.reason}</span><h2>{record.title}</h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="Recovery ID" value={record.id} mono />
        <Field label="Movement" value={record.movementId} mono />
        <Field label="Order" value={record.orderId} mono />
        <Field label="Attempt" value={record.invoiceId} mono />
        <Field label="Opened" value={record.createdAt} />
        <Field label="Reviewed by" value={record.reviewedBy} />
      </dl>
      {record.details ? <pre>{JSON.stringify(record.details, null, 2)}</pre> : null}
      {record.status === "OPEN" ? (
        <form className="action-row" method="post" action="/admin/actions/recovery/review">
          <Csrf token={csrfToken} />
          <input type="hidden" name="recoveryId" value={record.id} />
          <button className="button" type="submit">Mark reviewed</button>
        </form>
      ) : null}
    </article>
  );
}

function SweepCard({ record, csrfToken }: { record: any; csrfToken: string }) {
  return (
    <article className={record.status === "FAILED" ? "record record--alert" : "record"}>
      <div className="record__header">
        <div><span className="eyebrow">{record.asset} sweep</span><h2 className="mono">{record.id}</h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="Deposit" value={record.depositAddress ?? record.depositAddressId} mono />
        <Field label="Order" value={record.orderId} mono />
        <Field label="Amount atomic" value={record.amountAtomic} mono />
        <Field label="Recipient" value={record.recipientAddress} mono />
        <Field label="Tx hash" value={record.transactionHash} mono />
        <Field label="Deposit seqno" value={record.seqno} mono />
        <Field label="Jetton query ID" value={record.queryId} mono />
        <Field label="Gas top-up" value={record.gasTopupAmountNano} mono />
        <Field label="Gas from" value={record.gasServiceAddress} mono />
        <Field label="Gas to" value={record.depositAddress} mono />
        <Field label="Gas seqno" value={record.gasTopupSeqno} mono />
        <Field label="Gas tx" value={record.gasTopupTransactionHash} mono />
        <Field label="Reserve repair" value={record.reserveTopupAmountNano} mono />
        <Field label="Reserve seqno" value={record.reserveTopupSeqno} mono />
        <Field label="Attempts" value={record.attempts} />
        <Field label="Started" value={record.startedAt} />
        <Field label="Sent" value={record.sentAt} />
        <Field label="Confirmed" value={record.confirmedAt} />
      </dl>
      {record.lastError ? <p className="error-copy">{record.lastError}</p> : null}
      {record.status === "FAILED" ? (
        <form className="action-row" method="post" action="/admin/actions/sweeps/retry">
          <Csrf token={csrfToken} />
          <input type="hidden" name="sweepId" value={record.id} />
          <button className="button" type="submit">Queue retry</button>
        </form>
      ) : null}
    </article>
  );
}

function OrderCard({ record }: { record: any }) {
  return (
    <article className="record">
      <div className="record__header">
        <div><span className="eyebrow">Order</span><h2 className="mono">{record.externalId ?? record.id}</h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="Order ID" value={record.id} mono />
        <Field label="Fiat obligation" value={`${record.fiatAmountMicros} µ${record.fiatCurrency}`} mono />
        <Field label="Credited" value={`${record.creditedFiatMicros} µ${record.fiatCurrency}`} mono />
        <Field label="Overpayment" value={`${record.overpaymentFiatMicros} µ${record.fiatCurrency}`} mono />
        <Field label="Created" value={record.createdAt} />
        <Field label="Updated" value={record.updatedAt} />
      </dl>
      <div className="attempt-list">
        {(record.invoices ?? []).map((invoice: any) => (
          <div className="attempt" key={invoice.id}>
            <div><strong>{invoice.asset}</strong> · {invoice.network}</div>
            <Status value={invoice.status} />
            <span className="mono">{invoice.amountAtomic} atomic</span>
            <span className="mono muted">{invoice.address}</span>
            <span className="mono muted">{invoice.id}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function MovementCard({ record, csrfToken }: { record: any; csrfToken: string }) {
  return (
    <article className="record">
      <div className="record__header">
        <div><span className="eyebrow">{record.direction} · {record.network}</span><h2>{record.asset} <span className="mono">{record.amountAtomic}</span></h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="From" value={record.fromAddress} mono />
        <Field label="To" value={record.toAddress} mono />
        <Field label="Master" value={record.jettonMasterAddress} mono />
        <Field label="Jetton wallet" value={record.jettonWalletAddress} mono />
        <Field label="Hash" value={record.transactionHash} mono />
        <Field label="LT" value={record.transactionLt} mono />
        <Field label="Blockchain time" value={record.blockchainAt} />
        <Field label="Fiat credit" value={record.fiatCreditMicros} mono />
        <Field label="Rate" value={record.rate ? `${record.rate.price} ${record.rate.quoteCurrency} · ${record.rate.source}` : null} mono />
        <Field label="Movement ID" value={record.id} mono />
      </dl>
      {record.allocations?.length ? (
        <div className="allocation-list">
          {record.allocations.map((allocation: any) => (
            <span key={allocation.id}>{allocation.kind} → <span className="mono">{allocation.orderId}</span> · {allocation.fiatCreditMicros} µ</span>
          ))}
        </div>
      ) : record.direction === "INCOMING" && record.status !== "REJECTED" ? (
        <details>
          <summary>Attach movement to order</summary>
          <form className="form-grid" method="post" action="/admin/actions/movements/attach">
            <Csrf token={csrfToken} />
            <input type="hidden" name="movementId" value={record.id} />
            <label>Order ID<input name="orderId" required maxLength={512} /></label>
            <label>Attempt ID<input name="invoiceId" required maxLength={512} /></label>
            <button className="button" type="submit">Validate and attach</button>
          </form>
        </details>
      ) : null}
    </article>
  );
}

function WebhookCard({ record, csrfToken }: { record: any; csrfToken: string }) {
  return (
    <article className="record">
      <div className="record__header">
        <div><span className="eyebrow">{record.topic}</span><h2 className="mono">{record.eventId}</h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="Aggregate" value={`${record.aggregateType}:${record.aggregateId}`} mono />
        <Field label="Attempts" value={record.attempts} />
        <Field label="Available" value={record.availableAt} />
        <Field label="Delivered" value={record.deliveredAt} />
        <Field label="Last error" value={record.lastError} />
      </dl>
      {record.deliveryAttempts?.length ? (
        <div className="allocation-list">
          {record.deliveryAttempts.map((attempt: any) => (
            <span key={attempt.id}>
              #{attempt.attemptNumber} · {attempt.status} · HTTP {attempt.httpStatus ?? "—"} · {attempt.durationMs ?? "—"} ms
              {attempt.error ? ` · ${attempt.error}` : ""}
            </span>
          ))}
        </div>
      ) : null}
      {record.status === "FAILED" ? (
        <form className="action-row" method="post" action="/admin/actions/webhooks/retry">
          <Csrf token={csrfToken} />
          <input type="hidden" name="outboxEventId" value={record.id} />
          <button className="button" type="submit">Retry delivery</button>
        </form>
      ) : null}
    </article>
  );
}

function AuditCard({ record }: { record: any }) {
  return (
    <article className="record">
      <div className="record__header">
        <div><span className="eyebrow">{record.action}</span><h2>{record.targetType}</h2></div>
        <span className="muted">{record.createdAt}</span>
      </div>
      <dl className="field-grid">
        <Field label="Operator" value={record.adminUsername} />
        <Field label="Target" value={record.targetId} mono />
        <Field label="Audit ID" value={record.id} mono />
      </dl>
      {record.payload ? <pre>{JSON.stringify(record.payload, null, 2)}</pre> : null}
    </article>
  );
}

function WebhookAttemptCard({ record }: { record: any }) {
  return (
    <article className={record.status === "FAILED" ? "record record--alert" : "record"}>
      <div className="record__header">
        <div><span className="eyebrow">{record.topic} · attempt #{record.attemptNumber}</span><h2 className="mono">{record.eventId}</h2></div>
        <Status value={record.status} />
      </div>
      <dl className="field-grid">
        <Field label="HTTP status" value={record.httpStatus} />
        <Field label="Duration ms" value={record.durationMs} />
        <Field label="Started" value={record.startedAt} />
        <Field label="Completed" value={record.completedAt} />
        <Field label="Error" value={record.error} />
        <Field label="Attempt ID" value={record.id} mono />
      </dl>
    </article>
  );
}

function RefundCard({ record }: { record: any }) {
  return (
    <article className="record">
      <div className="record__header">
        <div><span className="eyebrow">Registered refund · {record.network}</span><h2>{record.asset} <span className="mono">{record.amountAtomic}</span></h2></div>
        <Status value="REGISTERED" />
      </div>
      <dl className="field-grid">
        <Field label="From" value={record.fromAddress} mono />
        <Field label="To" value={record.toAddress} mono />
        <Field label="Master" value={record.jettonMasterAddress} mono />
        <Field label="Hash" value={record.transactionHash} mono />
        <Field label="LT" value={record.transactionLt} mono />
        <Field label="Blockchain time" value={record.blockchainAt} />
        <Field label="Order" value={record.orderId} mono />
        <Field label="Attempt" value={record.invoiceId} mono />
        <Field label="Registered by" value={record.registeredBy} />
      </dl>
    </article>
  );
}

function Pager({ page }: { page: AdminPage }) {
  const pages = Math.max(1, Math.ceil(page.total / 50));
  return (
    <nav className="pager" aria-label="Pagination">
      {page.page > 1 ? <a className="button button--quiet" href={`/admin/${page.section}?page=${page.page - 1}`}>Previous</a> : <span />}
      <span>Page {page.page} of {pages} · {page.total} records</span>
      {page.page < pages ? <a className="button button--quiet" href={`/admin/${page.section}?page=${page.page + 1}`}>Next</a> : <span />}
    </nav>
  );
}

function SecondaryPager({ page, label }: { page: AdminPage; label: string }) {
  const current = page.secondaryPage ?? 1;
  const total = page.secondaryTotal ?? 0;
  const pages = Math.max(1, Math.ceil(total / 50));
  const base = `/admin/${page.section}?page=${page.page}`;
  return (
    <nav className="pager" aria-label={`${label} pagination`}>
      {current > 1 ? <a className="button button--quiet" href={`${base}&secondaryPage=${current - 1}`}>Previous {label}</a> : <span />}
      <span>{label}: page {current} of {pages} · {total} records</span>
      {current < pages ? <a className="button button--quiet" href={`${base}&secondaryPage=${current + 1}`}>Next {label}</a> : <span />}
    </nav>
  );
}

export function renderAdminLogin(input: { error?: string | null }) {
  return `<!doctype html>${renderToStaticMarkup(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <title>Sign in · Tonhub Payments Admin</title>
        <link rel="stylesheet" href="/admin/styles.css" />
      </head>
      <body className="login-page">
        <main className="login-card">
          <span className="brand-mark">TP</span>
          <span className="eyebrow">Restricted operations</span>
          <h1>Merchant admin</h1>
          <p>Review ledger evidence and queue operational work. Signing keys are not available in this runtime.</p>
          {input.error ? <div className="notice notice--error" role="alert">{input.error}</div> : null}
          <form className="login-form" method="post" action="/admin/login">
            <label>Username<input name="username" autoComplete="username" required maxLength={128} autoFocus /></label>
            <label>Password<input type="password" name="password" autoComplete="current-password" required maxLength={1024} /></label>
            <button className="button" type="submit">Sign in</button>
          </form>
        </main>
      </body>
    </html>,
  )}`;
}

export function renderAdminOverview(input: {
  username: string;
  csrfToken: string;
  overview: AdminOverview;
  notice?: string | null;
}) {
  const { counts } = input.overview;
  return `<!doctype html>${renderToStaticMarkup(
    <AdminShell {...input} title="Operations overview">
      <section className="metrics" aria-label="Operational totals">
        <a href="/admin/orders"><span>Orders</span><strong>{counts.orders}</strong></a>
        <a href="/admin/recovery"><span>Open recovery</span><strong>{counts.openRecovery}</strong></a>
        <a href="/admin/sweeps"><span>Failed sweeps</span><strong>{counts.failedSweeps}</strong></a>
        <a href="/admin/webhooks"><span>Webhook backlog</span><strong>{counts.pendingWebhooks}</strong></a>
      </section>
      <section className="section-heading"><div><span className="eyebrow">Needs attention</span><h2>Oldest open recovery</h2></div></section>
      <div className="records">
        {input.overview.recovery.length
          ? input.overview.recovery.map((record) => <RecoveryCard key={record.id} record={record} csrfToken={input.csrfToken} />)
          : <div className="empty">No open recovery cases.</div>}
      </div>
      <section className="section-heading"><div><span className="eyebrow">Worker queue</span><h2>Failed asset sweeps</h2></div></section>
      <div className="records">
        {input.overview.sweeps.length
          ? input.overview.sweeps.map((record) => <SweepCard key={record.id} record={record} csrfToken={input.csrfToken} />)
          : <div className="empty">No failed asset sweeps.</div>}
      </div>
    </AdminShell>,
  )}`;
}

export function renderAdminSection(input: {
  username: string;
  csrfToken: string;
  page: AdminPage;
  notice?: string | null;
}) {
  const title = sections.find((section) => section.id === input.page.section)?.label ?? "Admin";
  return `<!doctype html>${renderToStaticMarkup(
    <AdminShell {...input} active={input.page.section} title={title}>
      {input.page.section === "sweeps" ? (
        <details className="operation-panel">
          <summary>Initiate a sweep job</summary>
          <form className="form-grid" method="post" action="/admin/actions/sweeps/queue">
            <Csrf token={input.csrfToken} />
            <input type="hidden" name="requestId" value={crypto.randomUUID()} />
            <label>Deposit address ID<input name="depositAddressId" required maxLength={512} /></label>
            <label>Asset<select name="asset" defaultValue="USDT"><option>USDT</option><option>GRAM</option></select></label>
            <button className="button" type="submit">Create job only</button>
          </form>
          <p className="muted">The API never signs. A separately deployed signing worker consumes the queued state.</p>
        </details>
      ) : null}
      {input.page.section === "audit" ? (
        <details className="operation-panel">
          <summary>Register an already executed refund</summary>
          <form className="form-grid" method="post" action="/admin/actions/refunds/register">
            <Csrf token={input.csrfToken} />
            <label>Order ID<input name="orderId" required maxLength={512} /></label>
            <label>Attempt ID (optional)<input name="invoiceId" maxLength={512} /></label>
            <label>Network<select name="network" defaultValue="mainnet"><option>mainnet</option><option>testnet</option></select></label>
            <label>Asset<select name="asset" defaultValue="USDT"><option>USDT</option><option>GRAM</option></select></label>
            <label>Amount atomic<input name="amountAtomic" required inputMode="numeric" pattern="[1-9][0-9]*" maxLength={128} /></label>
            <label>From address (optional)<input name="fromAddress" maxLength={128} /></label>
            <label>Refund recipient address<input name="toAddress" required maxLength={128} /></label>
            <label>Jetton master (USDT only)<input name="jettonMasterAddress" maxLength={128} /></label>
            <label>Transaction hash<input name="transactionHash" required maxLength={128} /></label>
            <label>Transaction LT (optional)<input name="transactionLt" inputMode="numeric" maxLength={32} /></label>
            <label>Blockchain time (ISO 8601)<input name="blockchainAt" required placeholder="2026-08-13T10:00:00Z" maxLength={64} /></label>
            <button className="button" type="submit">Register immutable evidence</button>
          </form>
        </details>
      ) : null}
      <div className="records">
        {input.page.records.length ? input.page.records.map((record) => {
          if (input.page.section === "orders") return <OrderCard key={record.id} record={record} />;
          if (input.page.section === "movements") return <MovementCard key={record.id} record={record} csrfToken={input.csrfToken} />;
          if (input.page.section === "recovery") return <RecoveryCard key={record.id} record={record} csrfToken={input.csrfToken} />;
          if (input.page.section === "sweeps") return <SweepCard key={record.id} record={record} csrfToken={input.csrfToken} />;
          if (input.page.section === "webhooks") return <WebhookCard key={record.id} record={record} csrfToken={input.csrfToken} />;
          return <AuditCard key={record.id} record={record} />;
        }) : <div className="empty">No records on this page.</div>}
      </div>
      {input.page.section === "movements" && input.page.secondaryRecords?.length ? (
        <>
          <section className="section-heading"><div><span className="eyebrow">Admin evidence</span><h2>Registered outgoing refunds</h2></div></section>
          <div className="records">
            {input.page.secondaryRecords.map((record) => <RefundCard key={record.id} record={record} />)}
          </div>
          <SecondaryPager page={input.page} label="Refunds" />
        </>
      ) : null}
      {input.page.section === "sweeps" && input.page.secondaryRecords?.length ? (
        <>
          <section className="section-heading"><div><span className="eyebrow">Native asset</span><h2>GRAM sweep state</h2></div></section>
          <div className="records">
            {input.page.secondaryRecords.map((record) => (
              <article className={record.sweepStatus === "FAILED" ? "record record--alert" : "record"} key={record.id}>
                <div className="record__header"><h2 className="mono">{record.address}</h2><Status value={record.sweepStatus} /></div>
                <dl className="field-grid">
                  <Field label="Amount nano" value={record.sweepAmountNano} mono />
                  <Field label="Recipient" value={record.sweepRecipientAddress} mono />
                  <Field label="Tx hash" value={record.sweepTransactionHash} mono />
                  <Field label="Seqno" value={record.sweepSeqno} mono />
                  <Field label="Started" value={record.sweepStartedAt} />
                  <Field label="Sent" value={record.sweepSentAt} />
                  <Field label="Attempts" value={record.sweepAttempts} />
                  <Field label="Error" value={record.sweepLastError} />
                </dl>
                {record.sweepStatus === "FAILED" ? (
                  <form className="action-row" method="post" action="/admin/actions/sweeps/retry">
                    <Csrf token={input.csrfToken} />
                    <input type="hidden" name="sweepId" value={`native:${record.id}`} />
                    <button className="button" type="submit">Queue retry</button>
                  </form>
                ) : null}
              </article>
            ))}
          </div>
          <SecondaryPager page={input.page} label="Native sweeps" />
        </>
      ) : null}
      {input.page.section === "webhooks" && input.page.secondaryRecords?.length ? (
        <>
          <section className="section-heading"><div><span className="eyebrow">At-least-once journal</span><h2>Every delivery attempt</h2></div></section>
          <div className="records">
            {input.page.secondaryRecords.map((record) => <WebhookAttemptCard key={record.id} record={record} />)}
          </div>
          <SecondaryPager page={input.page} label="Delivery attempts" />
        </>
      ) : null}
      <Pager page={input.page} />
    </AdminShell>,
  )}`;
}

export function renderAdminError(input: {
  username: string;
  csrfToken: string;
  message: string;
}) {
  return `<!doctype html>${renderToStaticMarkup(
    <AdminShell {...input} title="Action not completed">
      <div className="notice notice--error" role="alert">{input.message}</div>
      <p><a className="button button--quiet" href="/admin">Return to overview</a></p>
    </AdminShell>,
  )}`;
}
