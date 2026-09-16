import { createHmac } from 'crypto';

/**
 * Generate a Telegram bot join token for a user.
 * The token encodes the userId and a timestamp, signed with HMAC-SHA256.
 * Format: base64url(userId:timestamp:signature)
 *
 * Token expires after 30 minutes by default.
 */
export function generateTelegramUserJoinToken(
  userId: string,
  secret: string,
  ttlMs = 30 * 60 * 1000,
): string {
  const timestamp = Date.now().toString();
  const payload = `${userId}:${timestamp}`;
  const signature = createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .slice(0, 16);
  const token = Buffer.from(`${payload}:${signature}`).toString('base64url');
  return token;
}

/**
 * Verify a Telegram bot join token.
 * Returns the userId if valid and not expired, or null otherwise.
 */
export function verifyTelegramUserJoinToken(
  token: string,
  secret: string,
  ttlMs = 30 * 60 * 1000,
): string | null {
  try {
    const decoded = Buffer.from(token, 'base64url').toString('utf-8');
    const parts = decoded.split(':');
    if (parts.length < 3) return null;

    const signature = parts.pop()!;
    const timestamp = parts.pop()!;
    const userId = parts.join(':'); // userId may contain colons (unlikely but safe)

    // Verify signature
    const expectedPayload = `${userId}:${timestamp}`;
    const expectedSignature = createHmac('sha256', secret)
      .update(expectedPayload)
      .digest('hex')
      .slice(0, 16);

    if (signature !== expectedSignature) return null;

    // Check expiry
    const tokenTime = parseInt(timestamp, 10);
    if (isNaN(tokenTime)) return null;
    if (Date.now() - tokenTime > ttlMs) return null;

    return userId;
  } catch {
    return null;
  }
}
