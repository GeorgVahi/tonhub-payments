import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  createPrismaRateSnapshotRepository,
  refreshPaymentRateSnapshots,
} from "../backend/src/rate-snapshots";

const prisma = new PrismaClient();
const repository = createPrismaRateSnapshotRepository(prisma as any);

try {
  const firstObservedAt = new Date("2026-08-13T12:00:00.000Z");
  const secondObservedAt = new Date("2026-08-13T12:01:00.000Z");
  const first = {
    asset: "GRAM" as const,
    baseCurrency: "GRAM" as const,
    quoteCurrency: "USD" as const,
    price: "2.5",
    source: "coingecko" as const,
    observedAt: firstObservedAt,
    fetchedAt: new Date("2026-08-13T12:00:10.000Z"),
    payload: null,
  };
  const second = {
    ...first,
    price: "2.6",
    observedAt: secondObservedAt,
    fetchedAt: new Date("2026-08-13T12:01:10.000Z"),
  };
  await repository.recordMany([first, first, second]);
  await repository.recordMany([first, second]);
  await Promise.all(Array.from({ length: 4 }, () => repository.recordMany([first, second])));
  assert.equal((await repository.recordMany([{ ...first, price: "9.9" }]))[0]?.price, "2.5");
  assert.equal(
    await prisma.tonhubRateSnapshot.count({
      where: { asset: "GRAM", quoteCurrency: "USD", source: "coingecko" },
    }),
    2,
  );
  assert.equal((await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T12:00:30.000Z"),
    maxAgeMs: 60_000,
  }))?.price, "2.5");
  assert.equal(await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T11:59:59.000Z"),
    maxAgeMs: 60_000,
  }), null);
  assert.equal(await repository.findAt({
    asset: "GRAM",
    quoteCurrency: "USD",
    at: new Date("2026-08-13T12:10:00.000Z"),
    maxAgeMs: 60_000,
  }), null);

  const refreshed = await refreshPaymentRateSnapshots({
    repository,
    now: () => new Date("2026-08-13T12:02:30.000Z"),
    maxProviderAgeMs: 300_000,
    fetchGramRate: async (currency) => ({
      source: "coingecko",
      currency,
      fiatPerTon: currency === "USD" ? 2.5 : 2,
      updatedAt: new Date("2026-08-13T12:02:00.000Z"),
      fetchedAt: new Date("2026-08-13T12:02:20.000Z"),
    }),
  });
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.snapshots.length, 4);
  assert.equal(
    (await prisma.tonhubRateSnapshot.findFirstOrThrow({
      where: { asset: "USDT", quoteCurrency: "USD", source: "usd-peg" },
      orderBy: { observedAt: "desc" },
    })).price.toString(),
    "1",
  );
  const usdtEur = await prisma.tonhubRateSnapshot.findFirstOrThrow({
    where: { asset: "USDT", quoteCurrency: "EUR", source: "usd-peg" },
    orderBy: { observedAt: "desc" },
  });
  assert.equal(usdtEur.price.toString(), "0.8");
  const evidence = usdtEur.payload as any;
  const components = await prisma.tonhubRateSnapshot.findMany({
    where: {
      id: { in: [evidence.components.gramEur.snapshotId, evidence.components.gramUsd.snapshotId] },
    },
  });
  assert.equal(components.length, 2);
  assert.deepEqual(
    components.map(({ asset, quoteCurrency, price }) => `${asset}/${quoteCurrency}:${price}`).sort(),
    ["GRAM/EUR:2", "GRAM/USD:2.5"],
  );
  const forgedEvidence = structuredClone(evidence);
  forgedEvidence.components.gramUsd.observedAt = "2026-08-13T12:02:01.000Z";
  await assert.rejects(
    repository.recordMany([{
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "EUR",
      price: "0.8",
      source: "usd-peg",
      observedAt: new Date("2026-08-13T12:02:01.000Z"),
      fetchedAt: new Date("2026-08-13T12:02:30.000Z"),
      payload: forgedEvidence,
    }]),
    /component snapshot does not match stored evidence|rate snapshot violates payment rate policy/,
  );
  assert.equal(
    await prisma.tonhubRateSnapshot.count({
      where: { asset: "USDT", quoteCurrency: "EUR", source: "usd-peg" },
    }),
    1,
  );
  await assert.rejects(
    repository.recordMany([{
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "USD",
      price: "0.99",
      source: "usd-peg",
      observedAt: new Date("2026-08-13T12:03:00.000Z"),
      fetchedAt: new Date("2026-08-13T12:03:00.000Z"),
      payload: { policy: "1 USDT = 1 USD" },
    }]),
    /exact 1 USDT = 1 USD policy/,
  );
} finally {
  await prisma.$disconnect();
}
