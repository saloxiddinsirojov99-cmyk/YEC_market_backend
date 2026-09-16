import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async log(
    action: string,
    who: string,
    orderId: string | null,
    oldValue: any = null,
    newValue: any = null,
    reason: string | null = null,
    ip: string | null = null,
  ) {
    const oldStr = oldValue
      ? typeof oldValue === 'string'
        ? oldValue
        : JSON.stringify(oldValue)
      : null;
    const newStr = newValue
      ? typeof newValue === 'string'
        ? newValue
        : JSON.stringify(newValue)
      : null;

    return this.prisma.auditLog.create({
      data: {
        action,
        who,
        orderId,
        oldValue: oldStr,
        newValue: newStr,
        reason,
        ip,
      },
    });
  }
}
