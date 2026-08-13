import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { Address } from "@ton/core";
import { WalletContractV5R1 } from "@ton/ton";
import {
  buildMainnetUsdtTransferBody,
  createMainnetUsdtSweepBlockchain,
  deriveMainnetUsdtSweepQueryId,
  processMainnetUsdtSweep,
  resolveMainnetUsdtSweepConfig,
  type MainnetUsdtSweepBlockchain,
  type MainnetUsdtSweepConfig,
  type MainnetUsdtSweepRecord,
  type MainnetUsdtSweepRepository,
} from "../worker/src/mainnet-usdt-sweep";
import { tonPublicKeyFromSecretKey } from "../worker/src/sweep";
import { officialMainnetUsdtMasterAddress } from "../backend/src/ton/mainnet-usdt";

const depositSecretKey = Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);
const gasSecretKey = Buffer.concat([Buffer.alloc(32, 3), Buffer.alloc(32, 4)]);
const depositPublicKey = tonPublicKeyFromSecretKey(depositSecretKey);
const gasPublicKey = tonPublicKeyFromSecretKey(gasSecretKey);
const gasWallet = WalletContractV5R1.create({ publicKey: gasPublicKey });
const depositWallet = WalletContractV5R1.create({
  publicKey: depositPublicKey,
  workchain: 0,
  walletId: { networkGlobalId: -239, context: 91 },
});
const jettonWallet = Address.parseRaw(`0:${"22".repeat(32)}`);

function secretBase64(value: Buffer) {
  return value.toString("base64url");
}

function config(): MainnetUsdtSweepConfig {
  return resolveMainnetUsdtSweepConfig({
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    TON_MAINNET_DEPOSIT_SECRET_KEY: secretBase64(depositSecretKey),
    TON_MAINNET_SWEEP_RECIPIENT_ADDRESS: gasWallet.address.toString(),
    TON_MAINNET_GAS_SERVICE_SECRET_KEY: secretBase64(gasSecretKey),
  })!;
}

function record(status: MainnetUsdtSweepRecord["status"] = "QUEUED"): MainnetUsdtSweepRecord {
  return {
    id: "sweep-1",
    idempotencyKey: "official-usdt-movement:movement-1",
    status,
    asset: "USDT",
    assetKind: "JETTON",
    amountAtomic: null,
    reserveAtomic: null,
    recipientAddress: null,
    transactionHash: null,
    seqno: null,
    queryId: null,
    gasTopupAmountNano: null,
    gasTopupSeqno: null,
    reserveTopupAmountNano: null,
    reserveTopupSeqno: null,
    gasServicePlanKey: null,
    attempts: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    startedAt: null,
    sentAt: null,
    confirmedAt: null,
    lastError: null,
    depositAddressId: "deposit-1",
    orderId: "order-1",
    invoiceId: "invoice-1",
    depositNetwork: "mainnet",
    depositAddress: depositWallet.address.toString(),
    depositAddressRaw: depositWallet.address.toRawString(),
    walletVersion: "v5r1",
    walletWorkchain: 0,
    walletContext: 91,
    walletNetworkGlobalId: -239,
    walletPublicKeyHash: config().depositPublicKeyHash,
    invoiceNetwork: "mainnet",
    invoiceAddress: depositWallet.address.toString(),
    invoiceAddressRaw: depositWallet.address.toRawString(),
    accountNetwork: "mainnet",
    accountAsset: "USDT",
    accountAssetKind: "JETTON",
    accountAssetDecimals: 6,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: jettonWallet.toRawString(),
    accountStatus: "VERIFIED",
  };
}

