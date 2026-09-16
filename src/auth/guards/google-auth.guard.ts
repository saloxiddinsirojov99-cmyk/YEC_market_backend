import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import type { Request } from 'express';
import { createHash } from 'crypto';

@Injectable()
export class GoogleAuthGuard extends AuthGuard('google') {
  getAuthenticateOptions(context: ExecutionContext) {
    const base = super.getAuthenticateOptions(context) ?? {};
    const req = context.switchToHttp().getRequest<Request>();

    const userAgent = String(req.headers['user-agent'] ?? '').trim();
    const ip = String(req.ip ?? '').trim();

    // Google private-IP redirect'larda `device_id` va `device_name` so'rashi mumkin.
    // PII chiqarmaslik uchun ip+UA'dan hash qilib yuboramiz.
    const seed = `${ip}|${userAgent || 'unknown'}`;
    const deviceId = createHash('sha256')
      .update(seed)
      .digest('hex')
      .slice(0, 32);
    const deviceName = (userAgent || 'YEC Market Browser').slice(0, 120);

    return {
      ...base,
      device_id: deviceId,
      device_name: deviceName,
    };
  }
}
