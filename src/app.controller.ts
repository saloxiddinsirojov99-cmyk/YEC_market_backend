import { Controller, Get, ServiceUnavailableException, Optional } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Public } from './common/decorators/public.decorator';
import { PrismaService } from './prisma/prisma.service';
import { TelegramService } from './telegram/telegram.service';

@ApiExcludeController()
@Controller()
export class AppController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Optional() private readonly telegramService?: TelegramService,
  ) {}

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
        dbErrorMsg =
          "ECONNREFUSED: Server portiga ulanish rad etildi (host/port noto'g'ri yoki server ishlamayapti).";
      } else if (msg.includes('ENOTFOUND')) {
        dbErrorMsg = 'ENOTFOUND: Database host manzili topilmadi (DNS xatosi).';
      } else if (msg.includes('ETIMEDOUT')) {
        dbErrorMsg = "ETIMEDOUT: Database so'rovi vaqti tugadi.";
      } else {
        dbErrorMsg = 'Database ulanishida xatolik yuz berdi.';
      }
    }

    const safeInfo = this.prisma.getSafeDbInfo();
    const isHealthy = databaseStatus === 'up';

    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const tgInfo = this.telegramService?.getHealthInfo();

    const payload = {
      status: isHealthy ? 'ok' : 'degraded',
      api: 'up',
      database: databaseStatus,
      dbInfo: safeInfo,
      telegram: {
        configured: Boolean(token && token.trim().length > 10),
        enabled: this.configService.get<string>('TELEGRAM_ENABLED', 'true') === 'true',
        activeMode: tgInfo?.activeMode || 'unknown',
        webhookUrl: tgInfo?.webhookUrl || null,
      },
      commitSha: process.env.RENDER_GIT_COMMIT || 'local',
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
