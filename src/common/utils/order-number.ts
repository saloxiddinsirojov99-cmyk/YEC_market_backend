export function formatOrderNumber(
  id: string,
  createdAt?: Date | string | null,
): string {
  const safeId = String(id ?? '');
  let timestamp = '';

  if (createdAt) {
    const parsed = createdAt instanceof Date ? createdAt : new Date(createdAt);
    if (!Number.isNaN(parsed.getTime())) {
      timestamp = parsed.toISOString();
    }
  }

  const seed = `${safeId}|${timestamp}`;
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  const normalized = (hash >>> 0) % 1000000;
  return normalized.toString().padStart(6, '0');
}
