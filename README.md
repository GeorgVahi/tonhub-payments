# Tonhub Payments

Portable GRAM (ex TON) direct-payment module extracted from an existing production-style TON network payment flow.

The module creates a unique TON V5R1 deposit wallet for each invoice, locks a
live GRAM/EUR or GRAM/USD quote, exposes a QR/deeplink payment UI, verifies
incoming transfers server-side, supports partial payments with a separate time
window, and includes a sweep worker that moves paid deposit balances to a main
wallet.

## Structure

- `backend/` - Hono/Bun API, invoice lifecycle, TON Center checks, CoinGecko rate lookup.
- `frontend/` - React widget with amount input, EUR/USD selector, and testnet/mainnet switch.
- `worker/` - paid deposit-address sweep worker; this is the only runtime that needs TON secret keys.
- `prisma/` - standalone PostgreSQL schema for invoices, deposit wallets, and transactions.
- `tests/` - contract tests for amount conversion, QR/deeplink, unique addresses, partial payment, and full settlement.

## Setup

```bash
npm install
cp .env.example .env
npm run db:generate
npm run db:migrate
npm run backend:dev
```

In another terminal:

```bash
npm run dev
```

The API listens on `http://localhost:3008`; the Vite demo proxies `/api/**` to
that API and runs on `http://localhost:5173`.

For a full local GRAM payment flow with the additive shadow scanner, run five runtimes:

```bash
npm run backend:dev
npm run dev
npm run worker:rates -- --watch --interval-seconds=60
npm run worker:scan:gram-shadow -- --network=testnet --watch --interval-seconds=15
npm run worker:sweep -- --network=testnet --watch --interval-seconds=15
```

The official mainnet USDT observer and sweep service are separate, disabled-by-default runtimes:

```bash
TON_USDT_MAINNET_ADAPTER_ENABLED=true npm run worker:scan:usdt-mainnet -- --watch
TON_USDT_MAINNET_ADAPTER_ENABLED=true npm run worker:sweep:usdt-mainnet -- --watch
npm run worker:scan:gram-shadow -- --network=mainnet --watch --interval-seconds=15
npm run worker:sweep -- --network=mainnet --watch --interval-seconds=15
```

They can only process mainnet. Public USDT checkout is a third, independent
rollout switch: it is exposed only when `TON_USDT_MAINNET_CHECKOUT_ENABLED`,
`TON_USDT_MAINNET_ADAPTER_ENABLED`, and `TON_MOVEMENT_SETTLEMENT_ENABLED` are
all `true`, and settlement mode is exactly `ledger`. Testnet checkout remains
GRAM-only. A production USDT rollout therefore runs the rate, USDT observer,
GRAM shadow observer, settlement, native-sweep, and asset-sweep workers before
enabling the public switch. The GRAM observer must include mainnet so a native
transfer sent to a USDT checkout is still discovered and valued in fiat.

### Small mainnet USDT canary

Run the canary without opening USDT to general checkout traffic. Keep
`TON_USDT_MAINNET_CHECKOUT_ENABLED=false`, set the adapter and movement
settlement flags to `true`, keep `TON_GRAM_SETTLEMENT_MODE=ledger`, and put only
the selected merchant order IDs in `TON_USDT_MAINNET_CANARY_EXTERNAL_IDS`.
The allowlist is exact, case-sensitive, rejects ambiguous/duplicate values, and
is capped at 20 orders. It enables USDT creation only when the invoice request
carries one of those `externalId` values; `/config` and the public widget remain
GRAM-only until the separate public rollout switch is enabled.

Before issuing a real invoice, apply migrations with `prisma migrate deploy`,
start the rate, mainnet USDT observer, mainnet GRAM shadow observer, mixed
settlement, native sweep, USDT sweep, and webhook workers, then run:

```bash
npm run canary:usdt-mainnet:status
```

The read-only command prints no keys or blockchain addresses and exits non-zero
if the required migration or fresh USD/EUR snapshots are missing, public USDT
was accidentally enabled, mainnet/ledger prerequisites are wrong, or an
allowlisted order has open recovery, a failed sweep, or a failed webhook that
must be retried and delivered before the canary continues.

