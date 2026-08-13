import { Hono } from "hono";
import type { Context } from "hono";
import { isIP } from "node:net";
import {
  canonicalAdminPeerAddress,
  adminLoginRateKey,
  adminSessionCookie,
  adminSessionCookieName,
  clearAdminSessionCookie,
  createAdminSessionToken,
  hasSameOrigin,
  isSecureAdminRequest,
  parseCookie,
  resolveAdminSecurityConfig,
  safeAdminTextEqual,
  verifyAdminPassword,
  verifyAdminSessionToken,
  type AdminSecurityConfig,
  type AdminSession,
} from "./security";
import {
  adminPageSize,
  prismaAdminRepository,
  type AdminRepository,
  type AdminSection,
} from "./repository";
import {
  renderAdminError,
  renderAdminLogin,
  renderAdminOverview,
  renderAdminSection,
} from "../../../frontend/src/AdminConsole";
import { adminStyles } from "../../../frontend/src/admin-styles";
import { parsePaymentAsset } from "../../../shared/payment-assets";

const sectionNames = new Set<AdminSection>([
  "orders",
  "movements",
  "recovery",
  "sweeps",
  "webhooks",
  "audit",
]);

const notices: Record<string, string> = {
  attached: "Movement was validated and attached through the accounting ledger.",
  reviewed: "Recovery case was marked reviewed.",
  sweepQueued: "Sweep job was queued. A separate signing worker will process it.",
  sweepRetried: "Failed sweep was reset to the worker queue.",
  refundRegistered: "Executed refund evidence was registered in the immutable audit log.",
  webhookRetried: "Failed webhook delivery was returned to the outbox queue.",
};

class AdminFormError extends Error {
  constructor(message: string, readonly status: 400 | 413 | 415) {
    super(message);
  }
}

function pageNumber(value: string | undefined) {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isSafeInteger(page) && page >= 1 && page <= 1_000_000 ? page : 1;
}

function bodyIsBounded(context: Context) {
  const contentLength = context.req.header("content-length");
  return !contentLength || (/^\d+$/.test(contentLength) && Number(contentLength) <= 16_384);
}

