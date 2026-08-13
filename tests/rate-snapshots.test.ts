import assert from "node:assert/strict";
import test from "node:test";
import {
  createPrismaRateSnapshotRepository,
  divideRatePrices,
  finiteNumberToRatePrice,
  normalizeRatePrice,
  refreshPaymentRateSnapshots,
  type RateSnapshotDraft,
  type RateSnapshotRecord,
  type RateSnapshotRepository,
} from "../backend/src/rate-snapshots";

function createMemoryPrisma() {
  const rows: any[] = [];
  let sequence = 0;
  const matches = (row: any, where: any): boolean => Object.entries(where).every(([key, expected]: [string, any]) => {
    if (key === "OR") {
      return expected.some((candidate: any) => matches(row, candidate));
    }
    if (expected && typeof expected === "object" && "lte" in expected) {
      return row[key].getTime() <= expected.lte.getTime();
    }
    if (expected instanceof Date) {
      return row[key].getTime() === expected.getTime();
    }
    return row[key] === expected;
  });
  const db: any = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => {
      const beforeRows = rows.slice();
      const beforeSequence = sequence;
      try {
        return await handler(db);
      } catch (error) {
        rows.splice(0, rows.length, ...beforeRows);
        sequence = beforeSequence;
        throw error;
      }
    },
    tonhubRateSnapshot: {
      createMany: async ({ data, skipDuplicates }: any) => {
        let count = 0;
        for (const candidate of data) {
          const duplicate = rows.some((row) =>
            row.asset === candidate.asset &&
            row.baseCurrency === candidate.baseCurrency &&
            row.quoteCurrency === candidate.quoteCurrency &&
            row.source === candidate.source &&
            row.observedAt.getTime() === candidate.observedAt.getTime());
          if (duplicate && skipDuplicates) {
            continue;
          }
          rows.push({
            id: `rate-${++sequence}`,
            createdAt: new Date("2026-08-13T10:05:00.000Z"),
            ...candidate,
            price: { toString: () => candidate.price },
          });
          count += 1;
        }
        return { count };
      },
      findMany: async ({ where }: any) => rows.filter((row) => matches(row, where)),
      findFirst: async ({ where }: any) => rows
        .filter((row) => matches(row, where))
        .sort((left, right) =>
          right.observedAt.getTime() - left.observedAt.getTime() ||
          right.fetchedAt.getTime() - left.fetchedAt.getTime() ||
          right.createdAt.getTime() - left.createdAt.getTime())[0] ?? null,
    },
  };
  return { db, rows };
}

function draft(overrides: Partial<RateSnapshotDraft> = {}): RateSnapshotDraft {
  return {
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: "2.5",
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:00:00.000Z"),
    fetchedAt: new Date("2026-08-13T10:00:10.000Z"),
    payload: null,
    ...overrides,
  };
}

test("rate decimal helpers preserve provider text and calculate an exact cross-rate", () => {
  assert.equal(finiteNumberToRatePrice(2.5), "2.5");
  assert.equal(finiteNumberToRatePrice(1e-7), "0.0000001");
  assert.equal(normalizeRatePrice("0002.500000"), "2.5");
  assert.equal(divideRatePrices("2", "2.5"), "0.8");
  assert.equal(divideRatePrices("1", "3", 18), "0.333333333333333333");
  assert.throws(() => normalizeRatePrice("1e3"), /positive decimal string/);
  assert.throws(() => normalizeRatePrice("0"), /greater than zero/);
  assert.throws(() => normalizeRatePrice("1.1234567890123456789"), /Decimal\(36,18\)/);
});

test("snapshot persistence is idempotent and historical lookup never looks ahead", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaRateSnapshotRepository(memory.db);
  const first = draft();
  const second = draft({
    price: "2.6",
    observedAt: new Date("2026-08-13T10:01:00.000Z"),
    fetchedAt: new Date("2026-08-13T10:01:10.000Z"),
  });
  const future = draft({
    price: "2.7",
    observedAt: new Date("2026-08-13T10:03:00.000Z"),
    fetchedAt: new Date("2026-08-13T10:03:10.000Z"),
  });
  await repository.recordMany([first, second, first, future]);
  await repository.recordMany([first, second]);
  const replay = await repository.recordMany([{ ...first, price: "9.9" }]);

  assert.equal(memory.rows.length, 3);
  assert.equal(replay[0]?.price, "2.5");
  assert.equal((await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T10:02:00.000Z"),
    maxAgeMs: 120_000,
  }))?.price, "2.6");
  assert.equal((await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T10:02:00.000Z"),
    maxAgeMs: 60_000,
  }))?.price, "2.6");
  assert.equal(await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T10:02:00.000Z"),
    maxAgeMs: 59_999,
  }), null);
  assert.equal(await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T09:59:59.000Z"),
    maxAgeMs: 120_000,
  }), null);
  assert.equal(await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T10:10:00.000Z"),
    maxAgeMs: 120_000,
  }), null);
});