Issue one merchant-approved low-value order at a time through the normal invoice
API with an allowlisted `externalId`. For each real transfer, verify in admin:
the official master and verified deposit jetton wallet, immutable inbound
movement, fiat allocation and terminal order state, gas top-up, confirmed USDT
sweep and treasury receipt, retained TON reserve, and delivered webhook. Record
the transaction hashes externally in the rollout change log. Exercise the
supported wallets in separate bounded payments rather than combining variables
in one transaction.

Stop new issuance immediately by clearing the canary allowlist if any identity
drift, stale rate, unexpected recovery, insufficient gas, failed/repeated
top-up, failed sweep, or treasury mismatch appears. Keep observers, settlement,
sweep, and webhook workers running until already issued attempts are terminal
and all detected funds are reconciled; disabling those workers is not a safe
rollback for an in-flight payment. Only after this live evidence is reviewed
should the public checkout flag be enabled in the next rollout step.

The frontend and backend are enough to create invoices and detect payments, but
they do not sweep funds to the main wallet. The sweep worker must be running for
paid deposit-wallet balances to move to `TON_*_SWEEP_RECIPIENT_ADDRESS`.

## Environment

`.env.example` contains separate placeholders for testnet and mainnet:

- `TON_TESTNET_API_KEY`, `TON_MAINNET_API_KEY`
- `TON_TESTNET_DEPOSIT_PUBLIC_KEY`, `TON_MAINNET_DEPOSIT_PUBLIC_KEY`
- `TON_TESTNET_DEPOSIT_SECRET_KEY`, `TON_MAINNET_DEPOSIT_SECRET_KEY`
- `TON_TESTNET_SWEEP_RECIPIENT_ADDRESS`, `TON_MAINNET_SWEEP_RECIPIENT_ADDRESS`
- `TON_MAINNET_GAS_SERVICE_SECRET_KEY` (USDT sweep worker only)

Keep `TON_*_DEPOSIT_SECRET_KEY` only in the worker environment. The backend
derives unique deposit addresses from public keys and does not need signing
credentials.

The mainnet treasury is deliberately reused as the gas service, avoiding an
extra operational wallet: its standard V5R1 address, derived from
`TON_MAINNET_GAS_SERVICE_SECRET_KEY`, must exactly equal
`TON_MAINNET_SWEEP_RECIPIENT_ADDRESS`. Keep this secret in the isolated sweep
worker only. The gas service tops each deposit wallet up to 0.15 TON by default,
adding a 0.001 TON delivery margin so storage or inbound-message fees cannot
leave a first-deployment wallet a few nanotons below the operational target.
The deposit attaches 0.05 TON to the TEP-74 transfer, requests a 1-nanoton
notification, reserves another 0.05 TON as an explicit wallet-fee cushion, and
is expected to retain at least 0.05 TON. These values are configurable, but the
target must cover the transfer value, a positive fee cushion, and the reserve.
All TON top-up and execution cost is merchant cost; the worker sweeps the full
verified USDT jetton-wallet balance without deducting a user fee.

The rate worker writes immutable GRAM/USD, GRAM/EUR, USDT/USD, and USDT/EUR
snapshots. `TON_RATE_SNAPSHOT_INTERVAL_SECONDS` controls its polling interval;
`TON_RATE_SNAPSHOT_MAX_AGE_SECONDS` rejects stale provider evidence. USDT/USD
is fixed at the merchant policy `1 USDT = 1 USD`; USDT/EUR is derived exactly
from contemporaneous GRAM/EUR and GRAM/USD observations and references both
immutable component snapshot IDs. A provider outage does not invent a market
rate: the worker stores the independent USDT/USD peg, reports the unavailable
pairs, and retries on the next watch iteration.

The GRAM shadow scanner is an additive rollout runtime. It scans active attempts
every 15 seconds and recent terminal attempts once per day for 30 days by
default. Its per-address cursor and lease are stored in `TonhubScanCursor`.
It accepts only successful, positive native transfers whose normalized TON
destination exactly matches the invoice deposit address, then appends an
idempotent `OBSERVED` movement. The background worker itself does not allocate
fiat or update invoice/order status. The `/check` path now uses these strict
movements as its observation source before running the compatible GRAM state
machine. Tune the worker's batch, pagination, retry, lease, active cadence, and
terminal cadence with the `TON_GRAM_SHADOW_*` variables documented in
`.env.example`.

