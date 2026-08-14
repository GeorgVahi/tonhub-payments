import { canonicalTonAddress } from "./ton/gram-shadow-scanner";
import { officialMainnetUsdtMasterAddress } from "./ton/jetton-identities";
import type { PaymentAssetSymbol } from "../../shared/payment-assets";

type AutomaticSweepPrisma = {
  $queryRawUnsafe: <T = unknown>(query: string, ...values: unknown[]) => Promise<T>;
  tonhubPaymentOrder: any;
  tonhubPaymentInvoice: any;
  tonhubDepositAddress: any;
  tonhubPaymentMovement: any;
  tonhubMovementAllocation: any;
  tonhubAssetSweep: any;
  tonhubRecoveryCase: any;
};

type AutomaticSweepReason =
  | "INTERMEDIATE_RATIO"
  | "INTERMEDIATE_VALUE"
  | "TERMINAL_PAID";

const activeSweepStatuses = [
  "QUEUED",
  "GAS_CHECK",
  "GAS_TOPUP_REQUIRED",
  "GAS_TOPUP_SENT",
  "READY",
  "SENT",
  "FAILED",
] as const;

function nonNegativeInteger(value: unknown, field: string) {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer string.`);
  }
  return BigInt(value);
}

function strictPolicyInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${field} must be an integer between ${minimum} and ${maximum}.`);
  }
  return Number(value);
}

function allocationBalance(rows: any[], asset?: PaymentAssetSymbol) {
  const credits = new Map<string, { fiat: bigint; asset: PaymentAssetSymbol }>();
  const reversed = new Set<string>();
  for (const row of rows) {
    if (row.kind === "REVERSAL") {
      if (typeof row.reversesAllocationId === "string") reversed.add(row.reversesAllocationId);
      continue;
    }
    const movementAsset = row.movement?.asset;
    if ((movementAsset !== "GRAM" && movementAsset !== "USDT") || !row.movement?.id) {
      throw new Error("Automatic sweep allocation has incomplete movement evidence.");
    }
    credits.set(row.id, {
      fiat: nonNegativeInteger(row.fiatCreditMicros, "Allocation fiatCreditMicros"),
      asset: movementAsset,
    });
  }
  let total = 0n;
  for (const [id, credit] of credits) {
    if (!reversed.has(id) && (!asset || credit.asset === asset)) total += credit.fiat;
  }
  return total;
}

function depositAllocationBalance(rows: any[], depositAddressId: string, asset: PaymentAssetSymbol) {
  return allocationBalance(
    rows.filter((row) => row.movement?.depositAddressId === depositAddressId),
    asset,
  );
}

function ledgerAtomicBalance(rows: any[], asset: PaymentAssetSymbol) {
  return rows.reduce((balance, movement) => {
    if (movement.asset !== asset || movement.status === "REJECTED") return balance;
    const amount = nonNegativeInteger(movement.amountAtomic, "Movement amountAtomic");
    return balance + (movement.direction === "INCOMING" ? amount : -amount);
  }, 0n);
}

