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
    let databaseStatus = 'unknown';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      databaseStatus = 'up';
    } catch {
      databaseStatus = 'down';
    }

    return {
      status: 'ok',
      database: databaseStatus,
      timestamp: new Date().toISOString(),
    };
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
