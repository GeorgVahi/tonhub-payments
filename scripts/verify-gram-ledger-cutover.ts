import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { PrismaClient } from "@prisma/client";
import { Address } from "@ton/core";
import { checkTonhubPaymentInvoice } from "../backend/src/payments";
import { createPrismaTonhubPaymentRepository } from "../backend/src/repository";
import { createMovementLedger } from "../backend/src/movement-ledger";
import {
  createPrismaGramLedgerSettlementSource,
  type GramSettlementComparison,
} from "../backend/src/gram-ledger-source";

const prisma = new PrismaClient();
const repository = createPrismaTonhubPaymentRepository(prisma as any);
const ledger = createMovementLedger(prisma as any);
const source = createPrismaGramLedgerSettlementSource(prisma as any, ledger);
const suffix = process.env.TONHUB_GRAM_CUTOVER_VERIFY_SUFFIX ?? "default";
const destinationRaw = `0:${(suffix === "clean" ? "b1" : "b2").repeat(32)}`;
const sourceRaw = `0:${(suffix === "clean" ? "c1" : "c2").repeat(32)}`;
const destination = Address.parse(destinationRaw).toString({ bounceable: true, testOnly: true });
const createdAt = new Date("2026-08-13T10:00:00.000Z");
const now = new Date("2026-08-13T10:30:00.000Z");
const firstHash = (suffix === "clean" ? "d1" : "d2").repeat(32);
const secondHash = (suffix === "clean" ? "e1" : "e2").repeat(32);
const abortedHash = (suffix === "clean" ? "f1" : "f2").repeat(32);
const comparisons: GramSettlementComparison[] = [];

const payment = (input: {
  hash: string;
  lt: string;
  at: Date;
  aborted?: boolean;
}) => ({
  hash: input.hash,
  lt: input.lt,
  now: Math.floor(input.at.getTime() / 1000),
  description: {
    aborted: input.aborted ?? false,
    action: { success: !(input.aborted ?? false) },
  },
  in_msg: {
    source: sourceRaw,
    destination: destinationRaw,
    value: "1000000000",
  },
});

let transactions = [
  payment({
    hash: abortedHash,
    lt: "700002",
    at: new Date("2026-08-13T10:11:00.000Z"),
    aborted: true,
  }),
  payment({
    hash: firstHash,
    lt: "700001",
    at: new Date("2026-08-13T10:10:00.000Z"),
  }),
];

try {
  const created = await repository.createPendingInvoice({
    externalId: `gram-cutover-order-${suffix}`,
    amountCents: 500,
    currency: "USD",
    network: "testnet",
    depositAddress: {
      network: "testnet",
      address: destination,
      addressRaw: destinationRaw,
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 840_001 : 840_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `gram-cutover-key-${suffix}`,
    },
    reference: `GRAM-CUTOVER-${suffix}`,
    quote: {
      source: "coingecko",
      asset: "GRAM",
      assetDecimals: 9,
      fiatPerAsset: 2.5,
      amountAtomic: "2000000000",
      amountFormatted: "2 GRAM (ex TON)",
      fiatAmountCents: 500,
      fiatAmount: 5,
      fiatCurrency: "USD",
      fiatPerGram: 2.5,
      fiatPerTon: 2.5,
      amountNano: "2000000000",
      amountGram: "2 GRAM (ex TON)",
      amountTon: "2 GRAM (ex TON)",
      updatedAt: createdAt,
      fetchedAt: createdAt,
    },
    createdAt,
    expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    priceLockedAt: createdAt,
    priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    activationThresholdFiatMicros: "0",
  });

  const dependencies = {
    repository,
    now: () => now,
    resolveTonApiConfig: () => ({
      network: "testnet" as const,
      baseUrl: "https://example.invalid",
      address: "",
      addressEnvName: "",
    }),
    fetchTonTransactions: async () => ({ transactions }),
    gramLedgerSource: source,
    gramSettlementMode: () => "ledger" as const,
    reportGramSettlementComparison: (comparison: GramSettlementComparison) => {
      comparisons.push(comparison);
    },
  };

  const partial = await checkTonhubPaymentInvoice(created.id, dependencies);
  assert.equal(partial.status, 200);
  assert.equal(partial.body.finalized, false);
  const partialInvoice = await prisma.tonhubPaymentInvoice.findUnique({
    where: { id: created.id },
  });
  const partialOrder = await prisma.tonhubPaymentOrder.findUnique({
    where: { id: created.orderId! },
  });
  assert.equal(partialInvoice?.status, "PARTIAL");
  assert.equal(partialInvoice?.paidAmountAtomic, "1000000000");
  assert.equal(partialOrder?.status, "PARTIAL");
  assert.equal(partialOrder?.creditedFiatMicros, "2500000");
  const movements = await prisma.tonhubPaymentMovement.findMany({
    where: { transactionHash: { in: [firstHash, abortedHash] } },
  });
  assert.equal(movements.length, 1);
  assert.equal(movements[0]?.transactionHash, firstHash);
  assert.equal(movements[0]?.status, "OBSERVED");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { movementId: movements[0]!.id },
  }), 0);
  assert.equal(comparisons[0]?.legacyAmountAtomic, "2000000000");
  assert.equal(comparisons[0]?.ledgerAmountAtomic, "1000000000");
  assert.deepEqual(comparisons[0]?.onlyLegacy, [abortedHash]);

  const partialObservedPayments = partialInvoice?.observedPayments as Array<Record<string, unknown>>;
  assert.equal(partialObservedPayments.length, 1);
  await prisma.tonhubPaymentInvoice.update({
    where: { id: created.id },
    data: {
      observedPayments: partialObservedPayments.map((payment) => ({
        ...payment,
        transactionId: Buffer.from(firstHash, "hex").toString("base64url"),
      })),
    },
  });

  transactions = [
    payment({
      hash: secondHash,
      lt: "700003",
      at: new Date("2026-08-13T10:20:00.000Z"),
    }),
    ...transactions,
  ];
  const paid = await checkTonhubPaymentInvoice(created.id, dependencies);
  assert.equal(paid.status, 200);
  assert.equal(paid.body.finalized, true);
  const paidInvoice = await prisma.tonhubPaymentInvoice.findUnique({ where: { id: created.id } });
  const paidOrder = await prisma.tonhubPaymentOrder.findUnique({ where: { id: created.orderId! } });
  assert.equal(paidInvoice?.status, "PAID");
  assert.equal(paidInvoice?.paidAmountAtomic, "2000000000");
  assert.equal(paidOrder?.status, "PAID");
  assert.equal(paidOrder?.creditedFiatMicros, "5000000");
  assert.equal(await prisma.tonhubPaymentMovement.count({
    where: { transactionHash: { in: [firstHash, secondHash, abortedHash] } },
  }), 2);
  assert.equal(await prisma.tonhubPaymentMovement.count({ where: { transactionHash: firstHash } }), 1);
  assert.equal(comparisons.length, 2);
} finally {
  await prisma.$disconnect();
}

console.log(`ok - GRAM ledger settlement cutover (${suffix})`);
