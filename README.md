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

## Validation

```bash
npm run test
npm run typecheck
```

The tests use fake repositories and fake TON Center responses, so they do not
touch a real wallet, network, or database.