function harness(initial = record(), walletLeases = new Map<string, string>()) {
  let current = structuredClone(initial) as MainnetUsdtSweepRecord;
  const events: string[] = [];
  const failures: string[] = [];
  const confirmations: string[] = [];
  const repository: MainnetUsdtSweepRepository = {
    listCandidates: async () => [current],
    claim: async ({ workerId, now, leaseMs }) => {
      if (current.leaseOwner && current.leaseExpiresAt && current.leaseExpiresAt > now) {
        return null;
      }
      current = {
        ...current,
        leaseOwner: workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: current.attempts + 1,
        startedAt: current.startedAt ?? now,
      };
      events.push("claim");
      return current;
    },
    transition: async ({ leaseOwner, expectedStatuses, data }) => {
      if (current.leaseOwner !== leaseOwner || !expectedStatuses.includes(current.status)) {
        return null;
      }
      current = { ...current, ...data } as MainnetUsdtSweepRecord;
      events.push(`status:${current.status}`);
      return current;
    },
    defer: async ({ retryAt, error }) => {
      current = { ...current, leaseOwner: null, leaseExpiresAt: retryAt, lastError: error ?? null };
      events.push("defer");
    },
    fail: async ({ error, retryAt }) => {
      current = {
        ...current,
        status: "FAILED",
        leaseOwner: null,
        leaseExpiresAt: retryAt,
        lastError: error,
      };
      failures.push(error);
      events.push("failed");
    },
    confirm: async ({ confirmation, confirmedAt }) => {
      current = {
        ...current,
        status: "CONFIRMED",
        transactionHash: confirmation.transactionHash,
        confirmedAt,
        leaseOwner: null,
        leaseExpiresAt: null,
      };
      confirmations.push(confirmation.transactionHash);
      events.push("confirmed");
    },
    acquireWalletLease: async ({ streamType, scopeKey, owner }) => {
      const key = `${streamType}:${scopeKey}`;
      const existing = walletLeases.get(key);
      if (existing && existing !== owner) {
        events.push(`blocked:${scopeKey}`);
        return false;
      }
      walletLeases.set(key, owner);
      events.push(`lock:${scopeKey}`);
      return true;
    },
    releaseWalletLease: async ({ streamType, scopeKey, owner }) => {
      const key = `${streamType}:${scopeKey}`;
      if (walletLeases.get(key) === owner) {
        walletLeases.delete(key);
      }
      events.push(`unlock:${scopeKey}`);
    },
    retryFailed: async () => true,
    queueForDeposit: async () => current,
  };
  return { repository, current: () => current, events, failures, confirmations };
}

function blockchain(overrides: Partial<MainnetUsdtSweepBlockchain> = {}): MainnetUsdtSweepBlockchain {
  return {
    getTonBalance: async () => 200_000_000n,
    getJettonBalance: async () => 25_000_000n,
    getWalletSeqno: async () => 7,
    sendGasTopup: async () => undefined,
    sendJettonSweep: async () => undefined,
    waitForWalletSeqno: async () => true,
    findJettonSweep: async () => null,
    ...overrides,
  };
}

test("mainnet USDT sweep config is off with the adapter and reuses the treasury as gas service", () => {
  assert.equal(resolveMainnetUsdtSweepConfig({}), null);
  const resolved = config();
  assert.equal(resolved.recipientAddressRaw, gasWallet.address.toRawString());
  assert.equal(resolved.gasServiceAddressRaw, gasWallet.address.toRawString());
  assert.equal(resolved.gasTargetNano, 150_000_000n);
  assert.equal(resolved.depositReserveNano, 50_000_000n);
  assert.equal(resolved.jettonTransferValueNano, 50_000_000n);
  assert.equal(resolved.walletFeeCushionNano, 50_000_000n);
  assert.throws(
    () => resolveMainnetUsdtSweepConfig({
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
      TON_MAINNET_DEPOSIT_SECRET_KEY: secretBase64(depositSecretKey),
      TON_MAINNET_SWEEP_RECIPIENT_ADDRESS: depositWallet.address.toString(),
      TON_MAINNET_GAS_SERVICE_SECRET_KEY: secretBase64(gasSecretKey),
    }),
    /gas service wallet must be the mainnet sweep recipient/i,
  );
  assert.throws(
    () => resolveMainnetUsdtSweepConfig({
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
      TON_MAINNET_DEPOSIT_SECRET_KEY: secretBase64(depositSecretKey),
      TON_MAINNET_SWEEP_RECIPIENT_ADDRESS: gasWallet.address.toString(),
      TON_MAINNET_GAS_SERVICE_SECRET_KEY: secretBase64(gasSecretKey),
      TON_MAINNET_USDT_GAS_TARGET_NANO: "100000000",
    }),
    /positive wallet fee cushion/,
  );
});

