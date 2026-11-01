import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { KeepAliveService } from './keep-alive.service';

describe('KeepAliveService', () => {
  let service: KeepAliveService;
  let configService: ConfigService;
  let originalFetch: typeof global.fetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  const createModule = async (envOverrides: Record<string, string> = {}) => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        KeepAliveService,
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string, defaultValue?: any) => {
              return envOverrides[key] !== undefined
                ? envOverrides[key]
                : defaultValue;
            }),
          },
        },
      ],
    }).compile();

    service = module.get<KeepAliveService>(KeepAliveService);
    configService = module.get<ConfigService>(ConfigService);
    return service;
  };

  afterEach(() => {
    if (service) {
      service.onModuleDestroy();
    }
    jest.clearAllMocks();
    jest.clearAllTimers();
  });

  describe('Konfiguratsiya va Environment Variables', () => {
    it('1. 10 daqiqalik interval (600,000 ms) va 15s timeout to\'g\'ri sozlangan', () => {
      expect(KeepAliveService.INTERVAL_MS).toBe(600_000);
      expect(KeepAliveService.TIMEOUT_MS).toBe(15_000);
    });

    it('2. Default fallback URL to\'g\'ri qaytariladi', async () => {
      await createModule({});
      expect(service.getUrl()).toBe(
        'https://yec-market-backend.onrender.com/api/health',
      );
    });

    it('3. KEEP_ALIVE_URL environment variable to\'g\'ri o\'qiladi', async () => {
      const customUrl = 'https://custom-domain.uz/api/health';
      await createModule({ KEEP_ALIVE_URL: customUrl });
      expect(service.getUrl()).toBe(customUrl);
    });

    it('4. KEEP_ALIVE_ENABLED=false bo\'lganda timer ishga tushmaydi', async () => {
      await createModule({ KEEP_ALIVE_ENABLED: 'false' });
      service.onApplicationBootstrap();
      expect(service.getTimer()).toBeNull();
    });
  });

  describe('HTTP Ping va Xatoliklarni boshqarish', () => {
    it('5. HTTP 200 qaytganda muvaffaqiyatli deb qayd etiladi va true qaytaradi', async () => {
      await createModule({});
      global.fetch = jest.fn().mockResolvedValue({
        status: 200,
        ok: true,
      });

      const result = await service.ping();
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://yec-market-backend.onrender.com/api/health',
        expect.objectContaining({
          method: 'GET',
        }),
      );
    });

    it('6. HTTP 500 xatosi serverni yiqitmaydi va false qaytaradi', async () => {
      await createModule({});
      global.fetch = jest.fn().mockResolvedValue({
        status: 500,
        ok: false,
      });

      const result = await service.ping();
      expect(result).toBe(false);
      expect(service.getIsRequestInProgress()).toBe(false);
    });

    it('7. Tarmoq xatosi yoki ulanish uzilishi yiqitmaydi', async () => {
      await createModule({});
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('Connection refused (ECONNREFUSED)'));

      const result = await service.ping();
      expect(result).toBe(false);
      expect(service.getIsRequestInProgress()).toBe(false);
    });

    it('8. Timeout yuz berganda xatolik to\'g\'ri ushlanadi', async () => {
      await createModule({});
      global.fetch = jest.fn().mockImplementation((url, options) => {
        return new Promise((_, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              const abortErr = new Error('The operation was aborted');
              (abortErr as any).name = 'AbortError';
              reject(abortErr);
            });
          }
        });
      });

      jest.useFakeTimers();
      const pingPromise = service.ping();
      // Fast forward past the 15s timeout
      jest.advanceTimersByTime(KeepAliveService.TIMEOUT_MS + 100);
      const result = await pingPromise;
      expect(result).toBe(false);
      jest.useRealTimers();
    });

    it('9. Parallel takroriy so\'rovlar (isRequestInProgress) bloklanadi', async () => {
      await createModule({});
      let resolveFirstCall: (value: any) => void;
      global.fetch = jest.fn().mockImplementation(() => {
        return new Promise((resolve) => {
          resolveFirstCall = resolve;
        });
      });

      // Start first ping (will hang until resolved)
      const firstPing = service.ping();
      expect(service.getIsRequestInProgress()).toBe(true);

      // Attempt second parallel ping
      const secondPingResult = await service.ping();
      expect(secondPingResult).toBe(false);

      // Resolve first
      resolveFirstCall!({ status: 200, ok: true });
      const firstPingResult = await firstPing;
      expect(firstPingResult).toBe(true);
      expect(service.getIsRequestInProgress()).toBe(false);
    });
  });

  describe('Lifecycle va Graceful Shutdown', () => {
    it('10. onModuleDestroy chaqirilganda timer tozalanadi va in-flight so\'rov to\'xtatiladi', async () => {
      await createModule({});
      service.onApplicationBootstrap();
      expect(service.getTimer()).not.toBeNull();

      service.onModuleDestroy();
      expect(service.getTimer()).toBeNull();

      // Subsequent ping after destruction returns false
      const result = await service.ping();
      expect(result).toBe(false);
    });

    it('11. 10 daqiqalik interval bo\'yicha timer ishga tushadi', async () => {
      jest.useFakeTimers();
      await createModule({});
      const pingSpy = jest.spyOn(service, 'ping').mockResolvedValue(true);

      service.onApplicationBootstrap();

      // Initial ping after 5s
      jest.advanceTimersByTime(5_000);
      expect(pingSpy).toHaveBeenCalledTimes(1);

      // Advance by 10 minutes (600,000 ms)
      jest.advanceTimersByTime(KeepAliveService.INTERVAL_MS);
      expect(pingSpy).toHaveBeenCalledTimes(2);

      // Advance by another 10 minutes
      jest.advanceTimersByTime(KeepAliveService.INTERVAL_MS);
      expect(pingSpy).toHaveBeenCalledTimes(3);

      jest.useRealTimers();
    });
  });
});
