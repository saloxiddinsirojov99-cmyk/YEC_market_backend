import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool, PoolConfig } from 'pg';

export type SafeDbInfo = {
  configured: boolean;
  protocol?: string;
  host?: string;
  port?: string;
  database?: string;
  ssl?: boolean;
  isLocalhost?: boolean;
  hasSurroundingQuotes?: boolean;
  isConnected?: boolean;
};

/**
 * Strips surrounding quotes, whitespace and hidden characters
 * commonly introduced during copy-paste into Render or .env
 */
export function cleanConnectionString(raw?: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/**
 * Safely parses database connection parameters WITHOUT exposing secrets
 */
export function parseSafeDbInfo(rawUrl?: string, isConnected = false): SafeDbInfo {
  if (!rawUrl || !rawUrl.trim()) {
    return { configured: false, isConnected: false };
  }

  const hasSurroundingQuotes =
    (rawUrl.startsWith('"') && rawUrl.endsWith('"')) ||
    (rawUrl.startsWith("'") && rawUrl.endsWith("'"));

  const cleaned = cleanConnectionString(rawUrl);

  try {
    const u = new URL(cleaned);
    const host = u.hostname;
    const isLocalhost =
      host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const isCloudHost =
      host.includes('neon.tech') ||
      host.includes('neon.build') ||
      host.includes('supabase.co') ||
      host.includes('render.com') ||
      host.includes('amazonaws.com');
    const sslParam = u.searchParams.get('sslmode') || u.searchParams.get('ssl');
    const hasSsl = isCloudHost || sslParam === 'require' || sslParam === 'true';

    return {
      configured: true,
      protocol: u.protocol.replace(':', ''),
      host,
      port: u.port || '5432',
      database: u.pathname.replace(/^\//, ''),
      ssl: hasSsl,
      isLocalhost,
      hasSurroundingQuotes,
      isConnected,
    };
  } catch {
    return {
      configured: true,
      host: 'invalid-url-format',
      hasSurroundingQuotes,
      isConnected: false,
    };
  }
}

/**
 * Builds pg.Pool configuration with optimal timeouts, pool size and SSL for cloud DBs
 */
export function buildPoolConfig(
  connectionString: string,
  maxConnections = 20,
): PoolConfig {
  const cleaned = cleanConnectionString(connectionString);
  const config: PoolConfig = {
    connectionString: cleaned,
    max: maxConnections,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };

  try {
    const u = new URL(cleaned);
    const host = u.hostname.toLowerCase();
    const isCloudHost =
      host.includes('neon.tech') ||
      host.includes('neon.build') ||
      host.includes('supabase.co') ||
      host.includes('render.com') ||
      host.includes('amazonaws.com');
    const sslParam = u.searchParams.get('sslmode') || u.searchParams.get('ssl');

    // Cloud PostgreSQL (especially Neon) requires TLS connection
    if (isCloudHost || sslParam === 'require' || sslParam === 'true') {
      config.ssl = {
        rejectUnauthorized: false,
      };
    }
  } catch {
    // If URL parsing fails, pass cleaned string directly to pg
  }

  return config;
}

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);
  private isConnecting = false;
  private isDbConnected = false;
  private readonly pool: Pool;
  private readonly rawConnectionString: string;

  constructor(configService: ConfigService) {
    const rawUrl =
      configService.get<string>('DATABASE_URL') || process.env.DATABASE_URL || '';

    if (!rawUrl) {
      throw new Error(
        'DATABASE_URL topilmadi. Render Environment Variables yoki .env faylni tekshiring.',
      );
    }

    const cleanedUrl = cleanConnectionString(rawUrl);
    const maxConnections = Number(process.env.DB_POOL_MAX || 20);
    const poolConfig = buildPoolConfig(cleanedUrl, maxConnections);

    const pool = new Pool(poolConfig);
    const adapter = new PrismaPg(pool);
    super({ adapter });

    this.pool = pool;
    this.rawConnectionString = rawUrl;

    const safeInfo = parseSafeDbInfo(rawUrl, false);
    if (process.env.NODE_ENV === 'production' && safeInfo.isLocalhost) {
      this.logger.error(
        'XATOLIK: Production rejimida DATABASE_URL "localhost" ga sozlangan! Render Environment Variables ichida DATABASE_URL ni Neon PostgreSQL manziliga almashtiring.',
      );
    }
  }

  /**
   * Returns safe connection metadata without passwords or secrets
   */
  getSafeDbInfo(): SafeDbInfo {
    return parseSafeDbInfo(this.rawConnectionString, this.isDbConnected);
  }

  /**
   * Performs an actual SELECT 1 query to verify active database connectivity
   */
  async verifyConnection(): Promise<boolean> {
    try {
      await this.$queryRaw`SELECT 1`;
      this.isDbConnected = true;
      return true;
    } catch {
      this.isDbConnected = false;
      return false;
    }
  }

  private async connectWithRetry(): Promise<boolean> {
    if (this.isConnecting) {
      return this.isDbConnected;
    }

    this.isConnecting = true;
    let attempt = 0;
    const maxAttempts = 5;

    while (attempt < maxAttempts) {
      try {
        await this.$connect();
        // Execute real DB query to verify connection
        await this.$queryRaw`SELECT 1`;
        this.isDbConnected = true;
        this.logger.log('Database ulanishi muvaffaqiyatli (SELECT 1 tasdiqlandi).');
        this.isConnecting = false;
        return true;
      } catch (error) {
        attempt += 1;
        this.isDbConnected = false;
        const delay = Math.min(6000, 1200 * attempt);
        const trace =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Database ulanishida xatolik (urinish ${attempt}/${maxAttempts}): ${trace}. ${Math.ceil(
            delay / 1000,
          )}s dan keyin qayta urinamiz.`,
        );

        if (attempt >= maxAttempts) {
          this.logger.error(
            'Database ulanish urinishlari yakunlandi. Bazaga ulanib bo\'lmadi.',
          );
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    this.isConnecting = false;
    return false;
  }

  async onModuleInit(): Promise<void> {
    const success = await this.connectWithRetry();
    if (!success) {
      this.logger.warn(
        'Ogohlantirish: Server ishga tushdi, lekin Database ulanishi muvaffaqiyatsiz. So\'rovlar 503 xatoligi qaytaradi.',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.$disconnect();
      await this.pool.end();
      this.logger.log('Database ulanishlari xavfsiz yopildi.');
    } catch (error) {
      const trace =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error('Database uzishda xatolik yuz berdi:', trace);
    }
  }
}
