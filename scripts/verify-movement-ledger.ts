import assert from "node:assert/strict";
import { PrismaClient } from "@prisma/client";
import { Address } from "@ton/core";
import {
  createMovementLedger,
  MovementFingerprintConflictError,
} from "../backend/src/movement-ledger";
import { createPrismaRateSnapshotRepository } from "../backend/src/rate-snapshots";
import { createInternalTestnetJettonAdapter } from "../backend/src/ton/internal-testnet-jetton";
import {
  createMainnetUsdtAdapter,
  officialMainnetUsdtMasterAddress,
  resolveMainnetUsdtAdapterConfig,
} from "../backend/src/ton/mainnet-usdt";
import { createPrismaMainnetUsdtScannerRepository } from "../worker/src/mainnet-usdt";

const prisma = new PrismaClient();
const ledger = createMovementLedger(prisma as any);
const rates = createPrismaRateSnapshotRepository(prisma as any);
const suffix = process.env.TONHUB_LEDGER_VERIFY_SUFFIX ?? "default";
const ids = {
  order: `ledger-order-${suffix}`,
  invoice: `ledger-invoice-${suffix}`,
  deposit: `ledger-deposit-${suffix}`,
  external: `ledger-external-${suffix}`,
  reference: `ledger-reference-${suffix}`,
  address: `ledger-address-${suffix}`,
  rawAddress: `0:ledger-address-${suffix}`,
};