test("TEP-74 body fixes opcode, deterministic uint64 query, amount and response owner", () => {
  const queryId = deriveMainnetUsdtSweepQueryId("sweep-1");
  const body = buildMainnetUsdtTransferBody({
    queryId,
    amountAtomic: 25_000_000n,
    destination: gasWallet.address,
    responseDestination: depositWallet.address,
  });
  const slice = body.beginParse();
  assert.equal(slice.loadUint(32), 0x0f8a7ea5);
  assert.equal(slice.loadUintBig(64), queryId);
  assert.equal(slice.loadCoins(), 25_000_000n);
  assert.equal(slice.loadAddress().toRawString(), gasWallet.address.toRawString());
  assert.equal(slice.loadAddress().toRawString(), depositWallet.address.toRawString());
  assert.equal(slice.loadBit(), false);
  assert.equal(slice.loadCoins(), 1n);
  assert.equal(slice.loadBit(), false);
  assert.equal(slice.remainingBits, 0);
});

test("low TON balance persists an exact merchant-funded top-up before broadcasting it", async () => {
  const state = harness();
  const topups: Array<{ amountNano: bigint; seqno: number }> = [];
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getTonBalance: async () => 40_000_000n,
      getWalletSeqno: async (wallet) => wallet.address.equals(gasWallet.address) ? 19 : 7,
      sendGasTopup: async ({ amountNano, seqno }) => {
        topups.push({ amountNano, seqno });
      },
    }),
    workerId: "worker-1",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(result.status, "gas-topup-sent");
  assert.deepEqual(topups, [{ amountNano: 110_000_000n, seqno: 19 }]);
  assert.equal(state.current().status, "GAS_TOPUP_SENT");
  assert.equal(state.current().gasTopupAmountNano, "110000000");
  assert.equal(state.current().gasTopupSeqno, 19);
  assert.ok(state.events.indexOf("status:GAS_TOPUP_REQUIRED") < state.events.indexOf("status:GAS_TOPUP_SENT"));
});

test("a persisted top-up plan is reduced if TON arrived before its seqno was broadcast", async () => {
  const initial = record("GAS_TOPUP_REQUIRED");
  initial.gasTopupAmountNano = "110000000";
  initial.gasTopupSeqno = 19;
  initial.gasServicePlanKey = `${config().gasServiceAddressRaw}:19`;
  const state = harness(initial);
  const sent: bigint[] = [];
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getTonBalance: async () => 100_000_000n,
      getWalletSeqno: async () => 19,
      sendGasTopup: async ({ amountNano }) => {
        sent.push(amountNano);
      },
    }),
    workerId: "worker-topup-recheck",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(result.status, "gas-topup-sent");
  assert.deepEqual(sent, [50_000_000n]);
  assert.equal(state.current().gasTopupAmountNano, "50000000");
});

