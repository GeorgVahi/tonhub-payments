import {
  extractTonComment,
  type TonCenterTransaction,
  type TonInvoiceMatch
} from "./direct-payments";

function transactionCreatedAtMs(transaction: TonCenterTransaction) {
  return transaction.now ? transaction.now * 1000 : null;
}

function hasPositiveIncomingValue(value: string | undefined): value is string {
  if (!value) {
    return false;
  }

  try {
    return BigInt(value) > BigInt(0);
  } catch {
    return false;
  }
}

export function findTonDepositAddressPayments(input: {
  transactions: TonCenterTransaction[];
  notBefore?: Date | null;
  notAfter?: Date | null;
}) {
  const notBeforeMs = input.notBefore?.getTime() ?? null;
  const notAfterMs = input.notAfter?.getTime() ?? null;
  const matches: TonInvoiceMatch[] = [];

  for (const transaction of input.transactions) {
    const inMessage = transaction.in_msg ?? null;
    const createdAtMs = transactionCreatedAtMs(transaction);

    const amountNano = inMessage?.value;
    if (!inMessage || !hasPositiveIncomingValue(amountNano)) {
      continue;
    }

    if ((notBeforeMs !== null || notAfterMs !== null) && createdAtMs === null) {
      continue;
    }

    if (notBeforeMs !== null && createdAtMs !== null && createdAtMs < notBeforeMs) {
      continue;
    }

    if (notAfterMs !== null && createdAtMs !== null && createdAtMs > notAfterMs) {
      continue;
    }

    matches.push({
      transaction,
      comment: extractTonComment(inMessage),
      amountNano,
      createdAt: createdAtMs ? new Date(createdAtMs).toISOString() : null,
      status: "observed"
    });
  }

  return matches;
}
