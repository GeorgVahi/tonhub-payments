import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import {
  TonhubOrderNotRetryableError,
  TonhubOrderTermsMismatchError,
  createPrismaTonhubPaymentRepository,
} from "../backend/src/repository";

const prisma = new PrismaClient();
const repository = createPrismaTonhubPaymentRepository(prisma as any);
const createdAt = new Date("2026-08-13T10:00:00.000Z");
const input = {
  externalId: "repository-rehearsal-order",
  amountCents: 500,
  currency: "USD",
  network: "testnet" as const,
  depositAddress: {
    network: "testnet" as const,
    address: "EQ_REPOSITORY_REHEARSAL",
    addressRaw: "0:repository-rehearsal",
    addressStrategy: "unique-address" as const,
    walletVersion: "v5r1" as const,
    walletWorkchain: 0,
    walletContext: 701,
    walletNetworkGlobalId: -3,
    walletPublicKeyHash: "repository-rehearsal-key",
  },
  reference: "REPOSITORY-REHEARSAL",
  quote: {
    source: "coingecko" as const,
    fiatAmountCents: 500,
    fiatAmount: 5,
    fiatCurrency: "USD" as const,
    fiatPerGram: 2.5,
    fiatPerTon: 2.5,
    amountNano: "2000000000",
    amountGram: "2 GRAM (ex TON)",
    amountTon: "2 GRAM (ex TON)",
    updatedAt: createdAt,
    fetchedAt: createdAt,
  },
  metadata: { source: "repository-rehearsal" },
  createdAt,
  expiresAt: new Date("2026-08-13T11:00:00.000Z"),
  priceLockedAt: createdAt,
  priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
};

