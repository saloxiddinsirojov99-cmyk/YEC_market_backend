import { Injectable, Logger, ConflictException, BadRequestException } from '@nestjs/common';
import { BaskoExcelImportService } from './basko-excel-import.service';
import { BaskoSyncService } from './basko-sync.service';
import { BaskoSyncLogService } from './basko-sync-log.service';
import { BaskoSyncResult, BaskoSyncStats } from './types/basko.types';

@Injectable()
export class BaskoIntegrationService {
  private readonly logger = new Logger(BaskoIntegrationService.name);
  private isSyncRunning = false;
  private currentJobId: string | null = null;

  constructor(
    private readonly excelImportService: BaskoExcelImportService,
    private readonly syncService: BaskoSyncService,
    private readonly syncLogService: BaskoSyncLogService,
  ) {}

  /**
   * Checks whether a synchronization process is currently in progress.
   */
  isSyncInProgress(): boolean {
    return this.isSyncRunning;
  }

  /**
   * Executes full end-to-end synchronization from an Excel file (path or Buffer).
   * Guaranteed concurrency safety: prevents simultaneous sync runs.
   */
  async syncFromExcel(
    input: string | Buffer,
    options?: {
      fileName?: string;
      performedBy?: string;
      customAliases?: Record<string, string[]>;
    },
  ): Promise<BaskoSyncResult> {
    if (this.isSyncRunning) {
      throw new ConflictException(
        'Sinxronizatsiya jarayoni hozirda boshqa foydalanuvchi tomonidan bajarilmoqda. Iltimos, kuting.',
      );
    }

    this.isSyncRunning = true;
    const { jobId, startedAt } = await this.syncLogService.startSyncJob({
      source: 'EXCEL',
      fileName: options?.fileName,
      performedBy: options?.performedBy,
    });
    this.currentJobId = jobId;

    try {
      // 1. Parse Excel file into raw products
      const { rawProducts, totalRows } = this.excelImportService.parseWorkbook(
        input,
        { customAliases: options?.customAliases },
      );

      // 2. Phase 1: Preview and Validation
      const preview = await this.syncService.previewSync(rawProducts);

      if (!preview.isSafeToExecute) {
        const errorMsg =
          `Sinxronizatsiya xavfsizlik sababli bekor qilindi: Fayl chala yoki unda ${preview.errors.length} ta yaroqsiz qator mavjud. ` +
          `Mavjud tovarlar bazasiga hech qanday o'zgartirish kiritilmadi.`;
        this.logger.error(errorMsg);

        const failedResult: BaskoSyncResult = {
          jobId,
          status: 'FAILED',
          stats: preview.stats,
          errors: preview.errors,
          startedAt,
          finishedAt: new Date(),
          source: 'EXCEL',
          fileName: options?.fileName,
        };
        await this.syncLogService.completeSyncJob(failedResult);
        throw new BadRequestException(errorMsg);
      }

      // 3. Phase 2: Execute safe O(n + m) sync
      const result = await this.syncService.executeSync(preview.validItems, {
        jobId,
        startedAt,
        source: 'EXCEL',
        fileName: options?.fileName,
        performedBy: options?.performedBy,
        rawCount: totalRows,
        errors: preview.errors,
        duplicateCount: preview.stats.duplicateBarcodes,
      });

      return result;
    } finally {
      this.isSyncRunning = false;
      this.currentJobId = null;
    }
  }

  /**
   * Future-ready placeholder for official BASKO API synchronization.
   * When official API docs arrive, the API adapter will feed normalized records here.
   */
  async syncFromApi(performedBy = 'SYSTEM'): Promise<BaskoSyncResult> {
    throw new BadRequestException(
      'BASKO rasmiy API integratsiyasi hujjatlar kelgandan so\'ng ishga tushiriladi. Hozircha faqat Excel sinxronizatsiyasi mavjud.',
    );
  }

  /**
   * Formats sync stats as human-readable Uzbek message for Telegram bot.
   */
  formatTelegramReport(stats: BaskoSyncStats): string {
    return this.syncLogService.formatSyncReportUzbek(stats);
  }
}