async function form(context: Context) {
  if (!bodyIsBounded(context)) {
    throw new AdminFormError("Admin form is too large.", 413);
  }
  if (context.req.header("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    throw new AdminFormError("Admin forms require application/x-www-form-urlencoded.", 415);
  }
  const reader = context.req.raw.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      size += next.value.byteLength;
      if (size > 16_384) {
        await reader.cancel();
        throw new AdminFormError("Admin form is too large.", 413);
      }
      chunks.push(next.value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let parsed: URLSearchParams;
  try {
    parsed = new URLSearchParams(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new AdminFormError("Admin form must contain valid UTF-8.", 400);
  }
  const output: Record<string, string> = {};
  let fields = 0;
  for (const [key, value] of parsed) {
    fields += 1;
    if (fields > 64 || key.length > 128 || Object.hasOwn(output, key)) {
      throw new AdminFormError("Admin form contains invalid or duplicate fields.", 400);
    }
    output[key] = value;
  }
  return output;
}

function remoteAddress(context: Context, config: AdminSecurityConfig) {
  try {
    const environment = context.env as unknown as {
      server?: { requestIP?: (request: Request) => { address?: string } | null };
      requestIP?: (request: Request) => { address?: string } | null;
    };
    const server = environment?.server ?? environment;
    const peerAddress = canonicalAdminPeerAddress(server.requestIP?.(context.req.raw)?.address);
    if (!peerAddress || !isIP(peerAddress)) {
      return "unknown";
    }
    if (!config.trustedProxyAddresses.includes(peerAddress)) {
      return peerAddress;
    }
    const forwarded = canonicalAdminPeerAddress(
      context.req.header("x-forwarded-for")?.split(",", 1)[0].trim(),
    );
    return forwarded ?? peerAddress;
  } catch {
    return "unknown";
  }
}

function sessionFor(context: Context, config: AdminSecurityConfig) {
  return verifyAdminSessionToken({
    token: parseCookie(context.req.header("cookie"), adminSessionCookieName),
    username: config.username,
    sessionSecret: config.sessionSecret,
  });
}

function html(context: Context, body: string, status = 200) {
  return context.html(body, status as 200);
}

function csrfMatches(submitted: string | undefined, session: AdminSession, config: AdminSecurityConfig) {
  return Boolean(submitted) && safeAdminTextEqual(submitted!, session.csrfToken, config.sessionSecret);
}

function redirectWithNotice(context: Context, path: string, code: keyof typeof notices) {
  return context.redirect(`${path}?notice=${encodeURIComponent(code)}`, 303);
}

function dateFromIso(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new Error("Blockchain time must be an explicit UTC ISO 8601 timestamp.");
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error("Blockchain time is invalid.");
  }
  return date;
}

function errorPage(context: Context, session: AdminSession, error: unknown) {
  console.error("[tonhub-admin] action failed", error instanceof Error ? error.message : error);
  return html(context, renderAdminError({
    username: session.username,
    csrfToken: session.csrfToken,
    message: error instanceof Error ? error.message : "The admin action could not be completed.",
  }), error instanceof AdminFormError ? error.status : 409);
}

export function createAdminRoutes(input: {
  config?: AdminSecurityConfig;
  repository?: AdminRepository;
} = {}) {
  const config = input.config ?? resolveAdminSecurityConfig();
  const repository = input.repository ?? prismaAdminRepository;
  const app = new Hono();

  app.use("/admin/*", async (context, next) => {
    if (!isSecureAdminRequest(context.req.raw)) {
      return context.text("Admin requires a direct HTTPS request.", 426);
    }
    await next();
    context.header("Cache-Control", "no-store, max-age=0");
    context.header("Content-Security-Policy", "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    context.header("Cross-Origin-Opener-Policy", "same-origin");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Strict-Transport-Security", "max-age=63072000");
    context.header("X-Content-Type-Options", "nosniff");
    context.header("X-Frame-Options", "DENY");
  });

  app.get("/admin/styles.css", (context) => {
    context.header("Content-Type", "text/css; charset=UTF-8");
    return context.body(adminStyles);
  });

  app.get("/admin/login", (context) => {
    if (sessionFor(context, config)) {
      return context.redirect("/admin", 303);
    }
    return html(context, renderAdminLogin({ error: null }));
  });

  app.post("/admin/login", async (context) => {
    if (!hasSameOrigin(context.req.raw)) {
      return context.text("Invalid login origin.", 403);
    }
    try {
      const values = await form(context);
      const username = values.username?.trim() ?? "";
      const password = values.password ?? "";
      const rateKey = adminLoginRateKey({
        username: config.username,
        remoteAddress: remoteAddress(context, config),
        secret: config.sessionSecret,
      });
      const rate = await repository.consumeLoginAttempt({
        rateKey,
        adminUsername: config.username,
        now: new Date(),
      });
      if (!rate.allowed) {
        if (rate.retryAt) {
          context.header("Retry-After", String(Math.max(1, Math.ceil((rate.retryAt.getTime() - Date.now()) / 1000))));
        }
        return html(context, renderAdminLogin({
          error: "Too many sign-in attempts. Wait before trying again.",
        }), 429);
      }
      const [usernameMatches, passwordMatches] = await Promise.all([
        Promise.resolve(safeAdminTextEqual(username, config.username, config.sessionSecret)),
        verifyAdminPassword(password, config.passwordHash),
      ]);
      const success = usernameMatches && passwordMatches;
      await repository.finishLoginAttempt({
        rateKey,
        adminUsername: config.username,
        success,
      });
      if (!success) {
        return html(context, renderAdminLogin({ error: "Invalid username or password." }), 401);
      }
      const token = createAdminSessionToken({
        username: config.username,
        sessionSecret: config.sessionSecret,
      });
      context.header("Set-Cookie", adminSessionCookie(token));
      return context.redirect("/admin", 303);
    } catch (error) {
      console.error("[tonhub-admin] login failed closed", error instanceof Error ? error.message : error);
      return html(
        context,
        renderAdminLogin({
          error: error instanceof AdminFormError
            ? error.message
            : "Sign-in is temporarily unavailable.",
        }),
        error instanceof AdminFormError ? error.status : 503,
      );
    }
  });

  app.use("/admin/*", async (context, next) => {
    if (context.req.path === "/admin/login" || context.req.path === "/admin/styles.css") {
      return next();
    }
    const session = sessionFor(context, config);
    if (!session) {
      if (context.req.method === "GET") {
        return context.redirect("/admin/login", 303);
      }
      return context.text("Admin session is missing or expired.", 401);
    }
    if (context.req.method !== "GET" && !hasSameOrigin(context.req.raw)) {
      return context.text("Invalid admin action origin.", 403);
    }
    await next();
  });

  app.post("/admin/logout", async (context) => {
    const session = sessionFor(context, config)!;
    const values: Record<string, string> = await form(context).catch(() => ({}));
    if (!csrfMatches(values.csrfToken, session, config)) {
      return context.text("Invalid CSRF token.", 403);
    }
    context.header("Set-Cookie", clearAdminSessionCookie());
    try {
      await repository.audit({
        adminUsername: session.username,
        action: "ADMIN_LOGOUT",
        targetType: "AdminSession",
        targetId: session.sessionId,
      });
    } catch (error) {
      console.error("[tonhub-admin] logout audit failed", error);
      return context.text("Session cleared, but the logout audit could not be persisted.", 503);
    }
    return context.redirect("/admin/login", 303);
  });

  app.get("/admin", async (context) => {
    const session = sessionFor(context, config)!;
    const overview = await repository.overview();
    return html(context, renderAdminOverview({
      username: session.username,
      csrfToken: session.csrfToken,
      overview,
      notice: notices[context.req.query("notice") ?? ""] ?? null,
    }));
  });

  app.get("/admin/:section", async (context) => {
    const section = context.req.param("section") as AdminSection;
    if (!sectionNames.has(section)) {
      return context.notFound();
    }
    const session = sessionFor(context, config)!;
    const page = await repository.page(
      section,
      pageNumber(context.req.query("page")),
      pageNumber(context.req.query("secondaryPage")),
    );
    return html(context, renderAdminSection({
      username: session.username,
      csrfToken: session.csrfToken,
      page,
      notice: notices[context.req.query("notice") ?? ""] ?? null,
    }));
  });

  async function mutation(
    context: Context,
    action: (values: Record<string, string>, session: AdminSession) => Promise<Response>,
  ) {
    const session = sessionFor(context, config)!;
    try {
      const values = await form(context);
      if (!csrfMatches(values.csrfToken, session, config)) {
        return context.text("Invalid CSRF token.", 403);
      }
      return await action(values, session);
    } catch (error) {
      return errorPage(context, session, error);
    }
  }

  app.post("/admin/actions/movements/attach", (context) => mutation(context, async (values, session) => {
    await repository.attachMovement({
      adminUsername: session.username,
      movementId: values.movementId,
      orderId: values.orderId,
      invoiceId: values.invoiceId,
    });
    return redirectWithNotice(context, "/admin/movements", "attached");
  }));

  app.post("/admin/actions/recovery/review", (context) => mutation(context, async (values, session) => {
    await repository.markRecoveryReviewed({
      adminUsername: session.username,
      recoveryId: values.recoveryId,
    });
    return redirectWithNotice(context, "/admin/recovery", "reviewed");
  }));

  app.post("/admin/actions/sweeps/queue", (context) => mutation(context, async (values, session) => {
    await repository.queueSweep({
      adminUsername: session.username,
      depositAddressId: values.depositAddressId,
      asset: values.asset,
      requestId: values.requestId,
    });
    return redirectWithNotice(context, "/admin/sweeps", "sweepQueued");
  }));

  app.post("/admin/actions/sweeps/retry", (context) => mutation(context, async (values, session) => {
    await repository.retrySweep({
      adminUsername: session.username,
      sweepId: values.sweepId,
    });
    return redirectWithNotice(context, "/admin/sweeps", "sweepRetried");
  }));

  app.post("/admin/actions/refunds/register", (context) => mutation(context, async (values, session) => {
    const asset = parsePaymentAsset(values.asset);
    await repository.registerRefund({
      adminUsername: session.username,
      orderId: values.orderId,
      invoiceId: values.invoiceId,
      network: values.network,
      asset: asset.symbol,
      assetKind: asset.kind,
      assetDecimals: asset.decimals,
      amountAtomic: values.amountAtomic,
      fromAddress: values.fromAddress,
      toAddress: values.toAddress,
      jettonMasterAddress: values.jettonMasterAddress,
      transactionHash: values.transactionHash,
      transactionLt: values.transactionLt,
      blockchainAt: dateFromIso(values.blockchainAt),
    });
    return redirectWithNotice(context, "/admin/audit", "refundRegistered");
  }));

  app.post("/admin/actions/webhooks/retry", (context) => mutation(context, async (values, session) => {
    await repository.retryWebhook({
      adminUsername: session.username,
      outboxEventId: values.outboxEventId,
    });
    return redirectWithNotice(context, "/admin/webhooks", "webhookRetried");
  }));

  return app;
}