`TON_GRAM_SETTLEMENT_MODE` controls the reversible read cutover. `ledger` is the
default and settles only strict persisted movements. `compare` records the same
movements and emits a structured `[tonhub-settlement-compare]` diff while the
legacy matcher still determines the response. `legacy` is the emergency
rollback and bypasses movement observation. Comparison/reporting failures never
change the legacy result; ledger-mode observation failures fail closed.

## API

Create invoice:

```http
POST /api/tonhub-payments/invoices
Content-Type: application/json

{
  "amount": "49.00",
  "currency": "EUR",
  "network": "testnet",
  "asset": "GRAM",
  "externalId": "order-123",
  "metadata": { "customerId": "user-1" }
}
```

Check invoice:

```http
POST /api/tonhub-payments/invoices/:id/check
```

Read invoice:

```http
GET /api/tonhub-payments/invoices/:id
```

The server returns `PENDING`, `PARTIAL`, `PAID`, `EXPIRED`, `CANCELLED`, or
`FAILED`. A partial payment keeps the same address and creates a remaining
amount until `TON_PARTIAL_PAYMENT_TTL_HOURS` expires.

## Payment Flow

This module uses unique-address direct GRAM (ex TON) payments on the TON network:

1. The backend creates one TON V5R1 deposit wallet address per invoice. The
   address is derived from the configured deposit public key plus invoice wallet
   context metadata stored in PostgreSQL.
2. The frontend shows that invoice-specific address as a QR/deeplink and polls
   the backend.
3. The backend checks TON Center for incoming transfers to the owned deposit
   address, journals only explicitly successful native transfers as immutable
   movements, and settles the compatible GRAM state machine from those rows.
   When the expected amount is observed, it marks the invoice `PAID` and marks
   the related deposit address `PAID`.
4. The sweep worker queries PostgreSQL for `PAID` deposit addresses with
   `sweepStatus` `NOT_STARTED` or retryable `FAILED`, reconstructs the matching
   V5R1 wallet from the stored metadata and worker secret key, and sends
   `balance - TON_SWEEP_RESERVE_NANO` to `TON_*_SWEEP_RECIPIENT_ADDRESS`.

The sweep worker does not independently discover payments. It only sweeps
addresses that the backend settlement path has already marked `PAID`, so
invoice polling or an explicit `POST /api/tonhub-payments/invoices/:id/check`
must still happen before the sweep candidate exists. The separate GRAM scanner
can discover and journal movements without polling, but the compatible state
transition still runs on `/check` until the later autonomous settlement stage.

Current sweep state is stored on `TonhubDepositAddress`. A successful broadcast
sets `sweepStatus` to `SENT` and stores `sweepAmountNano`, `sweepReserveNano`,
`sweepRecipientAddress`, `sweepSeqno`, and `sweepSentAt`. The current worker
does not persist a transaction hash or advance `SENT` to on-chain
`CONFIRMED`.

## Database Schema

The GRAM runtime now treats `TonhubPaymentOrder` as the fiat obligation and
`TonhubPaymentInvoice` as a concrete payment attempt. It dual-writes the legacy
GRAM fields and the neutral amount fields, so existing clients and workers keep
working while later multi-asset stages are introduced. The additive persistence
foundation does not remove or rename legacy fields:

- `TonhubPaymentOrder` owns the fiat obligation while invoice rows become
  payment attempts; PostgreSQL permits only one active attempt per order. A
  merchant `externalId` cannot silently change amount or currency, paid orders
  are idempotently returned, and an empty expired attempt may be replaced.
- `TonhubDepositAssetAccount` records the native or jetton account associated
  with a unique deposit wallet.
- `TonhubRateSnapshot`, `TonhubPaymentMovement`, and
  `TonhubMovementAllocation` preserve valuation evidence and allocations.
  Financial facts are database-protected from mutation; corrections are
  compensating `REVERSAL` allocations.
- `TonhubScanCursor` and `TonhubAssetSweep` support resumable scanners and
  idempotent per-asset sweeps with only one active sweep per deposit asset.
- `TonhubRecoveryCase`, `TonhubOutboxEvent`, and `TonhubAdminAuditEvent` support
  operator recovery, reliable delivery, and append-only administration audit.

