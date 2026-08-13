import assert from "node:assert/strict";
import test from "node:test";
import { Address } from "@ton/core";
import {
  createMainnetUsdtAdapter,
  officialMainnetUsdtMasterAddress,
  resolveMainnetUsdtAdapterConfig,
} from "../backend/src/ton/mainnet-usdt";
import {
  createPrismaMainnetUsdtScannerRepository,
  runMainnetUsdtScanBatch,
  scheduleMainnetUsdtDueIds,
} from "../worker/src/mainnet-usdt";

const ownerRaw = `0:${"51".repeat(32)}`;
const assetWalletRaw = `0:${"71".repeat(32)}`;
const senderRaw = `0:${"81".repeat(32)}`;
const senderWalletRaw = `0:${"91".repeat(32)}`;
const ownerFriendly = Address.parse(ownerRaw).toString({ bounceable: true });
const assetWalletFriendly = Address.parse(assetWalletRaw).toString({ bounceable: true });
const senderFriendly = Address.parse(senderRaw).toString({ bounceable: false });
const senderWalletFriendly = Address.parse(senderWalletRaw).toString({ bounceable: true });
const transactionHash = "a1".repeat(32);
const notBefore = new Date("2026-08-13T10:00:00.000Z");
const notAfter = new Date("2026-08-13T10:30:00.000Z");

test("official mainnet USDT adapter is independently flagged, off by default, and pins identity", () => {
  assert.equal(resolveMainnetUsdtAdapterConfig({}), null);
  assert.equal(resolveMainnetUsdtAdapterConfig({
    TON_INTERNAL_TESTNET_JETTON_ENABLED: "true",
  }), null);
  assert.throws(
    () => resolveMainnetUsdtAdapterConfig({ TON_USDT_MAINNET_ADAPTER_ENABLED: "yes" }),
    /must be true or false/,
  );
  assert.deepEqual(resolveMainnetUsdtAdapterConfig({
    TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
  }), {
    enabled: true,
    network: "mainnet",
    masterAddress: officialMainnetUsdtMasterAddress,
    decimals: 6,
  });
});