try {
  const first = await repository.createPendingInvoice(input);
  const duplicate = await repository.createPendingInvoice({
    ...input,
    reference: "UNUSED-DUPLICATE-REFERENCE",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_UNUSED_DUPLICATE_REHEARSAL",
      addressRaw: "0:unused-duplicate-rehearsal",
      walletContext: 702,
    },
  });

  assert.equal(duplicate.id, first.id);
  assert.ok(first.orderId);
  assert.equal(first.externalId, input.externalId);
  assert.equal(await prisma.tonhubPaymentOrder.count(), 1);
  assert.equal(await prisma.tonhubPaymentInvoice.count(), 1);
  assert.equal(await prisma.tonhubDepositAddress.count(), 1);

  const partial = await repository.markInvoicePartial({
    invoiceId: first.id,
    paidNano: "1000000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  assert.equal(partial?.status, "PARTIAL");
  assert.equal(partial?.order?.status, "PARTIAL");
  assert.equal(partial?.creditedFiatMicros, "2500000");

  const paidAt = new Date("2026-08-13T10:20:00.000Z");
  const paid = await repository.markInvoicePaid({
    invoiceId: first.id,
    transactionId: "repository-rehearsal-paid",
    paidNano: "2000000000",
    observedPayments: [],
    paidAt,
  });
  assert.equal(paid?.status, "PAID");
  assert.equal(paid?.order?.status, "PAID");
  assert.equal(paid?.order?.creditedFiatMicros, "5000000");
  assert.equal(paid?.order?.paidAt?.toISOString(), paidAt.toISOString());
  assert.equal(paid?.firstMovementAt?.toISOString(), new Date("2026-08-13T10:10:00.000Z").toISOString());

  const reusable = await repository.findReusableInvoice({
    externalId: input.externalId,
    network: "mainnet",
    amountCents: 500,
    currency: "USD",
  });
  assert.equal(reusable?.id, first.id);
  assert.equal(reusable?.status, "PAID");

  await assert.rejects(
    repository.findReusableInvoice({
      externalId: input.externalId,
      network: "testnet",
      amountCents: 501,
      currency: "USD",
    }),
    TonhubOrderTermsMismatchError,
  );

  const concurrentResults = await Promise.all(
    Array.from({ length: 8 }, (_, index) => repository.createPendingInvoice({
      ...input,
      externalId: "repository-concurrent-order",
      reference: `REPOSITORY-CONCURRENT-${index}`,
      depositAddress: {
        ...input.depositAddress,
        address: `EQ_REPOSITORY_CONCURRENT_${index}`,
        addressRaw: `0:repository-concurrent-${index}`,
        walletContext: 800 + index,
      },
    })),
  );
  assert.equal(new Set(concurrentResults.map((invoice) => invoice.id)).size, 1);
  const concurrentOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId: "repository-concurrent-order" },
  });
  assert.equal(
    await prisma.tonhubPaymentInvoice.count({ where: { orderId: concurrentOrder.id } }),
    1,
  );
  assert.equal(
    await prisma.tonhubDepositAddress.count({
      where: { invoice: { orderId: concurrentOrder.id } },
    }),
    1,
  );

  const rolloutLinked = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-rollout-funded",
    reference: "REPOSITORY-ROLLOUT-LINKED",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_ROLLOUT_LINKED",
      addressRaw: "0:repository-rollout-linked",
      walletContext: 910,
    },
  });
  const rolloutObservedAt = new Date("2026-08-13T10:30:00.000Z");
  const rolloutLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-rollout-funded",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_ROLLOUT_LEGACY",
      addressRaw: "0:repository-rollout-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 911,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-rollout-legacy-key",
      amountNano: "2000000000",
      paidNano: "500000000",
      reference: "REPOSITORY-ROLLOUT-LEGACY",
      status: "EXPIRED",
      providerName: "ton-direct",
      observedAt: rolloutObservedAt,
      expiresAt: rolloutObservedAt,
      createdAt: new Date("2026-08-13T09:59:00.000Z"),
      updatedAt: rolloutObservedAt,
    },
  });
  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "repository-rollout-funded",
      network: "testnet",
      amountCents: 500,
      currency: "USD",
    }),
    TonhubOrderNotRetryableError,
  );
  const reconciledRolloutOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId: "repository-rollout-funded" },
  });
  assert.equal(reconciledRolloutOrder.status, "RECOVERY");
  assert.equal(reconciledRolloutOrder.creditedFiatMicros, "1250000");
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: rolloutLinked.id } })).status,
    "CANCELLED",
  );
  assert.equal(
    (await prisma.tonhubDepositAddress.findUniqueOrThrow({ where: { invoiceId: rolloutLinked.id } })).status,
    "CANCELLED",
  );
  const attachedRolloutLegacy = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: rolloutLegacy.id },
  });
  assert.equal(attachedRolloutLegacy.orderId, rolloutLinked.orderId);
  assert.equal(attachedRolloutLegacy.firstMovementAt?.toISOString(), rolloutObservedAt.toISOString());

  const orphanFunded = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-funded-without-order",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_FUNDED_WITHOUT_ORDER",
      addressRaw: "0:repository-funded-without-order",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 932,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-funded-without-order-key",
      amountNano: "2000000000",
      paidNano: "500000000",
      reference: "REPOSITORY-FUNDED-WITHOUT-ORDER",
      status: "EXPIRED",
      providerName: "ton-direct",
      observedAt: rolloutObservedAt,
      expiresAt: rolloutObservedAt,
      createdAt: new Date("2026-08-13T09:57:00.000Z"),
      updatedAt: rolloutObservedAt,
    },
  });
  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "repository-funded-without-order",
      network: "mainnet",
      amountCents: 500,
      currency: "USD",
    }),
    TonhubOrderNotRetryableError,
  );
  const orphanFundedOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId: "repository-funded-without-order" },
  });
  assert.equal(orphanFundedOrder.status, "RECOVERY");
  assert.equal(orphanFundedOrder.creditedFiatMicros, "1250000");
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: orphanFunded.id } })).orderId,
    orphanFundedOrder.id,
  );

  const crossNetworkLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-cross-network-legacy",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_CROSS_NETWORK_LEGACY",
      addressRaw: "0:repository-cross-network-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 933,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-cross-network-legacy-key",
      amountNano: "2000000000",
      paidNano: "0",
      reference: "REPOSITORY-CROSS-NETWORK-LEGACY",
      status: "PENDING",
      providerName: "ton-direct",
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T09:56:00.000Z"),
      updatedAt: createdAt,
    },
  });
  const crossNetworkReuse = await repository.findReusableInvoice({
    externalId: "repository-cross-network-legacy",
    network: "mainnet",
    amountCents: 500,
    currency: "USD",
  });
  assert.equal(crossNetworkReuse?.id, crossNetworkLegacy.id);
  assert.equal(crossNetworkReuse?.network, "testnet");
  assert.ok(crossNetworkReuse?.orderId);

  const recoveryBase = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-rollout-existing-recovery",
    reference: "REPOSITORY-ROLLOUT-RECOVERY-BASE",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_ROLLOUT_RECOVERY_BASE",
      addressRaw: "0:repository-rollout-recovery-base",
      walletContext: 930,
    },
  });
  await repository.markInvoicePartial({
    invoiceId: recoveryBase.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:10:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:10:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:10:00.000Z"),
  });
  await repository.markInvoiceExpired({
    invoiceId: recoveryBase.id,
    expiredAt: new Date("2026-08-14T10:11:00.000Z"),
  });
  const recoveryLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-rollout-existing-recovery",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_ROLLOUT_RECOVERY_LEGACY",
      addressRaw: "0:repository-rollout-recovery-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 931,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-rollout-recovery-legacy-key",
      amountNano: "2000000000",
      paidNano: "500000000",
      reference: "REPOSITORY-ROLLOUT-RECOVERY-LEGACY",
      status: "EXPIRED",
      providerName: "ton-direct",
      observedAt: rolloutObservedAt,
      expiresAt: rolloutObservedAt,
      createdAt: new Date("2026-08-13T09:58:00.000Z"),
      updatedAt: rolloutObservedAt,
    },
  });
  await assert.rejects(
    repository.findReusableInvoice({
      externalId: "repository-rollout-existing-recovery",
      network: "testnet",
      amountCents: 500,
      currency: "USD",
    }),
    TonhubOrderNotRetryableError,
  );
  const accumulatedRecoveryOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId: "repository-rollout-existing-recovery" },
  });
  assert.equal(accumulatedRecoveryOrder.status, "RECOVERY");
  assert.equal(accumulatedRecoveryOrder.creditedFiatMicros, "2500000");
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: recoveryLegacy.id } })).orderId,
    recoveryBase.orderId,
  );

  const transitionLinked = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-rollout-transition",
    reference: "REPOSITORY-ROLLOUT-TRANSITION-LINKED",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_TRANSITION_LINKED",
      addressRaw: "0:repository-transition-linked",
      walletContext: 920,
    },
  });
  const transitionLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-rollout-transition",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_TRANSITION_LEGACY",
      addressRaw: "0:repository-transition-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 921,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-transition-legacy-key",
      amountNano: "2000000000",
      paidNano: "0",
      reference: "REPOSITORY-ROLLOUT-TRANSITION-LEGACY",
      status: "PENDING",
      providerName: "ton-direct",
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T09:59:00.000Z"),
      updatedAt: createdAt,
    },
  });
  const transitionPartial = await repository.markInvoicePartial({
    invoiceId: transitionLegacy.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:35:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:35:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:35:00.000Z"),
  });
  assert.equal(transitionPartial?.status, "PARTIAL");
  assert.equal(transitionPartial?.order?.status, "PARTIAL");
  assert.equal(transitionPartial?.orderId, transitionLinked.orderId);
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: transitionLinked.id } })).status,
    "CANCELLED",
  );
  assert.equal(
    (await prisma.tonhubDepositAddress.findUniqueOrThrow({ where: { invoiceId: transitionLinked.id } })).status,
    "CANCELLED",
  );

  const concurrentTransitionLinked = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-rollout-concurrent-transition",
    reference: "REPOSITORY-ROLLOUT-CONCURRENT-LINKED",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_CONCURRENT_TRANSITION_LINKED",
      addressRaw: "0:repository-concurrent-transition-linked",
      walletContext: 940,
    },
  });
  const concurrentTransitionLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-rollout-concurrent-transition",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_CONCURRENT_TRANSITION_LEGACY",
      addressRaw: "0:repository-concurrent-transition-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 941,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-concurrent-transition-legacy-key",
      amountNano: "2000000000",
      paidNano: "0",
      reference: "REPOSITORY-ROLLOUT-CONCURRENT-LEGACY",
      status: "PENDING",
      providerName: "ton-direct",
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T09:55:00.000Z"),
      updatedAt: createdAt,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      network: "testnet",
      address: "EQ_REPOSITORY_CONCURRENT_TRANSITION_LEGACY",
      addressRaw: "0:repository-concurrent-transition-legacy",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 941,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-concurrent-transition-legacy-key",
      invoiceKind: "tonhub-payment",
      invoiceId: concurrentTransitionLegacy.id,
      status: "ACTIVE",
      assignedAt: createdAt,
    },
  });
  let signalStaleRead!: () => void;
  const staleRead = new Promise<void>((resolve) => {
    signalStaleRead = resolve;
  });
  let resumeStaleTransition!: () => void;
  const staleTransitionResume = new Promise<void>((resolve) => {
    resumeStaleTransition = resolve;
  });
  let paused = false;
  const pausedPrisma = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => prisma.$transaction(async (tx) => {
      const wrappedTx: any = {
        tonhubPaymentOrder: {
          findUnique: (args: any) => tx.tonhubPaymentOrder.findUnique(args),
          create: (args: any) => tx.tonhubPaymentOrder.create(args),
          upsert: (args: any) => tx.tonhubPaymentOrder.upsert(args),
          updateMany: (args: any) => tx.tonhubPaymentOrder.updateMany(args),
        },
        tonhubPaymentInvoice: {
          findUnique: async (args: any) => {
            const value = await tx.tonhubPaymentInvoice.findUnique(args);
            if (!paused && args.where?.id === concurrentTransitionLegacy.id) {
              paused = true;
              signalStaleRead();
              await staleTransitionResume;
            }
            return value;
          },
          findFirst: (args: any) => tx.tonhubPaymentInvoice.findFirst(args),
          findMany: (args: any) => tx.tonhubPaymentInvoice.findMany(args),
          updateMany: (args: any) => tx.tonhubPaymentInvoice.updateMany(args),
        },
        tonhubDepositAddress: {
          updateMany: (args: any) => tx.tonhubDepositAddress.updateMany(args),
        },
        tonhubPaymentTransaction: tx.tonhubPaymentTransaction,
      };
      wrappedTx.$transaction = async (inner: (nested: any) => Promise<unknown>) => inner(wrappedTx);
      return handler(wrappedTx);
    }),
    tonhubPaymentOrder: prisma.tonhubPaymentOrder,
    tonhubPaymentInvoice: prisma.tonhubPaymentInvoice,
    tonhubDepositAddress: prisma.tonhubDepositAddress,
    tonhubPaymentTransaction: prisma.tonhubPaymentTransaction,
  };
  const pausedRepository = createPrismaTonhubPaymentRepository(pausedPrisma as any);
  const concurrentPartialPromise = pausedRepository.markInvoicePartial({
    invoiceId: concurrentTransitionLegacy.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:40:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:40:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:40:00.000Z"),
  });
  await staleRead;
  const concurrentReuse = await repository.findReusableInvoice({
    externalId: "repository-rollout-concurrent-transition",
    network: "testnet",
    amountCents: 500,
    currency: "USD",
  });
  assert.equal(concurrentReuse?.id, concurrentTransitionLinked.id);
  resumeStaleTransition();
  const concurrentPartial = await concurrentPartialPromise;
  assert.equal(concurrentPartial?.id, concurrentTransitionLegacy.id);
  assert.equal(concurrentPartial?.status, "PARTIAL");
  assert.equal(concurrentPartial?.order?.status, "PARTIAL");
  assert.equal(
    (await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: concurrentTransitionLinked.id } })).status,
    "CANCELLED",
  );
  assert.equal(
    await prisma.tonhubPaymentInvoice.count({
      where: {
        orderId: concurrentTransitionLinked.orderId,
        status: { in: ["PENDING", "PARTIAL"] },
      },
    }),
    1,
  );
  assert.equal(
    (await prisma.tonhubDepositAddress.findUniqueOrThrow({
      where: { invoiceId: concurrentTransitionLegacy.id },
    })).status,
    "ACTIVE",
  );

  const fundedRaceLinked = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-rollout-funded-race",
    reference: "REPOSITORY-ROLLOUT-FUNDED-RACE-LINKED",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_FUNDED_RACE_LINKED",
      addressRaw: "0:repository-funded-race-linked",
      walletContext: 944,
    },
  });
  const fundedRaceLegacy = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: "repository-rollout-funded-race",
      network: "testnet",
      asset: "GRAM",
      fiatAmountCents: 500,
      fiatCurrency: "USD",
      address: "EQ_REPOSITORY_FUNDED_RACE_LEGACY",
      addressRaw: "0:repository-funded-race-legacy",
      addressStrategy: "unique-address",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 945,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-funded-race-legacy-key",
      amountNano: "2000000000",
      paidNano: "0",
      reference: "REPOSITORY-ROLLOUT-FUNDED-RACE-LEGACY",
      status: "PENDING",
      providerName: "ton-direct",
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T09:53:00.000Z"),
      updatedAt: createdAt,
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      network: "testnet",
      address: "EQ_REPOSITORY_FUNDED_RACE_LEGACY",
      addressRaw: "0:repository-funded-race-legacy",
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: 945,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: "repository-funded-race-legacy-key",
      invoiceKind: "tonhub-payment",
      invoiceId: fundedRaceLegacy.id,
      status: "ACTIVE",
      assignedAt: createdAt,
    },
  });
  let signalFundedRaceRead!: () => void;
  const fundedRaceRead = new Promise<void>((resolve) => {
    signalFundedRaceRead = resolve;
  });
  let resumeFundedRace!: () => void;
  const fundedRaceResume = new Promise<void>((resolve) => {
    resumeFundedRace = resolve;
  });
  let fundedRacePaused = false;
  const fundedRacePrisma = {
    $transaction: async (handler: (tx: any) => Promise<unknown>) => prisma.$transaction(async (tx) => {
      const wrappedTx: any = {
        tonhubPaymentOrder: {
          findUnique: (args: any) => tx.tonhubPaymentOrder.findUnique(args),
          create: (args: any) => tx.tonhubPaymentOrder.create(args),
          upsert: (args: any) => tx.tonhubPaymentOrder.upsert(args),
          updateMany: (args: any) => tx.tonhubPaymentOrder.updateMany(args),
        },
        tonhubPaymentInvoice: {
          findUnique: async (args: any) => {
            const value = await tx.tonhubPaymentInvoice.findUnique(args);
            if (!fundedRacePaused && args.where?.id === fundedRaceLinked.id) {
              fundedRacePaused = true;
              signalFundedRaceRead();
              await fundedRaceResume;
            }
            return value;
          },
          findFirst: (args: any) => tx.tonhubPaymentInvoice.findFirst(args),
          findMany: (args: any) => tx.tonhubPaymentInvoice.findMany(args),
          updateMany: (args: any) => tx.tonhubPaymentInvoice.updateMany(args),
        },
        tonhubDepositAddress: {
          updateMany: (args: any) => tx.tonhubDepositAddress.updateMany(args),
        },
        tonhubPaymentTransaction: tx.tonhubPaymentTransaction,
      };
      wrappedTx.$transaction = async (inner: (nested: any) => Promise<unknown>) => inner(wrappedTx);
      return handler(wrappedTx);
    }),
    tonhubPaymentOrder: prisma.tonhubPaymentOrder,
    tonhubPaymentInvoice: prisma.tonhubPaymentInvoice,
    tonhubDepositAddress: prisma.tonhubDepositAddress,
    tonhubPaymentTransaction: prisma.tonhubPaymentTransaction,
  };
  const fundedRaceRepository = createPrismaTonhubPaymentRepository(fundedRacePrisma as any);
  const linkedFundedTransition = fundedRaceRepository.markInvoicePartial({
    invoiceId: fundedRaceLinked.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:42:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:42:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:42:00.000Z"),
  });
  await fundedRaceRead;
  const rolloutFundedTransition = await repository.markInvoicePartial({
    invoiceId: fundedRaceLegacy.id,
    paidNano: "500000000",
    partialPaymentStartedAt: new Date("2026-08-13T10:43:00.000Z"),
    partialPaymentExpiresAt: new Date("2026-08-14T10:43:00.000Z"),
    observedPayments: [],
    observedAt: new Date("2026-08-13T10:43:00.000Z"),
  });
  resumeFundedRace();
  const linkedFundedRecovery = await linkedFundedTransition;
  assert.equal(rolloutFundedTransition?.status, "PARTIAL");
  assert.equal(linkedFundedRecovery?.status, "FAILED");
  assert.equal(linkedFundedRecovery?.paidAmountAtomic, "500000000");
  const fundedRaceOrder = await prisma.tonhubPaymentOrder.findUniqueOrThrow({
    where: { externalId: "repository-rollout-funded-race" },
  });
  assert.equal(fundedRaceOrder.status, "RECOVERY");
  assert.equal(fundedRaceOrder.creditedFiatMicros, "2500000");
  assert.equal(
    (await prisma.tonhubDepositAddress.findUniqueOrThrow({ where: { invoiceId: fundedRaceLinked.id } })).status,
    "FAILED",
  );
  assert.equal(
    (await prisma.tonhubDepositAddress.findUniqueOrThrow({ where: { invoiceId: fundedRaceLegacy.id } })).status,
    "ACTIVE",
  );

  for (const terminalStatus of ["CANCELLED", "FAILED"] as const) {
    const externalId = `repository-orphan-${terminalStatus.toLowerCase()}`;
    const terminalInvoice = await prisma.tonhubPaymentInvoice.create({
      data: {
        externalId,
        network: "testnet",
        asset: "GRAM",
        fiatAmountCents: 500,
        fiatCurrency: "USD",
        address: `EQ_REPOSITORY_ORPHAN_${terminalStatus}`,
        addressRaw: `0:repository-orphan-${terminalStatus.toLowerCase()}`,
        addressStrategy: "unique-address",
        walletVersion: "v5r1",
        walletWorkchain: 0,
        walletContext: terminalStatus === "CANCELLED" ? 942 : 943,
        walletNetworkGlobalId: -3,
        walletPublicKeyHash: `repository-orphan-${terminalStatus.toLowerCase()}-key`,
        amountNano: "2000000000",
        paidNano: "0",
        reference: `REPOSITORY-ORPHAN-${terminalStatus}`,
        status: terminalStatus,
        providerName: "ton-direct",
        expiresAt: new Date("2026-08-13T11:00:00.000Z"),
        createdAt: new Date("2026-08-13T09:54:00.000Z"),
        updatedAt: createdAt,
      },
    });
    await assert.rejects(
      repository.findReusableInvoice({
        externalId,
        network: "testnet",
        amountCents: 500,
        currency: "USD",
      }),
      TonhubOrderNotRetryableError,
    );
    assert.equal(
      (await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { externalId } })).status,
      terminalStatus,
    );
    assert.ok((await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: terminalInvoice.id } })).orderId);
  }

  const direct = await repository.createPendingInvoice({
    ...input,
    externalId: "repository-direct-paid-order",
    reference: "REPOSITORY-DIRECT-PAID",
    depositAddress: {
      ...input.depositAddress,
      address: "EQ_REPOSITORY_DIRECT_PAID",
      addressRaw: "0:repository-direct-paid",
      walletContext: 900,
    },
  });
  const directPaidAt = new Date("2026-08-13T10:25:00.000Z");
  const directPaid = await repository.markInvoicePaid({
    invoiceId: direct.id,
    transactionId: "repository-direct-paid-transaction",
    paidNano: "2000000000",
    observedPayments: [],
    paidAt: directPaidAt,
  });
  assert.equal(directPaid?.firstMovementAt?.toISOString(), directPaidAt.toISOString());

  process.stdout.write("Order/attempt repository rehearsal passed.\n");
} finally {
  await prisma.$disconnect();
}