Each invoice has at most one `TonhubDepositAddress`; the deposit address can be
reconstructed only when the worker's secret key matches its stored public-key
hash. See `prisma/README.md` for clean deployment, legacy baselining, and the
Docker migration rehearsal.

## Asset and amount contract

The shared registry in `shared/payment-assets.ts` is the canonical definition
of payment-asset identity and precision:

- `GRAM` is the TON native coin exposed under the product name
  `GRAM (ex TON)`. The legacy input alias `TON` resolves to `GRAM`; amounts use
  9 atomic decimals and checkout amounts are rounded up to 2 displayed digits.
- `USDT` is the machine code for official TON-network Tether, presented to users
  as `USD₮`. It is a TON jetton with 6 atomic decimals and a USD-peg pricing strategy.
  Public mainnet checkout presents it first when the independent public flag
  and all required settlement services are enabled; GRAM remains the alternate
  choice. Public testnet and the internal arbitrary test jetton remain GRAM-only.

`POST /api/tonhub-payments/invoices` accepts optional `asset: "GRAM" | "USDT"`.
When omitted, the server policy selects USD₮ on enabled mainnet checkout and
GRAM on testnet. The choice fixes the concrete attempt and payment instruction
but not the fiat order obligation; a
retry of the same merchant `externalId` reuses the existing attempt instead of
silently switching assets. New issuance stores both available TON offers on the
same unique deposit address: USD₮ keeps the gross fiat amount, while the GRAM
offer snapshots a maximum $1/€1 saving. The saving is not credited here; final
all-GRAM eligibility is decided by settlement. Both offers reference fresh
immutable rate snapshots and use integer arithmetic. USD₮ returns a
standard `ton://transfer` jetton link plus the unique owner address and manual
amount fallback. The link pins the compiled official mainnet USDT master.

The order minimum defaults to $10/€10 and the intermediate unswept-balance
threshold defaults to $100/€100. Configure integer cents with
`TON_MIN_ORDER_{USD,EUR}_CENTS`, `TON_GRAM_DISCOUNT_{USD,EUR}_CENTS`, and
`TON_INTERMEDIATE_SWEEP_MIN_{USD,EUR}_CENTS`; configure the percentage and
automatic-sweep cap with `TON_INTERMEDIATE_SWEEP_TRIGGER_BPS` and
`TON_MAX_AUTOMATIC_SWEEPS_PER_ASSET` (1 or 2). These values are immutable snapshots on
new orders, so an env change never rewrites an already issued obligation.

The React widget also supports TON Connect through the official
`@tonconnect/ui-react` client. Pass an HTTPS manifest URL through the
`tonConnectManifestUrl` prop (the demo reads `VITE_TONCONNECT_MANIFEST_URL`).
Connected wallets receive an explicit network-bound request: a raw native
message for GRAM or a structured official-master jetton item for USDT. The
request expires no later than the invoice payment window, and a submitted wallet
request never marks the invoice paid locally; the server ledger remains the
authority. Wallet rejection or unsupported structured jetton support leaves the
standard wallet deeplink, QR, address, and amount available as fallbacks.

## Admin and recovery console

Set `TONHUB_ADMIN_USERNAME`, `TONHUB_ADMIN_PASSWORD_HASH`, and
`TONHUB_ADMIN_SESSION_SECRET` together to mount the server-rendered console at
`/admin/**`. Generate the password hash by piping the password through stdin to
`npm run admin:hash-password`; the API rejects plain-text or unsupported hash
formats. The session secret must contain at least 32 UTF-8 bytes. Missing all
three values keeps the console unmounted, while a partial or invalid setup makes
the API fail at startup.

Admin requests must reach Hono with an `https:` request URL. Forwarded headers
are deliberately not trusted, so a TLS-terminating reverse proxy must construct
the upstream request with the authoritative external HTTPS URL and keep the API
port private. If client-IP login throttling must cross that proxy, set
`TONHUB_ADMIN_TRUSTED_PROXY_IPS` to its exact peer IP address(es); only allowlisted
peers may supply `X-Forwarded-For`, and the proxy must replace that header.
Responses use HSTS, a restrictive CSP, no-store caching, and a
`Secure`, `HttpOnly`, `SameSite=Strict`, `__Host-` session cookie. Mutations also
require a same-origin request and a session-bound CSRF token. Login attempts are
limited in PostgreSQL across API replicas; successful and failed authentication
and every operator mutation enter the append-only admin audit log.

