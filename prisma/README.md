# Prisma migrations

The migration history starts with `20260813100000_baseline`, which is an exact
snapshot of the original GRAM-only schema. Later migrations are additive: the
foundation keeps every legacy table and column, while the order-attempt
migration links existing invoices to fiat-denominated orders and fills neutral
amount fields.

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
- Movement blockchain facts cannot be updated and movement rows cannot be
  deleted or truncated. Evidence fields may be attached once. Status follows
  explicit forward transitions; `RECOVERY` may re-enter validation, while
  `CREDITED` and `REJECTED` are terminal and immutable.
- Rate snapshots, movement allocations, and admin audit events are append-only.
  They cannot be updated, deleted, or truncated. Allocation corrections use one
  full `REVERSAL` row that must exactly mirror and reference the original
  `CREDIT` allocation instead of editing it.
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
