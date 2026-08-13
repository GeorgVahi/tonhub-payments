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

For a full local payment flow, run four runtimes:

```bash
npm run backend:dev
npm run dev
npm run worker:rates -- --watch --interval-seconds=60
npm run worker:sweep -- --network=testnet --watch --interval-seconds=15
```

The frontend and backend are enough to create invoices and detect payments, but
they do not sweep funds to the main wallet. The sweep worker must be running for
paid deposit-wallet balances to move to `TON_*_SWEEP_RECIPIENT_ADDRESS`.

## Environment

`.env.example` contains separate placeholders for testnet and mainnet:

- `TON_TESTNET_API_KEY`, `TON_MAINNET_API_KEY`
- `TON_TESTNET_DEPOSIT_PUBLIC_KEY`, `TON_MAINNET_DEPOSIT_PUBLIC_KEY`
- `TON_TESTNET_DEPOSIT_SECRET_KEY`, `TON_MAINNET_DEPOSIT_SECRET_KEY`
- `TON_TESTNET_SWEEP_RECIPIENT_ADDRESS`, `TON_MAINNET_SWEEP_RECIPIENT_ADDRESS`

Keep `TON_*_DEPOSIT_SECRET_KEY` only in the worker environment. The backend
derives unique deposit addresses from public keys and does not need signing
credentials.

The rate worker writes immutable GRAM/USD, GRAM/EUR, USDT/USD, and USDT/EUR
snapshots. `TON_RATE_SNAPSHOT_INTERVAL_SECONDS` controls its polling interval;
`TON_RATE_SNAPSHOT_MAX_AGE_SECONDS` rejects stale provider evidence. USDT/USD
is fixed at the merchant policy `1 USDT = 1 USD`; USDT/EUR is derived exactly
from contemporaneous GRAM/EUR and GRAM/USD observations and references both
immutable component snapshot IDs. A provider outage does not invent a market
rate: the worker stores the independent USDT/USD peg, reports the unavailable
pairs, and retries on the next watch iteration.

## API

Create invoice:

```http
POST /api/tonhub-payments/invoices
Content-Type: application/json

{
  "amount": "49.00",
  "currency": "EUR",
  "network": "testnet",
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
3. The backend checks TON Center for incoming transfers to the invoice address.
   When the expected amount is observed, it marks the invoice `PAID` and marks
   the related deposit address `PAID`.
4. The sweep worker queries PostgreSQL for `PAID` deposit addresses with
   `sweepStatus` `NOT_STARTED` or retryable `FAILED`, reconstructs the matching
   V5R1 wallet from the stored metadata and worker secret key, and sends
   `balance - TON_SWEEP_RESERVE_NANO` to `TON_*_SWEEP_RECIPIENT_ADDRESS`.

The worker does not independently scan every known address on-chain. It only
sweeps addresses that the backend has already marked `PAID`, so invoice polling
or an explicit `POST /api/tonhub-payments/invoices/:id/check` must happen before
the sweep candidate exists.

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
- `USDT` is a TON jetton with 6 atomic decimals and a USD-peg pricing strategy.
  Listing it in the registry does not yet enable it in checkout: the config
  endpoint continues to return `checkoutAssets: ["GRAM"]` until the verified
  jetton scanner and canonical deployment are enabled in later rollout stages.

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
```

The tests use fake repositories and fake TON Center responses, so they do not
touch a real wallet, network, or database.
