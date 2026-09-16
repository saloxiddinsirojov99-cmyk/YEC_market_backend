import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { CacheService } from '../cache/cache.service';
import { Public } from '../common/decorators/public.decorator';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
  ) {}

  @Public()
  @ApiOperation({ summary: 'System Health Check' })
  @Get()
  async getHealth() {
    const health = {
      status: 'UP',
      timestamp: new Date().toISOString(),
      services: {
        database: 'DOWN',
        cache: 'DOWN',
        telegram: 'DOWN',
        clickGateway: 'UP', // Mock Click endpoint status
        paymeGateway: 'UP', // Mock Payme endpoint status
      },
    };

    // 1. Check Database
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      health.services.database = 'UP';
    } catch (err) {
      health.status = 'DEGRADED';
    }

    // 2. Check Cache
    try {
      await this.cache.set('health-check-temp-key', 'OK', 5);
      const val = await this.cache.get('health-check-temp-key');
      if (val === 'OK') {
        health.services.cache = 'UP';
      }
    } catch (err) {
      health.status = 'DEGRADED';
    }

    // 3. Check Telegram Bot Token
    try {
      const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
      if (token) {
        const response = await fetch(
          `https://api.telegram.org/bot${token}/getMe`,
        );
        if (response.ok) {
          health.services.telegram = 'UP';
        }
      }
    } catch (err) {
      health.status = 'DEGRADED';
    }

    return health;
  }
}
