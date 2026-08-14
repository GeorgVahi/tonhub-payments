import assert from "node:assert/strict";
import test from "node:test";
import {
  adminLoginRateKey,
  adminSessionCookie,
  createAdminPasswordHash,
  createAdminSessionToken,
  hasSameOrigin,
  isSecureAdminRequest,
  resolveAdminSecurityConfig,
  verifyAdminPassword,
  verifyAdminSessionToken,
  resolveOptionalAdminSecurityConfig,
} from "../backend/src/admin/security";
import { createAdminRoutes } from "../backend/src/admin/routes";
import { renderAdminSection } from "../frontend/src/AdminConsole";
import {
  createPrismaAdminRepository,
  type AdminRepository,
} from "../backend/src/admin/repository";
import { resumableFailedUsdtSweepStatus } from "../shared/mainnet-usdt-sweep-state";
import { resumableFailedNativeGramSweepStatus } from "../shared/native-gram-sweep-state";

async function adminConfig() {
  return {
    username: "merchant",
    passwordHash: await createAdminPasswordHash("correct horse battery staple", Buffer.alloc(16, 8)),
    sessionSecret: "s".repeat(32),
    trustedProxyAddresses: [],
  };
}

function fakeRepository(overrides: Partial<AdminRepository> = {}): AdminRepository {
  return {
    overview: async () => ({
      counts: { orders: 1, openRecovery: 0, failedSweeps: 0, pendingWebhooks: 0 },
      recovery: [],
      sweeps: [],
    }),
    page: async (section, page) => ({ section, page, total: 0, records: [] }),
    audit: async () => undefined,
    consumeLoginAttempt: async () => ({ allowed: true, retryAt: null }),
    finishLoginAttempt: async () => undefined,
    attachMovement: async () => ({ outcome: "credited" }),
    markRecoveryReviewed: async () => undefined,
    queueSweep: async () => ({ jobId: "sweep-1", status: "QUEUED" }),
    retrySweep: async () => undefined,
    registerRefund: async () => ({ refundId: "refund-1" }),
    retryWebhook: async () => undefined,
    ...overrides,
  };
}

test("admin credentials use bounded scrypt and never accept a different password", async () => {
  const hash = await createAdminPasswordHash("correct horse battery staple", Buffer.alloc(16, 7));
  assert.match(hash, /^scrypt\$32768\$8\$3\$/);
  assert.equal(await verifyAdminPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyAdminPassword("incorrect", hash), false);
  assert.throws(() => resolveAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
    TONHUB_ADMIN_PASSWORD_HASH: "plain-text-password",
    TONHUB_ADMIN_SESSION_SECRET: "s".repeat(32),
  }), /scrypt format/i);
  assert.throws(() => resolveAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
    TONHUB_ADMIN_PASSWORD_HASH: hash.replace("scrypt$32768$", "scrypt$32768garbage$"),
    TONHUB_ADMIN_SESSION_SECRET: "s".repeat(32),
  }), /unsupported scrypt parameters/i);
});

test("admin sessions are signed, fixed-expiry, secure-cookie credentials", async () => {
  const secret = "s".repeat(32);
  const now = new Date("2026-08-13T10:00:00.000Z");
  const token = createAdminSessionToken({ username: "merchant", sessionSecret: secret, now });
  const session = verifyAdminSessionToken({
    token,
    username: "merchant",
    sessionSecret: secret,
    now: new Date("2026-08-13T17:59:59.000Z"),
  });
  assert.equal(session?.username, "merchant");
  assert.equal(verifyAdminSessionToken({
    token,
    username: "merchant",
    sessionSecret: secret,
    now: new Date("2026-08-13T18:00:00.000Z"),
  }), null);
  assert.equal(verifyAdminSessionToken({
    token: `${token.slice(0, -1)}x`,
    username: "merchant",
    sessionSecret: secret,
    now,
  }), null);
  assert.match(adminSessionCookie(token), /Path=\/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict/);
});

