# Prisma migrations

The migration history starts with `20260813100000_baseline`, which is an exact
snapshot of the original GRAM-only schema. Later migrations are additive: the
foundation keeps every legacy table and column, while the order-attempt
migration links existing invoices to fiat-denominated orders and fills neutral
amount fields. The TON checkout policy migration adds immutable GRAM and USDT
quote evidence plus append-only payment-method adjustments without renaming or
removing any legacy field.

## Empty database

Run the normal production command:

```bash
npm run db:migrate:deploy
```

Prisma applies both the baseline and all later migrations.

## Existing database created before migration history

Take a database backup first. Verify that the existing tables match the
independent checked-in GRAM-only datamodel, then record only the baseline as
already applied:

```bash
npx prisma migrate diff --from-url "$DATABASE_URL" --to-schema-datamodel tests/fixtures/gram-only-schema.prisma --exit-code
npx prisma migrate resolve --applied 20260813100000_baseline
npm run db:migrate:deploy
```

Do not mark `20260813101000_multi_asset_foundation` as applied: `migrate
deploy` must execute it. Afterwards, confirm the migration state:

```bash
npx prisma migrate status
```

The resolve command is a one-time production-baselining action. New databases
must never use it; they apply the baseline normally.

## Local rehearsal

With Docker running, exercise both paths against temporary PostgreSQL 16
databases:

```bash
npm run db:migrate:rehearse
```

The script creates an isolated, process-named container and derives its legacy
database from `tests/fixtures/gram-only-schema.prisma`, independently of the
baseline SQL. It verifies baseline equivalence, clean and legacy deployments,
pending/partial/paid/recovery/anonymous backfill, real Prisma repository
dual-writes, one-active-attempt and one-active-sweep constraints, append-only
financial records, schema drift, and cleanup of only that temporary container.
The same clean and legacy paths exercise the GRAM shadow scanner with the real
Prisma client: concurrent workers cannot lease the same address stream, cursor
replay is idempotent, and observed movements do not mutate settlement state.
It also drives `/check` through the strict GRAM ledger source on both database
histories, proving that aborted transfers are excluded, replay remains unique,
and valid movements preserve the compatible `PARTIAL` to `PAID` transition.
Both histories also execute the official-USDT sweep repository through
`QUEUED` → gas top-up → `SENT` → `CONFIRMED`, verify the outgoing movement,
recovery case, and manual retry path, and ensure the gas/query seqno state is
preserved by real PostgreSQL transactions.

During rollout, apply migrations immediately before deploying the compatible
application. The repository can still read an unlinked legacy row and will
atomically attach it to an order when that invoice is reused or changes state,
covering invoices created by an old process near the migration boundary.

## Database-enforced invariants

- An order can have many historical attempts, but only one `PENDING` or
  `PARTIAL` attempt.
- A deposit asset can have many confirmed historical sweeps, but only one
  unfinished sweep (including a retryable `FAILED` row); every sweep also
  carries a unique idempotency key. Mainnet USDT sweeps additionally persist a
  unique uint64 query ID and non-negative gas/deposit wallet seqno plans before
  either signing operation. A unique gas-service plan key fences the central
  wallet seqno across initial top-ups and post-transfer reserve repairs, even
  after a process lease expires. The step-13 migration queues any positive
  official-USDT ledger balance journaled by the earlier observer.
- Automatic sweep rows retain immutable order/invoice/deposit ownership and
  allocation-backed trigger evidence. Their per-order/asset sequence is capped
  by the snapshotted policy, an intermediate row must reserve the final slot,
  and the terminal row requires a materialized `PAID` order. Automatic
  provenance cannot be updated, deleted, or truncated; operational lifecycle
  fields remain mutable through the worker state machine.
- Movement blockchain facts cannot be updated and movement rows cannot be
  deleted or truncated. Evidence fields may be attached once. Status follows
  explicit forward transitions; `RECOVERY` may re-enter validation, while
  `CREDITED` and `REJECTED` are terminal and immutable.
