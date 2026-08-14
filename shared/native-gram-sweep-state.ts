export type FailedNativeGramSweepEvidence = {
  sentAt?: Date | null;
  transactionHash?: string | null;
  confirmedAt?: Date | null;
  amountAtomic?: string | null;
  reserveAtomic?: string | null;
  recipientAddress?: string | null;
  seqno?: number | null;
};

export type ResumableNativeGramSweepStatus = "READY" | "SENT";

export function resumableFailedNativeGramSweepStatus(
  evidence: FailedNativeGramSweepEvidence,
): ResumableNativeGramSweepStatus {
  const present = (value: unknown) => value !== null && value !== undefined;
  const hasPlan =
    present(evidence.sentAt) ||
    present(evidence.transactionHash) ||
    present(evidence.confirmedAt) ||
    present(evidence.amountAtomic) ||
    present(evidence.reserveAtomic) ||
    present(evidence.recipientAddress) ||
    present(evidence.seqno);
  if (!hasPlan) return "READY";
  if (present(evidence.transactionHash) || present(evidence.confirmedAt)) {
    throw new Error("Failed GRAM sweep contains contradictory confirmation evidence.");
  }
  const complete =
    typeof evidence.amountAtomic === "string" && /^[1-9]\d*$/.test(evidence.amountAtomic) &&
    typeof evidence.reserveAtomic === "string" && /^\d+$/.test(evidence.reserveAtomic) &&
    typeof evidence.recipientAddress === "string" && Boolean(evidence.recipientAddress) &&
    Number.isSafeInteger(evidence.seqno) && Number(evidence.seqno) >= 0;
  if (!complete) {
    throw new Error("Failed GRAM sweep contains an incomplete persisted transfer plan.");
  }
  return evidence.sentAt ? "SENT" : "READY";
}
