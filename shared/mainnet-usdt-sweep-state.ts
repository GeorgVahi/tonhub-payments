export type FailedUsdtSweepEvidence = {
  sentAt?: Date | null;
  transactionHash?: string | null;
  confirmedAt?: Date | null;
  amountAtomic?: string | null;
  reserveAtomic?: string | null;
  recipientAddress?: string | null;
  seqno?: number | null;
  queryId?: string | null;
  gasTopupAmountNano?: string | null;
  gasTopupSeqno?: number | null;
  gasServicePlanKey?: string | null;
};

export type ResumableUsdtSweepStatus =
  | "QUEUED"
  | "GAS_CHECK"
  | "GAS_TOPUP_REQUIRED"
  | "READY"
  | "SENT";

export function resumableFailedUsdtSweepStatus(
  evidence: FailedUsdtSweepEvidence,
): ResumableUsdtSweepStatus {
  const present = (value: unknown) => value !== null && value !== undefined;
  const hasSweepPlan =
    present(evidence.sentAt) ||
    present(evidence.transactionHash) ||
    present(evidence.confirmedAt) ||
    present(evidence.amountAtomic) ||
    present(evidence.reserveAtomic) ||
    present(evidence.recipientAddress) ||
    present(evidence.seqno) ||
    present(evidence.queryId);
  if (hasSweepPlan) {
    if (present(evidence.transactionHash) || present(evidence.confirmedAt)) {
      throw new Error("Failed USDT sweep contains contradictory confirmation evidence.");
    }
    const complete =
      typeof evidence.amountAtomic === "string" && /^[1-9]\d*$/.test(evidence.amountAtomic) &&
      evidence.reserveAtomic === "0" &&
      typeof evidence.recipientAddress === "string" && Boolean(evidence.recipientAddress) &&
      Number.isSafeInteger(evidence.seqno) && Number(evidence.seqno) >= 0 &&
      typeof evidence.queryId === "string" && /^\d+$/.test(evidence.queryId) &&
      BigInt(evidence.queryId) <= (1n << 64n) - 1n;
    if (!complete) {
      throw new Error("Failed USDT sweep contains an incomplete persisted transfer plan.");
    }
    return evidence.sentAt ? "SENT" : "READY";
  }
  const hasGasPlan = present(evidence.gasTopupAmountNano) || present(evidence.gasTopupSeqno) ||
    present(evidence.gasServicePlanKey);
  if (hasGasPlan) {
    const complete =
      typeof evidence.gasTopupAmountNano === "string" && /^[1-9]\d*$/.test(evidence.gasTopupAmountNano) &&
      Number.isSafeInteger(evidence.gasTopupSeqno) && Number(evidence.gasTopupSeqno) >= 0;
    if (!complete) {
      throw new Error("Failed USDT sweep contains an incomplete persisted gas top-up plan.");
    }
  }
  if (evidence.gasServicePlanKey && hasGasPlan) {
    return "GAS_TOPUP_REQUIRED";
  }
  if (hasGasPlan) {
    return "GAS_CHECK";
  }
  return "QUEUED";
}