- Rate snapshots, movement allocations, registered refund evidence, and admin
  audit events are append-only.
  They cannot be updated, deleted, or truncated. Allocation corrections use one
  full `REVERSAL` row that must exactly mirror and reference the original
  `CREDIT` allocation instead of editing it.
- Login throttling is durable across API replicas but intentionally mutable and
  contains only an HMAC-derived rate key. Registered refunds retain canonical
  chain facts and order/attempt ownership separately from the operator audit.
- Invoice/recovery/sweep state changes enqueue webhook rows through PostgreSQL
  triggers in the same transaction. Delivery attempts are created before each
  HTTP request and may move exactly once from `STARTED` to `DELIVERED` or
  `FAILED`; terminal attempt evidence cannot be edited or deleted. Outbox rows
  remain mutable only through the lease/delivery lifecycle and retain one stable
  event ID across at-least-once retries.
- Each on-chain movement can have at most one `CREDIT` allocation. PostgreSQL
  also requires that allocation to match the movement's terminal fiat evidence;
  automatic credit requires an invoice whose order and deposit address own the
  movement. The database validates supported rate source/asset precision,
  exact USDT/USD peg policy, and immutable USDT/EUR component provenance before
  accepting either a snapshot or credit. Application transactions lock the
  order before replaying active allocations, preventing lost updates and
  deriving `paidAt` deterministically from blockchain time.
- New attempts persist an immutable initial-partial activation threshold.
  Existing attempts are grandfathered with zero so rollout cannot reinterpret
  legacy payments. The first GRAM CREDIT allocation locks one rate snapshot per
  order at the database boundary, and recovery cases are idempotent per
  movement/reason. Deposit addresses carry a dedicated settlement retry time so
  worker backoff and queue fairness do not reuse scanner or sweep timestamps.
  Positive held movements on one attempt accumulate below that threshold and
  are promoted to `CREDITED` with one append-only allocation each in the same
  order-locked transaction once their cumulative fiat value qualifies.
- Each scanner cursor records a separate monotonic `scannedThroughAt` proof.
  Mainnet automatic credit waits for both the native-GRAM and official-USDT
  streams to cross the configured post-movement horizon and for their active
  leases to finish. Empty successful scans advance the proof; failures and
  capped pagination do not.
- New TON orders snapshot their minimum-order, GRAM-discount, intermediate-sweep,
  and automatic-sweep-count policies. Those terms and the gross fiat obligation
  are immutable; legacy orders retain zero-valued compatibility defaults.
- An invoice can hold one immutable quote for each machine asset code (`USDT`
  and `GRAM`). PostgreSQL validates invoice/order/rate ownership, exact atomic
  rounding, the mainnet-only zero-discount USDT policy, and the capped GRAM
  offer. Quote rows retain their own restricted order and network identity;
  their invoice ownership, currency, chronology, and deadline basis cannot be
  rewritten after insertion. Once the first movement locks a selected asset,
  that selection cannot be rewritten.
- A GRAM payment-method discount is a separate append-only adjustment. It can
  fill only the exact all-GRAM shortfall, must reference the locked GRAM quote,
  and never mutates the order's original gross amount. Corrections use one
  exact append-only reversal rather than editing financial history. PostgreSQL
  derives the mutable order summary from those rows and serializes it against
  USDT CREDIT allocations, so neither a direct writer nor a concurrent worker
  can leave an active GRAM-only discount on a mixed payment.
- `20260814104000_checkout_payment_rails` hardens the pre-movement payment
  method switch. Any change to the asset/kind/decimals/amount instruction must
  match the immutable quote for that invoice, and the full instruction becomes
  immutable as soon as payment-selection evidence is locked. The unique
  address, raw address, reference, strategy, and wallet-derivation tuple are
  immutable from issuance. Deployment first calls the reusable
  `tonhub_assert_checkout_payment_rail_integrity()` audit and fails closed if a
  pre-rollout quote-backed invoice has already drifted from its quote or linked
  deposit. Direct SQL writers therefore cannot manufacture or redirect a
  checkout rail.
