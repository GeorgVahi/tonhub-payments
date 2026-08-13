import assert from "node:assert/strict";
import test from "node:test";
import { Address, beginCell } from "@ton/core";
import {
  createInternalTestnetJettonAdapter,
  jettonTransferNotificationOpcode,
  resolveInternalTestnetJettonConfig,
  scanInternalTestnetJettonTransfers,
} from "../backend/src/ton/internal-testnet-jetton";

const ownerRaw = `0:${"51".repeat(32)}`;
const masterRaw = `0:${"61".repeat(32)}`;
const fakeMasterRaw = `0:${"62".repeat(32)}`;
const assetWalletRaw = `0:${"71".repeat(32)}`;
const wrongWalletRaw = `0:${"72".repeat(32)}`;
const fakeWalletRaw = `0:${"73".repeat(32)}`;
const senderRaw = `0:${"81".repeat(32)}`;
const senderWalletRaw = `0:${"91".repeat(32)}`;
const ownerFriendly = Address.parse(ownerRaw).toString({ bounceable: true, testOnly: true });
const masterFriendly = Address.parse(masterRaw).toString({ bounceable: true, testOnly: true });
const fakeMasterFriendly = Address.parse(fakeMasterRaw).toString({ bounceable: true, testOnly: true });
const assetWalletFriendly = Address.parse(assetWalletRaw).toString({ bounceable: true, testOnly: true });
const wrongWalletFriendly = Address.parse(wrongWalletRaw).toString({ bounceable: true, testOnly: true });
const fakeWalletFriendly = Address.parse(fakeWalletRaw).toString({ bounceable: true, testOnly: true });
const senderFriendly = Address.parse(senderRaw).toString({ bounceable: false, testOnly: true });
const senderWalletFriendly = Address.parse(senderWalletRaw).toString({ bounceable: true, testOnly: true });
const transactionHash = "a1".repeat(32);
const notBefore = new Date("2026-08-13T10:00:00.000Z");
const notAfter = new Date("2026-08-13T10:30:00.000Z");

function transfer(overrides: Record<string, unknown> = {}) {
  return {
    amount: "5000000",
    destination: ownerFriendly,
    jetton_master: masterFriendly,
    query_id: "42",
    source: senderFriendly,
    source_wallet: senderWalletFriendly,
    trace_id: "b2".repeat(32),
    transaction_aborted: false,
    transaction_hash: transactionHash,
    transaction_lt: "900001",
    transaction_now: 1_786_615_800,
    ...overrides,
  };
}

function scan(transfers: ReturnType<typeof transfer>[], notifications: any[] = []) {
  return scanInternalTestnetJettonTransfers({
    depositAddressId: "deposit-1",
    ownerAddress: ownerRaw,
    masterAddress: masterRaw,
    assetWalletAddress: assetWalletRaw,
    notBefore,
    notAfter,
    transfers,
    notifications: notifications.map((value) => ({ accountAddress: ownerFriendly, ...value })),
  });
}

function notificationBody(opcode: number, overrides: {
  queryId?: bigint;
  amount?: bigint;
  sender?: string;
} = {}) {
  return beginCell()
    .storeUint(opcode, 32)
    .storeUint(overrides.queryId ?? BigInt(42), 64)
    .storeCoins(overrides.amount ?? BigInt(5_000_000))
    .storeAddress(Address.parse(overrides.sender ?? senderRaw))
    .storeBit(0)
    .endCell()
    .toBoc()
    .toString("base64");
}

function notificationTransaction(input: {
  traceId: string;
  walletAddress: string;
  body: string;
  aborted?: boolean;
  outMessages?: unknown[];
}) {
  return {
    account: ownerFriendly,
    trace_id: input.traceId,
    description: { aborted: input.aborted ?? false },
    in_msg: {
      source: input.walletAddress,
      destination: ownerFriendly,
      message_content: { body: input.body },
    },
    out_msgs: input.outMessages ?? [],
  };
}

