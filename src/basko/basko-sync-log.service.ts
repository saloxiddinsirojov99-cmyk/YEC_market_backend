import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BaskoSyncStats,
  BaskoValidationError,
  BaskoSyncResult,
} from './types/basko.types';

@Injectable()
export class BaskoSyncLogService {
  private readonly logger = new Logger(BaskoSyncLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Initializes a new synchronization job record.
   */
  async startSyncJob(params: {
    source: 'EXCEL' | 'API';
    fileName?: string;
    fileHash?: string;
    performedBy?: string;
  }): Promise<{ jobId: string; startedAt: Date }> {
    const startedAt = new Date();
    const jobId = `basko_sync_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;

    this.logger.log(
      `🏁 BASKO sinxronizatsiya boshlandi (JobId: ${jobId}, Manba: ${params.source}, Fayl: ${params.fileName || 'N/A'})`,
    );

    return { jobId, startedAt };
  }

  /**
   * Saves the final synchronization result to persistent storage.
   * Uses import_logs or custom basko log while ensuring zero disruption.
   */
  async completeSyncJob(result: BaskoSyncResult): Promise<void> {
    const durationMs = result.finishedAt.getTime() - result.startedAt.getTime();
    result.stats.durationMs = durationMs;

    this.logger.log(
      `✅ BASKO sinxronizatsiya yakunlandi (${result.jobId}): ` +
      `Qabul qilindi: ${result.stats.totalReceived}, Yangi: ${result.stats.newProducts}, ` +
      `Yangilandi: ${result.stats.updatedProducts}, Arxivlandi: ${result.stats.archivedProducts}, ` +
      `Xatolar: ${result.stats.invalidRecords}, Davomiyligi: ${durationMs}ms`,
    );

    try {
      // Save to existing import_logs table for backward-compatibility with admin dashboard
      await this.prisma.importLog.create({
        data: {
          fileName: result.fileName || `BASKO_${result.source}_SYNC`,
          userName: result.source === 'API' ? 'BASKO_API_INTEGRATION' : 'SELLER_TELEGRAM_BOT',
          userEmail: 'system@yecmarket.uz',
          totalRows: result.stats.totalReceived,
          successCount: result.stats.newProducts + result.stats.updatedProducts,
          duplicateCount: result.stats.duplicateBarcodes,
          noImageCount: result.stats.missingImages,
          validationErrorCount: result.stats.invalidRecords,
          failedCount: result.errors.length,
          importType: `BASKO_${result.source}`,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          durationMs,
          status: result.status === 'SUCCESS' ? 'SUCCESS' : result.status === 'PARTIAL' ? 'PARTIAL' : 'FAILED',
          details: {
            jobId: result.jobId,
            stats: result.stats,
            errorsSummary: result.errors.slice(0, 50), // Store up to 50 sample errors for audit
          } as any,
        },
      });
    } catch (err: any) {
      this.logger.error(`ImportLog saqlashda xatolik (davom etilmoqda): ${err.message}`);
    }
  }

  /**
   * Fetches latest sync stats and formats as a Telegram report.
   */
  async formatTelegramSyncReport(): Promise<string> {
    const latestLog = await this.prisma.importLog.findFirst({
      where: { importType: { startsWith: 'BASKO_' } },
      orderBy: { createdAt: 'desc' },
    });

    if (!latestLog) {
      return (
        `📊 <b>BASKO Sinxronizatsiya Holati:</b>\n\n` +
        `ℹ️ Hozircha sinxronizatsiya amalga oshirilmagan.\n` +
        `Tizim yangi fayllarni qabul qilishga tayyor.`
      );
    }

    const details = (latestLog.details as any) || {};
    const stats: BaskoSyncStats = details.stats || {
      totalReceived: latestLog.totalRows,
      totalValidated: latestLog.successCount,
      newProducts: latestLog.successCount,
      updatedProducts: 0,
      unchangedProducts: 0,
      archivedProducts: 0,
      duplicateBarcodes: latestLog.duplicateCount,
      invalidRecords: latestLog.validationErrorCount,
      missingImages: latestLog.noImageCount,
      durationMs: latestLog.durationMs || 0,
    };

    return this.formatSyncReportUzbek(stats);
  }

  /**
   * Helper to format human-readable Uzbek sync report for Telegram message.
   */
  formatSyncReportUzbek(stats: BaskoSyncStats): string {
    const durationSec = ((stats.durationMs || 0) / 1000).toFixed(1);
    return (
      `📊 <b>BASKO Sinxronizatsiya Hisoboti:</b>\n\n` +
      `📥 Jami qabul qilingan: <b>${stats.totalReceived} ta</b>\n` +
      `✅ Muvaffaqiyatli tekshirildi: <b>${stats.totalValidated} ta</b>\n` +
      `🆕 Yangi qo‘shilgan gilamlar: <b>${stats.newProducts} ta</b>\n` +
      `🔄 Yangilangan gilamlar: <b>${stats.updatedProducts} ta</b>\n` +
      `📦 O‘zgarmagan mahsulotlar: <b>${stats.unchangedProducts} ta</b>\n` +
      `📁 Arxivlangan (yo‘q) gilamlar: <b>${stats.archivedProducts} ta</b>\n` +
      `⚠️ Takrorlangan shtrix-kodlar: <b>${stats.duplicateBarcodes} ta</b>\n` +
      `❌ Yaroqsiz yozuvlar: <b>${stats.invalidRecords} ta</b>\n` +
      `🖼️ Rasmi kutilayotgan gilamlar: <b>${stats.missingImages} ta</b>\n` +
      `⏱️ Bajarilish vaqti: <b>${durationSec} soniya</b>\n\n` +
      `<i>⏳ 5 soniyadan so‘ng asosiy menyu avtomatik ochiladi...</i>`
    );
  }
}

