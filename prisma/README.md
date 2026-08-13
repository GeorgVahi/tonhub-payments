# Prisma migrations

The migration history starts with `20260813100000_baseline`, which is an exact
snapshot of the original GRAM-only schema. The following migration is additive:
it keeps every legacy table and column available while introducing the
multi-asset foundation.

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
sample-invoice survival, one-active-attempt and one-active-sweep constraints,
append-only financial records, schema drift, and cleanup of only that temporary
container.

## Database-enforced invariants

- An order can have many historical attempts, but only one `PENDING` or
  `PARTIAL` attempt.
- A deposit asset can have many confirmed historical sweeps, but only one
  unfinished sweep (including a retryable `FAILED` row); every sweep also
  carries a unique idempotency key.
- Movement blockchain facts cannot be updated and movement rows cannot be
  deleted or truncated. Evidence fields may be attached once. Status follows
  explicit forward transitions; `RECOVERY` may re-enter validation, while
  `CREDITED` and `REJECTED` are terminal and immutable.
- Rate snapshots, movement allocations, and admin audit events are append-only.
  They cannot be updated, deleted, or truncated. Allocation corrections use one
  full `REVERSAL` row that must exactly mirror and reference the original
  `CREDIT` allocation instead of editing it.
