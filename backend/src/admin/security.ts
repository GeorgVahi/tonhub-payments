import {
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { isIP } from "node:net";
const passwordPrefix = "scrypt";
const passwordN = 32_768;
const passwordR = 8;
const passwordP = 3;
const passwordBytes = 64;
const saltBytes = 16;
const sessionVersion = "v1";

export const adminSessionCookieName = "__Host-tonhub_admin_session";
export const adminSessionTtlMs = 8 * 60 * 60 * 1000;
export const adminLoginWindowMs = 15 * 60 * 1000;
export const adminLoginMaxFailures = 5;
export const adminLoginThrottleRetentionMs = 24 * 60 * 60 * 1000;

export type AdminSecurityConfig = {
  username: string;
  passwordHash: string;
  sessionSecret: string;
  trustedProxyAddresses: string[];
};

export type AdminSession = {
  username: string;
  csrfToken: string;
  issuedAt: number;
  expiresAt: number;
  sessionId: string;
};

function canonicalIpAddress(value: string) {
  const version = isIP(value);
  if (version === 4) {
    return value.split(".").map((part) => String(Number(part))).join(".");
  }
  if (version === 6) {
    const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const groups = ipv6Groups(canonical);
    if (
      groups.slice(0, 5).every((part) => part === 0) &&
      groups[5] === 0xffff
    ) {
      return [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join(".");
    }
    return canonical;
  }
  return null;
}

function ipv6Groups(value: string) {
  const [left = "", right = ""] = value.split("::");
  const leftGroups = left ? left.split(":") : [];
  const rightGroups = right ? right.split(":") : [];
  const missing = 8 - leftGroups.length - rightGroups.length;
  return [...leftGroups, ...Array(Math.max(0, missing)).fill("0"), ...rightGroups]
    .map((part) => Number.parseInt(part || "0", 16));
}

export function canonicalAdminPeerAddress(value: string | undefined) {
  return value ? canonicalIpAddress(value) : null;
}

export function adminLoginRateAddress(value: string | undefined) {
  const canonical = value ? canonicalIpAddress(value) : null;
  if (!canonical) {
    return "unknown";
  }
  if (isIP(canonical) === 4) {
    return canonical;
  }
  return `${ipv6Groups(canonical).slice(0, 4).map((part) => part.toString(16)).join(":")}::/64`;
}

function requiredEnv(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${name} is required to enable admin routes.`);
  }
  return normalized;
}

function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Non-canonical base64url value.");
  }
  return decoded;
}

function parsePasswordHash(value: string) {
  const parts = value.split("$");
  if (parts.length !== 6 || parts[0] !== passwordPrefix) {
    throw new Error("TONHUB_ADMIN_PASSWORD_HASH must use the documented scrypt format.");
  }
  if (
    parts[1] !== String(passwordN) ||
    parts[2] !== String(passwordR) ||
    parts[3] !== String(passwordP)
  ) {
    throw new Error("TONHUB_ADMIN_PASSWORD_HASH has unsupported scrypt parameters.");
  }
  const [n, r, p] = parts.slice(1, 4).map(Number);
  const salt = decodeBase64Url(parts[4]);
  const digest = decodeBase64Url(parts[5]);
  if (
    n !== passwordN ||
    r !== passwordR ||
    p !== passwordP ||
    salt.length !== saltBytes ||
    digest.length !== passwordBytes
  ) {
    throw new Error("TONHUB_ADMIN_PASSWORD_HASH has unsupported scrypt parameters.");
  }
  return { n, r, p, salt, digest };
}

function derivePassword(password: string, salt: Buffer, length: number) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, length, {
      N: passwordN,
      r: passwordR,
      p: passwordP,
      maxmem: 64 * 1024 * 1024,
    }, (error, derivedKey) => {
      if (error) {
        reject(error);
      } else {
        resolve(derivedKey);
      }
    });
  });
}

export function resolveAdminSecurityConfig(
  env: Record<string, string | undefined> = process.env,
): AdminSecurityConfig {
  const username = requiredEnv(env.TONHUB_ADMIN_USERNAME, "TONHUB_ADMIN_USERNAME");
  if (username.length > 128) {
    throw new Error("TONHUB_ADMIN_USERNAME must be at most 128 characters.");
  }
  const passwordHash = requiredEnv(
    env.TONHUB_ADMIN_PASSWORD_HASH,
    "TONHUB_ADMIN_PASSWORD_HASH",
  );
  parsePasswordHash(passwordHash);
  const sessionSecret = requiredEnv(
    env.TONHUB_ADMIN_SESSION_SECRET,
    "TONHUB_ADMIN_SESSION_SECRET",
  );
  if (Buffer.byteLength(sessionSecret, "utf8") < 32) {
    throw new Error("TONHUB_ADMIN_SESSION_SECRET must contain at least 32 bytes.");
  }
  const trustedProxyAddresses = env.TONHUB_ADMIN_TRUSTED_PROXY_IPS
    ?.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => canonicalIpAddress(value)) ?? [];
  if (trustedProxyAddresses.some((value) => !value)) {
    throw new Error("TONHUB_ADMIN_TRUSTED_PROXY_IPS must contain only comma-separated IP addresses.");
  }
  return {
    username,
    passwordHash,
    sessionSecret,
    trustedProxyAddresses: [...new Set(trustedProxyAddresses as string[])],
  };
}

export function resolveOptionalAdminSecurityConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const forbiddenSigningKeys = [
    "TON_DEPOSIT_SECRET_KEY",
    "TON_TESTNET_DEPOSIT_SECRET_KEY",
    "TON_MAINNET_DEPOSIT_SECRET_KEY",
    "TON_MAINNET_GAS_SERVICE_SECRET_KEY",
  ].filter((name) => env[name]?.trim());
  if (forbiddenSigningKeys.length) {
    throw new Error(
      `Signing keys must be absent from the admin/API runtime: ${forbiddenSigningKeys.join(", ")}.`,
    );
  }
  const values = [
    env.TONHUB_ADMIN_USERNAME,
    env.TONHUB_ADMIN_PASSWORD_HASH,
    env.TONHUB_ADMIN_SESSION_SECRET,
  ];
  if (values.every((value) => !value?.trim())) {
    return null;
  }
  return resolveAdminSecurityConfig(env);
}

export async function createAdminPasswordHash(password: string, salt = randomBytes(saltBytes)) {
  if (!password || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("Admin password must contain between 1 and 1024 UTF-8 bytes.");
  }
  if (salt.length !== saltBytes) {
    throw new Error(`Admin password salt must contain ${saltBytes} bytes.`);
  }
  const digest = await derivePassword(password, salt, passwordBytes);
  return [
    passwordPrefix,
    passwordN,
    passwordR,
    passwordP,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export async function verifyAdminPassword(password: string, encodedHash: string) {
  const parsed = parsePasswordHash(encodedHash);
  const boundedPassword = Buffer.byteLength(password, "utf8") <= 1024 ? password : "";
  const digest = await derivePassword(boundedPassword, parsed.salt, parsed.digest.length);
  return timingSafeEqual(digest, parsed.digest) && boundedPassword === password;
}

function signature(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest();
}

function safeEqual(left: Buffer, right: Buffer) {
  return left.length === right.length && timingSafeEqual(left, right);
}

export function createAdminSessionToken(input: {
  username: string;
  sessionSecret: string;
  now?: Date;
}) {
  const issuedAt = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const payload = Buffer.from(JSON.stringify({
    username: input.username,
    csrfToken: randomBytes(32).toString("base64url"),
    issuedAt,
    expiresAt: issuedAt + Math.floor(adminSessionTtlMs / 1000),
    sessionId: randomBytes(24).toString("base64url"),
  }), "utf8").toString("base64url");
  const signedValue = `${sessionVersion}.${payload}`;
  return `${signedValue}.${signature(signedValue, input.sessionSecret).toString("base64url")}`;
}

export function verifyAdminSessionToken(input: {
  token: string | undefined;
  username: string;
  sessionSecret: string;
  now?: Date;
}): AdminSession | null {
  if (!input.token || input.token.length > 2048) {
    return null;
  }
  const parts = input.token.split(".");
  if (parts.length !== 3 || parts[0] !== sessionVersion) {
    return null;
  }
  try {
    const signedValue = `${parts[0]}.${parts[1]}`;
    if (!safeEqual(decodeBase64Url(parts[2]), signature(signedValue, input.sessionSecret))) {
      return null;
    }
    const parsed = JSON.parse(decodeBase64Url(parts[1]).toString("utf8")) as Partial<AdminSession>;
    const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (
      parsed.username !== input.username ||
      typeof parsed.csrfToken !== "string" ||
      decodeBase64Url(parsed.csrfToken).length !== 32 ||
      !Number.isSafeInteger(parsed.issuedAt) ||
      !Number.isSafeInteger(parsed.expiresAt) ||
      typeof parsed.sessionId !== "string" ||
      decodeBase64Url(parsed.sessionId).length !== 24 ||
      Number(parsed.issuedAt) > now ||
      Number(parsed.expiresAt) <= now ||
      Number(parsed.expiresAt) - Number(parsed.issuedAt) !== adminSessionTtlMs / 1000
    ) {
      return null;
    }
    return parsed as AdminSession;
  } catch {
    return null;
  }
}

export function parseCookie(cookieHeader: string | undefined, name: string) {
  for (const part of cookieHeader?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return undefined;
}

export function adminSessionCookie(token: string) {
  return `${adminSessionCookieName}=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.floor(adminSessionTtlMs / 1000)}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${adminSessionCookieName}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function isSecureAdminRequest(request: Request) {
  return new URL(request.url).protocol === "https:";
}

export function hasSameOrigin(request: Request) {
  const expected = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected;
  }
  const referer = request.headers.get("referer");
  if (!referer) {
    return false;
  }
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}

export function safeAdminTextEqual(left: string, right: string, secret: string) {
  return timingSafeEqual(signature(left, secret), signature(right, secret));
}

export function adminLoginRateKey(input: {
  username: string;
  remoteAddress?: string;
  userAgent?: string;
  secret: string;
}) {
  return createHmac("sha256", input.secret)
    .update(`${input.username}\n${adminLoginRateAddress(input.remoteAddress)}\n${input.userAgent ?? "unknown"}`)
    .digest("base64url");
}
