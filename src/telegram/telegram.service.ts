import { Injectable, Logger } from '@nestjs/common';
import { InjectBot } from 'nestjs-telegraf';
import { Telegraf, Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TelegramService {
  private readonly logger = new Logger(TelegramService.name);
  private readonly photoCaptionFallback = 'HTML';

  constructor(
    @InjectBot() private bot: Telegraf<Context>,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

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
    } catch (e) {
      this.logger.error(`Error sending photo to ${chatId}: ${e.message}`);
      // Fallback to text if photo fails
      await this.bot.telegram.sendMessage(chatId, caption, {
        parse_mode: this.photoCaptionFallback,
        reply_markup,
      });
    }
  }

  async sendLocation(chatId: string, lat: number, lng: number) {
    try {
      await this.bot.telegram.sendLocation(chatId, lat, lng);
    } catch (e) {
      this.logger.error(`Error sending location to ${chatId}: ${e.message}`);
    }
  }

  async sendSticker(chatId: string, stickerId: string) {
    try {
      await this.bot.telegram.sendSticker(chatId, stickerId);
    } catch (e) {
      this.logger.error(`Error sending sticker to ${chatId}: ${e.message}`);
    }
  }

  async sendRaw(chatId: string, text: string, replyMarkup?: any) {
    try {
      await this.bot.telegram.sendMessage(chatId, text, {
        parse_mode: 'HTML',
        reply_markup: replyMarkup,
      });
    } catch (e) {
      this.logger.error(`Error sendRaw to ${chatId}: ${e.message}`);
    }
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
          await this.bot.telegram.sendMessage(admin.telegramChatId, message, {
            parse_mode: 'HTML',
            reply_markup: replyMarkup,
          });
          if (location) {
            await this.sendLocation(
              admin.telegramChatId,
              location.lat,
              location.lng,
            );
          }
        } catch (e) {
          this.logger.error(
            `Telegram xabarnoma yuborishda xatolik (${admin.telegramChatId}): ${e.message}`,
          );
        }
      }
    }
  }
}