test("mainnet adapter verifies the official master wallet and journals production USDT evidence", async () => {
  const accounts: any[] = [];
  const observed: any[] = [];
  const urls: URL[] = [];
  const adapter = createMainnetUsdtAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-mainnet",
          network: "mainnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {
        upsert: async ({ where, create }: any) => {
          const existing = accounts.find((row) =>
            row.depositAddressId === where.depositAddressId_asset.depositAddressId &&
            row.asset === where.depositAddressId_asset.asset);
          if (existing) {
            return existing;
          }
          const row = { id: "asset-mainnet", ...create };
          accounts.push(row);
          return row;
        },
      },
    } as any,
    ledger: {
      recordObserved: async (movement) => observed.push(movement),
      recordRejected: async () => undefined,
    },
    config: resolveMainnetUsdtAdapterConfig({
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    })!,
    resolveReadConfig: () => ({
      network: "mainnet",
      baseUrl: "https://toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      urls.push(url);
      if (url.pathname.endsWith("/jetton/masters")) {
        return new Response(JSON.stringify({
          jetton_masters: [{
            address: officialMainnetUsdtMasterAddress,
            jetton_content: { decimals: "6", symbol: "anything" },
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/jetton/wallets")) {
        return new Response(JSON.stringify({
          jetton_wallets: [{
            address: assetWalletFriendly,
            owner: ownerFriendly,
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
          destination: ownerFriendly,
          jetton_master: officialMainnetUsdtMasterAddress,
          query_id: "42",
          source: senderFriendly,
          source_wallet: senderWalletFriendly,
          trace_id: "b2".repeat(32),
          transaction_aborted: false,
          transaction_hash: transactionHash,
          transaction_lt: "900001",
          transaction_now: 1_786_615_800,
        }],
      }), { status: 200 });
    }) as typeof fetch,
    now: () => notAfter,
  });

  const result = await adapter.observeDeposit({
    depositAddressId: "deposit-mainnet",
    notBefore,
    notAfter,
  });

  assert.equal(result.movementsObserved, 1);
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.network, "mainnet");
  assert.equal(accounts[0]?.jettonMasterAddress, officialMainnetUsdtMasterAddress);
  assert.equal(accounts[0]?.assetWalletAddress, assetWalletRaw);
  assert.equal(urls[0]?.hostname, "toncenter.com");
  assert.equal(urls[0]?.searchParams.get("address"), officialMainnetUsdtMasterAddress);
  assert.equal(urls[2]?.searchParams.get("jetton_master"), officialMainnetUsdtMasterAddress);
  assert.deepEqual(observed[0], {
    fingerprint: `ton:mainnet:jetton-in:${transactionHash}:42:${officialMainnetUsdtMasterAddress}`,
    depositAddressId: "deposit-mainnet",
    network: "mainnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    fromAddress: senderRaw,
    toAddress: ownerRaw,
    ownerAddress: ownerRaw,
    jettonMasterAddress: officialMainnetUsdtMasterAddress,
    jettonWalletAddress: assetWalletRaw,
    transactionHash,
    transactionLt: "900001",
    traceId: "b2".repeat(32),
    queryId: "42",
    blockchainAt: new Date("2026-08-13T10:10:00.000Z"),
    rawPayload: {
      evidenceVersion: 1,
      provider: "toncenter-v3-jetton-transfers",
      officialUsdt: true,
      transfer: {
        amount: "5000000",
        destination: ownerRaw,
        jettonMaster: officialMainnetUsdtMasterAddress,
        queryId: "42",
        source: senderRaw,
        sourceWallet: senderWalletRaw,
        transactionAborted: false,
        transactionHash,
        transactionLt: "900001",
        transactionNow: 1_786_615_800,
      },
    },
  });
});

test("mainnet adapter refuses a testnet deposit before provider or ledger I/O", async () => {
  let fetches = 0;
  let writes = 0;
  const adapter = createMainnetUsdtAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-testnet",
          network: "testnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {
        upsert: async () => {
          writes += 1;
          return null;
        },
      },
    } as any,
    ledger: {
      recordObserved: async () => { writes += 1; },
      recordRejected: async () => { writes += 1; },
    },
    config: resolveMainnetUsdtAdapterConfig({
      TON_USDT_MAINNET_ADAPTER_ENABLED: "true",
    })!,
    fetchImpl: (async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch,
  });

  await assert.rejects(
    adapter.observeDeposit({ depositAddressId: "deposit-testnet", notBefore, notAfter }),
    /mainnet deposit/,
  );
  assert.equal(fetches, 0);
  assert.equal(writes, 0);
});