The console shows orders and their attempts, incoming/outgoing movements with
addresses, asset identity, hash/LT, fiat credit and rate, recovery/rate-pending/
held states, gas top-ups, native and jetton sweeps, webhook outbox state, and
audit history. Operators can validate and attach an owned movement through the
normal ledger, mark recovery reviewed, create or retry a durable sweep job, and
register immutable evidence for an already executed refund. These actions never
sign or broadcast. `TON_DEPOSIT_SECRET_KEY`, network-specific deposit secret
keys, and `TON_MAINNET_GAS_SERVICE_SECRET_KEY` are rejected from the API process
environment; deploy signing workers with a separate environment.

## Webhooks

Set one global `TONHUB_WEBHOOK_URL` and `TONHUB_WEBHOOK_SECRET` in the webhook
worker environment, then run `npm run worker:webhooks -- --watch`. Both values
are required together. The URL must be HTTPS and cannot contain credentials,
query parameters, or a fragment; invoices never accept an individual callback
URL. This keeps the outbound destination under merchant deployment control and
removes invoice-driven SSRF and data-exfiltration paths.

PostgreSQL transaction triggers create immutable-identity outbox events for
`invoice.partial`, `invoice.paid`, `invoice.expired`, `recovery.opened`, and
`sweep.failed` in the same transaction as their authoritative state change.
Delivery is at least once: receivers must persist and deduplicate the `id` (also
sent as `X-Tonhub-Event-Id`) before applying side effects. Failed events retry
forever with bounded exponential backoff; an admin can make a failed event due
immediately without changing its event ID or attempt counter. Every claimed
attempt is journaled before the HTTP request, including stale attempts left by a
worker crash.

The request body is UTF-8 JSON with `id`, `type`, `createdAt`, and `data`.
`X-Tonhub-Timestamp` is the Unix timestamp used to sign it and
`X-Tonhub-Signature` is `v1=` followed by lowercase hex HMAC-SHA256 over
`timestamp + "." + exactRawBody`. Receivers should use a timing-safe comparison,
reject stale timestamps according to their own clock-skew policy, and still
deduplicate event IDs because a valid request can be replayed. The journal never
stores the secret, signature, or response body.

New API consumers should use `asset`, `assetKind`, `assetDecimals`,
`amountAtomic`, `amountFormatted`, and the corresponding `expected`, `paid`,
and `remaining` neutral fields. Existing GRAM-only fields such as `amountNano`,
`amountGram`, and `amountTon` remain available for GRAM clients during the
compatibility window. Atomic conversion uses decimal strings and `BigInt`; it
does not route financial values through JavaScript floating-point numbers.

Rate snapshots are append-only and selected historically: a lookup can use only
an observation at or before the requested blockchain time and rejects evidence
older than its configured maximum age. The first credited movement will lock
the selected GRAM rate for the remaining partial-payment window when movement
allocation is enabled in the following rollout stage. The current legacy GRAM
settlement path remains unchanged while this snapshot writer runs in parallel.

The neutral movement ledger records immutable on-chain facts by a unique
fingerprint and values incoming assets in fiat micros using the latest eligible
snapshot at or before their blockchain time. Valuation always rounds down.
Allocation replay updates `creditedFiatMicros` up to the order obligation and
keeps excess value separately in `overpaymentFiatMicros`; `paidAt` is derived
from blockchain chronology, not worker execution order. One movement can credit
only one order. Corrections append a full `REVERSAL` and move the order into
`RECOVERY`; neither movement facts nor earlier allocations are rewritten. This
ledger remains additive until the shadow scanner and settlement cutover stages.
It refuses to overwrite a non-zero legacy order balance that has not yet been
backfilled into allocations, routing that rollout gap to explicit recovery
handling instead of silently losing or double-counting prior credit. Automatic
credit always derives ownership through movement deposit address → invoice →
order; invoice-less reassignment is reserved for a later authenticated and
audited recovery workflow.