test("refresh records market GRAM and exact USD-peg USDT snapshots", async () => {
  const stored: RateSnapshotRecord[] = [];
  let sequence = 0;
  const repository: RateSnapshotRepository = {
    recordMany: async (drafts) => drafts.map((value) => {
      const record = {
        ...value,
        id: `stored-${sequence++}`,
        createdAt: new Date("2026-08-13T10:00:30.000Z"),
      };
      stored.push(record);
      return record;
    }),
    findAt: async () => null,
  };
  const fetchedAt = new Date("2026-08-13T10:00:20.000Z");
  const result = await refreshPaymentRateSnapshots({
    repository,
    now: () => new Date("2026-08-13T10:00:30.000Z"),
    maxProviderAgeMs: 300_000,
    fetchGramRate: async (currency) => ({
      source: "coingecko",
      currency,
      fiatPerTon: currency === "USD" ? 2.5 : 2,
      updatedAt: new Date(currency === "USD"
        ? "2026-08-13T10:00:05.000Z"
        : "2026-08-13T10:00:00.000Z"),
      fetchedAt,
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(stored.map(({ asset, quoteCurrency, price, source }) => ({
    asset,
    quoteCurrency,
    price,
    source,
  })), [
    { asset: "GRAM", quoteCurrency: "USD", price: "2.5", source: "coingecko" },
    { asset: "GRAM", quoteCurrency: "EUR", price: "2", source: "coingecko" },
    { asset: "USDT", quoteCurrency: "USD", price: "1", source: "usd-peg" },
    { asset: "USDT", quoteCurrency: "EUR", price: "0.8", source: "usd-peg" },
  ]);
  const usdtEur = stored.find(({ asset, quoteCurrency }) => asset === "USDT" && quoteCurrency === "EUR");
  assert.equal(usdtEur?.observedAt.toISOString(), "2026-08-13T10:00:05.000Z");
  assert.equal(usdtEur?.fetchedAt.toISOString(), "2026-08-13T10:00:30.000Z");
  assert.deepEqual(usdtEur?.payload, {
    policy: "1 USDT = 1 USD",
    derivation: "GRAM/EUR divided by GRAM/USD",
    components: {
      gramEur: {
        snapshotId: "stored-1",
        quoteCurrency: "EUR",
        price: "2",
        observedAt: "2026-08-13T10:00:00.000Z",
        fetchedAt: "2026-08-13T10:00:20.000Z",
        source: "coingecko",
      },
      gramUsd: {
        snapshotId: "stored-0",
        quoteCurrency: "USD",
        price: "2.5",
        observedAt: "2026-08-13T10:00:05.000Z",
        fetchedAt: "2026-08-13T10:00:20.000Z",
        source: "coingecko",
      },
    },
  });
});

test("refresh preserves the USD peg when market rates fail and reports missing EUR evidence", async () => {
  const stored: RateSnapshotDraft[] = [];
  const repository: RateSnapshotRepository = {
    recordMany: async (drafts) => {
      stored.push(...drafts);
      return drafts.map((value, index) => ({
        ...value,
        id: `partial-${index}`,
        createdAt: value.fetchedAt,
      }));
    },
    findAt: async () => null,
  };
  const result = await refreshPaymentRateSnapshots({
    repository,
    now: () => new Date("2026-08-13T10:00:00.000Z"),
    maxProviderAgeMs: 300_000,
    fetchGramRate: async () => {
      throw new Error("provider unavailable");
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(stored.map(({ asset, quoteCurrency, price }) => ({ asset, quoteCurrency, price })), [
    { asset: "USDT", quoteCurrency: "USD", price: "1" },
  ]);
  assert.deepEqual(result.errors.map(({ asset, quoteCurrency }) => `${asset}/${quoteCurrency}`).sort(), [
    "GRAM/EUR",
    "GRAM/USD",
    "USDT/EUR",
  ]);
});

test("invalid future and malformed snapshots are rejected before persistence", async () => {
  const repository = createPrismaRateSnapshotRepository(createMemoryPrisma().db);
  await assert.rejects(
    repository.recordMany([draft({
      observedAt: new Date("2026-08-13T10:00:11.000Z"),
    })]),
    /observedAt cannot be later than fetchedAt/,
  );
  await assert.rejects(
    repository.recordMany([draft({ price: "Infinity" })]),
    /positive decimal string/,
  );
  await assert.rejects(
    repository.recordMany([draft({ source: "usd-peg" })]),
    /Rate source for GRAM must be coingecko/,
  );
  await assert.rejects(
    repository.recordMany([draft({ quoteCurrency: "GBP" as any })]),
    /quote currency must be EUR or USD/,
  );
  await assert.rejects(
    repository.recordMany([draft({
      asset: "USDT",
      baseCurrency: "USDT",
      price: "0.99",
      source: "usd-peg",
      payload: { policy: "1 USDT = 1 USD" },
    })]),
    /exact 1 USDT = 1 USD policy/,
  );
  await assert.rejects(
    repository.recordMany([draft({
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "EUR",
      price: "0.8",
      source: "usd-peg",
      payload: null,
    })]),
    /USDT\/EUR provenance payload is required/,
  );
  await assert.rejects(
    repository.findAt({
      asset: "GRAM",
      quoteCurrency: "GBP" as any,
      at: new Date("2026-08-13T10:00:00.000Z"),
      maxAgeMs: 60_000,
    }),
    /Currency must be EUR or USD/,
  );
});

test("EUR-only refresh persists both immutable market components before the derived snapshot", async () => {
  const memory = createMemoryPrisma();
  const repository = createPrismaRateSnapshotRepository(memory.db);
  const result = await refreshPaymentRateSnapshots({
    repository,
    currencies: ["EUR"],
    now: () => new Date("2026-08-13T10:00:30.000Z"),
    maxProviderAgeMs: 300_000,
    fetchGramRate: async (currency) => ({
      source: "coingecko",
      currency,
      fiatPerTon: currency === "USD" ? 2.5 : 2,
      updatedAt: new Date(currency === "USD"
        ? "2026-08-13T10:00:05.000Z"
        : "2026-08-13T10:00:00.000Z"),
      fetchedAt: new Date("2026-08-13T10:00:20.000Z"),
    }),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.snapshots.map(({ asset, quoteCurrency }) => `${asset}/${quoteCurrency}`), [
    "GRAM/EUR",
    "GRAM/USD",
    "USDT/EUR",
  ]);
  const derived = result.snapshots[2]!;
  const payload = structuredClone(derived.payload) as any;
  payload.components.gramUsd.price = "3";
  payload.components.gramUsd.observedAt = "2026-08-13T10:00:06.000Z";
  await assert.rejects(
    repository.recordMany([{
      ...derived,
      price: divideRatePrices("2", "3"),
      observedAt: new Date("2026-08-13T10:00:06.000Z"),
      payload,
    }]),
    /component snapshot does not match stored evidence/,
  );
});

test("refresh isolates malformed provider pairs without losing independent snapshots", async () => {
  const stored: RateSnapshotDraft[] = [];
  const repository: RateSnapshotRepository = {
    recordMany: async (drafts) => {
      stored.push(...drafts);
      return drafts.map((value, index) => ({
        ...value,
        id: `isolated-${index}`,
        createdAt: value.fetchedAt,
      }));
    },
    findAt: async () => null,
  };
  const result = await refreshPaymentRateSnapshots({
    repository,
    now: () => new Date("2026-08-13T10:00:30.000Z"),
    maxProviderAgeMs: 300_000,
    fetchGramRate: async (currency) => ({
      source: "coingecko",
      currency: currency === "EUR" ? "USD" : currency,
      fiatPerTon: 2.5,
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
      fetchedAt: new Date("2026-08-13T10:00:20.000Z"),
    }),
  });

  assert.equal(result.ok, false);
  assert.deepEqual(stored.map(({ asset, quoteCurrency }) => `${asset}/${quoteCurrency}`), [
    "GRAM/USD",
    "USDT/USD",
  ]);
  assert.deepEqual(result.errors.map(({ asset, quoteCurrency }) => `${asset}/${quoteCurrency}`).sort(), [
    "GRAM/EUR",
    "USDT/EUR",
  ]);
  await assert.rejects(
    refreshPaymentRateSnapshots({ repository, maxProviderAgeMs: -1 }),
    /maxProviderAgeMs must be a non-negative integer/,
  );
});