test("admin transport and origin checks fail closed", () => {
  assert.equal(isSecureAdminRequest(new Request("https://merchant.example/admin")), true);
  assert.equal(isSecureAdminRequest(new Request("http://merchant.example/admin", {
    headers: { "x-forwarded-proto": "https" },
  })), false);
  assert.equal(hasSameOrigin(new Request("https://merchant.example/admin/login", {
    method: "POST",
    headers: { origin: "https://merchant.example" },
  })), true);
  assert.equal(hasSameOrigin(new Request("https://merchant.example/admin/login", {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  })), false);

});

test("admin config is all-or-nothing and rejects signing keys in the API runtime", async () => {
  const hash = await createAdminPasswordHash("password", Buffer.alloc(16, 9));
  assert.equal(resolveOptionalAdminSecurityConfig({}), null);
  assert.throws(() => resolveOptionalAdminSecurityConfig({
    TON_MAINNET_DEPOSIT_SECRET_KEY: "do-not-load-this",
  }), /signing keys must be absent/i);
  assert.throws(() => resolveOptionalAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
  }), /password_hash is required/i);
  assert.throws(() => resolveOptionalAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
    TONHUB_ADMIN_PASSWORD_HASH: hash,
    TONHUB_ADMIN_SESSION_SECRET: "s".repeat(32),
    TON_MAINNET_DEPOSIT_SECRET_KEY: "do-not-load-this",
  }), /signing keys must be absent/i);
  const proxyConfig = resolveAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
    TONHUB_ADMIN_PASSWORD_HASH: hash,
    TONHUB_ADMIN_SESSION_SECRET: "s".repeat(32),
    TONHUB_ADMIN_TRUSTED_PROXY_IPS: "2001:0db8:0:0:0:0:0:1",
  });
  assert.deepEqual(proxyConfig.trustedProxyAddresses, ["2001:db8::1"]);
  assert.throws(() => resolveAdminSecurityConfig({
    TONHUB_ADMIN_USERNAME: "merchant",
    TONHUB_ADMIN_PASSWORD_HASH: hash,
    TONHUB_ADMIN_SESSION_SECRET: "s".repeat(32),
    TONHUB_ADMIN_TRUSTED_PROXY_IPS: "proxy.internal",
  }), /only comma-separated IP/i);
});

test("admin login rate keys collapse IPv6 clients to a stable /64 prefix", () => {
  const input = { username: "merchant", secret: "s".repeat(32) };
  assert.equal(
    adminLoginRateKey({ ...input, remoteAddress: "2001:db8:1234:5678::1" }),
    adminLoginRateKey({ ...input, remoteAddress: "2001:0db8:1234:5678:ffff::2" }),
  );
  assert.notEqual(
    adminLoginRateKey({ ...input, remoteAddress: "2001:db8:1234:5678::1" }),
    adminLoginRateKey({ ...input, remoteAddress: "2001:db8:1234:5679::1" }),
  );
  assert.equal(
    adminLoginRateKey({ ...input, remoteAddress: "192.0.2.1" }),
    adminLoginRateKey({ ...input, remoteAddress: "::ffff:192.0.2.1" }),
  );
  assert.notEqual(
    adminLoginRateKey({ ...input, remoteAddress: "::ffff:192.0.2.1" }),
    adminLoginRateKey({ ...input, remoteAddress: "::ffff:192.0.2.2" }),
  );
});

test("admin routes require HTTPS, same-origin login, a secure session, and CSRF", async () => {
  const config = await adminConfig();
  let reviewed = 0;
  const repository = fakeRepository({
    markRecoveryReviewed: async ({ recoveryId }) => {
      assert.equal(recoveryId, "recovery-1");
      reviewed += 1;
    },
  });
  const app = createAdminRoutes({ config, repository });

  assert.equal((await app.request("http://merchant.example/admin/login")).status, 426);
  assert.equal((await app.request("https://merchant.example/admin/login")).status, 200);
  assert.equal((await app.request("https://merchant.example/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: "merchant", password: "correct horse battery staple" }),
  })).status, 403);

  const login = await app.request("https://merchant.example/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "https://merchant.example",
    },
    body: new URLSearchParams({ username: "merchant", password: "correct horse battery staple" }),
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict/);
  const cookiePair = cookie.split(";", 1)[0];

  const dashboard = await app.request("https://merchant.example/admin", {
    headers: { cookie: cookiePair },
  });
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  assert.equal(dashboard.headers.get("cache-control"), "no-store, max-age=0");
  const dashboardHtml = await dashboard.text();
  const csrfToken = dashboardHtml.match(/name="csrfToken" value="([^"]+)"/)?.[1];
  assert.ok(csrfToken);

  assert.equal((await app.request("https://merchant.example/admin/actions/recovery/review", {
    method: "POST",
    headers: {
      cookie: cookiePair,
      origin: "https://merchant.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrfToken: "wrong", recoveryId: "recovery-1" }),
  })).status, 403);
  assert.equal(reviewed, 0);

  const action = await app.request("https://merchant.example/admin/actions/recovery/review", {
    method: "POST",
    headers: {
      cookie: cookiePair,
      origin: "https://merchant.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ csrfToken, recoveryId: "recovery-1" }),
  });
  assert.equal(action.status, 303);
  assert.equal(reviewed, 1);
});

