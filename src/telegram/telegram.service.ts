import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { maskChatId } from './telegram.constants';

@Injectable()
export class TelegramService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(TelegramService.name);
  private isStopping = false;
  private isSupervisorRunning = false;
  private retryCount = 0;

  constructor(
    @InjectBot() private bot: Telegraf<Context>,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onApplicationBootstrap() {
    const token = this.configService.get<string>('TELEGRAM_BOT_TOKEN');
    const enabled =
      this.configService.get<string>('TELEGRAM_ENABLED', 'true') === 'true';

    if (!token || !enabled) {
      this.logger.warn(
        'Telegram bot faollashtirilmadi (token mavjud emas yoki TELEGRAM_ENABLED=false).',
      );
      return;
    }

    this.setupBotMiddlewares();
    void this.startPollingSupervisor();
  }

  async onModuleDestroy() {
    this.isStopping = true;
    this.logger.log('🛑 Telegram bot to\'xtatilmoqda (Graceful Shutdown)...');
    try {
      if ((this.bot as any).polling) {
        (this.bot as any).polling.stop();
        (this.bot as any).polling = undefined;
      }
      this.bot.stop('SIGTERM');
      this.logger.log('✅ Telegram bot to\'xtatildi va resurslar bo\'shatildi.');
    } catch (e: any) {
      this.logger.debug(`Bot stop notice: ${e?.message}`);
    }
  }

  private setupBotMiddlewares() {
    // 1. Safe update logger middleware with timing and error isolation
    this.bot.use(async (ctx, next) => {
      const start = Date.now();
      const updateType = ctx.updateType || 'unknown';
      const rawChatId = ctx.chat?.id;
      const masked = maskChatId(rawChatId);
      const textPreview = (
        (ctx as any).message?.text ||
        (ctx as any).callbackQuery?.data ||
        ''
      )
        .slice(0, 50)
        .replace(/\n/g, ' ');

      this.logger.log(
        `📥 [Update] ${updateType} | chat=${masked} | query="${textPreview}"`,
      );

      try {
        await next();
        const duration = Date.now() - start;
        this.logger.log(
          `✅ [Success] ${updateType} | chat=${masked} | (${duration}ms)`,
        );
      } catch (err: any) {
        const duration = Date.now() - start;
        this.logger.error(
          `❌ [Handler Error] ${updateType} | chat=${masked} | (${duration}ms): ${err?.message || err}`,
        );

        // Send friendly user-facing fallback so user is never ignored
        if (rawChatId) {
          try {
            await ctx.reply(
              "⚠️ So'rovingizni bajarishda texnik xatolik yuz berdi. Iltimos, qayta urinib ko'ring yoki /start bosing.",
            );
          } catch (replyErr: any) {
            this.logger.error(
              `Fallback javob yuborishda xatolik (${masked}): ${replyErr?.message}`,
            );
          }
        }
      }
    });

    // 2. Global Telegraf error handler
    this.bot.catch((err: any, ctx: Context) => {
      const masked = maskChatId(ctx.chat?.id);
      this.logger.error(
        `⚠️ Telegraf global xatosi [chat=${masked}]: ${err?.message || err}`,
      );
    });
  }

  private async startPollingSupervisor() {
    if (this.isSupervisorRunning) return;
    this.isSupervisorRunning = true;

    // Clear any dangling webhook first (without dropping updates)
    try {
      await this.bot.telegram.deleteWebhook({ drop_pending_updates: false });
      this.logger.log('✅ Telegram webhook tozalandi (drop_pending_updates: false)');
    } catch (e: any) {
      this.logger.warn(`deleteWebhook ogohlantirish: ${e?.message}`);
    }

    while (!this.isStopping) {
      try {
        this.logger.log('🔄 Telegram polling ishga tushirilmoqda...');

        // Cleanup any previous polling state
        try {
          if ((this.bot as any).polling) {
            (this.bot as any).polling.stop();
            (this.bot as any).polling = undefined;
          }
        } catch {}

        await this.bot.launch({
          dropPendingUpdates: false,
          allowedUpdates: [
            'message',
            'edited_message',
            'callback_query',
            'inline_query',
            'chosen_inline_result',
          ],
        });

        this.logger.log('🛑 Telegram polling normal yakunlandi.');
        if (this.isStopping) break;
      } catch (err: any) {
        if (this.isStopping) {
          this.logger.log('🛑 Telegram polling to\'xtatildi (shutdown).');
          break;
        }

        const msg = String(err?.message || err);
        const isConflict = msg.includes('409') || msg.includes('Conflict');

        if (isConflict) {
          this.retryCount++;
          this.logger.warn(
            `⚠️ [Telegram 409 Conflict]: Boshqa konteyner (oldingi deploy) hali yopilmagan. 5 soniyadan keyin qayta ulanish (urinish #${this.retryCount})...`,
          );
          await this.delay(5000);
        } else {
          this.logger.error(
            `❌ [Telegram Polling Error]: ${msg}. 5 soniyadan keyin qayta ishga tushiriladi...`,
          );
          await this.delay(5000);
        }
      }
    }

    this.isSupervisorRunning = false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Safely sends a text message with HTML parse_mode, falling back to plain text
   * if HTML parsing fails or Telegram rejects the formatting.
   */
  async sendMessageSafe(
    chatId: string | number,
    text: string,
    replyMarkup?: any,
  ) {
    const id = String(chatId);
    try {
      return await this.bot.telegram.sendMessage(id, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } catch (e: any) {
      this.logger.warn(
        `sendMessage HTML failed for ${maskChatId(id)}: ${e?.message}. Plain text fallback...`,
      );
      try {
        const plainText = text.replace(/<[^>]*>/g, '');
        return await this.bot.telegram.sendMessage(id, plainText, {
          reply_markup: replyMarkup,
        });
      } catch (e2: any) {
        this.logger.error(
          `sendMessage plain text fallback failed for ${maskChatId(id)}: ${e2?.message}`,
        );
      }
    }
  }

  /**
   * Sends photo with automatic multi-level fallback:
   * 1. Photo + HTML caption
   * 2. Photo + Plain text caption (if HTML formatting was rejected)
   * 3. Plain text message with HTML (if photo cannot be loaded by Telegram)
   * 4. Plain text message without HTML
   */
  async sendPhoto(
    chatId: string,
    photo: string | { source: string },
    caption: string,
    reply_markup?: any,
  ) {
    try {
      await this.bot.telegram.sendPhoto(chatId, photo, {
        caption,
        parse_mode: 'HTML',
        reply_markup,
      });
    } catch (e: any) {
      this.logger.warn(
        `sendPhoto HTML xatolik (${maskChatId(chatId)}): ${e.message}. Fallback 1 (Plain caption)...`,
      );
      try {
        await this.bot.telegram.sendPhoto(chatId, photo, {
          caption: caption.replace(/<[^>]*>/g, ''),
          reply_markup,
        });
      } catch (e2: any) {
        this.logger.warn(
          `sendPhoto yuklash xatolik (${maskChatId(chatId)}): ${e2.message}. Fallback 2 (Faqat matn)...`,
        );
        await this.sendMessageSafe(chatId, caption, reply_markup);
      }
    }
  }

  async sendLocation(chatId: string, lat: number, lng: number) {
    try {
      await this.bot.telegram.sendLocation(chatId, lat, lng);
    } catch (e: any) {
      this.logger.error(`Error sending location to ${maskChatId(chatId)}: ${e.message}`);
    }
  }

  async sendSticker(chatId: string, stickerId: string) {
    try {
      await this.bot.telegram.sendSticker(chatId, stickerId);
    } catch (e: any) {
      this.logger.debug(`Error sending sticker to ${maskChatId(chatId)}: ${e.message}`);
    }
  }

  async sendRaw(chatId: string, text: string, replyMarkup?: any) {
    await this.sendMessageSafe(chatId, text, replyMarkup);
  }

  async notifyAdmins(
    message: string,
    location?: { lat: number; lng: number },
    replyMarkup?: any,
  ) {
    if (!this.configService.get('TELEGRAM_BOT_TOKEN')) {
      return;
    }

    const admins = await this.prisma.user.findMany({
      where: {
        role: { in: [UserRole.ADMIN, UserRole.SUPERADMIN] },
        telegramChatId: { not: null },
      },
    });

    for (const admin of admins) {
      if (admin.telegramChatId) {
        try {
          await this.sendMessageSafe(
            admin.telegramChatId,
            message,
            replyMarkup,
          );
          if (location) {
            await this.sendLocation(
              admin.telegramChatId,
              location.lat,
              location.lng,
            );
          }
        } catch (e: any) {
          this.logger.error(
            `Telegram xabarnoma yuborishda xatolik (${maskChatId(admin.telegramChatId)}): ${e.message}`,
          );
        }
      }
    }
  }
}