test("mainnet USDT scan batch owns a separate lease, paginates fully, and advances its time cursor", async () => {
  const calls: any[] = [];
  const completions: any[] = [];
  const now = new Date("2026-08-13T10:30:00.000Z");
  const cursorTimestamp = new Date("2026-08-13T10:20:00.000Z");
  const target = {
    invoiceId: "invoice-mainnet",
    depositAddressId: "deposit-mainnet",
    network: "mainnet" as const,
    invoiceNetwork: "mainnet",
    depositNetwork: "mainnet",
    address: ownerFriendly,
    addressRaw: ownerRaw,
    invoiceAddress: ownerFriendly,
    invoiceAddressRaw: ownerRaw,
    status: "PENDING",
    createdAt: notBefore,
    updatedAt: notBefore,
    terminalMonitorUntil: null,
    cursorTimestamp,
    leaseOwner: "worker-1",
  };
  const result = await runMainnetUsdtScanBatch({
    now,
    workerId: "worker-1",
    pageSize: 2,
    maxPages: 3,
    overlapMs: 60_000,
    activeIntervalMs: 15_000,
    repository: {
      claimDueTargets: async () => [target],
      renewLease: async () => true,
      completeScan: async (input) => {
        completions.push(input);
        return true;
      },
      failScan: async () => true,
    },
    adapter: {
      observeDeposit: async (input) => {
        calls.push(input);
        return input.offset === 0
          ? {
              transfersScanned: 2,
              discoveryTransfersScanned: 2,
              notificationTransactionsScanned: 1,
              movementsObserved: 1,
              rejectionsRecorded: 0,
              nextOffset: 2,
            }
          : {
              transfersScanned: 1,
              discoveryTransfersScanned: 0,
              notificationTransactionsScanned: 1,
              movementsObserved: 1,
              rejectionsRecorded: 0,
              nextOffset: 4,
            };
      },
    },
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.failed, 0);
  assert.equal(result.movementsObserved, 2);
  assert.deepEqual(calls.map(({ offset }) => offset), [0, 2]);
  assert.equal(calls[0]?.notBefore.toISOString(), "2026-08-13T10:19:00.000Z");
  assert.equal(calls[0]?.notAfter, now);
  assert.equal(completions.length, 1);
  assert.equal(completions[0]?.scannedThroughAt, now);
  assert.equal(completions[0]?.nextScanAt.toISOString(), "2026-08-13T10:30:15.000Z");
});

test("mainnet USDT scan batch rejects invoice/deposit network drift before fetch or cursor advance", async () => {
  let fetches = 0;
  let completions = 0;
  const failures: any[] = [];
  const result = await runMainnetUsdtScanBatch({
    now: notAfter,
    pageSize: 1,
    maxPages: 1,
    repository: {
      claimDueTargets: async () => [{
        invoiceId: "invoice-drift",
        depositAddressId: "deposit-drift",
        network: "mainnet",
        invoiceNetwork: "testnet",
        depositNetwork: "mainnet",
        address: ownerFriendly,
        addressRaw: ownerRaw,
        invoiceAddress: ownerFriendly,
        invoiceAddressRaw: ownerRaw,
        status: "PENDING",
        createdAt: notBefore,
        updatedAt: notBefore,
        terminalMonitorUntil: null,
        cursorTimestamp: null,
        leaseOwner: "worker-drift",
      }],
      renewLease: async () => true,
      completeScan: async () => {
        completions += 1;
        return true;
      },
      failScan: async (input) => {
        failures.push(input);
        return true;
      },
    },
    adapter: {
      observeDeposit: async () => {
        fetches += 1;
        return {
          transfersScanned: 1,
          discoveryTransfersScanned: 1,
          notificationTransactionsScanned: 0,
          movementsObserved: 0,
          rejectionsRecorded: 0,
          nextOffset: 1,
        };
      },
    },
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /network evidence is inconsistent/);
  assert.equal(fetches, 0);
  assert.equal(completions, 0);
  assert.equal(failures.length, 1);
});

test("mainnet USDT scan batch does not advance its cursor when the pagination cap is exhausted", async () => {
  let fetches = 0;
  let completions = 0;
  let failures = 0;
  const result = await runMainnetUsdtScanBatch({
    now: notAfter,
    pageSize: 1,
    maxPages: 1,
    repository: {
      claimDueTargets: async () => [{
        invoiceId: "invoice-overflow",
        depositAddressId: "deposit-overflow",
        network: "mainnet",
        invoiceNetwork: "mainnet",
        depositNetwork: "mainnet",
        address: ownerFriendly,
        addressRaw: ownerRaw,
        invoiceAddress: ownerFriendly,
        invoiceAddressRaw: ownerRaw,
        status: "PENDING",
        createdAt: notBefore,
        updatedAt: notBefore,
        terminalMonitorUntil: null,
        cursorTimestamp: null,
        leaseOwner: "worker-overflow",
      }],
      renewLease: async () => true,
      completeScan: async () => {
        completions += 1;
        return true;
      },
      failScan: async () => {
        failures += 1;
        return true;
      },
    },
    adapter: {
      observeDeposit: async () => {
        fetches += 1;
        return {
          transfersScanned: 1,
          discoveryTransfersScanned: 1,
          notificationTransactionsScanned: 0,
          movementsObserved: 1,
          rejectionsRecorded: 0,
          nextOffset: 1,
        };
      },
    },
  });

  assert.equal(result.failed, 1);
  assert.match(result.outcomes[0]?.error ?? "", /exceeded 1 pages/);
  assert.equal(fetches, 1);
  assert.equal(completions, 0);
  assert.equal(failures, 1);
  assert.equal(result.movementsObserved, 1);
});

test("mainnet USDT repository filters due rows before bounded pools and reserves terminal fairness", async () => {
  const activeIds = Array.from({ length: 10 }, (_, index) => `active-${index}`);
  const terminalIds = ["terminal-0", "terminal-1"];
  const queriedStatusGroups: string[][] = [];
  const deposits = new Map([...activeIds, ...terminalIds].map((id) => [id, {
    id,
    network: "mainnet",
    address: ownerFriendly,
    addressRaw: ownerRaw,
    invoice: {
      id: `invoice-${id}`,
      network: "mainnet",
      address: ownerFriendly,
      addressRaw: ownerRaw,
      status: id.startsWith("active") ? "PENDING" : "PAID",
      createdAt: notBefore,
      updatedAt: notBefore,
      terminalMonitorUntil: id.startsWith("terminal")
        ? new Date("2026-09-01T00:00:00.000Z")
        : null,
    },
  }]));
  const cursors = new Map<string, any>();
  let cursorIndex = 0;
  const claimed: string[] = [];
  const repository = createPrismaMainnetUsdtScannerRepository({
    $queryRaw: async () => {
      const statuses = queriedStatusGroups.length === 0
        ? ["PENDING", "PARTIAL"]
        : ["PAID", "EXPIRED", "CANCELLED", "FAILED"];
      queriedStatusGroups.push(statuses);
      return (statuses[0] === "PENDING" ? activeIds : terminalIds).map((id) => ({ id }));
    },
    tonhubDepositAddress: {
      findMany: async ({ where }: any) => where.id.in.map((id: string) => deposits.get(id)),
    },
    tonhubScanCursor: {
      findMany: async () => [],
      createMany: async ({ data }: any) => {
        const cursor = {
          id: `cursor-${cursorIndex += 1}`,
          ...data,
          lastTimestamp: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: notBefore,
        };
        cursors.set(cursor.id, cursor);
        return { count: 1 };
      },
      findUnique: async ({ where }: any) => Array.from(cursors.values()).find((cursor) =>
        cursor.network === where.network_streamType_scopeKey.network &&
        cursor.streamType === where.network_streamType_scopeKey.streamType &&
        cursor.scopeKey === where.network_streamType_scopeKey.scopeKey
      ) ?? null,
      updateMany: async ({ where, data }: any) => {
        const cursor = cursors.get(where.id);
        if (!cursor) {
          return { count: 0 };
        }
        Object.assign(cursor, data);
        claimed.push(cursor.scopeKey);
        return { count: 1 };
      },
    },
  } as any);

  const targets = await repository.claimDueTargets({
    workerId: "fair-worker",
    now: notAfter,
    limit: 4,
    leaseMs: 60_000,
    activeIntervalMs: 15_000,
    terminalIntervalMs: 86_400_000,
    terminalMonitorMs: 30 * 86_400_000,
    candidatePoolSize: 10,
  });

  assert.deepEqual(queriedStatusGroups, [
    ["PENDING", "PARTIAL"],
    ["PAID", "EXPIRED", "CANCELLED", "FAILED"],
  ]);
  assert.equal(targets.length, 4);
  assert.deepEqual(claimed, ["active-0", "active-1", "active-2", "terminal-0"]);
});

test("mainnet USDT scheduler reserves terminal capacity for every supported batch size", async () => {
  const active = ["active-0", "active-1", "active-2", "active-3"];
  const terminal = ["terminal-0", "terminal-1"];
  assert.throws(
    () => scheduleMainnetUsdtDueIds(active, terminal, 1),
    /at least 2/,
  );
  for (const limit of [2, 3, 4]) {
    const selected = scheduleMainnetUsdtDueIds(active, terminal, limit).slice(0, limit);
    assert.equal(selected.length, limit);
    assert.ok(selected.some((id) => id.startsWith("active")), `active slot at limit ${limit}`);
    assert.ok(selected.some((id) => id.startsWith("terminal")), `terminal slot at limit ${limit}`);
  }
  await assert.rejects(
    runMainnetUsdtScanBatch({
      adapter: { observeDeposit: async () => { throw new Error("unreachable"); } },
      limit: 1,
    }),
    /at least 2/,
  );
});
