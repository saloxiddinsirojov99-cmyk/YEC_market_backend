import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class KeepAliveService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger('KeepAlive');
  public static readonly DEFAULT_URL =
    'https://yec-market-backend.onrender.com/api/health';
  public static readonly INTERVAL_MS = 600_000; // 10 minutes
  public static readonly TIMEOUT_MS = 15_000; // 15 seconds

  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private isRequestInProgress = false;
  private isDestroyed = false;
  private currentAbortController: AbortController | null = null;

  constructor(private readonly configService: ConfigService) {}

  getUrl(): string {
    const configuredUrl = this.configService.get<string>('KEEP_ALIVE_URL');
    if (configuredUrl && configuredUrl.trim().length > 0) {
      return configuredUrl.trim();
    }
    return KeepAliveService.DEFAULT_URL;
  }

  isEnabled(): boolean {
    const enabledVal = this.configService.get<string>('KEEP_ALIVE_ENABLED');
    if (enabledVal === 'false' || enabledVal === '0') {
      return false;
    }
    return true;
  }

  onApplicationBootstrap() {
    if (!this.isEnabled()) {
      this.logger.log("Keep-Alive xizmati o'chirilgan (KEEP_ALIVE_ENABLED=false).");
      return;
    }

    const url = this.getUrl();
    this.logger.log(
      `[KEEP-ALIVE] Xizmat ishga tushdi | Interval: ${KeepAliveService.INTERVAL_MS / 60000} daqiqa | Target: ${url}`,
    );

    // Initial ping after server bootstrap (delayed by 5s to allow full HTTP listen)
    const initialDelay = 5_000;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      if (!this.isDestroyed) {
        void this.ping();
      }
    }, initialDelay);
    if (this.initialTimer && typeof this.initialTimer.unref === 'function') {
      this.initialTimer.unref();
    }

    // Recurring interval every 10 minutes
    this.timer = setInterval(() => {
      if (!this.isDestroyed) {
        void this.ping();
      }
    }, KeepAliveService.INTERVAL_MS);

    // Unref so the timer doesn't prevent graceful exit if needed
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  async ping(): Promise<boolean> {
    if (this.isDestroyed) {
      return false;
    }

    // Guard against concurrent overlapping pings
    if (this.isRequestInProgress) {
      this.logger.warn(
        "[KEEP-ALIVE] Oldingi so'rov hali yakunlanmadi, takroriy chaqiruv o'tkazib yuborildi.",
      );
      return false;
    }

    this.isRequestInProgress = true;
    const startTime = Date.now();
    const url = this.getUrl();

    const controller = new AbortController();
    this.currentAbortController = controller;
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, KeepAliveService.TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'YEC-KeepAlive/1.0 (+https://yecmarket.uz)',
          Accept: 'application/json, text/plain, */*',
        },
        signal: controller.signal,
      });

      const duration = Date.now() - startTime;
      const isSuccess = response.status >= 200 && response.status < 300;

      if (isSuccess) {
        this.logger.log(
          `[KEEP-ALIVE] GET successful | status=${response.status} | duration=${duration}ms`,
        );
        return true;
      } else {
        this.logger.warn(
          `[KEEP-ALIVE] GET failed | status=${response.status} | duration=${duration}ms`,
        );
        return false;
      }
    } catch (err: any) {
      const duration = Date.now() - startTime;
      const isAborted = controller.signal.aborted;
      const errorMsg = isAborted
        ? `Timeout (${KeepAliveService.TIMEOUT_MS}ms exceeded)`
        : err?.message || String(err);

      this.logger.error(
        `[KEEP-ALIVE] GET failed | error=${errorMsg} | duration=${duration}ms`,
      );
      return false;
    } finally {
      clearTimeout(timeoutId);
      this.currentAbortController = null;
      this.isRequestInProgress = false;
    }
  }

  onModuleDestroy() {
    this.isDestroyed = true;
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    this.logger.log("🛑 [KEEP-ALIVE] Xizmat to'xtatildi (Graceful shutdown).");
  }

  // Testing helpers
  getTimer(): NodeJS.Timeout | null {
    return this.timer;
  }

  getIsRequestInProgress(): boolean {
    return this.isRequestInProgress;
  }
}
