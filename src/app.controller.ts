import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';

@ApiExcludeController()
@Controller()
export class AppController {
  constructor(private readonly prisma: PrismaService) {}

  @Public()
  @Get()
  getApiRoot() {
    return {
      message: 'YEC Market API ishlayapti.',
      docs: '/docs',
    };
  }

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      ok: true,
      time: new Date().toISOString(),
    };
  }

  @Public()
  @Get('api/health')
  async apiHealth() {
    let databaseStatus = 'down';
    let dbErrorMsg: string | undefined;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      databaseStatus = 'up';
    } catch (err: any) {
      databaseStatus = 'down';
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('ECONNREFUSED')) {
        dbErrorMsg = 'ECONNREFUSED: Server portiga ulanish rad etildi (host/port noto\'g\'ri yoki server ishlamayapti).';
      } else if (msg.includes('ENOTFOUND')) {
        dbErrorMsg = 'ENOTFOUND: Database host manzili topilmadi (DNS xatosi).';
      } else if (msg.includes('ETIMEDOUT')) {
        dbErrorMsg = 'ETIMEDOUT: Database so\'rovi vaqti tugadi.';
      } else {
        dbErrorMsg = 'Database ulanishida xatolik yuz berdi.';
      }
    }

    const safeInfo = this.prisma.getSafeDbInfo();
    const isHealthy = databaseStatus === 'up';

    const payload = {
      status: isHealthy ? 'ok' : 'degraded',
      api: 'up',
      database: databaseStatus,
      dbInfo: safeInfo,
      ...(dbErrorMsg && !isHealthy ? { message: dbErrorMsg } : {}),
      timestamp: new Date().toISOString(),
    };

    if (!isHealthy) {
      throw new ServiceUnavailableException(payload);
    }

    return payload;
  }

  @Public()
  @Get('health/ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        ok: true,
        db: true,
        time: new Date().toISOString(),
      };
    } catch {
      throw new ServiceUnavailableException({
        ok: false,
        db: false,
        time: new Date().toISOString(),
      });
    }
  }

  @Public()
  @Get('api/v1')
  getApiRootWithPrefix() {
    return {
      message: 'YEC Market API ishlayapti.',
      docs: '/docs',
    };
  }
}
