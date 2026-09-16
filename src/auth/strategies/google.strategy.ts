import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { Profile, Strategy } from 'passport-google-oauth20';

export type GoogleProfile = {
  email: string;
  name: string;
  avatar?: string;
  phone?: string | null;
  googleId: string;
  accessToken?: string;
};

const GOOGLE_CALLBACK_FALLBACK_URL =
  'http://localhost:3001/api/v1/auth/google/callback';
const strategyLogger = new Logger('GoogleStrategy');

function isPrivateIpv4Host(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) return false;
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '[::1]'
  ) {
    return false;
  }

  const parts = normalized.split('.').map((value) => Number(value));
  if (parts.length !== 4 || parts.some((value) => !Number.isInteger(value))) {
    return false;
  }
  if (parts.some((value) => value < 0 || value > 255)) return false;

  const [a, b] = parts;
  if (a === 10 || (a === 192 && b === 168)) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function resolveGoogleCallbackUrl(config: ConfigService): string {
  const configuredCallback =
    config.get<string>('GOOGLE_CALLBACK_URL') ??
    process.env.GOOGLE_CALLBACK_URL;
  if (!configuredCallback?.trim()) {
    strategyLogger.warn(
      `GOOGLE_CALLBACK_URL topilmadi. Default callback ishlatiladi: ${GOOGLE_CALLBACK_FALLBACK_URL}`,
    );
    return GOOGLE_CALLBACK_FALLBACK_URL;
  }

  let parsed: URL;
  try {
    parsed = new URL(configuredCallback);
  } catch {
    strategyLogger.warn(
      `GOOGLE_CALLBACK_URL noto'g'ri: "${configuredCallback}". Default callback ishlatiladi: ${GOOGLE_CALLBACK_FALLBACK_URL}`,
    );
    return GOOGLE_CALLBACK_FALLBACK_URL;
  }

  if (isPrivateIpv4Host(parsed.hostname)) {
    strategyLogger.warn(
      `GOOGLE_CALLBACK_URL private IP (${parsed.hostname}) bilan berilgan. Google OAuth 400 invalid_request bo'lsa, device_id va device_name parametrlari kerak bo'lishi mumkin.`,
    );
  }

  return parsed.toString();
}

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly isPrivateCallbackHost: boolean;

  constructor(private readonly config: ConfigService) {
    const callbackURL = resolveGoogleCallbackUrl(config);
    super({
      clientID:
        config.get<string>('GOOGLE_CLIENT_ID') ??
        (process.env.GOOGLE_CLIENT_ID as string),
      clientSecret:
        config.get<string>('GOOGLE_CLIENT_SECRET') ??
        (process.env.GOOGLE_CLIENT_SECRET as string),
      callbackURL,
      scope: ['email', 'profile'],
    });

    this.isPrivateCallbackHost = (() => {
      try {
        const parsed = new URL(callbackURL);
        return isPrivateIpv4Host(parsed.hostname);
      } catch {
        return false;
      }
    })();
  }

  authorizationParams(
    options: Record<string, unknown>,
  ): Record<string, string> {
    const params = super.authorizationParams(options) as Record<string, string>;

    if (!this.isPrivateCallbackHost) {
      return params;
    }

    const deviceId = options?.device_id ?? options?.deviceId;
    const deviceName = options?.device_name ?? options?.deviceName;

    if (deviceId) {
      params.device_id = String(deviceId);
    }
    if (deviceName) {
      params.device_name = String(deviceName);
    }

    return params;
  }

  validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
  ): GoogleProfile {
    const email = profile.emails?.[0]?.value?.trim();
    if (!email) {
      throw new UnauthorizedException('Google akkauntdan email olinmadi.');
    }
    const profileAny = profile as Profile & {
      _json?: { phone_number?: string; phone?: string };
    };
    const phone =
      profileAny._json?.phone_number?.trim() ||
      profileAny._json?.phone?.trim() ||
      null;

    return {
      email,
      name: profile.displayName ?? email,
      avatar: profile.photos?.[0]?.value,
      phone,
      googleId: profile.id,
      accessToken,
    };
  }
}