try {
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: ids.order,
      externalId: ids.external,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: ids.invoice,
      orderId: ids.order,
      externalId: null,
      network: "testnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "2500000",
      fiatCurrency: "USD",
      address: ids.address,
      addressRaw: ids.rawAddress,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_001 : 810_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ledger-key-${suffix}`,
      amountNano: "2000000000",
      amountAtomic: "2000000000",
      reference: ids.reference,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      priceLockedAt: new Date("2026-08-13T10:00:00.000Z"),
      priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: ids.deposit,
      invoiceId: ids.invoice,
      network: "testnet",
      address: ids.address,
      addressRaw: ids.rawAddress,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_001 : 810_002,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ledger-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  await assert.rejects(
    prisma.tonhubPaymentInvoice.update({
      where: { id: ids.invoice },
      data: { activationThresholdFiatMicros: "2500001" },
    }),
  );

  await rates.recordMany([
    {
      asset: "GRAM",
      baseCurrency: "GRAM",
      quoteCurrency: "USD",
      price: "2.5",
      source: "coingecko",
      observedAt: new Date("2026-08-13T09:59:00.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:10.000Z"),
      payload: { verifier: "movement-ledger" },
    },
    {
      asset: "USDT",
      baseCurrency: "USDT",
      quoteCurrency: "USD",
      price: "1",
      source: "usd-peg",
      observedAt: new Date("2026-08-13T09:59:30.000Z"),
      fetchedAt: new Date("2026-08-13T09:59:30.000Z"),
      payload: { policy: "1 USDT = 1 USD" },
    },
  ]);
  await assert.rejects(
    prisma.tonhubRateSnapshot.create({
      data: {
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "USD",
        price: "0.99",
        source: "usd-peg",
        observedAt: new Date("2026-08-13T09:59:40.000Z"),
        fetchedAt: new Date("2026-08-13T09:59:40.000Z"),
        payload: { policy: "1 USDT = 1 USD" },
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubRateSnapshot.create({
      data: {
        asset: "USDT",
        baseCurrency: "USDT",
        quoteCurrency: "EUR",
        price: "0.8",
        source: "usd-peg",
        observedAt: new Date("2026-08-13T09:59:40.000Z"),
        fetchedAt: new Date("2026-08-13T09:59:40.000Z"),
        payload: {
          policy: "1 USDT = 1 USD",
          derivation: "GRAM/EUR divided by GRAM/USD",
          components: {},
        },
      },
    }),
  );

  const gramDraft = {
    fingerprint: `testnet:ledger-gram-${suffix}:incoming:0`,
    depositAddressId: ids.deposit,
    network: "testnet" as const,
    direction: "INCOMING" as const,
    asset: "GRAM" as const,
    assetKind: "NATIVE" as const,
    assetDecimals: 9,
    amountAtomic: "1500000000",
    fromAddress: "EQ_LEDGER_SENDER",
    toAddress: ids.address,
    transactionHash: `ledger-gram-${suffix}`,
    transactionLt: "900001",
    blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
    rawPayload: { verifier: true, eventIndex: 0 },
  };
  const [gram, gramReplay] = await Promise.all([
    ledger.recordObserved(gramDraft),
    ledger.recordObserved(gramDraft),
  ]);
  assert.equal(gram.id, gramReplay.id);
  await assert.rejects(
    ledger.recordObserved({ ...gramDraft, amountAtomic: "1500000001" }),
    MovementFingerprintConflictError,
  );

  const usdt = await ledger.recordObserved({
    fingerprint: `testnet:ledger-usdt-${suffix}:incoming:0`,
    depositAddressId: ids.deposit,
    network: "testnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "2000000",
    fromAddress: "EQ_LEDGER_SENDER",
    toAddress: ids.address,
    ownerAddress: "EQ_LEDGER_SENDER",
    jettonMasterAddress: "EQ_LEDGER_USDT_MASTER",
    jettonWalletAddress: "EQ_LEDGER_USDT_WALLET",
    transactionHash: `ledger-usdt-${suffix}`,
    transactionLt: "900002",
    blockchainAt: new Date("2026-08-13T10:00:30.000Z"),
    rawPayload: { verifier: true, eventIndex: 0 },
  });

  let [gramCredit, usdtCredit] = await Promise.all([
    ledger.creditMovement({
      movementId: gram.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
    ledger.creditMovement({
      movementId: usdt.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    }),
  ]);
  if (gramCredit.outcome === "blocked-earlier-movement") {
    gramCredit = await ledger.creditMovement({
      movementId: gram.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "NATIVE_INBOUND_V1",
      maxRateAgeMs: 300_000,
    });
  }
  if (usdtCredit.outcome === "blocked-earlier-movement") {
    usdtCredit = await ledger.creditMovement({
      movementId: usdt.id,
      orderId: ids.order,
      invoiceId: ids.invoice,
      validationCode: "JETTON_INBOUND_V1",
      maxRateAgeMs: 300_000,
    });
  }
  assert.equal(gramCredit.movement.fiatCreditMicros, "3750000");
  assert.equal(usdtCredit.movement.fiatCreditMicros, "2000000");
  const paid = await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } });
  assert.equal(paid.status, "PAID");
  assert.equal(paid.creditedFiatMicros, "5000000");
  assert.equal(paid.overpaymentFiatMicros, "750000");
  assert.equal(paid.paidAt?.toISOString(), "2026-08-13T10:00:30.000Z");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { orderId: ids.order, kind: "CREDIT" },
  }), 2);
  const synchronizedInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: ids.invoice },
  });
  assert.equal(synchronizedInvoice.status, "PAID");
  assert.equal(synchronizedInvoice.creditedFiatMicros, "5000000");
  assert.equal(synchronizedInvoice.remainingFiatMicros, "0");

  const [laterGramRate] = await rates.recordMany([{
    asset: "GRAM",
    baseCurrency: "GRAM",
    quoteCurrency: "USD",
    price: "5",
    source: "coingecko",
    observedAt: new Date("2026-08-13T10:01:00.000Z"),
    fetchedAt: new Date("2026-08-13T10:01:10.000Z"),
    payload: { verifier: "movement-ledger-later-rate" },
  }]);
  const laterGram = await ledger.recordObserved({
    ...gramDraft,
    fingerprint: `testnet:ledger-gram-later-${suffix}:incoming:0`,
    amountAtomic: "100000000",
    transactionHash: `ledger-gram-later-${suffix}`,
    transactionLt: "900003",
    blockchainAt: new Date("2026-08-13T10:02:00.000Z"),
  });
  const laterGramCredit = await ledger.creditMovement({
    movementId: laterGram.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(laterGramCredit.movement.rateSnapshotId, gramCredit.movement.rateSnapshotId);
  assert.equal(laterGramCredit.movement.fiatCreditMicros, "250000");
  assert.equal(laterGramCredit.order.status, "RECOVERY");
  const postPaidInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({
    where: { id: ids.invoice },
  });
  assert.equal(postPaidInvoice.status, "PAID");
  assert.equal(postPaidInvoice.settlementReason, "POST_PAID_MOVEMENT_RECOVERY");
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { movementId: laterGram.id, reason: "POST_PAID_MOVEMENT" },
  }), 1);

  const conflictingRateMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `testnet:ledger-gram-conflicting-rate-${suffix}:incoming:0`,
      depositAddressId: ids.deposit,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "100000000",
      fromAddress: "EQ_LEDGER_SENDER",
      toAddress: ids.address,
      transactionHash: `ledger-gram-conflicting-rate-${suffix}`,
      transactionLt: "900004",
      blockchainAt: new Date("2026-08-13T10:02:30.000Z"),
      status: "CREDITED",
      validationCode: "DIRECT_DB_RATE_LOCK_NEGATIVE",
      rateSnapshotId: laterGramRate.id,
      fiatCreditMicros: "500000",
    },
  });
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: conflictingRateMovement.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "500000",
      },
    }),
  );

  const replay = await ledger.creditMovement({
    movementId: gram.id,
    orderId: ids.order,
    invoiceId: ids.invoice,
    validationCode: "NATIVE_INBOUND_V1",
    maxRateAgeMs: 300_000,
  });
  assert.equal(replay.allocation.id, gramCredit.allocation?.id);
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { movementId: gram.id, kind: "CREDIT" },
  }), 1);

  const usdtAllocationId = usdtCredit.allocation!.id;
  const [reversed, reversedReplay] = await Promise.all([
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "rehearsal-admin",
      note: "verify compensating correction",
    }),
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "rehearsal-admin",
      note: "verify compensating correction",
    }),
  ]);
  assert.equal(reversed.reversal.id, reversedReplay.reversal.id);
  await assert.rejects(
    ledger.reverseAllocation({
      allocationId: usdtAllocationId,
      allocatedBy: "other-admin",
      note: "conflicting replay",
    }),
    /different audit evidence/,
  );
  const recovered = await prisma.tonhubPaymentOrder.findUniqueOrThrow({ where: { id: ids.order } });
  assert.equal(recovered.status, "RECOVERY");
  assert.equal(recovered.creditedFiatMicros, "4000000");
  assert.equal(recovered.overpaymentFiatMicros, "0");
  assert.equal(await prisma.tonhubMovementAllocation.count({
    where: { reversesAllocationId: usdtAllocationId },
  }), 1);
  const recoveryInvoice = await prisma.tonhubPaymentInvoice.findUniqueOrThrow({ where: { id: ids.invoice } });
  assert.equal(recoveryInvoice.status, "FAILED");
  assert.equal(recoveryInvoice.creditedFiatMicros, "4000000");
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { movementId: usdt.id, reason: "ALLOCATION_REVERSED" },
  }), 1);

  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "1",
      },
    }),
  );
  const ownerlessMovement = await prisma.tonhubPaymentMovement.create({
    data: {
      fingerprint: `testnet:ownerless-${suffix}:incoming:0`,
      network: "testnet",
      direction: "INCOMING",
      asset: "GRAM",
      assetKind: "NATIVE",
      assetDecimals: 9,
      amountAtomic: "1000000000",
      toAddress: "EQ_OWNERLESS",
      transactionHash: `ownerless-${suffix}`,
      blockchainAt: new Date("2026-08-13T10:00:00.000Z"),
      status: "CREDITED",
      validationCode: "DIRECT_DB_NEGATIVE",
      rateSnapshotId: gramCredit.movement.rateSnapshotId,
      fiatCreditMicros: "2500000",
    },
  });
  const ownerlessInvoice = await prisma.tonhubPaymentInvoice.create({
    data: {
      externalId: null,
      orderId: ids.order,
      network: "testnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      fiatCurrency: "USD",
      address: `ownerless-address-${suffix}`,
      addressRaw: `0:ownerless-address-${suffix}`,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_011 : 810_012,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ownerless-key-${suffix}`,
      amountNano: "1000000000",
      amountAtomic: "1000000000",
      reference: `ownerless-reference-${suffix}`,
      status: "FAILED",
    },
  });
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: ownerlessMovement.id,
        orderId: ids.order,
        invoiceId: ownerlessInvoice.id,
        kind: "CREDIT",
        fiatCreditMicros: "2500000",
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: null,
        kind: "CREDIT",
        fiatCreditMicros: "3750000",
      },
    }),
  );
  await assert.rejects(
    prisma.tonhubMovementAllocation.create({
      data: {
        movementId: gram.id,
        orderId: ids.order,
        invoiceId: ids.invoice,
        kind: "CREDIT",
        fiatCreditMicros: "3750000",
      },
    }),
    (error: any) => error?.code === "P2002",
  );

  const internalOwnerRaw = `0:${"51".repeat(32)}`;
  const internalMasterRaw = `0:${"61".repeat(32)}`;
  const internalWalletRaw = `0:${"71".repeat(32)}`;
  const internalSenderRaw = `0:${"81".repeat(32)}`;
  const internalSenderWalletRaw = `0:${"91".repeat(32)}`;
  const friendly = (raw: string) => Address.parse(raw).toString({ bounceable: true, testOnly: true });
  const internalDepositId = `ledger-internal-jetton-deposit-${suffix}`;
  await prisma.tonhubDepositAddress.create({
    data: {
      id: internalDepositId,
      network: "testnet",
      address: friendly(internalOwnerRaw),
      addressRaw: internalOwnerRaw,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_021 : 810_022,
      walletNetworkGlobalId: -3,
      walletPublicKeyHash: `ledger-internal-jetton-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  const internalAdapter = createInternalTestnetJettonAdapter({
    db: prisma,
    ledger,
    config: { enabled: true, network: "testnet", masterAddress: internalMasterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/jetton/masters")) {
        return new Response(JSON.stringify({
          jetton_masters: [{
            address: friendly(internalMasterRaw),
            jetton_content: { decimals: "6", symbol: "TEST" },
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/jetton/wallets")) {
        return new Response(JSON.stringify({
          jetton_wallets: [{
            address: friendly(internalWalletRaw),
            balance: "5000000",
            owner: friendly(internalOwnerRaw),
            jetton: friendly(internalMasterRaw),
            last_transaction_lt: "910001",
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/transactions")) {
        return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jetton_transfers: [{
          amount: "5000000",
          destination: friendly(internalOwnerRaw),
          jetton_master: friendly(internalMasterRaw),
          query_id: "84",
          source: friendly(internalSenderRaw),
          source_wallet: friendly(internalSenderWalletRaw),
          transaction_aborted: false,
          transaction_hash: "c3".repeat(32),
          transaction_lt: "910001",
          transaction_now: 1_786_616_400,
        }],
      }), { status: 200 });
    },
    now: () => new Date("2026-08-13T10:30:00.000Z"),
  });
  const internalObserved = await internalAdapter.observeDeposit({
    depositAddressId: internalDepositId,
    notBefore: new Date("2026-08-13T10:00:00.000Z"),
    notAfter: new Date("2026-08-13T10:30:00.000Z"),
  });
  assert.equal(internalObserved.movementsObserved, 1);
  const internalAccount = await prisma.tonhubDepositAssetAccount.findUniqueOrThrow({
    where: {
      depositAddressId_asset: {
        depositAddressId: internalDepositId,
        asset: "USDT",
      },
    },
  });
  assert.equal(internalAccount.status, "VERIFIED");
  assert.equal(internalAccount.jettonMasterAddress, internalMasterRaw);
  assert.equal(internalAccount.assetWalletAddress, internalWalletRaw);
  const internalMovement = await prisma.tonhubPaymentMovement.findUniqueOrThrow({
    where: {
      fingerprint: `ton:testnet:jetton-in:${"c3".repeat(32)}:84:${internalMasterRaw}`,
    },
  });
  assert.equal(internalMovement.asset, "USDT");
  assert.equal(internalMovement.assetDecimals, 6);
  assert.equal((internalMovement.rawPayload as any).internalTestAsset, true);

  const mainnetOrderId = `ledger-mainnet-usdt-order-${suffix}`;
  const mainnetInvoiceId = `ledger-mainnet-usdt-invoice-${suffix}`;
  const mainnetDepositId = `ledger-mainnet-usdt-deposit-${suffix}`;
  const mainnetOwnerRaw = `0:${"52".repeat(32)}`;
  const mainnetWalletRaw = `0:${"72".repeat(32)}`;
  const mainnetSenderRaw = `0:${"82".repeat(32)}`;
  const mainnetSenderWalletRaw = `0:${"92".repeat(32)}`;
  const mainnetFriendly = (raw: string) => Address.parse(raw).toString({ bounceable: true });
  await prisma.tonhubPaymentOrder.create({
    data: {
      id: mainnetOrderId,
      externalId: `ledger-mainnet-usdt-external-${suffix}`,
      fiatAmountMicros: "5000000",
      fiatCurrency: "USD",
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
    },
  });
  await prisma.tonhubPaymentInvoice.create({
    data: {
      id: mainnetInvoiceId,
      orderId: mainnetOrderId,
      network: "mainnet",
      fiatAmountCents: 500,
      fiatAmountMicros: "5000000",
      remainingFiatMicros: "5000000",
      activationThresholdFiatMicros: "2500000",
      fiatCurrency: "USD",
      address: mainnetFriendly(mainnetOwnerRaw),
      addressRaw: mainnetOwnerRaw,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_031 : 810_032,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `ledger-mainnet-usdt-key-${suffix}`,
      amountNano: "2000000000",
      amountAtomic: "2000000000",
      reference: `ledger-mainnet-usdt-reference-${suffix}`,
      expiresAt: new Date("2026-08-13T11:00:00.000Z"),
      priceLockedAt: new Date("2026-08-13T10:00:00.000Z"),
      priceLockedUntil: new Date("2026-08-13T11:00:00.000Z"),
      createdAt: new Date("2026-08-13T10:00:00.000Z"),
      updatedAt: new Date("2026-08-13T10:00:00.000Z"),
    },
  });
  await prisma.tonhubDepositAddress.create({
    data: {
      id: mainnetDepositId,
      invoiceId: mainnetInvoiceId,
      network: "mainnet",
      address: mainnetFriendly(mainnetOwnerRaw),
      addressRaw: mainnetOwnerRaw,
      walletVersion: "v5r1",
      walletWorkchain: 0,
      walletContext: suffix === "clean" ? 810_031 : 810_032,
      walletNetworkGlobalId: -239,
      walletPublicKeyHash: `ledger-mainnet-usdt-key-${suffix}`,
      status: "ACTIVE",
    },
  });
  const mainnetAdapter = createMainnetUsdtAdapter({
    db: prisma,
    ledger,
    config: resolveMainnetUsdtAdapterConfig({
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    })!,
    resolveReadConfig: () => ({
      network: "mainnet",
      baseUrl: "https://toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: async (request) => {
      const url = new URL(String(request));
      if (url.pathname.endsWith("/jetton/masters")) {
        return new Response(JSON.stringify({
          jetton_masters: [{
            address: officialMainnetUsdtMasterAddress,
            jetton_content: { decimals: "6", symbol: "metadata-is-not-identity" },
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/jetton/wallets")) {
        return new Response(JSON.stringify({
          jetton_wallets: [{
            address: mainnetFriendly(mainnetWalletRaw),
            owner: mainnetFriendly(mainnetOwnerRaw),
            jetton: officialMainnetUsdtMasterAddress,
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/transactions")) {
        return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
      }
      if (!url.searchParams.has("jetton_wallet")) {
        return new Response(JSON.stringify({ jetton_transfers: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jetton_transfers: [{
          amount: "5000000",
          destination: mainnetFriendly(mainnetOwnerRaw),
          jetton_master: officialMainnetUsdtMasterAddress,
          query_id: "86",
          source: mainnetFriendly(mainnetSenderRaw),
          source_wallet: mainnetFriendly(mainnetSenderWalletRaw),
          transaction_aborted: false,
          transaction_hash: "e5".repeat(32),
          transaction_lt: "920001",
          transaction_now: 1_786_616_400,
        }],
      }), { status: 200 });
    },
    now: () => new Date("2026-08-13T10:30:00.000Z"),
  });
  const mainnetObserved = await mainnetAdapter.observeDeposit({
    depositAddressId: mainnetDepositId,
    notBefore: new Date("2026-08-13T10:00:00.000Z"),
    notAfter: new Date("2026-08-13T10:30:00.000Z"),
  });
  assert.equal(mainnetObserved.movementsObserved, 1);
  const mainnetMovement = await prisma.tonhubPaymentMovement.findUniqueOrThrow({
    where: {
      fingerprint: `ton:mainnet:jetton-in:${"e5".repeat(32)}:86:${officialMainnetUsdtMasterAddress}`,
    },
  });
  assert.equal(mainnetMovement.network, "mainnet");
  assert.equal(mainnetMovement.jettonMasterAddress, officialMainnetUsdtMasterAddress);
  assert.equal(mainnetMovement.jettonWalletAddress, mainnetWalletRaw);
  assert.equal((mainnetMovement.rawPayload as any).officialUsdt, true);
  assert.equal((mainnetMovement.rawPayload as any).internalTestAsset, undefined);
  const queuedMainnetSweeps = await prisma.tonhubAssetSweep.findMany({
    where: { depositAddressId: mainnetDepositId, asset: "USDT" },
  });
  assert.equal(queuedMainnetSweeps.length, 1);
  assert.equal(queuedMainnetSweeps[0]?.status, "QUEUED");
  assert.equal(queuedMainnetSweeps[0]?.invoiceId, mainnetInvoiceId);
  assert.equal(queuedMainnetSweeps[0]?.orderId, mainnetOrderId);
  assert.equal(
    queuedMainnetSweeps[0]?.idempotencyKey,
    `official-usdt-movement:${mainnetMovement.id}`,
  );

  const scannerRepository = createPrismaMainnetUsdtScannerRepository(prisma);
  const claimedMainnetTargets = await scannerRepository.claimDueTargets({
    workerId: `mainnet-usdt-verifier-${suffix}`,
    now: new Date("2026-08-13T10:30:00.000Z"),
    limit: 100,
    leaseMs: 60_000,
    activeIntervalMs: 15_000,
    terminalIntervalMs: 86_400_000,
    terminalMonitorMs: 30 * 86_400_000,
    candidatePoolSize: 10_000,
  });
  const claimedMainnetTarget = claimedMainnetTargets.find(
    ({ depositAddressId }) => depositAddressId === mainnetDepositId,
  );
  assert.ok(claimedMainnetTarget);
  assert.equal(await scannerRepository.completeScan({
    target: claimedMainnetTarget,
    scannedThroughAt: new Date("2026-08-13T10:30:00.000Z"),
    nextScanAt: new Date("2026-08-13T10:30:15.000Z"),
  }), true);
  const storedMainnetCursor = await prisma.tonhubScanCursor.findUniqueOrThrow({
    where: {
      network_streamType_scopeKey: {
        network: "mainnet",
        streamType: "USDT_MAINNET_IN",
        scopeKey: mainnetDepositId,
      },
    },
  });
  assert.equal(storedMainnetCursor.lastTimestamp?.toISOString(), "2026-08-13T10:30:00.000Z");
  assert.equal(storedMainnetCursor.leaseOwner, null);
  assert.equal(storedMainnetCursor.leaseExpiresAt?.toISOString(), "2026-08-13T10:30:15.000Z");

  const rejectedJettonDraft = {
    fingerprint: `ton:testnet:jetton-rejected:${"d4".repeat(32)}:85:${internalMasterRaw}:${internalWalletRaw}`,
    depositAddressId: internalDepositId,
    network: "testnet" as const,
    direction: "INCOMING" as const,
    asset: "USDT" as const,
    assetKind: "JETTON" as const,
    assetDecimals: 6,
    amountAtomic: "5000000",
    fromAddress: internalSenderRaw,
    toAddress: internalOwnerRaw,
    ownerAddress: internalOwnerRaw,
    jettonMasterAddress: internalMasterRaw,
    jettonWalletAddress: internalWalletRaw,
    transactionHash: "d4".repeat(32),
    transactionLt: "910002",
    traceId: null,
    queryId: "85",
    blockchainAt: new Date("2026-08-13T10:20:00.000Z"),
    rawPayload: { untrustedJettonCandidate: true },
  };
  const rejectedJetton = await ledger.recordRejected({
    movement: rejectedJettonDraft,
    validationCode: "JETTON_MASTER_NOT_ALLOWLISTED",
    reason: "UNSUPPORTED_JETTON_MASTER",
    title: "Unsupported jetton received by a deposit address",
    details: { configuredMasterAddress: internalMasterRaw },
  });
  const rejectedReplay = await ledger.recordRejected({
    movement: rejectedJettonDraft,
    validationCode: "JETTON_MASTER_NOT_ALLOWLISTED",
    reason: "UNSUPPORTED_JETTON_MASTER",
    title: "Unsupported jetton received by a deposit address",
    details: { configuredMasterAddress: internalMasterRaw },
  });
  assert.equal(rejectedJetton.status, "REJECTED");
  assert.equal(rejectedReplay.id, rejectedJetton.id);
  assert.equal(await prisma.tonhubRecoveryCase.count({
    where: { movementId: rejectedJetton.id, reason: "UNSUPPORTED_JETTON_MASTER" },
  }), 1);
  assert.equal(await prisma.tonhubAssetSweep.count({
    where: { depositAddressId: internalDepositId, asset: "USDT" },
  }), 0);
} finally {
  await prisma.$disconnect();
}