test("internal testnet jetton config is explicit, disabled by default, and never accepts mainnet", () => {
  assert.equal(resolveInternalTestnetJettonConfig({}), null);
  assert.equal(resolveInternalTestnetJettonConfig({
    TON_INTERNAL_TESTNET_JETTON_ENABLED: "false",
  }), null);
  assert.throws(
    () => resolveInternalTestnetJettonConfig({
      TON_INTERNAL_TESTNET_JETTON_ENABLED: "true",
      TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS: masterFriendly,
      TON_INTERNAL_TESTNET_JETTON_NETWORK: "mainnet",
    }),
    /testnet only/,
  );

  const config = resolveInternalTestnetJettonConfig({
    TON_INTERNAL_TESTNET_JETTON_ENABLED: "true",
    TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS: masterFriendly,
    TON_INTERNAL_TESTNET_JETTON_DECIMALS: "6",
  });
  assert.deepEqual(config, {
    enabled: true,
    network: "testnet",
    masterAddress: masterRaw,
    decimals: 6,
  });
  assert.throws(
    () => resolveInternalTestnetJettonConfig({
      TON_INTERNAL_TESTNET_JETTON_ENABLED: "true",
      TON_INTERNAL_TESTNET_JETTON_MASTER_ADDRESS: masterFriendly,
      TON_INTERNAL_TESTNET_JETTON_DECIMALS: "9",
    }),
    /must explicitly equal 6/,
  );
});