test("two sweeps in one batch cannot reuse a retained central gas-wallet seqno lease", async () => {
  const sharedLeases = new Map<string, string>();
  const first = record();
  first.id = "sweep-a";
  const second = record();
  second.id = "sweep-b";
  second.depositAddressId = "deposit-b";
  second.invoiceId = "invoice-b";
  const secondWallet = WalletContractV5R1.create({
    publicKey: depositPublicKey,
    workchain: 0,
    walletId: { networkGlobalId: -239, context: 92 },
  });
  second.depositAddress = secondWallet.address.toString();
  second.depositAddressRaw = secondWallet.address.toRawString();
  second.invoiceAddress = secondWallet.address.toString();
  second.invoiceAddressRaw = secondWallet.address.toRawString();
  second.walletContext = 92;
  const stateA = harness(first, sharedLeases);
  const stateB = harness(second, sharedLeases);
  const topups: string[] = [];
  const chain = blockchain({
    getTonBalance: async () => 40_000_000n,
    getWalletSeqno: async () => 19,
    sendGasTopup: async ({ destination }) => {
      topups.push(destination.toRawString());
    },
    waitForWalletSeqno: async () => false,
  });
  assert.equal((await processMainnetUsdtSweep({
    record: stateA.current(),
    config: config(),
    repository: stateA.repository,
    blockchain: chain,
    workerId: "batch-worker",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  })).status, "gas-topup-sent");
  assert.equal((await processMainnetUsdtSweep({
    record: stateB.current(),
    config: config(),
    repository: stateB.repository,
    blockchain: chain,
    workerId: "batch-worker",
    now: () => new Date("2026-08-13T12:00:01.000Z"),
  })).status, "deferred");
  assert.deepEqual(topups, [depositWallet.address.toRawString()]);
  assert.equal(stateB.current().status, "QUEUED");
});

test("funded deposit sends the entire USDT balance and leaves TON reserve as merchant cost", async () => {
  const state = harness();
  const sends: Array<{ amountAtomic: bigint; queryId: bigint; seqno: number }> = [];
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      sendJettonSweep: async ({ amountAtomic, queryId, seqno }) => {
        sends.push({ amountAtomic, queryId, seqno });
      },
    }),
    workerId: "worker-1",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(result.status, "sent");
  assert.equal(state.current().status, "SENT");
  assert.equal(state.current().amountAtomic, "25000000");
  assert.equal(state.current().reserveAtomic, "0");
  assert.equal(state.current().seqno, 7);
  assert.equal(state.current().recipientAddress, gasWallet.address.toRawString());
  assert.deepEqual(sends, [{
    amountAtomic: 25_000_000n,
    queryId: deriveMainnetUsdtSweepQueryId("sweep-1"),
    seqno: 7,
  }]);
});

test("a READY crash recovery never rebroadcasts after the persisted deposit seqno advanced", async () => {
  const initial = record("READY");
  initial.amountAtomic = "25000000";
  initial.reserveAtomic = "0";
  initial.recipientAddress = gasWallet.address.toRawString();
  initial.queryId = deriveMainnetUsdtSweepQueryId(initial.id).toString();
  initial.seqno = 7;
  const state = harness(initial);
  let sends = 0;
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getWalletSeqno: async () => 8,
      sendJettonSweep: async () => {
        sends += 1;
      },
    }),
    workerId: "worker-ready-recovery",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(result.status, "sent");
  assert.equal(sends, 0);
  assert.equal(state.current().status, "SENT");
});

test("SENT is confirmed only by exact outgoing official-USDT evidence", async () => {
  const initial = record("SENT");
  initial.amountAtomic = "25000000";
  initial.reserveAtomic = "0";
  initial.recipientAddress = gasWallet.address.toRawString();
  initial.queryId = deriveMainnetUsdtSweepQueryId(initial.id).toString();
  initial.seqno = 7;
  initial.sentAt = new Date("2026-08-13T12:00:00.000Z");
  const state = harness(initial);
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getTonBalance: async () => 80_000_000n,
      getWalletSeqno: async () => 8,
      findJettonSweep: async () => ({
        transactionHash: "ab".repeat(32),
        transactionLt: "9001",
        blockchainAt: new Date("2026-08-13T12:00:05.000Z"),
      }),
    }),
    workerId: "worker-2",
    now: () => new Date("2026-08-13T12:00:10.000Z"),
  });
  assert.equal(result.status, "confirmed");
  assert.equal(state.current().status, "CONFIRMED");
  assert.deepEqual(state.confirmations, ["ab".repeat(32)]);
});