async function assertSweepAssetOwnership(input: {
  deposit: any;
  invoice: any;
  asset: PaymentAssetSymbol;
  creditedMovements: any[];
}) {
  const { deposit, invoice, asset } = input;
  const ownerAddresses = [
    deposit.address,
    deposit.addressRaw,
    invoice.address,
    invoice.addressRaw,
  ].map(canonicalTonAddress);
  if (
    !deposit.id ||
    deposit.invoiceId !== invoice.id ||
    deposit.network !== invoice.network ||
    ownerAddresses.some((address) => !address || address !== ownerAddresses[0])
  ) {
    throw new Error("Automatic sweep deposit ownership is inconsistent.");
  }
  if (asset === "GRAM") {
    for (const movement of input.creditedMovements) {
      if (
        movement.depositAddressId !== deposit.id ||
        movement.network !== deposit.network ||
        movement.direction !== "INCOMING" ||
        movement.asset !== "GRAM" ||
        movement.assetKind !== "NATIVE" ||
        movement.assetDecimals !== 9 ||
        movement.status !== "CREDITED" ||
        canonicalTonAddress(movement.toAddress) !== ownerAddresses[0]
      ) {
        throw new Error("Automatic GRAM sweep movement ownership evidence is inconsistent.");
      }
    }
    return;
  }
  const accounts = Array.isArray(deposit.assetAccounts) ? deposit.assetAccounts : [];
  const account = accounts.find((candidate: any) => candidate.asset === "USDT");
  if (
    invoice.network !== "mainnet" ||
    !account ||
    account.network !== "mainnet" ||
    account.assetKind !== "JETTON" ||
    account.assetDecimals !== 6 ||
    account.status !== "VERIFIED" ||
    canonicalTonAddress(account.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
    !canonicalTonAddress(account.assetWalletAddress)
  ) {
    throw new Error("Automatic USD₮ sweep lacks verified official jetton ownership.");
  }
  const assetWalletAddress = canonicalTonAddress(account.assetWalletAddress);
  for (const movement of input.creditedMovements) {
    const payload = movement.rawPayload;
    if (
      movement.network !== "mainnet" ||
      movement.depositAddressId !== deposit.id ||
      movement.direction !== "INCOMING" ||
      movement.asset !== "USDT" ||
      movement.assetKind !== "JETTON" ||
      movement.assetDecimals !== 6 ||
      movement.status !== "CREDITED" ||
      canonicalTonAddress(movement.jettonMasterAddress) !== officialMainnetUsdtMasterAddress ||
      canonicalTonAddress(movement.jettonWalletAddress) !== assetWalletAddress ||
      canonicalTonAddress(movement.ownerAddress) !== ownerAddresses[0] ||
      canonicalTonAddress(movement.toAddress) !== ownerAddresses[0] ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      payload.officialUsdt !== true || payload.internalTestAsset === true
    ) {
      throw new Error("Automatic USD₮ sweep movement ownership evidence is inconsistent.");
    }
  }
}

export async function reconcileAutomaticAssetSweeps(input: {
  tx: AutomaticSweepPrisma;
  orderId: string;
  invoiceId: string;
  triggeredAt: Date;
}) {
  if (!(input.triggeredAt instanceof Date) || Number.isNaN(input.triggeredAt.getTime())) {
    throw new Error("Automatic sweep triggeredAt must be a valid date.");
  }
  await input.tx.$queryRawUnsafe(
    `SELECT "id" FROM "TonhubPaymentOrder" WHERE "id" = $1 FOR UPDATE`,
    input.orderId,
  );
  const order = await input.tx.tonhubPaymentOrder.findUnique({ where: { id: input.orderId } });
  if (!order) {
    throw new Error("Automatic sweep order does not exist.");
  }
  const maxAutomaticSweeps = strictPolicyInteger(
    order.maxAutomaticSweepsPerAsset,
    "Order maxAutomaticSweepsPerAsset",
    0,
    2,
  );
  if (maxAutomaticSweeps === 0 || order.status === "RECOVERY") return [];
  const invoice = await input.tx.tonhubPaymentInvoice.findUnique({ where: { id: input.invoiceId } });
  const deposit = invoice
    ? await input.tx.tonhubDepositAddress.findUnique({
        where: { invoiceId: invoice.id },
        include: { assetAccounts: true },
      })
    : null;
  if (!invoice || !deposit || invoice.orderId !== order.id) {
    throw new Error("Automatic sweep order, invoice, and deposit ownership is incomplete.");
  }
  const triggerBps = strictPolicyInteger(
    order.intermediateSweepTriggerBps,
    "Order intermediateSweepTriggerBps",
    0,
    10_000,
  );
  const obligation = nonNegativeInteger(order.fiatAmountMicros, "Order fiatAmountMicros");
  const minFiat = nonNegativeInteger(
    order.intermediateSweepMinFiatMicros,
    "Order intermediateSweepMinFiatMicros",
  );
  const allocations = await input.tx.tonhubMovementAllocation.findMany({
    where: { orderId: order.id },
    include: { movement: true },
  });
  const totalCredited = allocationBalance(allocations);
  const reversedAllocationIds = new Set(
    allocations
      .filter((row: any) => row.kind === "REVERSAL" && typeof row.reversesAllocationId === "string")
      .map((row: any) => row.reversesAllocationId),
  );
  const activeCreditAllocations = allocations.filter((row: any) =>
    row.kind === "CREDIT" &&
    !reversedAllocationIds.has(row.id) &&
    row.movement?.depositAddressId &&
    (row.movement.asset === "GRAM" || row.movement.asset === "USDT"));
  for (const asset of ["GRAM", "USDT"] as const) {
    const fundedDeposits = new Set(
      activeCreditAllocations
        .filter((row: any) => row.movement.asset === asset)
        .map((row: any) => row.movement.depositAddressId),
    );
    if (fundedDeposits.size <= 1) continue;
    const recoveryId = `automatic-sweep-multiple-deposits:${order.id}:${asset}`;
    await input.tx.tonhubPaymentOrder.update({
      where: { id: order.id },
      data: { status: "RECOVERY" },
    });
    await input.tx.tonhubRecoveryCase.createMany({
      data: {
        id: recoveryId,
        orderId: order.id,
        invoiceId: null,
        reason: "AUTOMATIC_SWEEP_MULTIPLE_FUNDED_DEPOSITS",
        title: "Automatic sweep requires multiple deposit wallets",
        details: { asset, fundedDepositCount: fundedDeposits.size },
      },
      skipDuplicates: true,
    });
    const recovery = await input.tx.tonhubRecoveryCase.findUnique({ where: { id: recoveryId } });
    if (
      !recovery || recovery.orderId !== order.id || recovery.invoiceId !== null ||
      recovery.reason !== "AUTOMATIC_SWEEP_MULTIPLE_FUNDED_DEPOSITS"
    ) {
      throw new Error("Automatic sweep multi-deposit recovery evidence conflicts.");
    }
    return [];
  }
  const ledgerMovements = await input.tx.tonhubPaymentMovement.findMany({
    where: { depositAddressId: deposit.id },
    select: { asset: true, direction: true, amountAtomic: true, status: true },
  });
  const created = [];

  for (const asset of ["GRAM", "USDT"] as const) {
    const assetCredited = depositAllocationBalance(allocations, deposit.id, asset);
    if (assetCredited <= 0n) continue;
    const creditedAllocationRows = activeCreditAllocations
      .filter((row: any) =>
        row.movement?.asset === asset &&
        row.movement?.depositAddressId === deposit.id);
    const creditedMovements = creditedAllocationRows.map((row: any) => row.movement);
    await assertSweepAssetOwnership({ deposit, invoice, asset, creditedMovements });
    await input.tx.$queryRawUnsafe(
      `SELECT "id" FROM "TonhubAssetSweep"
       WHERE "orderId" = $1 AND "asset" = $2 AND "automaticSequence" IS NOT NULL
         AND "status" IN ('QUEUED', 'GAS_CHECK', 'GAS_TOPUP_REQUIRED', 'GAS_TOPUP_SENT', 'READY', 'SENT', 'FAILED')
       FOR UPDATE`,
      order.id,
      asset,
    );
    const existing = await input.tx.tonhubAssetSweep.findMany({
      where: { orderId: order.id, asset, automaticSequence: { not: null } },
      orderBy: [{ automaticSequence: "asc" }],
    });
    const previous = existing.at(-1) ?? null;
    const previousSequence = previous?.automaticSequence ?? 0;
    if (previous && previous.status !== "CONFIRMED") continue;
    const previousOnDeposit = existing.filter((sweep: any) => sweep.depositAddressId === deposit.id).at(-1) ?? null;
    const legacyConfirmed = previousOnDeposit ? null : await input.tx.tonhubAssetSweep.findFirst({
      where: {
        depositAddressId: deposit.id,
        asset,
        automaticSequence: null,
        status: "CONFIRMED",
        confirmedAt: { not: null },
      },
      orderBy: [{ confirmedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    });
    if (legacyConfirmed && !(legacyConfirmed.confirmedAt instanceof Date)) {
      throw new Error("Confirmed legacy sweep lacks its confirmation time.");
    }
    const previousCredited = previousOnDeposit
      ? nonNegativeInteger(previousOnDeposit.triggerCreditedFiatMicros, "Sweep triggerCreditedFiatMicros")
      : legacyConfirmed
        ? creditedAllocationRows.reduce((sum: bigint, row: any) => {
            const blockchainAt = row.movement?.blockchainAt;
            return blockchainAt instanceof Date &&
              blockchainAt.getTime() <= legacyConfirmed.confirmedAt.getTime()
              ? sum + nonNegativeInteger(row.fiatCreditMicros, "Allocation fiatCreditMicros")
              : sum;
          }, 0n)
        : 0n;
    const atomicBalance = ledgerAtomicBalance(ledgerMovements, asset);
    const retainedReserve = asset === "GRAM" && previousOnDeposit?.status === "CONFIRMED" &&
      typeof previousOnDeposit.reserveAtomic === "string" && /^\d+$/.test(previousOnDeposit.reserveAtomic)
      ? BigInt(previousOnDeposit.reserveAtomic)
      : 0n;
    if (atomicBalance <= retainedReserve) continue;
    const triggerFiat = assetCredited - previousCredited;
    if (triggerFiat <= 0n || previousSequence >= maxAutomaticSweeps) continue;
    const active = await input.tx.tonhubAssetSweep.findFirst({
      where: { orderId: order.id, asset, status: { in: [...activeSweepStatuses] } },
    });
    if (active) continue;

    let reason: AutomaticSweepReason | null = null;
    if (order.status === "PAID") {
      reason = "TERMINAL_PAID";
    } else if (previousSequence < maxAutomaticSweeps - 1) {
      if (obligation > 0n && totalCredited * 10_000n >= obligation * BigInt(triggerBps)) {
        reason = "INTERMEDIATE_RATIO";
      } else if (triggerFiat >= minFiat && minFiat > 0n) {
        reason = "INTERMEDIATE_VALUE";
      }
    }
    if (!reason) continue;
    const automaticSequence = previousSequence + 1;
    const idempotencyKey = `automatic:${order.id}:${asset}:${automaticSequence}`;
    await input.tx.tonhubAssetSweep.createMany({
      data: {
        idempotencyKey,
        depositAddressId: deposit.id,
        orderId: order.id,
        invoiceId: invoice.id,
        asset,
        assetKind: asset === "GRAM" ? "NATIVE" : "JETTON",
        automaticSequence,
        triggerReason: reason,
        triggerFiatMicros: triggerFiat.toString(),
        triggerCreditedFiatMicros: assetCredited.toString(),
        triggeredAt: input.triggeredAt,
        status: "QUEUED",
      },
      skipDuplicates: true,
    });
    const sweep = await input.tx.tonhubAssetSweep.findUnique({ where: { idempotencyKey } });
    if (
      !sweep ||
      sweep.idempotencyKey !== idempotencyKey ||
      sweep.depositAddressId !== deposit.id ||
      sweep.orderId !== order.id ||
      sweep.invoiceId !== invoice.id ||
      sweep.asset !== asset ||
      sweep.assetKind !== (asset === "GRAM" ? "NATIVE" : "JETTON") ||
      sweep.automaticSequence !== automaticSequence ||
      sweep.triggerReason !== reason ||
      sweep.triggerFiatMicros !== triggerFiat.toString() ||
      sweep.triggerCreditedFiatMicros !== assetCredited.toString() ||
      !(sweep.triggeredAt instanceof Date) ||
      sweep.triggeredAt.getTime() !== input.triggeredAt.getTime() ||
      sweep.status !== "QUEUED"
    ) {
      throw new Error("Automatic sweep idempotency conflict.");
    }
    created.push(sweep);
  }
  return created;
}