test("internal adapter verifies one testnet asset wallet and journals incoming test jetton evidence", async () => {
  const accounts: any[] = [];
  const observed: any[] = [];
  const urls: URL[] = [];
  const db = {
    tonhubDepositAddress: {
      findUnique: async () => ({
        id: "deposit-1",
        network: "testnet",
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
        const row = {
          id: "asset-account-1",
          createdAt: notAfter,
          updatedAt: notAfter,
          verificationError: null,
          ...create,
        };
        accounts.push(row);
        return row;
      },
    },
  };
  const fetchImpl = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname.endsWith("/jetton/masters")) {
      return new Response(JSON.stringify({
        jetton_masters: [{
          address: masterFriendly,
          jetton_content: { decimals: "6", symbol: "TEST" },
        }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/jetton/wallets")) {
      return new Response(JSON.stringify({
        jetton_wallets: [{
          address: assetWalletFriendly,
          balance: "5000000",
          owner: ownerFriendly,
          jetton: masterFriendly,
          last_transaction_lt: "900001",
        }],
      }), { status: 200 });
    }
    if (url.pathname.endsWith("/transactions")) {
      return new Response(JSON.stringify({ transactions: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({
      jetton_transfers: [transfer()],
    }), { status: 200 });
  };
  const adapter = createInternalTestnetJettonAdapter({
    db: db as any,
    ledger: {
      recordObserved: async (movement) => observed.push(movement),
      recordRejected: async () => undefined,
    },
    config: {
      enabled: true,
      network: "testnet",
      masterAddress: masterRaw,
      decimals: 6,
    },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: fetchImpl as typeof fetch,
    now: () => notAfter,
  });
  const result = await adapter.observeDeposit({
    depositAddressId: "deposit-1",
    notBefore,
    notAfter,
  });

  assert.equal(result.account.status, "VERIFIED");
  assert.equal(result.account.asset, "USDT");
  assert.equal(result.account.jettonMasterAddress, masterRaw);
  assert.equal(result.account.assetWalletAddress, assetWalletRaw);
  assert.equal(result.movementsObserved, 1);
  assert.equal(result.rejections.length, 0);
  assert.equal(accounts.length, 1);
  assert.deepEqual(observed[0], {
    fingerprint: `ton:testnet:jetton-in:${transactionHash}:42:${masterRaw}`,
    depositAddressId: "deposit-1",
    network: "testnet",
    direction: "INCOMING",
    asset: "USDT",
    assetKind: "JETTON",
    assetDecimals: 6,
    amountAtomic: "5000000",
    fromAddress: senderRaw,
    toAddress: ownerRaw,
    ownerAddress: ownerRaw,
    jettonMasterAddress: masterRaw,
    jettonWalletAddress: assetWalletRaw,
    transactionHash,
    transactionLt: "900001",
    traceId: "b2".repeat(32),
    queryId: "42",
    blockchainAt: new Date("2026-08-13T10:10:00.000Z"),
    rawPayload: {
      evidenceVersion: 1,
      provider: "toncenter-v3-jetton-transfers",
      internalTestAsset: true,
      transfer: {
        amount: "5000000",
        destination: ownerRaw,
        jettonMaster: masterRaw,
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
  assert.equal(urls[0]?.pathname, "/api/v3/jetton/masters");
  assert.equal(urls[0]?.searchParams.get("address"), masterRaw);
  assert.equal(urls[1]?.pathname, "/api/v3/jetton/wallets");
  assert.equal(urls[1]?.searchParams.get("owner_address"), ownerRaw);
  assert.equal(urls[1]?.searchParams.get("jetton_address"), masterRaw);
  assert.equal(urls[2]?.pathname, "/api/v3/jetton/transfers");
  assert.equal(urls[2]?.searchParams.get("owner_address"), ownerRaw);
  assert.equal(urls[2]?.searchParams.get("jetton_wallet"), assetWalletRaw);
  assert.equal(urls[2]?.searchParams.get("jetton_master"), masterRaw);
  assert.equal(urls[2]?.searchParams.get("direction"), "in");
  assert.equal(urls[3]?.pathname, "/api/v3/jetton/transfers");
  assert.equal(urls[3]?.searchParams.get("owner_address"), ownerRaw);
  assert.equal(urls[3]?.searchParams.has("jetton_wallet"), false);
  assert.equal(urls[3]?.searchParams.has("jetton_master"), false);
  assert.equal(urls[4]?.pathname, "/api/v3/transactions");
  assert.equal(urls[4]?.searchParams.get("account"), ownerRaw);
});

test("jetton parser rejects fake identity, malformed transfers, aborted execution, and invalid notifications", () => {
  const cases = [
    ["malformed transaction hash", { transaction_hash: "not-a-hash" }, "TRANSACTION_ID_INVALID"],
    ["malformed transaction lt", { transaction_lt: "-1" }, "TRANSACTION_ID_INVALID"],
    ["transaction lt above uint64", { transaction_lt: "18446744073709551616" }, "TRANSACTION_ID_INVALID"],
    ["malformed transaction time", { transaction_now: "1786615800" }, "TRANSACTION_TIME_INVALID"],
    ["transaction time above uint32", { transaction_now: 0x1_0000_0000 }, "TRANSACTION_TIME_INVALID"],
    ["aborted transfer", { transaction_aborted: true }, "TRANSACTION_NOT_SUCCESSFUL"],
    ["missing explicit success", { transaction_aborted: undefined }, "TRANSACTION_NOT_SUCCESSFUL"],
    ["malformed query id", { query_id: "-42" }, "QUERY_ID_INVALID"],
    ["query id above uint64", { query_id: "18446744073709551616" }, "QUERY_ID_INVALID"],
    ["fake master", { jetton_master: fakeMasterFriendly }, "MASTER_MISMATCH"],
    ["wrong destination", { destination: senderFriendly }, "DESTINATION_MISMATCH"],
    ["malformed sender", { source: "not-an-address" }, "SOURCE_INVALID"],
    ["malformed sender wallet", { source_wallet: "not-an-address" }, "SOURCE_WALLET_INVALID"],
    ["non-positive amount", { amount: "0" }, "AMOUNT_INVALID"],
    [
      "amount above VarUInteger 16",
      { amount: (BigInt(1) << BigInt(120)).toString() },
      "AMOUNT_INVALID",
    ],
  ] as const;

  for (const [label, override, expectedCode] of cases) {
    const result = scan([transfer(override)]);
    assert.equal(result.movements.length, 0, label);
    assert.equal(result.rejections.length, 1, label);
    assert.equal(result.rejections[0]?.code, expectedCode, label);
  }

  const notificationCases = [
    ["malformed notification", "not-a-boc", assetWalletFriendly, "NOTIFICATION_MALFORMED"],
    [
      "wrong notification opcode",
      notificationBody(0x0f8a7ea5),
      assetWalletFriendly,
      "NOTIFICATION_OPCODE_MISMATCH",
    ],
    [
      "notification amount mismatch",
      notificationBody(jettonTransferNotificationOpcode, { amount: BigInt(4_999_999) }),
      assetWalletFriendly,
      "NOTIFICATION_FACTS_MISMATCH",
    ],
    [
      "correct master with wrong wallet",
      notificationBody(jettonTransferNotificationOpcode),
      wrongWalletFriendly,
      "WALLET_MISMATCH",
    ],
  ] as const;
  for (const [label, body, walletAddress, expectedCode] of notificationCases) {
    const result = scan([transfer()], [{
      traceId: "b2".repeat(32),
      walletAddress,
      destinationAddress: ownerFriendly,
      transactionAborted: false,
      body,
    }]);
    assert.equal(result.movements.length, 0, label);
    assert.equal(result.rejections[0]?.code, expectedCode, label);
  }

  const validNotification = notificationBody(jettonTransferNotificationOpcode);
  const accepted = scan([transfer()], [{
    traceId: "b2".repeat(32),
    walletAddress: assetWalletFriendly,
    destinationAddress: ownerFriendly,
    transactionAborted: false,
    body: validNotification,
  }]);
  assert.equal(accepted.rejections.length, 0);
  assert.equal(accepted.movements.length, 1);
  assert.deepEqual((accepted.movements[0]?.rawPayload as any).notification, {
    body: validNotification,
    opcode: "0x7362d09c",
    queryId: "42",
    amount: "5000000",
    sender: senderRaw,
  });
});

test("adapter journals fake-master and wrong-wallet transfers only as rejected recovery candidates", async () => {
  const observed: any[] = [];
  const rejected: any[] = [];
  const adapter = createInternalTestnetJettonAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-rejected",
          network: "testnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {
        upsert: async ({ create }: any) => ({
          id: "asset-account-rejected",
          createdAt: notAfter,
          updatedAt: notAfter,
          ...create,
        }),
      },
    } as any,
    ledger: {
      recordObserved: async (movement) => observed.push(movement),
      recordRejected: async (input) => rejected.push(input),
    },
    config: { enabled: true, network: "testnet", masterAddress: masterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jetton/masters")) {
        return new Response(JSON.stringify({
          jetton_masters: [{
            address: masterFriendly,
            jetton_content: {
              decimals: "6",
              symbol: "USDT",
              name: "Metadata is not identity",
              image: "https://example.invalid/fake.png",
            },
          }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/jetton/wallets")) {
        if (url.searchParams.get("jetton_address") === fakeMasterRaw) {
          return new Response(JSON.stringify({
            jetton_wallets: [{
              address: fakeWalletFriendly,
              owner: ownerFriendly,
              jetton: fakeMasterFriendly,
            }],
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          jetton_wallets: [{
            address: assetWalletFriendly,
            owner: ownerFriendly,
            jetton: masterFriendly,
          }],
        }), { status: 200 });
      }
      if (url.searchParams.has("jetton_wallet")) {
        return new Response(JSON.stringify({ jetton_transfers: [] }), { status: 200 });
      }
      if (url.pathname.endsWith("/transactions")) {
        return new Response(JSON.stringify({
          transactions: [
            notificationTransaction({
              traceId: "b2".repeat(32),
              walletAddress: fakeWalletFriendly,
              body: notificationBody(jettonTransferNotificationOpcode),
            }),
            notificationTransaction({
              traceId: "c5".repeat(32),
              walletAddress: wrongWalletFriendly,
              body: notificationBody(jettonTransferNotificationOpcode, { queryId: BigInt(43) }),
            }),
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        jetton_transfers: [
          transfer({ jetton_master: fakeMasterFriendly }),
          transfer({
            transaction_hash: "c4".repeat(32),
            query_id: "43",
            trace_id: "c5".repeat(32),
          }),
        ],
      }), { status: 200 });
    }) as typeof fetch,
    now: () => notAfter,
  });

  const result = await adapter.observeDeposit({
    depositAddressId: "deposit-rejected",
    notBefore,
    notAfter,
  });

  assert.equal(result.movementsObserved, 0);
  assert.equal(result.transfersScanned, 0);
  assert.equal(result.discoveryTransfersScanned, 2);
  assert.equal(result.rejectionsRecorded, 2);
  assert.deepEqual(result.rejections.map(({ code }) => code), ["MASTER_MISMATCH", "WALLET_MISMATCH"]);
  assert.equal(observed.length, 0);
  assert.equal(rejected.length, 2);
  assert.equal(rejected[0]?.movement.jettonMasterAddress, fakeMasterRaw);
  assert.equal(rejected[0]?.movement.jettonWalletAddress, fakeWalletRaw);
  assert.equal(rejected[0]?.movement.rawPayload.untrustedJettonCandidate, true);
  assert.equal(rejected[0]?.validationCode, "JETTON_MASTER_NOT_ALLOWLISTED");
  assert.equal(rejected[0]?.reason, "UNSUPPORTED_JETTON_MASTER");
  assert.equal(rejected[1]?.movement.jettonMasterAddress, masterRaw);
  assert.equal(rejected[1]?.movement.jettonWalletAddress, wrongWalletRaw);
  assert.equal(rejected[1]?.validationCode, "JETTON_WALLET_NOT_VERIFIED");
});

test("adapter never overwrites a stored verified account with a different jetton wallet", async () => {
  let transferFetches = 0;
  let ledgerWrites = 0;
  const adapter = createInternalTestnetJettonAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-account-conflict",
          network: "testnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {
        upsert: async () => ({
          id: "stored-account",
          depositAddressId: "deposit-account-conflict",
          network: "testnet",
          asset: "USDT",
          assetKind: "JETTON",
          assetDecimals: 6,
          jettonMasterAddress: masterRaw,
          assetWalletAddress: wrongWalletRaw,
          status: "VERIFIED",
          verifiedAt: notBefore,
          verificationError: null,
          createdAt: notBefore,
          updatedAt: notBefore,
        }),
      },
    } as any,
    ledger: {
      recordObserved: async () => {
        ledgerWrites += 1;
      },
      recordRejected: async () => {
        ledgerWrites += 1;
      },
    },
    config: { enabled: true, network: "testnet", masterAddress: masterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/jetton/masters")) {
        return new Response(JSON.stringify({
          jetton_masters: [{ address: masterFriendly, jetton_content: { decimals: "6" } }],
        }), { status: 200 });
      }
      if (url.pathname.endsWith("/jetton/wallets")) {
        return new Response(JSON.stringify({
          jetton_wallets: [{
            address: assetWalletFriendly,
            owner: ownerFriendly,
            jetton: masterFriendly,
          }],
        }), { status: 200 });
      }
      transferFetches += 1;
      return new Response(JSON.stringify({ jetton_transfers: [transfer()] }), { status: 200 });
    }) as typeof fetch,
    now: () => notAfter,
  });

  await assert.rejects(
    adapter.observeDeposit({ depositAddressId: "deposit-account-conflict", notBefore, notAfter }),
    /conflicts with verified provider evidence/,
  );
  assert.equal(transferFetches, 0);
  assert.equal(ledgerWrites, 0);
});

test("internal adapter rejects a non-6-decimal test master before account or ledger writes", async () => {
  let accountWrites = 0;
  let ledgerWrites = 0;
  let fetches = 0;
  const adapter = createInternalTestnetJettonAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-decimals",
          network: "testnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {
        upsert: async () => {
          accountWrites += 1;
          throw new Error("unexpected account write");
        },
      },
    } as any,
    ledger: {
      recordObserved: async () => {
        ledgerWrites += 1;
      },
      recordRejected: async () => {
        ledgerWrites += 1;
      },
    },
    config: { enabled: true, network: "testnet", masterAddress: masterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: async () => {
      fetches += 1;
      return new Response(JSON.stringify({
        jetton_masters: [{
          address: masterFriendly,
          jetton_content: { decimals: "9", symbol: "TEST" },
        }],
      }), { status: 200 });
    },
  });

  await assert.rejects(
    adapter.observeDeposit({ depositAddressId: "deposit-decimals", notBefore, notAfter }),
    /exactly 6 decimals/,
  );
  assert.equal(fetches, 1);
  assert.equal(accountWrites, 0);
  assert.equal(ledgerWrites, 0);
});

test("internal adapter rejects a reversed scan window before database or provider I/O", async () => {
  let databaseReads = 0;
  let fetches = 0;
  const adapter = createInternalTestnetJettonAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => {
          databaseReads += 1;
          return null;
        },
      },
      tonhubDepositAssetAccount: {},
    } as any,
    ledger: {
      recordObserved: async () => undefined,
      recordRejected: async () => undefined,
    },
    config: { enabled: true, network: "testnet", masterAddress: masterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    adapter.observeDeposit({ depositAddressId: "deposit-window", notBefore: notAfter, notAfter: notBefore }),
    /scan window is invalid/,
  );
  assert.equal(databaseReads, 0);
  assert.equal(fetches, 0);
});

test("internal adapter rejects a mainnet deposit before any provider request", async () => {
  let fetches = 0;
  const adapter = createInternalTestnetJettonAdapter({
    db: {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "mainnet-deposit",
          network: "mainnet",
          address: ownerFriendly,
          addressRaw: ownerRaw,
        }),
      },
      tonhubDepositAssetAccount: {},
    } as any,
    ledger: {
      recordObserved: async () => undefined,
      recordRejected: async () => undefined,
    },
    config: { enabled: true, network: "testnet", masterAddress: masterRaw, decimals: 6 },
    resolveReadConfig: () => ({
      network: "testnet",
      baseUrl: "https://testnet.toncenter.com/api/v3",
      address: "",
      addressEnvName: "",
    }),
    fetchImpl: async () => {
      fetches += 1;
      return new Response("{}", { status: 200 });
    },
  });

  await assert.rejects(
    adapter.observeDeposit({ depositAddressId: "mainnet-deposit", notBefore, notAfter }),
    /testnet deposit/,
  );
  assert.equal(fetches, 0);
});