test("an unexpectedly expensive sweep repairs the TON reserve before marking CONFIRMED", async () => {
  const initial = record("SENT");
  initial.amountAtomic = "25000000";
  initial.reserveAtomic = "0";
  initial.recipientAddress = gasWallet.address.toRawString();
  initial.queryId = deriveMainnetUsdtSweepQueryId(initial.id).toString();
  initial.seqno = 7;
  initial.sentAt = new Date("2026-08-13T12:00:00.000Z");
  const state = harness(initial);
  let depositBalance = 20_000_000n;
  const repairs: bigint[] = [];
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getTonBalance: async () => depositBalance,
      getWalletSeqno: async (wallet) => wallet.address.equals(gasWallet.address) ? 19 : 8,
      sendGasTopup: async ({ amountNano }) => {
        repairs.push(amountNano);
        depositBalance += amountNano;
      },
      findJettonSweep: async () => ({
        transactionHash: "ac".repeat(32),
        transactionLt: "9003",
        blockchainAt: new Date("2026-08-13T12:00:05.000Z"),
      }),
    }),
    workerId: "worker-reserve-repair",
    now: () => new Date("2026-08-13T12:00:10.000Z"),
  });
  assert.equal(result.status, "confirmed");
  assert.deepEqual(repairs, [30_000_000n]);
  assert.equal(state.current().reserveTopupAmountNano, "30000000");
  assert.equal(state.current().reserveTopupSeqno, 19);
  assert.equal(state.current().status, "CONFIRMED");
});

test("TON Center confirmation parser rejects duplicate or out-of-window outgoing evidence", async () => {
  const transfer = {
    amount: "25000000",
    destination: gasWallet.address.toRawString(),
    jetton_master: officialMainnetUsdtMasterAddress,
    query_id: "77",
    source: depositWallet.address.toRawString(),
    source_wallet: jettonWallet.toRawString(),
    transaction_aborted: false,
    transaction_hash: "cd".repeat(32),
    transaction_lt: "9002",
    transaction_now: 1_786_622_405,
  };
  const createClient = (transfers: unknown[]) => createMainnetUsdtSweepBlockchain(
    config(),
    async () => new Response(JSON.stringify({ jetton_transfers: transfers }), { status: 200 }),
  );
  const lookup = {
    ownerAddress: depositWallet.address,
    jettonWallet,
    recipientAddress: gasWallet.address,
    amountAtomic: 25_000_000n,
    queryId: 77n,
    notBefore: new Date("2026-08-13T12:00:00.000Z"),
    notAfter: new Date("2026-08-13T12:00:10.000Z"),
  };
  assert.equal(await createClient([{ ...transfer, transaction_now: 1_786_622_399 }]).findJettonSweep(lookup), null);
  const sameSecond = await createClient([{ ...transfer, transaction_now: 1_786_622_400 }]).findJettonSweep({
    ...lookup,
    notBefore: new Date("2026-08-13T12:00:00.700Z"),
  });
  assert.equal(sameSecond?.transactionHash, "cd".repeat(32));
  await assert.rejects(
    createClient([transfer, transfer]).findJettonSweep(lookup),
    /duplicate matching USDT sweep confirmations/,
  );
});

test("ownership drift fails into recovery without a blockchain call and remains retryable", async () => {
  const drifted = record();
  drifted.invoiceNetwork = "testnet";
  const state = harness(drifted);
  let blockchainCalls = 0;
  const result = await processMainnetUsdtSweep({
    record: state.current(),
    config: config(),
    repository: state.repository,
    blockchain: blockchain({
      getTonBalance: async () => {
        blockchainCalls += 1;
        return 0n;
      },
    }),
    workerId: "worker-3",
    now: () => new Date("2026-08-13T12:00:00.000Z"),
  });
  assert.equal(result.status, "failed");
  assert.equal(blockchainCalls, 0);
  assert.equal(state.current().status, "FAILED");
  assert.match(state.failures[0] ?? "", /ownership/i);
  assert.equal(await state.repository.retryFailed({
    sweepId: drifted.id,
    requestedAt: new Date("2026-08-13T12:10:00.000Z"),
  }), true);
});
