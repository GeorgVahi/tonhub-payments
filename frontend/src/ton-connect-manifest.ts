export function normalizeTonConnectManifestUrl(value: string | undefined) {
  if (!value?.trim()) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
