import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function unquote(value: string) {
  const trimmed = value.trim();
  const quote = trimmed[0];

  if ((quote === `"` || quote === `'`) && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

function parseEnv(content: string) {
  const values: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separatorIndex = normalized.indexOf("=");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      values[key] = unquote(normalized.slice(separatorIndex + 1));
    }
  }

  return values;
}

export function loadLocalEnv(root = process.cwd()) {
  const mode = process.env.NODE_ENV || "development";
  const files = [".env", `.env.${mode}`, ".env.local", `.env.${mode}.local`];
  const values: Record<string, string> = {};

  for (const file of files) {
    const path = join(root, file);

    if (existsSync(path)) {
      Object.assign(values, parseEnv(readFileSync(path, "utf8")));
    }
  }

  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