test("admin login returns 429 before password work when the durable limiter blocks", async () => {
  const config = await adminConfig();
  let finished = 0;
  const app = createAdminRoutes({
    config,
    repository: fakeRepository({
      consumeLoginAttempt: async () => ({
        allowed: false,
        retryAt: new Date(Date.now() + 60_000),
      }),
      finishLoginAttempt: async () => {
        finished += 1;
      },
    }),
  });
  const response = await app.request("https://merchant.example/admin/login", {
    method: "POST",
    headers: {
      origin: "https://merchant.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ username: "merchant", password: "irrelevant" }),
  });
  assert.equal(response.status, 429);
  assert.match(response.headers.get("retry-after") ?? "", /^\d+$/);
  assert.equal(finished, 0);
});

test("admin login keys the durable limiter by Bun peer IP and only trusts allowlisted proxies", async () => {
  const config = { ...(await adminConfig()), trustedProxyAddresses: ["10.0.0.8"] };
  const rateKeys: string[] = [];
  const app = createAdminRoutes({
    config,
    repository: fakeRepository({
      consumeLoginAttempt: async ({ rateKey }) => {
        rateKeys.push(rateKey);
        return { allowed: false, retryAt: new Date(Date.now() + 1_000) };
      },
    }),
  });
  const login = (peer: string, forwarded: string) => app.fetch(new Request("https://merchant.example/admin/login", {
    method: "POST",
    headers: {
      origin: "https://merchant.example",
      "content-type": "application/x-www-form-urlencoded",
      "x-forwarded-for": forwarded,
    },
    body: new URLSearchParams({ username: "merchant", password: "irrelevant" }),
  }), { server: { requestIP: () => ({ address: peer }) } });
  assert.equal((await login("10.0.0.7", "203.0.113.10")).status, 429);
  assert.equal((await login("10.0.0.7", "203.0.113.11")).status, 429);
  assert.equal(rateKeys[0], rateKeys[1]);
  assert.equal((await login("10.0.0.8", "203.0.113.10")).status, 429);
  assert.equal((await login("10.0.0.8", "203.0.113.11")).status, 429);
  assert.notEqual(rateKeys[2], rateKeys[3]);
});

test("admin rejects an oversized chunked login form before parsing or repository work", async () => {
  const config = await adminConfig();
  let consumed = 0;
  const app = createAdminRoutes({
    config,
    repository: fakeRepository({
      consumeLoginAttempt: async () => {
        consumed += 1;
        return { allowed: true, retryAt: null };
      },
    }),
  });
  const response = await app.request("https://merchant.example/admin/login", {
    method: "POST",
    headers: {
      origin: "https://merchant.example",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `username=merchant&password=${"x".repeat(20_000)}`,
  });
  assert.equal(response.status, 413);
  assert.equal(consumed, 0);
});

test("admin movement view exposes immutable chain and fiat-rate evidence without raw payload", () => {
  const html = renderAdminSection({
    username: "merchant",
    csrfToken: "csrf",
    page: {
      section: "movements",
      page: 1,
      total: 1,
      records: [{
        id: "movement-1",
        direction: "INCOMING",
        network: "mainnet",
        asset: "USDT",
        amountAtomic: "5000000",
        fromAddress: "0:sender",
        toAddress: "0:deposit",
        jettonMasterAddress: "0:master",
        jettonWalletAddress: "0:wallet",
        transactionHash: "ab".repeat(32),
        transactionLt: "123456",
        blockchainAt: "2026-08-13T10:00:00.000Z",
        status: "CREDITED",
        fiatCreditMicros: "5000000",
        rate: { price: "1", quoteCurrency: "USD", source: "usd-peg" },
        allocations: [{
          id: "allocation-1",
          kind: "CREDIT",
          orderId: "order-1",
          fiatCreditMicros: "5000000",
        }],
      }],
    },
  });
  for (const evidence of ["0:sender", "0:deposit", "0:master", "123456", "usd-peg", "5000000"]) {
    assert.match(html, new RegExp(evidence));
  }
  assert.doesNotMatch(html, /rawPayload/);
});

test("admin sweep view exposes retry provenance and independently paginates native sweeps", () => {
  const html = renderAdminSection({
    username: "merchant",
    csrfToken: "csrf",
    page: {
      section: "sweeps",
      page: 1,
      total: 1,
      secondaryPage: 2,
      secondaryTotal: 51,
      records: [{
        id: "sweep-1",
        asset: "USDT",
        status: "FAILED",
        seqno: 17,
        queryId: "1800000000000000017",
        sentAt: "2026-08-13T10:00:00.000Z",
        attempts: 4,
      }],
      secondaryRecords: [{
        id: "deposit-51",
        address: "0:deposit",
        sweepStatus: "FAILED",
        sweepSeqno: 23,
        sweepSentAt: "2026-08-13T10:01:00.000Z",
      }],
    },
  });
  for (const evidence of ["1800000000000000017", "2026-08-13T10:00:00.000Z", "Seqno", "Native sweeps: page 2 of 2", "23"]) {
    assert.match(html, new RegExp(evidence));
  }
});

test("admin repository paginates native sweep history independently from jetton jobs", async () => {
  const calls: any[] = [];
  const repository = createPrismaAdminRepository({
    tonhubAssetSweep: {
      count: async () => 3,
      findMany: async (input: any) => {
        calls.push(["asset", input.skip, input.take]);
        return [];
      },
    },
    tonhubDepositAddress: {
      count: async () => 72,
      findMany: async (input: any) => {
        calls.push(["native", input.skip, input.take]);
        return [];
      },
    },
  } as any);
  const page = await repository.page("sweeps", 1, 2);
  assert.deepEqual(calls, [["asset", 0, 50], ["native", 50, 50]]);
  assert.equal(page.total, 3);
  assert.equal(page.secondaryTotal, 72);
  assert.equal(page.secondaryPage, 2);
});

test("admin native initiate cannot reopen failed, sweeping, or sent deposits", async () => {
  for (const sweepStatus of ["FAILED", "SWEEPING", "SENT"]) {
    let storedStatus = sweepStatus;
    let audits = 0;
    const tx: any = {
      tonhubDepositAddress: {
        findUnique: async () => ({
          id: "deposit-1",
          invoiceId: "invoice-1",
          status: "PAID",
          sweepStatus: storedStatus,
          invoice: { id: "invoice-1", orderId: "order-1" },
          assetAccounts: [],
        }),
        updateMany: async ({ where, data }: any) => {
          if (where.sweepStatus !== storedStatus) return { count: 0 };
          storedStatus = data.sweepStatus;
          return { count: 1 };
        },
      },
      tonhubAdminAuditEvent: { create: async () => { audits += 1; } },
    };
    const repository = createPrismaAdminRepository({
      $transaction: async (handler: (scope: any) => Promise<unknown>) => handler(tx),
    } as any);
    await assert.rejects(repository.queueSweep({
      adminUsername: "merchant",
      depositAddressId: "deposit-1",
      asset: "GRAM",
      requestId: "request-1",
    }), /already initiated/i);
    assert.equal(storedStatus, sweepStatus);
    assert.equal(audits, 0);
  }
});

test("failed USDT sweep retries resume from immutable persisted chain plans", () => {
  assert.equal(resumableFailedUsdtSweepStatus({}), "QUEUED");
  assert.equal(resumableFailedUsdtSweepStatus({ gasTopupAmountNano: "1", gasTopupSeqno: 0 }), "GAS_CHECK");
  assert.equal(resumableFailedUsdtSweepStatus({
    gasTopupAmountNano: "1",
    gasTopupSeqno: 0,
    gasServicePlanKey: "0:gas:0",
  }), "GAS_TOPUP_REQUIRED");
  assert.equal(resumableFailedUsdtSweepStatus({
    amountAtomic: "5000000",
    reserveAtomic: "0",
    recipientAddress: "0:treasury",
    seqno: 7,
    queryId: "9",
  }), "READY");
  assert.equal(resumableFailedUsdtSweepStatus({
    amountAtomic: "5000000",
    reserveAtomic: "0",
    recipientAddress: "0:treasury",
    seqno: 7,
    queryId: "9",
    sentAt: new Date("2026-08-13T10:00:00.000Z"),
  }), "SENT");
  assert.throws(() => resumableFailedUsdtSweepStatus({
    amountAtomic: "5000000",
    seqno: 7,
  }), /incomplete persisted transfer plan/i);
  assert.throws(() => resumableFailedUsdtSweepStatus({
    sentAt: new Date("2026-08-13T10:00:00.000Z"),
  }), /incomplete persisted transfer plan/i);
  assert.throws(() => resumableFailedUsdtSweepStatus({
    transactionHash: "ab".repeat(32),
    confirmedAt: new Date("2026-08-13T10:01:00.000Z"),
  }), /contradictory confirmation evidence/i);
  assert.throws(() => resumableFailedUsdtSweepStatus({
    gasTopupAmountNano: "1",
  }), /incomplete persisted gas top-up plan/i);
});

test("failed automatic GRAM sweep retries preserve or reject its durable transfer plan", () => {
  assert.equal(resumableFailedNativeGramSweepStatus({}), "READY");
  assert.equal(resumableFailedNativeGramSweepStatus({
    amountAtomic: "950000000",
    reserveAtomic: "50000000",
    recipientAddress: "0:treasury",
    seqno: 7,
  }), "READY");
  assert.equal(resumableFailedNativeGramSweepStatus({
    amountAtomic: "950000000",
    reserveAtomic: "50000000",
    recipientAddress: "0:treasury",
    seqno: 7,
    sentAt: new Date("2026-08-13T10:00:00.000Z"),
  }), "SENT");
  assert.throws(() => resumableFailedNativeGramSweepStatus({
    amountAtomic: "950000000",
    seqno: 7,
  }), /incomplete persisted transfer plan/i);
  assert.throws(() => resumableFailedNativeGramSweepStatus({
    sentAt: new Date("2026-08-13T10:00:00.000Z"),
  }), /incomplete persisted transfer plan/i);
  assert.throws(() => resumableFailedNativeGramSweepStatus({
    transactionHash: "ab".repeat(32),
  }), /contradictory confirmation evidence/i);
});

test("admin webhook view keeps failed delivery retry and full attempt pagination visible", () => {
  const html = renderAdminSection({
    username: "merchant",
    csrfToken: "csrf",
    page: {
      section: "webhooks",
      page: 1,
      total: 1,
      secondaryPage: 2,
      secondaryTotal: 51,
      records: [{
        id: "event-row-1",
        eventId: "invoice.paid:invoice-1:3",
        topic: "invoice.paid",
        aggregateType: "TonhubPaymentInvoice",
        aggregateId: "invoice-1",
        status: "FAILED",
        attempts: 2,
        deliveryAttempts: [],
      }],
      secondaryRecords: [{
        id: "attempt-51",
        eventId: "invoice.paid:invoice-1:3",
        topic: "invoice.paid",
        attemptNumber: 51,
        status: "FAILED",
        httpStatus: 503,
        durationMs: 25,
        error: "HTTP 503",
      }],
    },
  });
  assert.match(html, /Retry delivery/);
  assert.match(html, /name="csrfToken" value="csrf"/);
  assert.match(html, /Delivery attempts: page 2 of 2/);
  assert.match(html, /HTTP 503/);
});