The GRAM shadow worker feeds this ledger independently of user polling. It
normalizes friendly/raw TON addresses and hex/base64 transaction hashes before
fingerprinting, ignores comments for unique-address matching, rejects aborted,
unknown, failed, malformed, foreign-address, non-positive, and out-of-window
evidence, and advances its resumable cursor only after every selected movement
has been persisted. Provider or persistence errors release the lease for retry
without changing settlement state.

An internal-only testnet jetton adapter exercises the provider and movement
ledger boundary before official mainnet USDT is enabled. It is off by default,
requires `TON_INTERNAL_TESTNET_JETTON_ENABLED=true` plus one explicit
`TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS` and
`TON_INTERNAL_TESTNET_JETTON_DECIMALS=6`, and refuses non-testnet deposits or
provider configs. The adapter verifies the test master's provider metadata is
also exactly 6-decimal, then verifies the deposit owner and derived asset-wallet
row reported by TON Center before journaling USDT-shaped evidence marked
`internalTestAsset`. It is intentionally absent
from public package exports and `/config`, so public testnet checkout remains
GRAM-only. Internal QA can scan one provider page with:

```bash
npm run worker:scan:jetton-testnet -- --deposit-id=<id> --not-before=<ISO date>
```

Use `--not-after`, `--limit`, and `--offset` for a bounded historical page.
The adapter follows TON Center's `/jetton/masters`, `/jetton/wallets`, and
owner/master-bound `/jetton/transfers` contracts. TON Center's `jetton_wallet`
filter identifies the sender wallet for inbound transfers, so it is not used as
destination evidence. Instead, the adapter verifies the unique wallet derived
from the deposit owner and master, and correlates `/transactions` by trace to
verify the destination wallet and raw notification when present. The receiving
owner transaction may abort when a first-deployment wallet has no code yet; the
successful jetton transfer and its verified master/owner wallet remain the
authoritative credit evidence. Fake-master and malformed-transfer hardening rejects
aborted or malformed transfers, wrong master-to-wallet identity, and malformed
raw notifications. A raw notification must have opcode `0x7362d09c` and matching
query, amount, and sender facts. Symbol, name, image, and other token metadata
are never authentication evidence. A separate owner-only discovery pass can
only produce rejection evidence; it can never credit a payment.
Structurally valid unsupported jetton candidates are journaled as `REJECTED`
with an open recovery case; they cannot be allocated as payment and do not
create an automatic asset sweep.

The production USDT observer reuses that strict verified-jetton boundary behind
the independent `TON_USDT_MAINNET_ADAPTER_ENABLED` flag. It pins the official
TON mainnet USDT master at
`EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs` (6 decimals); there is no
environment override for token identity. TON Center metadata such as symbol,
name, or image is ignored. Before accepting a transfer, the adapter verifies
the compiled master and the unique owner/master-derived jetton wallet, then
journals `officialUsdt` evidence into the same immutable movement ledger.
Testnet deposits are rejected before provider or ledger writes, and enabling
the internal QA flag cannot enable this mainnet adapter.

`worker:scan:usdt-mainnet` scans all eligible mainnet unique deposit addresses,
including attempts initially shown as GRAM, because the order settles the fiat
equivalent of whichever supported asset actually arrived. It uses its own
`USDT_MAINNET_IN` cursor and lease, paginates both the trusted and discovery
streams to completion, and overlaps the previous hour so delayed provider
indexing is replayed safely through immutable fingerprints. Active attempts are
checked every 15 seconds by default; terminal attempts are checked daily for 30
days. The `TON_USDT_MAINNET_SCAN_*` variables in `.env.example` tune those
cadences, pagination, retry, and lease limits. The mixed-settlement worker
performs fiat allocation. A newly journaled official incoming USDT movement
atomically queues a sweep; replay does not duplicate it. The sweep worker
verifies invoice/deposit/master/asset-wallet ownership again, persists the gas
and deposit-wallet seqno plans before broadcast, globally reserves each gas
wallet seqno across sweep rows, sends all USDT with a
deterministic TEP-74 query ID, and confirms only exact outgoing provider
evidence. If actual fees consume the retained reserve despite the configured
cushion, confirmation first performs an idempotent merchant-funded reserve
repair. A second incoming movement that lands during an in-flight sweep is
picked up by a follow-up queue item; if provider indexing is late, immutable
outgoing ledger coverage prevents a false empty sweep. Deployment backfills
previously journaled official-USDT balances from the step-12 adapter. Failures
open a recovery case and can be retried through the exported admin action. Native GRAM sweep remains separate,
but both paths share a per-deposit signing lease, and native sweep skips wallets
with an active USDT lifecycle so it cannot drain the top-up. The scanner batch
size has a minimum of two so a busy active queue always leaves capacity for
terminal-address monitoring.

