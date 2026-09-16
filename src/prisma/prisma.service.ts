import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

import { Pool } from 'pg';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private isConnecting = false;

  constructor(configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL');
    if (!connectionString) {
      throw new Error('DATABASE_URL topilmadi. .env faylni tekshiring.');
    }

    const maxConnections = Number(process.env.DB_POOL_MAX || 20);

    const pool = new Pool({
      connectionString,
      max: maxConnections,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    const adapter = new PrismaPg(pool);
    super({ adapter });
  }

  private async connectWithRetry(): Promise<void> {
    if (this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    let attempt = 0;
    const maxAttempts = 5;

    while (attempt < maxAttempts) {
      try {
        await this.$connect();
        this.logger.log('Database ulanishi muvaffaqiyatli.');
        break;
      } catch (error) {
        attempt += 1;
        const delay = Math.min(10000, 1500 * attempt);
        const trace =
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error);
        this.logger.error(
          `Database ulanishida xatolik (urinish ${attempt}/${maxAttempts}). ${Math.ceil(
            delay / 1000,
          )}s dan keyin qayta urinamiz.`,
          trace,
        );
        if (attempt >= maxAttempts) {
          this.logger.error('Database ulanish urinishlari yakunlandi.');
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.isConnecting = false;
  }

  async onModuleInit(): Promise<void> {
    void this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
    } catch (error) {
      const trace =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error('Database uzishda xatolik yuz berdi.', trace);
    }
  }
}
