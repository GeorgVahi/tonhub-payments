import assert from "node:assert/strict";
import test from "node:test";
import { Address } from "@ton/core";
import {
  createInternalTestnetJettonAdapter,
  resolveInternalTestnetJettonConfig,
} from "../backend/src/ton/internal-testnet-jetton";

const ownerRaw = `0:${"51".repeat(32)}`;
const masterRaw = `0:${"61".repeat(32)}`;
const assetWalletRaw = `0:${"71".repeat(32)}`;
const senderRaw = `0:${"81".repeat(32)}`;
const senderWalletRaw = `0:${"91".repeat(32)}`;
const ownerFriendly = Address.parse(ownerRaw).toString({ bounceable: true, testOnly: true });
const masterFriendly = Address.parse(masterRaw).toString({ bounceable: true, testOnly: true });
const assetWalletFriendly = Address.parse(assetWalletRaw).toString({ bounceable: true, testOnly: true });
const senderFriendly = Address.parse(senderRaw).toString({ bounceable: false, testOnly: true });
const senderWalletFriendly = Address.parse(senderWalletRaw).toString({ bounceable: true, testOnly: true });
const transactionHash = "a1".repeat(32);
const notBefore = new Date("2026-08-13T10:00:00.000Z");
const notAfter = new Date("2026-08-13T10:30:00.000Z");

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
    return new Response(JSON.stringify({
      jetton_transfers: [{
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
      }],
    }), { status: 200 });
  };
  const adapter = createInternalTestnetJettonAdapter({
    db: db as any,
    ledger: { recordObserved: async (movement) => observed.push(movement) },
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
    ledger: { recordObserved: async () => undefined },
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
    ledger: { recordObserved: async () => undefined },
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
