import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { UserRole } from '@prisma/client';
import { ExtractJwt, Strategy } from 'passport-jwt';
import type { Request } from 'express';

interface JwtPayload {
  sub: string;
  email: string;
  role: UserRole;
}

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(configService: ConfigService) {
    const secret = configService.get<string>('JWT_SECRET');
    if (!secret) {
      throw new Error('JWT_SECRET sozlanmagan.');
    }

    super({
      // Extract JWT from Authorization Bearer header OR from cookies (access_token)
      jwtFromRequest: (request: Request) => {
        // 1. Try Authorization: Bearer <token> header first
        const fromHeader = ExtractJwt.fromAuthHeaderAsBearerToken()(request);
        if (fromHeader) return fromHeader;

        // 2. Fallback: read from cookie named 'access_token'
        if (request?.cookies) {
          return request.cookies.access_token ?? request.cookies.token ?? null;
        }

        return null;
      },
      passReqToCallback: false,
      ignoreExpiration: false,
      secretOrKey: secret,
    });
  }

  validate(payload: JwtPayload): JwtPayload {
    if (!payload?.sub) {
      throw new UnauthorizedException("Token noto'g'ri.");
    }

    return payload;
  }
}
