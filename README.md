# Tonhub Payments

Portable TON direct-payment module extracted from an existing production-style TON payment flow.

The module creates a unique TON V5R1 deposit wallet for each invoice, locks a
live TON/EUR or TON/USD quote, exposes a QR/deeplink payment UI, verifies
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

For a full local payment flow, run three runtimes:

```bash
npm run backend:dev
npm run dev
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

This module uses unique-address direct TON payments:

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

The Prisma schema is intentionally small and standalone:

- `TonhubPaymentInvoice` stores the invoice lifecycle, fiat amount, locked TON
  amount, invoice address, payment status, observed payment metadata, expiration
  windows, and optional application metadata.
- `TonhubDepositAddress` stores the generated unique wallet address and the V5R1
  reconstruction metadata: workchain, wallet context, network global id, and
  public-key hash. It also stores sweep state and the main-wallet recipient used
  by the worker.
- `TonhubPaymentTransaction` stores invoice transaction records for observed
  payment transitions.

Each invoice has at most one `TonhubDepositAddress`; the deposit address can be
reconstructed only when the worker's secret key matches the public-key hash
stored with that address.

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
