export function compareVersions(a: string, b: string) {
  const aParts = a.split(".");
  const bParts = b.split(".");
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = Number(aParts[i] ?? 0) - Number(bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