The GRAM `/check` read path has been cut over to the same strict movement facts.
It resolves the deposit relation as the scan owner, synchronously journals the
current provider page, reads all usable GRAM movements inside the invoice
window, and supplies those matches to the characterized partial/expiry/payment
state machine. Existing stored partial hashes are canonicalized across hex and
base64url encodings, preventing rollout replay from double-counting them. A
legacy stored partial that cannot be reconciled to strict immutable movement
evidence fails closed without reducing or advancing its invoice. This stage
intentionally preserves the legacy locked-GRAM amount formula for grandfathered
attempts while the allocation path below is enabled only for new attempts.

Mixed settlement issuance and its background worker are available behind
`TON_MOVEMENT_SETTLEMENT_ENABLED`; only new attempts receive a non-zero
`activationThresholdFiatMicros`. Once issued, that policy is sticky and `/check`
continues the fiat-ledger path even if issuance is disabled, preventing a
partially allocated order from falling back to incompatible atomic mutation. It allocates
confirmed incoming GRAM and USDT movements to the same fiat order and closes
the order from aggregate fiat micros, regardless of the asset originally shown
in checkout. The first credited GRAM movement locks its immutable rate snapshot
for later GRAM partials; USDT continues to use the exact peg/cross snapshot
policy. The first partial must cover the whole order or at least the greater of
50% of the obligation and twice the configured full merchant network cost.
Later movements in the same 24-hour partial window have no activation minimum.
Late, undersized-first, late-discovered out-of-order, post-`PAID`,
terminal-attempt, and reversal cases remain journaled and enter the admin
recovery queue instead of being discarded. Invoice chronology is rebuilt from
the active CREDIT movements' blockchain time rather than discovery order.
Legacy attempts are backfilled with a zero threshold and stay on the reversible
characterized settlement path. The optional `worker:settlement -- --watch`
process retries rate-pending movements without relying on user polling and
passes the configured retry cutoff into settlement, so a later observed
movement cannot make an earlier rate lookup bypass its backoff. Each selected
deposit is claimed with `settlementNextAttemptAt` before processing; failures
and chronology blocks therefore rotate behind untried deposits instead of
starving the rest of the queue.

## Frontend

```tsx
import { TonhubPaymentWidget } from "tonhub-payments/frontend";
import "tonhub-payments/frontend/styles.css";

export function PaymentBox() {
  return (
    <TonhubPaymentWidget
      apiBase="/api/tonhub-payments"
      initialAmount="49.00"
      initialCurrency="EUR"
      initialNetwork="testnet"
      externalId="order-123"
    />
  );
}
```

The widget fetches `/api/tonhub-payments/config`, renders the testnet/mainnet
switch from `TON_ALLOWED_NETWORKS`, creates invoices, shows the QR/deeplink, and
polls the backend for confirmation.

## Sweep Worker

Run once:

```bash
npm run worker:sweep -- --network=testnet
```

Run continuously:

```bash
npm run worker:sweep -- --network=all --watch --interval-seconds=15
```

The worker signs from paid unique deposit wallets and sends
`balance - TON_SWEEP_RESERVE_NANO` to the configured recipient address.

Keep the worker running in any environment where paid invoices should be swept
automatically. Running only the API and frontend leaves funds on the
invoice-specific deposit addresses until the worker is started.

## Validation

```bash
npm run test
npm run typecheck
npm run db:migrate:rehearse
```

Unit tests use fake TON Center responses and never touch a real wallet or
network. The migration rehearsal creates temporary clean and legacy-upgraded
PostgreSQL databases in Docker and verifies scanner leasing, cursor replay,
movement idempotency, strict-vs-legacy divergence, partial-to-paid cutover, and
settlement isolation against the real Prisma client.
