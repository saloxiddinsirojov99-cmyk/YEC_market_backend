import { Update, Start, On, Command, Ctx } from 'nestjs-telegraf';
import { Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { Logger, BadRequestException } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';
import { UserRole, CarpetInventoryStatus, Prisma } from '@prisma/client';
import { TelegramService } from './telegram.service';
import { formatOrderNumber } from '../common/utils/order-number';
import { verifyTelegramUserJoinToken } from '../common/utils/telegram-link-token';
import { SimilarityService } from '../ai/services/similarity.service';
import { SearchService } from '../carpets/search.service';
import {
  TELEGRAM_BUTTONS,
  normalizeMenuText,
  escapeHtml,
  maskChatId,
} from './telegram.constants';

type CollectionCodeEntry = {
  slug: string;
  path: string;
};

type SellerInviteEntry = {
  createdByChatId: string;
  createdAt: number;
  usedByChatId?: string;
  usedAt?: number;
};

@Update()
export class TelegramUpdate {
  private readonly logger = new Logger(TelegramUpdate.name);
  private readonly DEFAULT_ADMIN = 'Saloxiddin_977';
  private readonly MENU_MAIN_SEARCH = '🔍 Gilam qidirish';
  private readonly MENU_MAIN_NEW_ORDERS = '📦 Buyurtmalar';
  private readonly MENU_MAIN_ADD_ADMIN = '👥 Adminlar';
  private readonly MENU_MAIN_ADD_SELLER = '🤝 Sotuvchilar';
  private readonly MENU_MAIN_COURIERS = '🚚 Kuryerlar';
  private readonly MENU_SELLERS_ALL = '📋 Barcha sotuvchilar';
  private readonly MENU_SELLERS_ADD = "➕ Sotuvchi qo'shish";
  private readonly MENU_SELLERS_BACK = '🔙 Orqaga';
  private readonly MENU_COURIERS_ALL = '📋 Barcha kuryerlar';
  private readonly MENU_COURIERS_ADD = "➕ Kuryer qo'shish";
  private readonly MENU_COURIERS_BACK = '🔙 Orqaga';
  private readonly MENU_COURIER_ORDERS = '📦 Mening buyurtmalarim';
  private readonly MENU_SEARCH_IMAGE = '🖼️ Rasm bilan qidirish';

  private readonly MENU_SEARCH_NAME = "🏷️ Nom bo'yicha";
  private readonly MENU_SEARCH_CODE = '🔢 Gul kodi bilan';
  private readonly MENU_SEARCH_SIZE = "📏 O'lcham bo'yicha";
  private readonly MENU_SEARCH_CATEGORY = "📂 Kategoriya bo'yicha";
  private readonly MENU_BACK = '🔙 Orqaga';
  private readonly MENU_CUSTOMER_ORDERS = '📦 Buyurtmalarim';
  private readonly MENU_CUSTOMER_BRANCHES = '🏢 Filiallar';
  private readonly MENU_CUSTOMER_CONTACT_ADMIN = "💬 Admin bilan bog'lanish";
  private readonly MENU_CUSTOMER_SEND_CONTACT = '📞 Telefonni yuborish';
  private readonly MENU_CUSTOMER_BACK = '🏠 Menyuga qaytish';

  private collectionCodeMap: Map<string, CollectionCodeEntry[]> | null = null;
  private collectionNameToSlug: Map<string, string> | null = null;
  private frontPublicDir: string | null = null;

  // In-memory pending admin requests: chatId -> { username, firstName }
  private readonly pendingRequests = new Map<
    string,
    { username: string; firstName: string }
  >();
  // Pre-approved by admins (chatId -> true), waiting for website registration
  private readonly preApprovedChatIds = new Set<string>();
  // Rejected by admins
  private readonly rejectedChatIds = new Set<string>();
  // Chats waiting for carpet search query
  private readonly carpetSearchState = new Set<string>();
  private readonly searchNameState = new Set<string>();
  private readonly searchCodeState = new Set<string>();
  private readonly searchSizeState = new Set<string>();
  private readonly searchCategoryState = new Set<string>();
  private readonly pendingCustomerContactRequests = new Set<string>();
  private readonly broadcastState = new Set<string>();
  private readonly pendingSellerApprovals = new Set<string>();
  private readonly pendingCourierApprovals = new Set<string>();
  private readonly sellerInviteTokens = new Map<string, SellerInviteEntry>();
  private readonly courierInviteTokens = new Map<string, SellerInviteEntry>();
  private readonly pendingReturnApprovals = new Map<string, string>();
  private readonly sellerInviteTokenTtlMs = 1000 * 60 * 60 * 24;
  private readonly activePhotoSearchChats = new Set<string>();
  // Active user search queries and filter selections
  private readonly userSearchState = new Map<
    string,
    {
      query: string;
      categoryId?: string;
      shape?: string;
      size?: string;
      minPrice?: number;
      maxPrice?: number;
      material?: string;
      onlyAvailable?: boolean;
      onlyPromo?: boolean;
      onlyNew?: boolean;
      page: number;
    }
  >();
  private readonly imageSearchMaxCandidates = this.readPositiveIntEnv(
    'TELEGRAM_IMAGE_MATCH_LIMIT',
    60,
  );
  private readonly imageSearchBatchSize = this.readPositiveIntEnv(
    'TELEGRAM_IMAGE_MATCH_BATCH',
    4,
  );

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly similarityService: SimilarityService,
    private readonly searchService: SearchService,
  ) {}

  private getTelegramLinkSecret(): string {
    const tokenSecret = process.env.TELEGRAM_LINK_SECRET?.trim();
    if (tokenSecret) return tokenSecret;

    const jwtSecret = process.env.JWT_SECRET?.trim();
    if (jwtSecret) return jwtSecret;

    return 'fallback-telegram-link-secret';
  }

  private purgeExpiredTokens() {
    const now = Date.now();
    for (const [token, entry] of this.sellerInviteTokens.entries()) {
      if (now - entry.createdAt > this.sellerInviteTokenTtlMs) {
        this.sellerInviteTokens.delete(token);
      }
    }
    for (const [token, entry] of this.courierInviteTokens.entries()) {
      if (now - entry.createdAt > this.sellerInviteTokenTtlMs) {
        this.courierInviteTokens.delete(token);
      }
    }
  }

  private createSellerInviteToken(createdByChatId: string): string {
    this.purgeExpiredTokens();
    const token = randomBytes(24).toString('hex');
    this.sellerInviteTokens.set(token, {
      createdByChatId,
      createdAt: Date.now(),
    });
    return token;
  }

  private createCourierInviteToken(createdByChatId: string): string {
    this.purgeExpiredTokens();
    const token = randomBytes(24).toString('hex');
    this.courierInviteTokens.set(token, {
      createdByChatId,
      createdAt: Date.now(),
    });
    return token;
  }

  private buildMainKeyboard(isSuperAdmin = false) {
    const rows = [
      [{ text: this.MENU_MAIN_SEARCH }, { text: this.MENU_MAIN_NEW_ORDERS }],
    ];

    const secondRow: any[] = [];
    if (isSuperAdmin) {
      secondRow.push({ text: this.MENU_MAIN_ADD_ADMIN });
    }
    secondRow.push({ text: this.MENU_MAIN_ADD_SELLER });
    rows.push(secondRow);

    rows.push([{ text: this.MENU_MAIN_COURIERS }]);

    return {
      reply_markup: {
        keyboard: rows,
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: 'Qidirish uchun nomini kiriting...',
      },
    };
  }

  private buildSellerKeyboard() {
    return {
      reply_markup: {
        keyboard: [[{ text: this.MENU_MAIN_SEARCH }]],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: 'Qidirish uchun nomini kiriting...',
      },
    };
  }

  private buildCourierKeyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: this.MENU_COURIER_ORDERS }],
          [{ text: this.MENU_MAIN_SEARCH }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: 'Kuryer menyusi',
      },
    };
  }

  private buildSellerManagementKeyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: this.MENU_SELLERS_ALL }],
          [{ text: this.MENU_SELLERS_ADD }],
          [{ text: this.MENU_SELLERS_BACK }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: "Sotuvchilar bo'limi",
      },
    };
  }

  private buildCourierManagementKeyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: this.MENU_COURIERS_ALL }],
          [{ text: this.MENU_COURIERS_ADD }],
          [{ text: this.MENU_COURIERS_BACK }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: "Kuryerlar bo'limi",
      },
    };
  }

  private buildCustomerKeyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: '🔍 Gilam qidirish' }, { text: '🖼 Rasm orqali qidirish' }],
          [{ text: '📂 Kategoriyalar' }, { text: "📏 O'lcham bo'yicha" }],
          [{ text: '💎 Premium' }, { text: '❤️ Sevimlilar' }],
          [{ text: '📞 Operator' }, { text: '⚙ Sozlamalar' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: "Bo'limni tanlang...",
      },
    };
  }

  private async buildSearchKeyboard(ctx: Context) {
    const isAdmin = await this.isAdmin(ctx);
    const isSeller = await this.isSeller(ctx);
    const isSpecial = isAdmin || isSeller;

    const keyboard: any[] = [[{ text: this.MENU_BACK }]];

    if (isSpecial) {
      keyboard.push([
        { text: this.MENU_SEARCH_IMAGE },
        { text: this.MENU_SEARCH_CODE },
      ]);
    }

    keyboard.push([
      { text: this.MENU_SEARCH_SIZE },
      { text: this.MENU_SEARCH_CATEGORY },
    ]);

    keyboard.push([{ text: this.MENU_SEARCH_NAME }]);

    return {
      reply_markup: {
        keyboard: keyboard,
        resize_keyboard: true,
        one_time_keyboard: false,
        is_persistent: true,
        input_field_placeholder: 'Qidiruv turini tanlang',
      },
    };
  }

  private clearSearchState(chatId: string) {
    this.searchNameState.delete(chatId);
    this.searchCodeState.delete(chatId);
    this.searchSizeState.delete(chatId);
    this.searchCategoryState.delete(chatId);
    this.activePhotoSearchChats.delete(chatId);
  }

  private async showMainMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ?? 'Asosiy menyu. Pastdagi tugmalardan foydalaning.',
      this.buildMainKeyboard(await this.isSuperAdmin(ctx)),
    );
  }

  private async showSellerMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ?? 'Sotuvchi menyusi. Qidiruvni ishlating:',
      this.buildSellerKeyboard(),
    );
  }

  private async showCourierMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ?? "Kuryer menyusi. Kerakli bo'limni tanlang:",
      this.buildCourierKeyboard(),
    );
  }

  private async showCustomerMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ??
        "Mijoz menyusi. Buyurtmalarni ko'rish, filiallar va admin bilan bog'lanish bo'limlari mavjud.",
      this.buildCustomerKeyboard(),
    );
  }

  private async showSellerManagementMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ?? "Sotuvchilar bo'limi: kerakli amalni tanlang.",
      this.buildSellerManagementKeyboard(),
    );
  }

  private async showCourierManagementMenu(ctx: Context, message?: string) {
    await ctx.reply(
      message ?? "Kuryerlar bo'limi: kerakli amalni tanlang.",
      this.buildCourierManagementKeyboard(),
    );
  }

  private async showSearchMenu(ctx: Context) {
    await this.sendOptionalSticker(ctx, 'search');
    await ctx.reply(
      '🔍 Qanday qidiruvni amalga oshirmoqchisiz? Pastdagi tugmalardan birini tanlang:',
      await this.buildSearchKeyboard(ctx),
    );
  }

  private async sendOptionalSticker(
    ctx: Context,
    type: 'welcome' | 'search' | 'success' | 'empty',
  ) {
    const stickers = {
      welcome:
        'CAACAgIAAxkBAAIBjGaZ_dUpzGvV8Ssd4X0T8sC3q7cAAgEAA1KJ4gsVGBM0X3fEBCQE',
      search:
        'CAACAgIAAxkBAAIBjGaZ_dUpzGvV8Ssd4X0T8sC3q7cAAgEAA1KJ4gsVGBM0X3fEBCQE',
      success:
        'CAACAgIAAxkBAAIBjGaZ_dUpzGvV8Ssd4X0T8sC3q7cAAgEAA1KJ4gsVGBM0X3fEBCQE',
      empty:
        'CAACAgIAAxkBAAIBjGaZ_dUpzGvV8Ssd4X0T8sC3q7cAAgEAA1KJ4gsVGBM0X3fEBCQE',
    };
    const stickerId = stickers[type];
    if (stickerId) {
      try {
        await ctx.replyWithSticker(stickerId);
      } catch (err) {
        this.logger.log(`Sticker [${type}] send failed, skipping.`);
      }
    }
  }

  private buildBackFirstKeyboard(options: string[], placeholder: string) {
    const rows: Array<Array<{ text: string }>> = [[{ text: this.MENU_BACK }]];
    for (let i = 0; i < options.length; i += 2) {
      rows.push(options.slice(i, i + 2).map((option) => ({ text: option })));
    }

    return {
      reply_markup: {
        keyboard: rows,
        resize_keyboard: true,
        one_time_keyboard: false,
        is_persistent: true,
        input_field_placeholder: placeholder,
      },
    };
  }

  private async getAvailableSizes(): Promise<string[]> {
    const items = await this.prisma.inventoryItem.findMany({
      where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
      select: { size: true },
      take: 500,
    });

    const unique = new Set<string>();
    for (const item of items) {
      const size = (item.size || '').trim();
      if (!size) continue;
      unique.add(size);
    }

    return Array.from(unique).sort((a, b) =>
      a.localeCompare(b, 'uz', { sensitivity: 'base' }),
    );
  }

  private async getAvailableCategoryNames(): Promise<string[]> {
    const categories = await this.prisma.category.findMany({
      where: {
        carpets: {
          some: {
            inventoryItems: {
              some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
          },
        },
      },
      select: { name: true },
      orderBy: { name: 'asc' },
      take: 100,
    });

    return categories
      .map((category) => (category.name || '').trim())
      .filter(Boolean);
  }

  private async getAvailableNames(): Promise<string[]> {
    const carpets = await this.prisma.carpet.findMany({
      where: {
        inventoryItems: {
          some: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
        },
      },
      select: { name: true },
      orderBy: { name: 'asc' },
      take: 500,
    });

    const unique = new Set<string>();
    for (const carpet of carpets) {
      const name = (carpet.name || '').trim();
      if (!name) continue;
      unique.add(name);
    }

    return Array.from(unique).sort((a, b) =>
      a.localeCompare(b, 'uz', { sensitivity: 'base' }),
    );
  }

  private async showAllSellers(ctx: Context) {
    const sellers = await this.prisma.user.findMany({
      where: { role: UserRole.SELLER },
      select: {
        name: true,
        phone: true,
        telegramUsername: true,
        telegramChatId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    if (sellers.length === 0) {
      await ctx.reply(
        "ℹ️ Hozircha sotuvchilar ro'yxati bo'sh.",
        this.buildSellerManagementKeyboard(),
      );
      return;
    }

    const header = `👥 <b>Sotuvchilar ro'yxati</b> (${sellers.length} ta):\n\n`;
    const lines = sellers.map((seller, index) => {
      const tg = seller.telegramUsername
        ? `@${seller.telegramUsername}`
        : seller.telegramChatId || "bog'lanmagan";
      return `${index + 1}. <b>${seller.name}</b>\n📞 ${seller.phone}\n📱 ${tg}`;
    });

    await ctx.reply(`${header}${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
      ...this.buildSellerManagementKeyboard(),
    });
  }

  private async showAllCouriers(ctx: Context) {
    const couriers = await this.prisma.user.findMany({
      where: { role: UserRole.COURIER },
      select: {
        name: true,
        phone: true,
        telegramUsername: true,
        telegramChatId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    if (couriers.length === 0) {
      await ctx.reply(
        "Hozircha kuryerlar ro'yxati bo'sh.",
        this.buildCourierManagementKeyboard(),
      );
      return;
    }

    const header = `<b>Kuryerlar ro'yxati</b> (${couriers.length} ta):\n\n`;
    const lines = couriers.map((courier, index) => {
      const tg = courier.telegramUsername
        ? `@${courier.telegramUsername}`
        : courier.telegramChatId || "bog'lanmagan";
      return `${index + 1}. <b>${courier.name}</b>\nTelefon: ${courier.phone}\nTelegram: ${tg}`;
    });

    await ctx.reply(`${header}${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
      ...this.buildCourierManagementKeyboard(),
    });
  }

  private async handleInviteLink(ctx: Context) {
    const adminSecret =
      process.env.ADMIN_INVITE_SECRET || 'yec_toshkent_admin_secret_2024';
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=admin_join_${adminSecret}`;
    await ctx.reply(
      `👤 Yangi admin qo'shish uchun linkni bosing yoki ulashing:\n\n<a href="${inviteLink}">Admin bo'lish uchun botni ochish</a>\n\n‼️ Faqat ishonchli odamlarga yuboring!`,
      {
        parse_mode: 'HTML',
        ...this.buildMainKeyboard(await this.isSuperAdmin(ctx)),
      },
    );
  }

  private async handleSellerInviteLink(ctx: Context) {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) {
      await ctx.reply("❌ Chat ID topilmadi. Qayta urinib ko'ring.");
      return;
    }

    const botUsername = ctx.botInfo.username;
    const sellerInviteToken = this.createSellerInviteToken(chatId);
    const inviteLink = `https://t.me/${botUsername}?start=seller_join_${sellerInviteToken}`;
    await ctx.reply(
      `👥 Yangi sotuvchi qo'shish uchun bir martalik link:\n\n<a href="${inviteLink}">Sotuvchi bo'lish uchun botni ochish</a>\n\nℹ️ Linkni birinchi bo'lib ochgan odam uchun ishlaydi va keyin avtomatik bekor bo'ladi.`,
      { parse_mode: 'HTML', ...this.buildSellerManagementKeyboard() },
    );
  }

  private async handleCourierInviteLink(ctx: Context) {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) {
      await ctx.reply("❌ Chat ID topilmadi. Qayta urinib ko'ring.");
      return;
    }

    const botUsername = ctx.botInfo.username;
    const courierInviteToken = this.createCourierInviteToken(chatId);
    const inviteLink = `https://t.me/${botUsername}?start=courier_join_${courierInviteToken}`;
    await ctx.reply(
      `🚚 Yangi kuryer qo'shish uchun bir martalik link:\n\n<a href="${inviteLink}">Kuryer bo'lish uchun botni ochish</a>\n\nℹ️ Linkni birinchi bo'lib ochgan odam uchun ishlaydi va keyin avtomatik bekor bo'ladi.`,
      { parse_mode: 'HTML', ...this.buildCourierManagementKeyboard() },
    );
  }

  private async handleNewOrders(ctx: Context) {
    const orders = await this.prisma.order.findMany({
      include: {
        items: {
          include: { carpet: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 3,
    });
    if (orders.length === 0) {
      await ctx.reply(
        "📋 Hozircha hech qanday buyurtma yo'q.",
        this.buildMainKeyboard(await this.isSuperAdmin(ctx)),
      );
      return;
    }

    const msgs = orders.map((order) => {
      const itemsText = order.items
        .map((i) => `- ${i.carpet?.name ?? "Noma'lum gilam"} x${i.quantity}`)
        .join('\n');

      let statusIcon = '⏳';
      if (order.status === 'ACCEPTED') statusIcon = '✅';
      if (order.status === 'ON_WAY') statusIcon = '🚚';
      if (order.status === 'DELIVERED') statusIcon = '🎉';
      if (order.status === 'CANCELLED') statusIcon = '❌';

      return (
        `📦 <b>Buyurtma #${formatOrderNumber(order.id, order.createdAt)}</b>\n` +
        `👤 Mijoz: ${order.customerName}\n` +
        `📞 Tel: ${(order as any).phone || "Noma'lum"}\n` +
        `📍 Manzil: ${order.address}\n` +
        `${statusIcon} Holati: ${order.status}\n\n` +
        `📍 Mahsulotlar:\n${itemsText}`
      );
    });

    for (const msg of msgs) {
      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...this.buildMainKeyboard(await this.isSuperAdmin(ctx)),
      });
    }
  }

  private async handleCourierOrders(ctx: Context) {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) {
      await ctx.reply('Chat ID topilmadi.');
      return;
    }

    const courier = await this.prisma.user.findUnique({
      where: { telegramChatId: chatId },
      select: { id: true, name: true, role: true },
    });

    if (!courier || courier.role !== UserRole.COURIER) {
      await ctx.reply('Kuryer profili topilmadi.', this.buildCourierKeyboard());
      return;
    }

    const orders = await this.prisma.order.findMany({
      where: {
        courierId: courier.id,
        status: { in: ['ACCEPTED', 'ON_WAY'] },
      },
      include: {
        items: {
          include: { carpet: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });

    if (orders.length === 0) {
      await ctx.reply(
        "Hozircha sizga biriktirilgan faol buyurtmalar yo'q.",
        this.buildCourierKeyboard(),
      );
      return;
    }

    await ctx.reply(
      `Sizga biriktirilgan buyurtmalar: ${orders.length} ta`,
      this.buildCourierKeyboard(),
    );

    for (const order of orders) {
      const itemsText = order.items
        .map((i) => `- ${i.carpet?.name ?? "Noma'lum gilam"} x${i.quantity}`)
        .join('\n');

      const statusText =
        order.status === 'ON_WAY'
          ? "Yo'lda"
          : order.status === 'ACCEPTED'
            ? 'Qabul qilingan'
            : order.status;

      const msg =
        `<b>Buyurtma #${formatOrderNumber(order.id, order.createdAt)}</b>\n` +
        `Mijoz: ${order.customerName}\n` +
        `Tel: ${(order as any).phone || "Noma'lum"}\n` +
        `Manzil: ${order.address}\n` +
        `Holati: ${statusText}\n\n` +
        `Mahsulotlar:\n${itemsText}`;

      if (order.status === 'ON_WAY') {
        await ctx.reply(msg, {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: 'Yetkazdim',
                  callback_data: `courier_delivered_${order.id}`,
                },
              ],
            ],
          },
        });
      } else {
        await ctx.reply(msg, { parse_mode: 'HTML' });
      }
    }
  }

  @Start()
  async onStart(@Ctx() ctx: Context) {
    const chatId = ctx.chat!.id.toString();
    const username = ctx.from?.username || '';
    const firstName = ctx.from?.first_name || '';

    await this.sendOptionalSticker(ctx, 'welcome');

    const text = (ctx as any).message?.text || '';
    const isUserJoinToken = text.includes('user_join_');

    if (isUserJoinToken) {
      const match = text.match(/user_join_([a-zA-Z0-9_-]+)/);
      const rawToken = match ? match[1] : '';
      const userId = rawToken
        ? verifyTelegramUserJoinToken(rawToken, this.getTelegramLinkSecret())
        : null;

      if (!userId) {
        const existingLinked = await this.prisma.user.findFirst({
          where: {
            OR: [
              { telegramChatId: chatId },
              ...(username ? [{ telegramUsername: username }] : []),
            ],
          },
        });
        if (existingLinked) {
          await ctx.reply(
            `✅ Salom, <b>${existingLinked.name}</b>!\n\nProfilingiz allaqachon botga bog'langan. Saytda buyurtmani davom ettirishingiz mumkin.`,
            {
              parse_mode: 'HTML',
              reply_markup: {
                keyboard: [[{ text: this.MENU_MAIN_SEARCH }]],
                resize_keyboard: true,
              },
            },
          );
          return;
        }

        await ctx.reply(
          "❌ Bu biriktirish havolasi yaroqsiz yoki muddati o'tgan. Saytdan botga qayta kirib ko'ring.",
        );
        return;
      }

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, role: true },
      });

      if (!user) {
        await ctx.reply(
          '❌ Foydalanuvchi topilmadi. Iltimos, saytga qayta kiring va botga qayta ulaning.',
        );
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: { id: { not: user.id }, telegramChatId: chatId },
          data: { telegramChatId: null },
        });

        if (username) {
          await tx.user.updateMany({
            where: { id: { not: user.id }, telegramUsername: username },
            data: { telegramUsername: null },
          });
        }

        await tx.user.update({
          where: { id: user.id },
          data: {
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });

      let linkedRole = user.role;

      if (this.pendingCourierApprovals.has(chatId)) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            role: UserRole.COURIER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });

        this.pendingCourierApprovals.delete(chatId);
        linkedRole = UserRole.COURIER;
      }

      if (linkedRole === UserRole.COURIER) {
        await ctx.reply(
          `✅ ${user.name}, siz kuryer sifatida faollashtirildingiz.`,
          this.buildCourierKeyboard(),
        );
        return;
      }

      if (linkedRole === UserRole.SELLER) {
        await ctx.reply(
          `✅ ${user.name}, Telegram profilingiz muvaffaqiyatli bog'landi.`,
          { ...this.buildSellerKeyboard() },
        );
        return;
      }

      if (linkedRole === UserRole.ADMIN || linkedRole === UserRole.SUPERADMIN) {
        await ctx.reply(
          `✅ ${user.name}, Telegram profilingiz muvaffaqiyatli bog'landi.`,
          { ...this.buildMainKeyboard(await this.isSuperAdmin(ctx)) },
        );
        return;
      }

      await ctx.reply(
        `✅ ${user.name}, Telegram profilingiz muvaffaqiyatli bog'landi. Endi saytda buyurtma berishingiz mumkin.`,
        {
          reply_markup: {
            keyboard: [[{ text: this.MENU_MAIN_SEARCH }]],
            resize_keyboard: true,
            input_field_placeholder: 'Gilam nomini yozing...',
          },
        },
      );
      return;
    }

    if (text.startsWith('/start seller_join_')) {
      const token = text.replace('/start seller_join_', '').trim();
      this.purgeExpiredTokens();
      const inviteEntry = this.sellerInviteTokens.get(token);

      if (!inviteEntry) {
        await ctx.reply('❌ Sotuvchi havolasi yaroqsiz yoki muddati tugagan.');
        return;
      }

      if (inviteEntry.usedByChatId && inviteEntry.usedByChatId !== chatId) {
        await ctx.reply(
          '❌ Bu havola allaqachon boshqa foydalanuvchi tomonidan ishlatilgan.',
        );
        return;
      }

      const existingSellerCandidate = await this.prisma.user.findFirst({
        where: {
          OR: [
            { telegramChatId: chatId },
            {
              telegramUsername:
                username && username !== '' ? username : undefined,
            },
          ],
        },
      });

      if (
        existingSellerCandidate &&
        (existingSellerCandidate.role === UserRole.ADMIN ||
          existingSellerCandidate.role === UserRole.SUPERADMIN)
      ) {
        await ctx.reply(
          "ℹ️ Admin akkaunt sotuvchiga o'tkazilmaydi. Kerak bo'lsa boshqa akkauntdan kiring.",
        );
        return;
      }

      if (!inviteEntry.usedByChatId) {
        inviteEntry.usedByChatId = chatId;
        inviteEntry.usedAt = Date.now();
        this.sellerInviteTokens.set(token, inviteEntry);
      }

      if (!existingSellerCandidate) {
        this.pendingSellerApprovals.add(chatId);
        await ctx.reply(
          "✅ Siz sotuvchi sifatida tasdiqlandingiz. Endi yecmarket.uz saytida ro'yxatdan o'ting va keyin /start bosing.",
        );
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: {
            id: { not: existingSellerCandidate.id },
            telegramChatId: chatId,
          },
          data: { telegramChatId: null },
        });

        if (username) {
          await tx.user.updateMany({
            where: {
              id: { not: existingSellerCandidate.id },
              telegramUsername: username,
            },
            data: { telegramUsername: null },
          });
        }

        await tx.user.update({
          where: { id: existingSellerCandidate.id },
          data: {
            role: UserRole.SELLER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });

      this.pendingSellerApprovals.delete(chatId);
      await ctx.reply(
        `✅ ${existingSellerCandidate.name}, siz sotuvchi sifatida tayinlandingiz.`,
        { ...this.buildSellerKeyboard() },
      );
      return;
    }

    if (text.startsWith('/start courier_join_')) {
      const token = text.replace('/start courier_join_', '').trim();
      this.purgeExpiredTokens();
      const inviteEntry = this.courierInviteTokens.get(token);

      if (!inviteEntry) {
        await ctx.reply('❌ Kuryer havolasi yaroqsiz yoki muddati tugagan.');
        return;
      }

      if (inviteEntry.usedByChatId && inviteEntry.usedByChatId !== chatId) {
        await ctx.reply(
          '❌ Bu havola allaqachon boshqa foydalanuvchi tomonidan ishlatilgan.',
        );
        return;
      }

      const existingCourierCandidate = await this.prisma.user.findFirst({
        where: {
          OR: [
            { telegramChatId: chatId },
            {
              telegramUsername:
                username && username !== '' ? username : undefined,
            },
          ],
        },
      });

      if (!inviteEntry.usedByChatId) {
        inviteEntry.usedByChatId = chatId;
        inviteEntry.usedAt = Date.now();
        this.courierInviteTokens.set(token, inviteEntry);
      }

      if (!existingCourierCandidate) {
        const autoName =
          firstName?.trim() ||
          (username ? `@${username}` : `Kuryer ${chatId.slice(-4)}`);
        const phoneDigits = chatId
          .replace(/\D/g, '')
          .slice(-9)
          .padStart(9, '0');
        const autoPhone = `+998${phoneDigits}`;
        const autoEmail = `tg-courier-${chatId}-${Date.now()}@yec.local`;
        const autoPassword = await bcrypt.hash(
          randomBytes(24).toString('hex'),
          10,
        );

        await this.prisma.user.create({
          data: {
            name: autoName,
            email: autoEmail,
            phone: autoPhone,
            password: autoPassword,
            role: UserRole.COURIER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });

        this.pendingCourierApprovals.delete(chatId);
        await ctx.reply(
          `✅ ${autoName}, siz kuryer sifatida tayinlandingiz.`,
          this.buildCourierKeyboard(),
        );
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: {
            id: { not: existingCourierCandidate.id },
            telegramChatId: chatId,
          },
          data: { telegramChatId: null },
        });
        if (username) {
          await tx.user.updateMany({
            where: {
              id: { not: existingCourierCandidate.id },
              telegramUsername: username,
            },
            data: { telegramUsername: null },
          });
        }
        await tx.user.update({
          where: { id: existingCourierCandidate.id },
          data: {
            role: UserRole.COURIER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });

      this.pendingCourierApprovals.delete(chatId);
      await ctx.reply(
        `✅ ${existingCourierCandidate.name}, siz kuryer sifatida tayinlandingiz.`,
        this.buildCourierKeyboard(),
      );
      return;
    }

    if (text.startsWith('/start admin_join_')) {
      const secret = text.replace('/start admin_join_', '');
      const expectedSecret =
        process.env.ADMIN_INVITE_SECRET || 'yec_toshkent_admin_secret_2024';

      if (secret !== expectedSecret) {
        await ctx.reply('❌ Yaroqsiz yoki eskirgan taklif havolasi.');
        return;
      }
      if (this.pendingRequests.has(chatId)) {
        await ctx.reply(
          "⏳ Sizning so'rovingiz allaqachon yuborilgan. Adminlar ko'rib chiqmoqda, iltimos kuting.",
        );
        return;
      }

      // C. Already pre-approved -> they need to register on the website
      if (this.preApprovedChatIds.has(chatId)) {
        await ctx.reply(
          "✅ Adminlar sizni tasdiqlagan! Agar hali ro'yxatdan o'tmagan bo'lsangiz, yecmarket.uz saytida ro'yxatdan o'ting va /start deb yozing.",
        );
        return;
      }

      // D. Check if in DB -> promote immediately
      const existingUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { telegramChatId: chatId },
            {
              telegramUsername:
                username && username !== '' ? username : undefined,
            },
          ],
        },
      });

      if (existingUser) {
        await this.prisma.user.update({
          where: { id: existingUser.id },
          data: {
            role: UserRole.ADMIN,
            telegramChatId: chatId,
            telegramUsername: username,
          },
        });
        await ctx.reply(
          `✅ Tabriklaymiz, <b>${existingUser.name}</b>! Siz endi <b>Admin</b> sifatida tayinlandingiz.`,
          { parse_mode: 'HTML' },
        );
        return;
      }

      // E. Not in DB -> save as pending and notify all admins
      this.pendingRequests.set(chatId, { username, firstName });
      await ctx.reply(
        `⏳ Salom, <b>${firstName}</b>! Sizning admin bo'lish so'rovingiz adminlarga yuborildi. Ular tasdiqlasa, siz ham admin bo'lasiz.\n\nAgar hali saytda ro'yxatdan o'tmagan bo'lsangiz, <b>yecmarket.uz</b> saytida ro'yxatdan o'ting.`,
        { parse_mode: 'HTML' },
      );

      // Notify all admins
      const admins = await this.prisma.user.findMany({
        where: {
          role: { in: [UserRole.ADMIN, UserRole.SUPERADMIN] },
          telegramChatId: { not: null },
        },
      });

      const noticeText = `👤 <b>Yangi admin so'rovi!</b>\n\nIsm: <b>${firstName}</b>\nUsername: ${username ? `@${username}` : "yo'q"}\nTelegram ID: <code>${chatId}</code>\n\nUshbu odamni admin qilishni xohlaysizmi?`;
      const keyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: '✅ Tasdiqlash',
                callback_data: `approve_admin_${chatId}`,
              },
              { text: '❌ Rad etish', callback_data: `reject_admin_${chatId}` },
            ],
          ],
        },
        parse_mode: 'HTML' as const,
      };

      for (const admin of admins) {
        if (admin.telegramChatId) {
          try {
            await this.telegramService.sendRaw(
              admin.telegramChatId,
              noticeText,
              keyboard.reply_markup,
            );
          } catch (e) {
            this.logger.error(
              `Admin ${admin.telegramChatId} ga xabar yuborishda xatolik: ${e.message}`,
            );
          }
        }
      }
      return;
    }

    // 1. Check if user exists by telegramChatId or telegramUsername
    let user = await this.prisma.user.findFirst({
      where: {
        OR: [
          { telegramChatId: chatId },
          {
            telegramUsername:
              username && username !== '' ? username : undefined,
          },
        ],
      },
    });

    if (this.pendingSellerApprovals.has(chatId)) {
      if (!user) {
        await ctx.reply(
          "✅ Siz sotuvchi sifatida tasdiqlangansiz. Iltimos, avval yecmarket.uz saytida ro'yxatdan o'ting, keyin /start bosing.",
        );
        return;
      }

      const approvedUser = user;
      if (
        approvedUser.role === UserRole.ADMIN ||
        approvedUser.role === UserRole.SUPERADMIN
      ) {
        this.pendingSellerApprovals.delete(chatId);
        await ctx.reply(
          "ℹ️ Admin akkaunt sotuvchiga o'tkazilmaydi.",
          this.buildMainKeyboard(approvedUser.role === UserRole.SUPERADMIN),
        );
        return;
      }
      user = await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: {
            id: { not: approvedUser.id },
            telegramChatId: chatId,
          },
          data: { telegramChatId: null },
        });

        if (username) {
          await tx.user.updateMany({
            where: {
              id: { not: approvedUser.id },
              telegramUsername: username,
            },
            data: { telegramUsername: null },
          });
        }

        return tx.user.update({
          where: { id: approvedUser.id },
          data: {
            role: UserRole.SELLER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });

      this.pendingSellerApprovals.delete(chatId);
      await ctx.reply(
        `✅ ${user.name}, siz sotuvchi sifatida faollashtirildingiz.`,
        { ...this.buildSellerKeyboard() },
      );
      return;
    }

    if (this.pendingCourierApprovals.has(chatId)) {
      if (!user) {
        await ctx.reply(
          "✅ Siz kuryer sifatida tasdiqlangansiz. Iltimos, avval yecmarket.uz saytida ro'yxatdan o'ting, keyin /start bosing.",
        );
        return;
      }
      const approvedUser = user;
      user = await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: { id: { not: approvedUser.id }, telegramChatId: chatId },
          data: { telegramChatId: null },
        });
        if (username) {
          await tx.user.updateMany({
            where: { id: { not: approvedUser.id }, telegramUsername: username },
            data: { telegramUsername: null },
          });
        }
        return tx.user.update({
          where: { id: approvedUser.id },
          data: {
            role: UserRole.COURIER,
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });
      this.pendingCourierApprovals.delete(chatId);
      await ctx.reply(
        `✅ ${user.name}, siz kuryer sifatida faollashtirildingiz.`,
        this.buildCourierKeyboard(),
      );
      return;
    }

    const adminKeyboard = this.buildMainKeyboard(await this.isSuperAdmin(ctx));

    // 2. Handle Default Admin linking
    if (username === this.DEFAULT_ADMIN) {
      if (!user) {
        user = await this.prisma.user.findFirst({
          where: {
            OR: [
              { name: { contains: 'Saloxiddin', mode: 'insensitive' } },
              { email: 'saloxiddinsirojov99@gmail.com' },
            ],
          },
        });
      }

      if (user) {
        const isAlreadyLinked = user.telegramChatId === chatId;
        await this.prisma.user.update({
          where: { id: user.id },
          data: {
            telegramChatId: chatId,
            telegramUsername: username,
            role: UserRole.SUPERADMIN,
          },
        });

        const msg = isAlreadyLinked
          ? `👋 Xush kelibsiz, <b>Super Admin</b> janoblari!\n\nNimani qilmoqchisiz?`
          : `✅ Xush kelibsiz, Super Admin <b>@${username}</b>! Telegram hisobingiz muvaffaqiyatli bog'landi.`;

        await ctx.reply(msg, { parse_mode: 'HTML', ...adminKeyboard });
      } else {
        await ctx.reply(
          `❌ Xush kelibsiz, @${username}! Tizimda sizning ismingizga mos foydalanuvchi topilmadi. Iltimos, avval saytda ro'yxatdan o'ting.`,
        );
      }
      return;
    }

    // Handle existing users (Sellers)
    if (user && user.id && user.role === UserRole.SELLER) {
      const isAlreadyLinked = user.telegramChatId === chatId;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId, telegramUsername: username },
      });

      const msg = isAlreadyLinked
        ? `👋 Xush kelibsiz, <b>Sotuvchi</b>!\n\nQidiruv tugmasidan foydalanib mahsulot izlashingiz mumkin.`
        : `✅ Xush kelibsiz! Siz sotuvchi sifatida tanindingiz.`;

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...this.buildSellerKeyboard(),
      });
      return;
    }

    // Handle existing users (Couriers)
    if (user && user.id && user.role === UserRole.COURIER) {
      const isAlreadyLinked = user.telegramChatId === chatId;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId, telegramUsername: username },
      });

      const msg = isAlreadyLinked
        ? `Xush kelibsiz, <b>Kuryer</b>!`
        : `Xush kelibsiz! Siz kuryer sifatida tanindingiz.`;

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...this.buildCourierKeyboard(),
      });
      return;
    }

    // Handle existing users (Admins/Super Admins)
    if (
      user &&
      user.id &&
      (user.role === UserRole.ADMIN || user.role === UserRole.SUPERADMIN)
    ) {
      const isAlreadyLinked = user.telegramChatId === chatId;
      await this.prisma.user.update({
        where: { id: user.id },
        data: { telegramChatId: chatId, telegramUsername: username },
      });

      const msg = isAlreadyLinked
        ? `👋 Xush kelibsiz, <b>${user.role === UserRole.SUPERADMIN ? 'Super Admin' : 'Admin'}</b> janoblari!\n\nNimani qilmoqchisiz?`
        : `✅ Xush kelibsiz! Siz admin sifatida tanindingiz.`;

      await ctx.reply(msg, { parse_mode: 'HTML', ...adminKeyboard });
      return;
    }

    // Default: Welcome everyone and show search instructions
    if (!user || !user.telegramChatId) {
      const welcomeMsg = `👋 Salom, <b>${firstName}</b>!\n\n<b>YEC Market</b> botiga xush kelibsiz.\n\nSaytimiz orqali buyurtma berish uchun, iltimos avval bot yordamida profilingizni tasdiqlang. (Pastdagi tugmani bosing)`;
      await ctx.reply(welcomeMsg, {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [
            [{ text: this.MENU_CUSTOMER_SEND_CONTACT, request_contact: true }],
            [{ text: this.MENU_MAIN_SEARCH }],
          ],
          resize_keyboard: true,
          one_time_keyboard: true,
          input_field_placeholder: 'Raqam yuboring yoki qidiring...',
        },
      });
      return;
    }

    const welcomeMsg = `👋 Salom, <b>${firstName}</b>!\n\n<b>YEC Market</b> botiga xush kelibsiz. Siz saytimiz uchun Telegram profilingizni tasdiqlagansiz. Bemalol buyurtma qilishingiz mumkin!\n\n🔍 Gilam qidirish uchun shunchaki uning <b>nomini</b> yoki <b>kodini</b> yozing yoki tugmadan foydalaning.`;

    await ctx.reply(welcomeMsg, {
      parse_mode: 'HTML',
      reply_markup: {
        keyboard: [[{ text: this.MENU_MAIN_SEARCH }]],
        resize_keyboard: true,
        input_field_placeholder: 'Gilam nomini yozing...',
      },
    });
  }

  private async handleSearchImage(ctx: Context) {
    const chatId = ctx.chat?.id.toString();
    if (chatId) {
      this.clearSearchState(chatId);
      // Photo is handled natively without a state, but we can instruct the user
      await ctx.reply(
        "🖼️ <b>Rasm bilan qidirish</b>\n\nQidirmoqchi bo'lgan gilam rasmini botga yuboring va izohiga (caption) maqsadni yozing.",
        { parse_mode: 'HTML' },
      );
    }
  }

  private async handleSearchName(ctx: Context) {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    this.clearSearchState(chatId);
    this.searchNameState.add(chatId);

    const names = await this.getAvailableNames();
    if (names.length === 0) {
      await ctx.reply(
        'Hozircha gilam nomlari topilmadi.',
        await this.buildSearchKeyboard(ctx),
      );
      this.searchNameState.delete(chatId);
      return;
    }

    await ctx.reply(
      'Gilam nomini tanlang:',
      this.buildBackFirstKeyboard(names, 'Gilam nomini tanlang'),
    );
  }

  private async handleSearchCode(ctx: Context) {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    this.clearSearchState(chatId);
    this.searchCodeState.add(chatId);

    await ctx.reply(
      '🔢 <b>Gul kodi bilan qidirish</b>\n\nGilam kodi yoki naqsh kodini yozib yuboring (masalan: <i>P101A</i>):',
      {
        parse_mode: 'HTML',
        reply_markup: {
          keyboard: [[{ text: this.MENU_BACK }]],
          resize_keyboard: true,
          one_time_keyboard: false,
          is_persistent: true,
        },
      },
    );
  }

  private async handleSearchSize(ctx: Context) {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    this.clearSearchState(chatId);
    this.searchSizeState.add(chatId);

    const sizes = await this.getAvailableSizes();
    if (sizes.length === 0) {
      await ctx.reply(
        'Hozircha razmerlar topilmadi.',
        await this.buildSearchKeyboard(ctx),
      );
      this.searchSizeState.delete(chatId);
      return;
    }

    await ctx.reply(
      'Razmerni tanlang:',
      this.buildBackFirstKeyboard(sizes, 'Razmerni tanlang'),
    );
  }

  private async handleSearchCategory(ctx: Context) {
    const chatId = ctx.chat?.id.toString();
    if (!chatId) return;

    this.clearSearchState(chatId);
    this.searchCategoryState.add(chatId);

    const categories = await this.getAvailableCategoryNames();
    if (categories.length === 0) {
      await ctx.reply(
        'Hozircha turlar topilmadi.',
        await this.buildSearchKeyboard(ctx),
      );
      this.searchCategoryState.delete(chatId);
      return;
    }

    await ctx.reply(
      'Turini tanlang:',
      this.buildBackFirstKeyboard(categories, 'Turini tanlang'),
    );
  }

  @On('callback_query')
  async onCallbackQuery(@Ctx() ctx: Context) {
    try {
      const callbackCtx = ctx as any;
      const data = callbackCtx.callbackQuery?.data;
      if (!data) return;
      const chatId = ctx.chat?.id.toString() || '';

      try {
        await callbackCtx.answerCbQuery?.().catch(() => {});
      } catch {}

      const isSeller = await this.isSeller(ctx);
    const isAdmin = await this.isAdmin(ctx);
    const isCourier = await this.isCourier(ctx);

    // Allow search/filter/like callbacks for all users
    const isSearchCallback =
      data.startsWith('search_') ||
      data.startsWith('filter_') ||
      data.startsWith('like_') ||
      data.startsWith('similar_') ||
      data.startsWith('settings_');

    const isCustomerCallback =
      data.startsWith('user_confirm_arrival_') ||
      data.startsWith('user_reject_arrival_') ||
      isSearchCallback;

    if (!isSeller && !isCourier && !isCustomerCallback && !isAdmin) {
      await ctx.reply("Bu amal faqat ro'yxatdan o'tgan xodimlar uchun.");
      return;
    }

    // Handle search-related callbacks first
    if (data.startsWith('like_toggle_')) {
      const carpetId = data.replace('like_toggle_', '');
      await this.handleLikeToggle(ctx, carpetId);
      return;
    }

    if (data.startsWith('similar_search_')) {
      const carpetId = data.replace('similar_search_', '');
      await this.handleSimilarSearch(ctx, carpetId);
      return;
    }

    if (data === 'search_page_next') {
      const state = this.userSearchState.get(chatId);
      if (state) {
        state.page++;
        await this.renderSearchResults(ctx, state);
      }
      return;
    }

    if (data === 'search_page_prev') {
      const state = this.userSearchState.get(chatId);
      if (state && state.page > 1) {
        state.page--;
        await this.renderSearchResults(ctx, state);
      }
      return;
    }

    if (data.startsWith('filter_menu_')) {
      const type = data.replace('filter_menu_', '');
      await this.handleFilterMenu(ctx, type);
      return;
    }

    if (data === 'filter_clear') {
      const state = this.userSearchState.get(chatId);
      if (state) {
        this.userSearchState.set(chatId, { query: state.query, page: 1 });
        await this.renderSearchResults(ctx, this.userSearchState.get(chatId)!);
      }
      return;
    }

    if (data.startsWith('filter_category_set_')) {
      const catId = data.replace('filter_category_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      state.categoryId = catId;
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_size_set_')) {
      const sizeVal = data.replace('filter_size_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      state.size = sizeVal;
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_color_set_')) {
      const colorVal = data.replace('filter_color_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      state.query = state.query ? `${state.query} ${colorVal}` : colorVal;
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_shape_set_')) {
      const shapeVal = data.replace('filter_shape_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      state.shape = shapeVal;
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_material_set_')) {
      const matVal = data.replace('filter_material_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      state.material = matVal;
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_price_set_')) {
      const range = data.replace('filter_price_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      if (range === 'low') {
        state.minPrice = 0;
        state.maxPrice = 300000;
      } else if (range === 'mid') {
        state.minPrice = 300000;
        state.maxPrice = 600000;
      } else if (range === 'high') {
        state.minPrice = 600000;
        state.maxPrice = undefined;
      }
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data.startsWith('filter_status_set_')) {
      const statusVal = data.replace('filter_status_set_', '');
      const state = this.userSearchState.get(chatId) || { query: '', page: 1 };
      if (statusVal === 'promo') {
        state.onlyPromo = true;
        state.onlyNew = false;
        state.onlyAvailable = true;
      } else if (statusVal === 'new') {
        state.onlyNew = true;
        state.onlyPromo = false;
        state.onlyAvailable = true;
      } else if (statusVal === 'available') {
        state.onlyAvailable = true;
        state.onlyPromo = false;
        state.onlyNew = false;
      }
      state.page = 1;
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
      return;
    }

    if (data === 'settings_orders') {
      const user = await this.prisma.user.findFirst({
        where: { telegramChatId: chatId },
      });
      if (!user) {
        await ctx.reply("Siz hali ro'yxatdan o'tmagansiz.");
        return;
      }
      const orders = await this.prisma.order.findMany({
        where: { customerId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 5,
      });
      if (orders.length === 0) {
        await ctx.reply('Sizda hali buyurtmalar mavjud emas.');
        return;
      }
      let ordersMsg = `📦 <b>Mening oxirgi buyurtmalarim</b>:\n\n`;
      orders.forEach((o, index) => {
        ordersMsg +=
          `${index + 1}. Buyurtma: <code>#${formatOrderNumber(o.id)}</code>\n` +
          `Sana: ${new Date(o.createdAt).toLocaleDateString()}\n` +
          `Holati: <b>${o.status}</b>\n` +
          `Summa: ${(Number(o.remainingAmount) + Number(o.paidAmount)).toLocaleString()} so'm\n\n`;
      });
      await ctx.reply(ordersMsg, { parse_mode: 'HTML' });
      return;
    }

    if (data === 'settings_branches') {
      const msg =
        `🏢 <b>YEC Market filiallari:</b>\n\n` +
        `📍 <b>Toshkent shahar filiali:</b>\n` +
        `Manzil: Toshkent sh., Chilonzor tumani, Lutfiy ko'chasi, 24-uy\n` +
        `Mo'ljal: Lutfiy bog'i ro'parasi\n` +
        `Ish vaqti: 09:00 - 20:00\n` +
        `Telefon: +998 90 123 45 67\n\n` +
        `📍 <b>Samarqand filiali:</b>\n` +
        `Manzil: Samarqand sh., Registon ko'chasi, 5-uy\n` +
        `Mo'ljal: Registon maydoni yaqinida\n` +
        `Ish vaqti: 09:00 - 19:00\n` +
        `Telefon: +998 93 765 43 21`;
      await ctx.reply(msg, { parse_mode: 'HTML' });
      return;
    }

    if (
      data === 'get_invite_link' ||
      data === 'new_orders' ||
      data.startsWith('approve_admin_') ||
      data.startsWith('reject_admin_') ||
      data.startsWith('admin_return_approve_') ||
      data.startsWith('admin_return_reject_')
    ) {
      if (!isAdmin) {
        await ctx.reply('Bu amal faqat adminlar uchun.');
        return;
      }
    }

    if (data === 'get_invite_link') {
      await this.handleInviteLink(ctx);
      return;
    }

    if (data === 'view_carpets') {
      await this.showSearchMenu(ctx);
      return;
    }

    if (data === 'search_image') {
      await this.handleSearchImage(ctx);
      return;
    }

    if (data === 'search_name') {
      await this.handleSearchName(ctx);
      return;
    }

    if (data === 'search_code') {
      await this.handleSearchCode(ctx);
      return;
    }

    if (data === 'new_orders') {
      await this.handleNewOrders(ctx);
      return;
    }
    if (data.startsWith('approve_admin_')) {
      const pendingChatId = data.replace('approve_admin_', '');
      const pendingInfo = this.pendingRequests.get(pendingChatId);

      if (!pendingInfo) {
        await ctx.reply(
          "Bu so'rov endi topilmadi (allaqachon ko'rib chiqilgan bo'lishi mumkin).",
        );
        return;
      }

      this.pendingRequests.delete(pendingChatId);

      // Check if user is now in DB
      const dbUser = await this.prisma.user.findFirst({
        where: {
          OR: [
            { telegramChatId: pendingChatId },
            {
              telegramUsername:
                pendingInfo.username && pendingInfo.username !== ''
                  ? pendingInfo.username
                  : undefined,
            },
          ],
        },
      });

      if (dbUser) {
        // Promote immediately
        await this.prisma.user.update({
          where: { id: dbUser.id },
          data: {
            role: UserRole.ADMIN,
            telegramChatId: pendingChatId,
            telegramUsername: pendingInfo.username,
          },
        });
        await ctx.reply(
          `✅ <b>${pendingInfo.firstName}</b> Admin qilib tayinlandi!`,
          { parse_mode: 'HTML' },
        );
        await this.telegramService.sendRaw(
          pendingChatId,
          `🎉 Tabriklaymiz! Siz <b>Admin</b> qilib tayinlandingiz. /start deb bosing.`,
        );
      } else {
        // Pre-approve - they'll get admin when they register
        this.preApprovedChatIds.add(pendingChatId);
        await ctx.reply(
          `✅ Tasdiqlandi! <b>${pendingInfo.firstName}</b> saytda ro'yxatdan o'tgach, avtomatik Admin bo'ladi.`,
          { parse_mode: 'HTML' },
        );
        await this.telegramService.sendRaw(
          pendingChatId,
          `✅ Admin sifatida tasdiqlandi! Iltimos, <b>yecmarket.uz</b> saytida ro'yxatdan o'ting, keyin botga /start deb yozing - avtomatik Admin bo'lasiz.`,
        );
      }
      return;
    }

    if (data.startsWith('reject_admin_')) {
      const pendingChatId = data.replace('reject_admin_', '');
      const pendingInfo = this.pendingRequests.get(pendingChatId);

      if (!pendingInfo) {
        await ctx.reply("Bu so'rov endi topilmadi.");
        return;
      }

      this.pendingRequests.delete(pendingChatId);
      this.rejectedChatIds.add(pendingChatId);

      await ctx.reply(
        `❌ <b>${pendingInfo.firstName}</b>ning so'rovi rad etildi.`,
        { parse_mode: 'HTML' },
      );
      await this.telegramService.sendRaw(
        pendingChatId,
        "❌ Kechirasiz, sizning admin bo'lish so'rovingiz rad etildi. Qo'shimcha ma'lumot uchun Super Admin bilan bog'laning.",
      );
      return;
    }
    if (data.startsWith('admin_return_approve_')) {
      if (!isAdmin) {
        await ctx.reply('Bu amal faqat adminlar uchun.');
        return;
      }
      const orderId = data.replace('admin_return_approve_', '');
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { returnRequest: true },
      });
      if (!order || !order.returnRequest) {
        await ctx.reply("Qaytarish so'rovi topilmadi.");
        return;
      }
      if (order.returnRequest.status !== 'RETURN_REQUESTED') {
        await ctx.reply("Bu so'rov allaqachon ko'rib chiqilgan.");
        return;
      }

      this.pendingReturnApprovals.set(chatId, orderId);
      await ctx.reply(
        `Buyurtma #${orderId} uchun kuryer (yetkazib berish) xarajatini kiriting (faqat raqam kiriting, masalan: 80000):`,
      );
      return;
    }

    if (data.startsWith('admin_return_confirm_')) {
      if (!isAdmin) {
        await ctx.reply('Bu amal faqat adminlar uchun.');
        return;
      }
      const parts = data.replace('admin_return_confirm_', '').split('_');
      const orderId = parts[0];
      const deliveryCost = parseInt(parts[1] || '0');

      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { returnRequest: true, items: { include: { carpet: true } } },
      });

      if (!order || !order.returnRequest) {
        await ctx.reply("Qaytarish so'rovi topilmadi.");
        return;
      }

      if (
        order.returnRequest.status !== 'RETURN_REQUESTED' &&
        order.returnRequest.status !== 'RETURN_UNDER_REVIEW'
      ) {
        await ctx.reply(
          "⚠️ Bu so'rov allaqachon ko'rib chiqilgan (double-refund protection).",
        );
        return;
      }

      const paidAmount = Number(order.paidAmount);
      const refundAmount = Math.max(0, paidAmount - deliveryCost);
      let conversionInfoText = '';

      try {
        await this.prisma.$transaction(async (tx) => {
          // Concurrency lock checks:
          const freshOrder = await tx.order.findUnique({
            where: { id: orderId },
          });
          if (!freshOrder || freshOrder.version !== order.version) {
            throw new BadRequestException(
              'Optimistic lock error: Order has been updated by another transaction.',
            );
          }
          const existingReturnedCarpet = await tx.inventoryItem.findFirst({
            where: { returnRequestId: order.returnRequest!.id },
          });
          if (existingReturnedCarpet) {
            throw new BadRequestException(
              "Bu qaytarish so'rovi uchun inventar yozuvi allaqachon yaratilgan.",
            );
          }

          // 1. Update ReturnRequest status to RETURN_APPROVED
          await tx.returnRequest.update({
            where: { orderId },
            data: {
              status: 'RETURN_APPROVED',
              deliveryCost,
              refundAmount,
              version: { increment: 1 },
            },
          });

          // 2. Update Order status to REFUNDED
          await tx.order.update({
            where: { id: orderId, version: freshOrder.version },
            data: {
              status: 'REFUNDED',
              version: { increment: 1 },
            },
          });

          // 3. Register payment history
          await tx.paymentHistory.create({
            data: {
              orderId,
              paymentType: 'REFUND',
              gateway: order.paymentMethod || 'CASH',
              transactionId: `REF_TX_${Date.now()}`,
              amount: refundAmount,
              status: 'SUCCESS',
            },
          });

          // 4. Restore Inventories or Create Returned Standalone Carpet
          for (const item of order.items) {
            if (!item.carpetId || !item.carpet) continue;

            if (item.isReturnedInventoryCreated) {
              throw new BadRequestException(
                'Ushbu mahsulot uchun qaytarilgan inventar yozuvi allaqachon yaratilgan.',
              );
            }

            const orderItemRoll = await tx.orderItemRoll.findFirst({
              where: { orderItemId: item.id },
            });

            if (orderItemRoll) {
              const parentCarpet = item.carpet;

              // If parent is already a returned item
              const allocations = await tx.orderItemInventory.findMany({
                where: { orderItemId: item.id },
                include: { inventory: true },
              });
              const isAlreadyReturnedItem =
                allocations.length > 0 && allocations[0].inventory.isReturned;

              if (isAlreadyReturnedItem) {
                const targetItem = allocations[0].inventory;
                await tx.inventoryItem.update({
                  where: { id: targetItem.id },
                  data: {
                    inventoryStatus: CarpetInventoryStatus.ACTIVE,
                  },
                });

                await tx.orderItemRoll.update({
                  where: { id: orderItemRoll.id },
                  data: { status: 'RESTOCKED' },
                });

                await tx.rollAllocationHistory.create({
                  data: {
                    rollInventoryId: orderItemRoll.rollInventoryId,
                    orderId,
                    lengthCm: orderItemRoll.lengthCm,
                    action: 'RETURNED',
                    actor: 'TELEGRAM_BOT',
                  },
                });

                await tx.auditLog.create({
                  data: {
                    action: 'ROLL_RETURN_CONVERTED',
                    who: 'TELEGRAM_BOT',
                    orderId,
                    oldValue: JSON.stringify({ stock: 0, status: 'SOLD' }),
                    newValue: JSON.stringify({ stock: 1, status: 'ACTIVE' }),
                    reason:
                      'Returned roll carpet restocked back to active inventory via Telegram Bot',
                  },
                });

                conversionInfoText +=
                  `♻️ Qaytarilgan gilam omborga qayta qo'shildi (Eski qaytgan gilam)\n` +
                  `<b>Kolleksiya:</b> ${parentCarpet.name}\n` +
                  `<b>Barcode:</b> ${targetItem.barcode}\n` +
                  `<b>SKU:</b> ${targetItem.sku || '-'}\n` +
                  `<b>O'lcham:</b> ${orderItemRoll.widthCm / 100}x${orderItemRoll.lengthCm / 100} m\n` +
                  `<b>Qoldiq:</b> 1 dona\n` +
                  `<b>Holati:</b> ACTIVE\n\n`;
              } else {
                const newBarcode = await this.generateUniqueBarcode(tx);
                const newSku = await this.generateUniqueSku(
                  tx,
                  parentCarpet.designCode || 'DC',
                  orderItemRoll.widthCm,
                  orderItemRoll.lengthCm,
                );
                const calculatedArea =
                  (orderItemRoll.widthCm * orderItemRoll.lengthCm) / 10000;
                const originalPricePerM2 = Number(
                  item.pricePerM2 || parentCarpet.price,
                );
                const calculatedPiecePrice = Math.round(
                  originalPricePerM2 * calculatedArea,
                );

                const newInventoryItem = await tx.inventoryItem.create({
                  data: {
                    carpetId: parentCarpet.id,
                    barcode: newBarcode,
                    sku: newSku,
                    widthMm: orderItemRoll.widthCm * 10,
                    lengthMm: orderItemRoll.lengthCm * 10,
                    size: `${orderItemRoll.widthCm / 100}x${orderItemRoll.lengthCm / 100}`,
                    pricePerM2: originalPricePerM2,
                    piecePrice: calculatedPiecePrice,
                    selectedArea: calculatedArea,
                    isReturned: true,
                    returnRequestId: order.returnRequest!.id,
                    returnCreatedAt: new Date(),
                    returnGeneration: 1,
                    inventorySource: 'RETURN',
                    sourceOrderId: orderId,
                    sourceOrderItemId: item.id,
                    inventoryStatus: CarpetInventoryStatus.ACTIVE,
                  },
                });

                await tx.orderItemRoll.update({
                  where: { id: orderItemRoll.id },
                  data: { status: 'RESTOCKED' },
                });

                await tx.rollAllocationHistory.create({
                  data: {
                    rollInventoryId: orderItemRoll.rollInventoryId,
                    orderId,
                    lengthCm: orderItemRoll.lengthCm,
                    action: 'RETURNED',
                    actor: 'TELEGRAM_BOT',
                  },
                });

                const durationMs =
                  Date.now() - order.returnRequest!.createdAt.getTime();
                await tx.auditLog.create({
                  data: {
                    action: 'ROLL_RETURN_CONVERTED',
                    who: 'TELEGRAM_BOT',
                    orderId,
                    oldValue: JSON.stringify({
                      oldPrice: parentCarpet.price,
                      previousStock: 0,
                      previousStatus: 'SOLD',
                    }),
                    newValue: JSON.stringify({
                      newInventoryItemId: newInventoryItem.id,
                      newBarcode,
                      newSku,
                      piecePrice: calculatedPiecePrice,
                      pricePerM2: originalPricePerM2,
                      area: calculatedArea,
                      conversionDurationMs: durationMs,
                      newStock: 1,
                      newStatus: 'ACTIVE',
                      inventorySource: 'RETURN',
                    }),
                    reason:
                      'Returned roll carpet successfully converted into individual standalone inventory item via Telegram Bot',
                  },
                });

                conversionInfoText +=
                  `♻️ Qaytarilgan gilam omborga qo'shildi (Yangi alohida bo'lak)\n` +
                  `<b>Kolleksiya:</b> ${parentCarpet.name}\n` +
                  `<b>Design:</b> ${parentCarpet.designCode || 'N/A'}\n` +
                  `<b>Yangi Barcode:</b> ${newBarcode}\n` +
                  `<b>Yangi SKU:</b> ${newSku}\n` +
                  `<b>O'lcham:</b> ${orderItemRoll.widthCm / 100}x${orderItemRoll.lengthCm / 100} m\n` +
                  `<b>Maydon:</b> ${calculatedArea.toFixed(2)} m²\n` +
                  `<b>Narxi:</b> ${calculatedPiecePrice.toLocaleString('uz-UZ')} so'm\n` +
                  `<b>Original Order:</b> #${orderId}\n` +
                  `<b>Original Customer:</b> ${order.customerId}\n` +
                  `<b>Return Request:</b> ${order.returnRequest!.id}\n` +
                  `<b>Operator:</b> TELEGRAM_BOT\n` +
                  `<b>Qoldiq:</b> 1 dona\n` +
                  `<b>Holati:</b> ACTIVE\n` +
                  `<b>Asl rulonga qayta qo'shilmadi.</b>\n\n`;
              }
            } else {
              // Ready carpet return: restock allocations to ACTIVE
              const allocations = await tx.orderItemInventory.findMany({
                where: { orderItemId: item.id },
              });
              const invIds = allocations.map((a) => a.inventoryId);
              if (invIds.length > 0) {
                await tx.inventoryItem.updateMany({
                  where: { id: { in: invIds } },
                  data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
                });
              }

              await tx.inventoryLedger.create({
                data: {
                  carpetId: item.carpetId,
                  quantity: item.quantity,
                  action: 'REFUND',
                  actor: 'TELEGRAM_BOT',
                  reason: `Returned & restocked order #${orderId}`,
                },
              });
            }

            await tx.orderItem.update({
              where: { id: item.id },
              data: { isReturnedInventoryCreated: true },
            });
          }

          // 5. Enqueue Notification
          await tx.notificationQueue.create({
            data: {
              channel: 'TELEGRAM',
              recipient: order.customerId,
              message: `Sizning #${orderId} raqamli buyurtmangiz bo'yicha pul qaytarildi. Qaytarilgan summa: ${refundAmount.toLocaleString('uz-UZ')} so'm.`,
              status: 'PENDING',
            },
          });
        });

        await ctx.reply(
          `✅ Qaytarish tasdiqlandi va rasmiylashtirildi!\n\n` +
            `<b>Refund:</b> ${refundAmount.toLocaleString('uz-UZ')} so'm\n` +
            `<b>Delivery:</b> ${deliveryCost.toLocaleString('uz-UZ')} so'm\n` +
            `<b>Reason:</b> Delivery Cost\n\n` +
            conversionInfoText,
          { parse_mode: 'HTML' },
        );

        // Notify customer
        const customer = await this.prisma.user.findUnique({
          where: { id: order.customerId },
        });
        if (customer && customer.telegramChatId) {
          try {
            await this.telegramService.sendRaw(
              customer.telegramChatId,
              `✅ Sizning #${orderId} raqamli buyurtmangiz bo'yicha qaytarish so'rovingiz tasdiqlandi.\n\n` +
                `<b>Qaytariladigan summa:</b> ${refundAmount.toLocaleString('uz-UZ')} so'm\n` +
                `<b>Yetkazib berish xarajati:</b> ${deliveryCost.toLocaleString('uz-UZ')} so'm`,
            );
          } catch {}
        }
      } catch (txErr) {
        await ctx.reply(`⚠️ Xatolik yuz berdi: ${(txErr as Error).message}`);
      }
      return;
    }

    if (data.startsWith('admin_return_cancel_')) {
      if (!isAdmin) {
        await ctx.reply('Bu amal faqat adminlar uchun.');
        return;
      }
      const orderId = data.replace('admin_return_cancel_', '');
      await ctx.reply('❌ Qaytarish bekor qilindi.');
      return;
    }

    if (data.startsWith('admin_return_reject_')) {
      if (!isAdmin) {
        await ctx.reply('Bu amal faqat adminlar uchun.');
        return;
      }
      const orderId = data.replace('admin_return_reject_', '');
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { returnRequest: true },
      });
      if (!order || !order.returnRequest) {
        await ctx.reply("Qaytarish so'rovi topilmadi.");
        return;
      }
      if (order.returnRequest.status !== 'RETURN_REQUESTED') {
        await ctx.reply("Bu so'rov allaqachon ko'rib chiqilgan.");
        return;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.returnRequest.update({
          where: { orderId },
          data: { status: 'RETURN_REJECTED' },
        });
        await tx.order.update({
          where: { id: orderId },
          data: { status: 'RETURN_REJECTED' },
        });
      });

      await ctx.reply("❌ Qaytarish so'rovi rad etildi.");

      const customer = await this.prisma.user.findUnique({
        where: { id: order.customerId },
      });
      if (customer && customer.telegramChatId) {
        try {
          await this.telegramService.sendRaw(
            customer.telegramChatId,
            `❌ Sizning #${orderId} raqamli buyurtmangiz uchun qaytarish so'rovingiz rad etildi.`,
          );
        } catch {}
      }
      return;
    }

    if (data.startsWith('courier_delivered_')) {
      const orderId = data.replace('courier_delivered_', '');
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { customer: true },
      });
      if (!order) return;

      if (!order.customer?.telegramChatId) {
        await ctx.reply(
          "Mijozning Telegram IDsi topilmadi. Holatni sayt orqali o'zgartiring.",
        );
        return;
      }

      await ctx.reply("Mijozga tasdiqlash so'rovi yuborildi. Kuting...");

      await this.telegramService.sendRaw(
        order.customer.telegramChatId,
        `Sizning #${formatOrderNumber(order.id, order.createdAt)} buyurtmangiz yetib keldimi?`,
        {
          inline_keyboard: [
            [
              {
                text: 'Ha ✅',
                callback_data: `user_confirm_arrival_${order.id}`,
              },
              {
                text: "Yo'q ❌",
                callback_data: `user_reject_arrival_${order.id}`,
              },
            ],
          ],
        },
      );
      return;
    }

    if (data.startsWith('user_confirm_arrival_')) {
      const orderId = data.replace('user_confirm_arrival_', '');
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { courier: true },
      });
      if (!order || order.status === 'DELIVERED') return;

      await this.prisma.order.update({
        where: { id: orderId },
        data: { status: 'DELIVERED' },
      });

      // Thank-you sticker (animated celebration sticker)
      const thankYouSticker =
        'CAACAgIAAxkBAAEBmZ1mX7Z2V8T2XtQJ5bHQ3dT5J4TqUAAC2BQAAiHkaEuLxhfI7g4fGzUE';

      // Find customer chatId
      const customerUser = await this.prisma.user.findUnique({
        where: { id: order.customerId },
        select: { telegramChatId: true },
      });
      if (customerUser?.telegramChatId) {
        try {
          await this.telegramService.sendSticker(
            customerUser.telegramChatId,
            thankYouSticker,
          );
        } catch {
          /* ignore */
        }
        await this.telegramService.sendRaw(
          customerUser.telegramChatId,
          `🎉 <b>Katta rahmat!</b>\n\n<b>#${formatOrderNumber(order.id, order.createdAt)}</b> buyurtmangizni qabul qilganingiz tasdiqlandi!\n\nYEC Market gilamlaridan xarid qilganingiz uchun minnatdormiz. Sifatli xizmatimizdan yana foydalanishni kutib qolamiz! 🌟`,
        );
      }

      if (order.courier?.telegramChatId) {
        await this.telegramService.sendRaw(
          order.courier.telegramChatId,
          `✅ <b>#${formatOrderNumber(order.id, order.createdAt)}</b> buyurtma mijoz tomonidan tasdiqlandi. Rahmat!`,
        );
      }
      return;
    }

    if (data.startsWith('user_reject_arrival_')) {
      const orderId = data.replace('user_reject_arrival_', '');
      const order = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: { courier: true },
      });

      if (!order) {
        await ctx.reply('Buyurtma topilmadi.');
        return;
      }

      // Inform the customer
      await ctx.reply(
        `⚠️ Tushundik. Adminlarga va kuryerga xabar yuborildi. Muammoni tezda hal qilamiz!`,
      );

      // Notify courier
      if (order.courier?.telegramChatId) {
        await this.telegramService.sendRaw(
          order.courier.telegramChatId,
          `⚠️ <b>Ogohlantirish!</b>\n\n<b>#${formatOrderNumber(order.id, order.createdAt)}</b> buyurtma mijoz tomonidan <b>tasdiqlanmadi</b>.\n\nMijoz bilan bog'laning va qayta tasdiqlashni so'rang.`,
          {
            inline_keyboard: [
              [
                {
                  text: '✅ Yetkazildi (qayta)',
                  callback_data: `courier_delivered_${order.id}`,
                },
              ],
            ],
          },
        );
      }

      // Notify all admins
      const orderNumber = formatOrderNumber(order.id, order.createdAt);
      await this.telegramService.notifyAdmins(
        `⚠️ <b>Muammo!</b> #${orderNumber} buyurtma mijoz tomonidan tasdiqlanmadi.\n\nMijoz: ${order.customerName}\nTel: ${order.phone}\nManzil: ${order.address}\nKuryer: ${order.courierName ?? 'Belgilanmagan'}`,
      );
      return;
    }
  } catch (err: any) {
    this.logger.error(
      `onCallbackQuery unhandled error for chat ${maskChatId(ctx.chat?.id)}: ${err?.message || err}`,
    );
  }
}

  @Command('help')
  async onHelp(@Ctx() ctx: Context) {
    const isAdmin = await this.isAdmin(ctx);
    const isSeller = await this.isSeller(ctx);
    const isCourier = await this.isCourier(ctx);

    const helpMsg =
      `🤖 <b>YEC Market Bot Qullanmasi</b>\n\n` +
      `🔍 <b>Qidiruv imkoniyatlari:</b>\n` +
      `• Gilam nomi bo'yicha: <code>stef</code>, <code>l102b</code>\n` +
      `• O'lcham bo'yicha: <code>3x2</code>, <code>2x3</code>, <code>1.5x2</code>\n` +
      `• Kirill yoki lotin yozuvida: <code>нео класика</code>\n` +
      `• Gul kodi bo'yicha: <code>102</code>\n\n` +
      `📌 <b>Mavjud buyruqlar:</b>\n` +
      `/start - Botni qayta ishga tushirish\n` +
      `/menu - Asosiy menyuni ko'rsatish\n` +
      `/help - Qo'llanma va yordam\n\n` +
      `📞 <b>Aloqa uchun:</b> @Saloxiddin_977`;

    if (isAdmin) {
      await ctx.reply(helpMsg, {
        parse_mode: 'HTML',
        ...this.buildMainKeyboard(await this.isSuperAdmin(ctx)),
      });
    } else if (isCourier) {
      await ctx.reply(helpMsg, {
        parse_mode: 'HTML',
        ...this.buildCourierKeyboard(),
      });
    } else if (isSeller) {
      await ctx.reply(helpMsg, {
        parse_mode: 'HTML',
        ...this.buildSellerKeyboard(),
      });
    } else {
      await ctx.reply(helpMsg, {
        parse_mode: 'HTML',
        ...this.buildCustomerKeyboard(),
      });
    }
  }

  @Command('menu')
  async onMenu(@Ctx() ctx: Context) {
    const isAdmin = await this.isAdmin(ctx);
    const isCourier = await this.isCourier(ctx);
    const isSeller = await this.isSeller(ctx);

    if (isAdmin) {
      await this.showMainMenu(ctx);
    } else if (isCourier) {
      await this.showCourierMenu(ctx);
    } else if (isSeller) {
      await this.showSellerMenu(ctx);
    } else {
      await this.showCustomerMenu(ctx);
    }
  }

  @Command('carpets')
  async onCarpets(@Ctx() ctx: Context) {
    if (!(await this.isAdmin(ctx))) {
      await ctx.reply('Bu buyruq faqat adminlar uchun.');
      return;
    }

    await this.showSearchMenu(ctx);
  }

  @On('text')
  async onText(@Ctx() ctx: Context) {
    try {
      const chatId = ctx.chat!.id.toString();
      const rawText = (ctx as any).message?.text || '';
      const text = rawText.trim();
      if (!text || text.startsWith('/')) return;

      const normalized = normalizeMenuText(text);
      const normalizedLower = normalized.toLowerCase();

      const isAdmin = await this.isAdmin(ctx);
      const isSeller = await this.isSeller(ctx);
      const isCourier = await this.isCourier(ctx);

      // 1. Pending refund approval flow for admins
      if (isAdmin && this.pendingReturnApprovals.has(chatId)) {
        const orderId = this.pendingReturnApprovals.get(chatId)!;
        const deliveryCost = parseInt(text.replace(/\s/g, ''));
        if (isNaN(deliveryCost) || deliveryCost < 0) {
          await ctx.reply(
            "Iltimos, kuryer xarajatini raqam ko'rinishida kiriting (masalan: 80000):",
          );
          return;
        }

        const order = await this.prisma.order.findUnique({
          where: { id: orderId },
          include: { items: true },
        });

        if (!order) {
          this.pendingReturnApprovals.delete(chatId);
          await ctx.reply('Buyurtma topilmadi.');
          return;
        }

        const paidAmount = Number(order.paidAmount);
        const refundAmount = Math.max(0, paidAmount - deliveryCost);

        this.pendingReturnApprovals.delete(chatId);

        const previewMessage =
          `━━━━━━━━━━━━━━━\n` +
          `🔍 <b>REFUND PREVIEW</b>\n\n` +
          `<b>Paid:</b> ${paidAmount.toLocaleString('uz-UZ')} so'm\n` +
          `<b>Delivery Cost:</b> ${deliveryCost.toLocaleString('uz-UZ')} so'm\n` +
          `<b>Refund Amount:</b> ${refundAmount.toLocaleString('uz-UZ')} so'm\n\n` +
          `Confirm?`;

        const replyMarkup = {
          inline_keyboard: [
            [
              {
                text: '✅ Confirm Refund',
                callback_data: `admin_return_confirm_${orderId}_${deliveryCost}`,
              },
              {
                text: '❌ Cancel',
                callback_data: `admin_return_cancel_${orderId}`,
              },
            ],
          ],
        };

        await ctx.reply(previewMessage, {
          parse_mode: 'HTML',
          reply_markup: replyMarkup,
        });
        return;
      }

      // 2. Global Back Navigation button
      if (
        text === this.MENU_BACK ||
        text === '🔙 Orqaga' ||
        text === this.MENU_CUSTOMER_BACK ||
        text === this.MENU_SELLERS_BACK ||
        text === this.MENU_COURIERS_BACK ||
        normalizedLower === 'orqaga' ||
        normalizedLower === 'menyuga qaytish'
      ) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.showMainMenu(ctx, 'Asosiy menyu.');
        } else if (isCourier) {
          await this.showCourierMenu(ctx, 'Kuryer menyusi.');
        } else if (isSeller) {
          await this.showSellerMenu(ctx, 'Sotuvchi menyusi.');
        } else {
          await this.showCustomerMenu(ctx, 'Asosiy menyu.');
        }
        return;
      }

      // 3. Admin: Couriers section ("🚚 Kuryerlar")
      const isCouriersBtn =
        text === this.MENU_MAIN_COURIERS ||
        normalized === normalizeMenuText(this.MENU_MAIN_COURIERS) ||
        normalizedLower === 'kuryerlar' ||
        normalizedLower === '🚚 kuryerlar';

      if (isCouriersBtn) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.showCourierManagementMenu(ctx);
        } else {
          await ctx.reply(
            "🔒 Ushbu bo'lim faqat do'kon ma'murlari (adminlar) uchun mo'ljallangan.\n\nAgar siz admin bo'lsangiz, profilingizni tasdiqlash uchun /start bosing.",
            this.buildCustomerKeyboard(),
          );
        }
        return;
      }

      // 4. Admin: Sellers section ("🤝 Sotuvchilar")
      const isSellersBtn =
        text === this.MENU_MAIN_ADD_SELLER ||
        normalized === normalizeMenuText(this.MENU_MAIN_ADD_SELLER) ||
        normalizedLower === 'sotuvchilar' ||
        normalizedLower === '🤝 sotuvchilar';

      if (isSellersBtn) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.showSellerManagementMenu(ctx);
        } else {
          await ctx.reply(
            "🔒 Ushbu bo'lim faqat do'kon ma'murlari (adminlar) uchun mo'ljallangan.\n\nAgar siz admin bo'lsangiz, profilingizni tasdiqlash uchun /start bosing.",
            this.buildCustomerKeyboard(),
          );
        }
        return;
      }

      // 5. Admin: Admins management ("👥 Adminlar" / "👤 Adminlar")
      const isAdminsBtn =
        text === this.MENU_MAIN_ADD_ADMIN ||
        text === '👤 Adminlar' ||
        normalized === normalizeMenuText(this.MENU_MAIN_ADD_ADMIN) ||
        normalizedLower === 'adminlar' ||
        normalizedLower === '👥 adminlar' ||
        normalizedLower === '👤 adminlar';

      if (isAdminsBtn) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.handleInviteLink(ctx);
        } else {
          await ctx.reply(
            "🔒 Ushbu bo'lim faqat do'kon ma'murlari (adminlar) uchun mo'ljallangan.\n\nAgar siz admin bo'lsangiz, profilingizni tasdiqlash uchun /start bosing.",
            this.buildCustomerKeyboard(),
          );
        }
        return;
      }

      // 6. Orders section ("📦 Buyurtmalar" / "📦 Mening buyurtmalarim")
      const isOrdersBtn =
        text === this.MENU_MAIN_NEW_ORDERS ||
        text === '📦 Buyurtmalar' ||
        text === this.MENU_CUSTOMER_ORDERS ||
        normalized === normalizeMenuText(this.MENU_MAIN_NEW_ORDERS) ||
        normalizedLower === 'buyurtmalar' ||
        normalizedLower === 'buyurtmalarim';

      if (isOrdersBtn) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.handleNewOrders(ctx);
        } else if (isCourier) {
          await this.handleCourierOrders(ctx);
        } else {
          await this.showCustomerOrders(ctx);
        }
        return;
      }

      // 7. Couriers management sub-buttons
      if (
        text === this.MENU_COURIERS_ALL ||
        normalized === normalizeMenuText(this.MENU_COURIERS_ALL) ||
        normalizedLower === 'barcha kuryerlar'
      ) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.showAllCouriers(ctx);
        } else {
          await ctx.reply("🔒 Bu bo'lim faqat adminlar uchun.");
        }
        return;
      }

      if (
        text === this.MENU_COURIERS_ADD ||
        normalized === normalizeMenuText(this.MENU_COURIERS_ADD) ||
        normalizedLower === "kuryer qo'shish"
      ) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.handleCourierInviteLink(ctx);
        } else {
          await ctx.reply("🔒 Bu bo'lim faqat adminlar uchun.");
        }
        return;
      }

      // 8. Sellers management sub-buttons
      if (
        text === this.MENU_SELLERS_ALL ||
        normalized === normalizeMenuText(this.MENU_SELLERS_ALL) ||
        normalizedLower === 'barcha sotuvchilar'
      ) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.showAllSellers(ctx);
        } else {
          await ctx.reply("🔒 Bu bo'lim faqat adminlar uchun.");
        }
        return;
      }

      if (
        text === this.MENU_SELLERS_ADD ||
        normalized === normalizeMenuText(this.MENU_SELLERS_ADD) ||
        normalizedLower === "sotuvchi qo'shish"
      ) {
        this.clearSearchState(chatId);
        if (isAdmin) {
          await this.handleSellerInviteLink(ctx);
        } else {
          await ctx.reply("🔒 Bu bo'lim faqat adminlar uchun.");
        }
        return;
      }

      // 9. Courier personal orders button
      if (
        text === this.MENU_COURIER_ORDERS ||
        normalized === normalizeMenuText(this.MENU_COURIER_ORDERS) ||
        normalizedLower === 'mening buyurtmalarim'
      ) {
        if (isCourier) {
          await this.handleCourierOrders(ctx);
        } else {
          await this.showCustomerOrders(ctx);
        }
        return;
      }

      // 10. Search entry button ("🔍 Gilam qidirish" / "🔍 Mahsulot qidirish")
      const isSearchBtn =
        text === '🔍 Gilam qidirish' ||
        text === '🔍 Mahsulot qidirish' ||
        text === this.MENU_MAIN_SEARCH ||
        normalizedLower === 'gilam qidirish' ||
        normalizedLower === 'mahsulot qidirish';

      if (isSearchBtn) {
        this.clearSearchState(chatId);
        if (isAdmin || isSeller) {
          await this.showSearchMenu(ctx);
        } else {
          this.carpetSearchState.add(chatId);
          await ctx.reply(
            "🔍 Gilam izlash uchun uning nomi, o'lchami (masalan: 3x2) yoki kodini kiriting:",
            {
              reply_markup: {
                keyboard: [[{ text: '🔙 Orqaga' }]],
                resize_keyboard: true,
              },
            },
          );
        }
        return;
      }

      // 11. Image search button ("🖼 Rasm orqali qidirish" / "🖼️ Rasm bilan qidirish")
      if (
        text === '🖼 Rasm orqali qidirish' ||
        text === this.MENU_SEARCH_IMAGE ||
        normalizedLower === 'rasm orqali qidirish' ||
        normalizedLower === 'rasm bilan qidirish'
      ) {
        this.clearSearchState(chatId);
        this.activePhotoSearchChats.add(chatId);
        await ctx.reply('🖼 Rasm orqali qidirish uchun gilam rasmini yuboring:', {
          reply_markup: {
            keyboard: [[{ text: '🔙 Orqaga' }]],
            resize_keyboard: true,
          },
        });
        return;
      }

      // 12. Search sub-menu options
      if (
        text === this.MENU_SEARCH_NAME ||
        normalizedLower === "nom bo'yicha"
      ) {
        await this.handleSearchName(ctx);
        return;
      }

      if (
        text === this.MENU_SEARCH_SIZE ||
        text === "📏 O'lcham bo'yicha" ||
        normalizedLower === "o'lcham bo'yicha"
      ) {
        this.clearSearchState(chatId);
        if (isAdmin || isSeller) {
          await this.handleSearchSize(ctx);
        } else {
          await this.handleSizesMenu(ctx);
        }
        return;
      }

      if (
        text === this.MENU_SEARCH_CATEGORY ||
        text === '📂 Kategoriyalar' ||
        normalizedLower === 'kategoriyalar' ||
        normalizedLower === "kategoriya bo'yicha"
      ) {
        this.clearSearchState(chatId);
        if (isAdmin || isSeller) {
          await this.handleSearchCategory(ctx);
        } else {
          await this.handleCategoriesMenu(ctx);
        }
        return;
      }

      if (
        text === this.MENU_SEARCH_CODE ||
        normalizedLower === 'gul kodi bilan'
      ) {
        await this.handleSearchCode(ctx);
        return;
      }

      // 13. Customer menu options
      if (text === '💎 Premium' || normalizedLower === 'premium') {
        this.clearSearchState(chatId);
        await this.handlePremiumSearch(ctx);
        return;
      }

      if (text === '❤️ Sevimlilar' || normalizedLower === 'sevimlilar') {
        this.clearSearchState(chatId);
        await this.handleFavoritesMenu(ctx);
        return;
      }

      if (text === '📞 Operator' || normalizedLower === 'operator') {
        await ctx.reply(
          "📞 Operator bilan bog'lanish:\n\nTelegram: @Saloxiddin_977\n\nSavollaringiz bo'lsa, bemalol yozishingiz mumkin!",
        );
        return;
      }

      if (text === '⚙ Sozlamalar' || normalizedLower === 'sozlamalar') {
        await this.handleSettingsMenu(ctx);
        return;
      }

      if (text === '🏢 Filiallar' || normalizedLower === 'filiallar') {
        await ctx.reply(
          "🏢 <b>YEC Toshkent Filiallari:</b>\n\n📍 <b>Bosh do'kon:</b> Toshkent sh., Chilonzor tumani\n🕒 Ish vaqti: 09:00 - 20:00\n📞 Aloqa: +998 90 000 00 00",
          { parse_mode: 'HTML' },
        );
        return;
      }

      if (
        text === "💬 Admin bilan bog'lanish" ||
        normalizedLower === "admin bilan bog'lanish"
      ) {
        await ctx.reply(
          "💬 Admin bilan bog'lanish uchun: @Saloxiddin_977 profiliga murojaat qilishingiz mumkin.",
        );
        return;
      }

      // 14. Active input states (Size, Name, Code, Category, General Carpet)
      if (this.carpetSearchState.has(chatId)) {
        this.clearSearchState(chatId);
        const state = { query: text, page: 1 };
        this.userSearchState.set(chatId, state);
        await this.renderSearchResults(ctx, state);
        return;
      }

      if (this.searchSizeState.has(chatId)) {
        const sizes = await this.getAvailableSizes();
        if (!sizes.includes(text)) {
          await ctx.reply(
            'Iltimos, mavjud razmerlardan birini tanlang.',
            this.buildBackFirstKeyboard(sizes, 'Razmerni tanlang'),
          );
          return;
        }

        this.clearSearchState(chatId);
        const state = { query: '', size: text, page: 1 };
        this.userSearchState.set(chatId, state);
        await this.renderSearchResults(ctx, state);
        return;
      }

      if (this.searchNameState.has(chatId)) {
        const names = await this.getAvailableNames();
        if (!names.includes(text)) {
          await ctx.reply(
            'Iltimos, mavjud gilam nomlaridan birini tanlang.',
            this.buildBackFirstKeyboard(names, 'Gilam nomini tanlang'),
          );
          return;
        }

        this.clearSearchState(chatId);
        const state = { query: text, page: 1 };
        this.userSearchState.set(chatId, state);
        await this.renderSearchResults(ctx, state);
        return;
      }

      if (this.searchCodeState.has(chatId)) {
        this.clearSearchState(chatId);
        const state = { query: text, page: 1 };
        this.userSearchState.set(chatId, state);
        await this.renderSearchResults(ctx, state);
        return;
      }

      if (this.searchCategoryState.has(chatId)) {
        const categories = await this.getAvailableCategoryNames();
        if (!categories.includes(text)) {
          await ctx.reply(
            'Iltimos, mavjud turlardan birini tanlang.',
            this.buildBackFirstKeyboard(categories, 'Turini tanlang'),
          );
          return;
        }

        this.clearSearchState(chatId);
        const category = await this.prisma.category.findFirst({
          where: { name: text },
        });
        const state = { query: '', categoryId: category?.id, page: 1 };
        this.userSearchState.set(chatId, state);
        await this.renderSearchResults(ctx, state);
        return;
      }

      // Check if it's any other navigation button we might have missed
      const knownButtons = [
        '🔙 Orqaga',
        '✅ Tasdiqlash',
        '❌ Bekor qilish',
        this.MENU_SELLERS_BACK,
        this.MENU_COURIERS_BACK,
        this.MENU_BACK,
      ];
      if (knownButtons.includes(text)) return;

      // 15. Direct search for all other text inputs (e.g. "stef", "3x2", "l102b", "нео класика", "nonexistentxyz123")
      const state = { query: text, page: 1 };
      this.userSearchState.set(chatId, state);
      await this.renderSearchResults(ctx, state);
    } catch (err: any) {
      this.logger.error(
        `onText unhandled error for chat ${maskChatId(ctx.chat?.id)}: ${err?.message || err}`,
      );
      try {
        await ctx.reply(
          "⚠️ Xatolik yuz berdi. Iltimos, qayta urinib ko'ring yoki /start bosing.",
        );
      } catch {}
    }
  }

  private async showCustomerOrders(ctx: Context) {
    const chatId = ctx.chat?.id?.toString();
    if (!chatId) return;

    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    const userConditions: any[] = [];
    if (user?.id) {
      userConditions.push({ customerId: user.id });
    }
    if (user?.phone) {
      userConditions.push({ customerPhone: user.phone });
      userConditions.push({ phone: user.phone });
    }

    if (userConditions.length === 0) {
      await ctx.reply(
        "📋 Sizda hali buyurtmalar mavjud emas. Buyurtma berish uchun yecmarket.uz saytidan foydalanishingiz mumkin.",
        this.buildCustomerKeyboard(),
      );
      return;
    }

    const orders = await this.prisma.order.findMany({
      where: { OR: userConditions },
      include: {
        items: {
          include: { carpet: { select: { name: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
    });

    if (orders.length === 0) {
      await ctx.reply(
        "📋 Hozircha sizda buyurtmalar mavjud emas. Buyurtma berish uchun yecmarket.uz saytidan foydalanishingiz mumkin.",
        this.buildCustomerKeyboard(),
      );
      return;
    }

    await ctx.reply(
      `📦 <b>Sizning buyurtmalaringiz:</b> (${orders.length} ta)`,
      { parse_mode: 'HTML', ...this.buildCustomerKeyboard() },
    );

    for (const order of orders) {
      const itemsText = order.items
        .map((i) => `- ${escapeHtml(i.carpet?.name ?? "Noma'lum gilam")} x${i.quantity}`)
        .join('\n');

      let statusIcon = '⏳';
      if (order.status === 'ACCEPTED') statusIcon = '✅';
      if (order.status === 'ON_WAY') statusIcon = '🚚';
      if (order.status === 'DELIVERED') statusIcon = '🎉';
      if (order.status === 'CANCELLED') statusIcon = '❌';

      const totalAmount =
        Number(order.paidAmount || 0) + Number(order.remainingAmount || 0);

      const msg =
        `📦 <b>Buyurtma #${formatOrderNumber(order.id, order.createdAt)}</b>\n` +
        `Manzil: ${escapeHtml(order.address)}\n` +
        `Umumiy summa: ${totalAmount.toLocaleString('uz-UZ')} so'm\n` +
        `${statusIcon} Holati: ${order.status}\n\n` +
        `Tarkibi:\n${itemsText}`;

      await ctx.reply(msg, { parse_mode: 'HTML' });
    }
  }

  private async processCarpetSearch(
    ctx: Context,
    query: string,
    isByCode = false,
  ) {
    const chatId = ctx.chat!.id.toString();

    const { results } = await this.searchService.search(query, {
      limit: 10,
    });

    if (results.length === 0) {
      return ctx.reply(
        `🔍 "<b>${query}</b>" bo'yicha hech qanday gilam topilmadi.`,
        { parse_mode: 'HTML' },
      );
    }

    await ctx.reply(`✅ Topildi: <b>${results.length} ta</b> natija.`, {
      parse_mode: 'HTML',
    });

    for (const item of results.slice(0, 5)) {
      const carpet = item;
      const sizeDisplay = carpet.sizes?.[0]?.sizeStr || '0x0';
      const stock = carpet.sizes?.reduce((sum, s) => sum + s.stock, 0) || 1;

      const msg =
        `✨ <b>${carpet.name}</b> ✨\n\n` +
        `📂 <b>Kategoriya:</b> ${carpet.categoryName || "Noma'lum"}\n` +
        `💰 <b>Narxi:</b> ${Number(carpet.price).toLocaleString()} so'm / m²\n` +
        `🧵 <b>Material:</b> ${carpet.material || "Noma'lum"}\n` +
        `📍 <b>O'lchami:</b> ${sizeDisplay}\n` +
        `📦 <b>Zaxirada:</b> ${stock} ta\n\n` +
        `🔗 <a href="https://yecmarket.uz/carpets/${carpet.id}">Veb-saytda ko'rish</a>`;

      const inlineKeyboard = {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "🛒 Saytda ko'rish",
                url: `https://yecmarket.uz/carpets/${carpet.id}`,
              },
            ],
          ],
        },
      };

      const image = carpet.images?.[0]?.trim() || '';
      if (image) {
        const photoInput = this.resolveCarpetPhoto(image);
        if (photoInput) {
          await this.telegramService.sendPhoto(
            ctx.chat!.id.toString(),
            photoInput,
            msg,
            inlineKeyboard.reply_markup,
          );
        } else {
          await ctx.reply(msg, { parse_mode: 'HTML', ...inlineKeyboard });
        }
      } else {
        await ctx.reply(msg, { parse_mode: 'HTML', ...inlineKeyboard });
      }
    }
  }

  @Command('add_admin')
  async onAddAdmin(@Ctx() ctx: Context) {
    if (!(await this.isSuperAdmin(ctx)))
      return ctx.reply('Bu buyruq faqat Super Adminlar uchun.');

    const messageText = (ctx as any).message?.text || '';
    const parts = messageText.split(' ');
    if (parts.length < 2) {
      return ctx.reply('Foydalanish: /add_admin <email_yoki_tel>');
    }

    const identifier = parts[1];

    // Normalize phone if given
    let normalizedIdentifier = identifier;
    if (
      /^\d/.test(normalizedIdentifier) &&
      !normalizedIdentifier.startsWith('+')
    ) {
      const digits = normalizedIdentifier.replace(/\D/g, '');
      let localDigits = '';
      if (digits.startsWith('998')) {
        localDigits = digits.slice(3, 12);
      } else {
        localDigits = digits.slice(0, 9);
      }
      const compact = localDigits.padEnd(9, '');
      normalizedIdentifier = `+998${compact}`;
    }

    const targetUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: normalizedIdentifier },
          { phone: identifier },
        ],
      },
    });

    if (!targetUser) {
      return ctx.reply('Foydalanuvchi topilmadi.');
    }

    await this.prisma.user.update({
      where: { id: targetUser.id },
      data: { role: UserRole.ADMIN },
    });

    return ctx.reply(`✅ ${targetUser.name} endi admin!`);
  }

  @Command('add_seller')
  async onAddSeller(@Ctx() ctx: Context) {
    if (!(await this.isAdmin(ctx)))
      return ctx.reply('Bu buyruq faqat Adminlar uchun.');

    const messageText = (ctx as any).message?.text || '';
    const parts = messageText.split(' ');
    if (parts.length < 2) {
      return ctx.reply('Foydalanish: /add_seller <telefon_raqam_yoki_email>');
    }

    const identifier = parts[1];

    let normalizedIdentifier = identifier;
    if (
      /^\d/.test(normalizedIdentifier) &&
      !normalizedIdentifier.startsWith('+')
    ) {
      const digits = normalizedIdentifier.replace(/\D/g, '');
      let localDigits = '';
      if (digits.startsWith('998')) {
        localDigits = digits.slice(3, 12);
      } else {
        localDigits = digits.slice(0, 9);
      }
      const compact = localDigits.padEnd(9, '');
      normalizedIdentifier = `+998${compact}`;
    }

    const targetUser = await this.prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier },
          { phone: normalizedIdentifier },
          { phone: identifier },
        ],
      },
    });

    if (!targetUser) {
      return ctx.reply(
        `Foydalanuvchi topilmadi. Raqam yoki Email to'g'riligiga ishonch hosil qiling.`,
      );
    }

    if (
      targetUser.role === UserRole.SUPERADMIN ||
      targetUser.role === UserRole.ADMIN
    ) {
      return ctx.reply(`Bu foydalanuvchi allaqachon Admin yoki Super Admin.`);
    }

    await this.prisma.user.update({
      where: { id: targetUser.id },
      data: { role: UserRole.SELLER },
    });

    return ctx.reply(
      `✅ ${targetUser.name} endi Sotuvchi (SELLER)!\nEndi bu foydalanuvchi bot orqali gilam qidirish imkoniyatlaridan to'liq foydalana oladi.`,
    );
  }

  @Command('invite')
  async onInvite(@Ctx() ctx: Context) {
    if (!(await this.isSuperAdmin(ctx)))
      return ctx.reply('Bu buyruq faqat Super Admin uchun.');

    const adminSecret =
      process.env.ADMIN_INVITE_SECRET || 'yec_toshkent_admin_secret_2024';
    const botUsername = ctx.botInfo.username;
    const inviteLink = `https://t.me/${botUsername}?start=admin_join_${adminSecret}`;

    return ctx.reply(
      `Yangi admin qo'shish uchun linkni bosing yoki ulashing:\n\n<a href="${inviteLink}">Admin bo'lish uchun botni ochish</a>\n\nDiqqat: Ushbu linkni faqat ishonchli odamlarga yuboring!`,
      { parse_mode: 'HTML' },
    );
  }

  @On('contact')
  async onContact(@Ctx() ctx: Context) {
    const message = (ctx as any).message;
    if (!message || !message.contact) return;

    const phone = message.contact.phone_number || '';
    const chatId = ctx.chat!.id.toString();
    const username = ctx.from?.username || '';

    const digits = phone.replace(/\D/g, '');
    const clean9Digits = digits.slice(-9);
    const standardPhone = `+998${clean9Digits}`;

    let user = await this.prisma.user.findFirst({
      where: {
        phone: { contains: clean9Digits },
      },
    });

    if (!user) {
      const allUsers = await this.prisma.user.findMany();
      user =
        allUsers.find(
          (u) => u.phone && u.phone.replace(/\D/g, '').endsWith(clean9Digits),
        ) || null;
    }

    if (user) {
      await this.prisma.$transaction(async (tx) => {
        await tx.user.updateMany({
          where: { id: { not: user.id }, telegramChatId: chatId },
          data: { telegramChatId: null },
        });

        await tx.user.update({
          where: { id: user.id },
          data: {
            telegramChatId: chatId,
            telegramUsername: username || null,
          },
        });
      });

      await ctx.reply(
        `✅ Salom, <b>${user.name}</b>!\n\nTelefon raqamingiz bo'yicha profilingiz botga muvaffaqiyatli bog'landi! Endi yecmarket.uz saytiga qaytib buyurtmani rasmiylashtirishingiz mumkin.`,
        {
          parse_mode: 'HTML',
          reply_markup: {
            keyboard: [[{ text: this.MENU_MAIN_SEARCH }]],
            resize_keyboard: true,
          },
        },
      );
    } else {
      await ctx.reply(
        `❌ Kechirasiz, ${standardPhone} raqami bilan saytimizda ro'yxatdan o'tgan foydalanuvchi topilmadi.\n\nIltimos, avval saytimizdan (yecmarket.uz) aynan shu raqam bilan ro'yxatdan o'ting, so'ngra botga qaytib qayta urinib ko'ring.`,
      );
    }
  }

  @On('photo')
  async onPhoto(@Ctx() ctx: Context) {
    const chatId = ctx.chat!.id.toString();
    const isSellerUser = await this.isSeller(ctx);
    const message = (ctx as any).message;
    const photos = message.photo;
    if (!photos || photos.length === 0) return;

    const bestPhoto = photos[photos.length - 1]; // largest resolution
    let searchingMsg: any = null;

    try {
      searchingMsg = await ctx.reply(
        "🔍 Yuborilgan rasm bo'yicha YEC katalogidan qidirilmoqda...",
      );

      // 1. Download photo from Telegram
      const axios = require('axios');
      const fileLink = await ctx.telegram.getFileLink(bestPhoto.file_id);
      const downloadRes = await axios.get(fileLink.href, {
        responseType: 'arraybuffer',
      });
      const imageBuffer = Buffer.from(downloadRes.data);

      // 2. Perform visual search using similarity engine
      const matches = await this.similarityService.searchCatalog(
        imageBuffer,
        10,
      );

      // Delete searching message
      if (searchingMsg) {
        try {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            searchingMsg.message_id,
          );
        } catch (e) {}
      }

      if (matches.length === 0) {
        await ctx.reply(
          "❌ Kechirasiz, katalogimizdan ushbu rasmga o'xshash gilamlar topilmadi.",
        );
        return;
      }

      await ctx.reply(
        `🎯 <b>Rasm orqali qidiruv natijalari:</b> Eng yaqin 10 ta o'xshash variant topildi:`,
        { parse_mode: 'HTML' },
      );

      // Show top 10 matches
      const topMatches = matches.slice(0, 10);
      for (const res of topMatches) {
        const dbCarpet = await this.prisma.carpet.findFirst({
          where: {
            name: res.collectionName,
            designCode: res.designCode,
            isArchived: false,
          },
          include: { category: true },
        });

        if (!dbCarpet) continue;

        let sizesList = '';
        let stockCount = 0;

        if (dbCarpet.type === 'ROLL') {
          const rolls = await this.prisma.rollInventory.findMany({
            where: { carpetId: dbCarpet.id },
            select: { widthCm: true, currentLengthCm: true },
          });
          sizesList =
            rolls
              .map((r) => `${r.widthCm / 100} x ${r.currentLengthCm / 100} m`)
              .join(', ') || "Noma'lum";
          stockCount = rolls.reduce(
            (sum, r) => sum + (r.currentLengthCm > 0 ? 1 : 0),
            0,
          );
        } else {
          const activeItems = await this.prisma.inventoryItem.findMany({
            where: { carpetId: dbCarpet.id, inventoryStatus: 'ACTIVE' },
            select: { widthMm: true, lengthMm: true },
          });
          sizesList =
            activeItems
              .map(
                (i) =>
                  `${Math.round(i.widthMm / 10) / 100} x ${Math.round(i.lengthMm / 10) / 100} m`,
              )
              .join(', ') || "Noma'lum";
          stockCount = activeItems.length;
        }

        const textMsg =
          `✨ <b>${res.collectionName} ${res.designCode}</b> ✨\n` +
          `🎯 <b>O'xshashlik:</b> ${res.matchPercent}%\n` +
          `💵 Narxi: ${Number(dbCarpet.price).toLocaleString()} so'm / m²\n` +
          `📏 O'lchamlari: ${sizesList}\n` +
          `📦 Qoldiq: ${stockCount} dona\n`;

        // Check if user already liked this carpet
        const user = await this.prisma.user.findFirst({
          where: { telegramChatId: chatId },
        });
        let isLiked = false;
        if (user) {
          const like = await this.prisma.carpetLike.findUnique({
            where: {
              userId_carpetId: { userId: user.id, carpetId: dbCarpet.id },
            },
          });
          isLiked = !!like;
        }

        const inlineKeyboard = {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: '🛒 Sotib olish',
                  url: `https://yecmarket.uz/carpets/${dbCarpet.id}`,
                },
                {
                  text: isLiked ? '❤️ Saqlangan' : '🖤 Saqlash',
                  callback_data: `like_toggle_${dbCarpet.id}`,
                },
              ],
              [
                {
                  text: '📤 Ulashish',
                  url: `https://t.me/share/url?url=https://yecmarket.uz/carpets/${dbCarpet.id}&text=${encodeURIComponent('YEC Marketda ajoyib gilam topdim: ' + dbCarpet.name)}`,
                },
                {
                  text: "🔍 O'xshashlar",
                  callback_data: `similar_search_${dbCarpet.id}`,
                },
              ],
              [
                {
                  text: '📞 Operator',
                  url: 'https://t.me/Saloxiddin_977',
                },
              ],
            ],
          },
        };

        const photoInput = this.resolveCarpetPhoto(res.image);
        if (photoInput) {
          await this.telegramService.sendPhoto(
            ctx.chat!.id.toString(),
            photoInput,
            textMsg,
            inlineKeyboard.reply_markup,
          );
        } else {
          await ctx.reply(textMsg, { parse_mode: 'HTML', ...inlineKeyboard });
        }
      }
    } catch (e) {
      this.logger.error(`Error in onPhoto visual search: ${e.message}`);
      if (searchingMsg) {
        try {
          await ctx.telegram.deleteMessage(
            ctx.chat!.id,
            searchingMsg.message_id,
          );
        } catch (err) {}
      }
      await ctx.reply(`Qidiruv jarayonida xatolik yuz berdi: ${e.message}`);
    }
  }

  private async isSuperAdmin(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    if (from.username === this.DEFAULT_ADMIN) return true;
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: from.id.toString() },
    });
    return user?.role === UserRole.SUPERADMIN;
  }

  private async isAdmin(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    if (from.username === this.DEFAULT_ADMIN) return true;
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: from.id.toString() },
    });
    return user?.role === UserRole.ADMIN || user?.role === UserRole.SUPERADMIN;
  }

  private async isSeller(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    if (from.username === this.DEFAULT_ADMIN) return true;
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: from.id.toString() },
    });
    return (
      user?.role === UserRole.SELLER ||
      user?.role === UserRole.ADMIN ||
      user?.role === UserRole.SUPERADMIN
    );
  }

  private async isCourier(ctx: Context): Promise<boolean> {
    const from = ctx.from;
    if (!from) return false;
    const user = await this.prisma.user.findUnique({
      where: { telegramChatId: from.id.toString() },
    });
    return user?.role === UserRole.COURIER;
  }

  private resolveCarpetPhoto(
    image: string,
  ): string | { source: string } | null {
    if (!image) return null;
    const trimmed = image.trim();
    if (!trimmed) return null;

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    const normalized = trimmed.replace(/\\/g, '/');
    const withoutLeading = normalized.replace(/^\/+/, '');

    if (withoutLeading.startsWith('images/')) {
      const local = this.resolveFrontPublicAsset(withoutLeading);
      if (local) return { source: local };
      const frontUrl = process.env.FRONTEND_URL?.replace(/\/+$/, '');
      if (frontUrl) {
        return `${frontUrl}/${withoutLeading}`;
      }
      return null;
    }

    const relativePath = withoutLeading.startsWith('uploads/')
      ? withoutLeading
      : `uploads/${withoutLeading}`;
    const localPath = join(process.cwd(), relativePath);

    if (existsSync(localPath)) {
      return { source: localPath };
    }

    const appUrl = process.env.APP_URL?.replace(/\/+$/, '');
    if (appUrl) {
      if (normalized.startsWith('/')) {
        return `${appUrl}${normalized}`;
      }
      if (normalized.startsWith('uploads/')) {
        return `${appUrl}/${normalized}`;
      }
      return `${appUrl}/uploads/${normalized}`;
    }

    return null;
  }

  private getPriceRangeFromSearch(
    search: string,
  ): { min: number; max: number } | null {
    const trimmed = search.trim();
    if (!trimmed) return null;

    if (!/^[\d\s.,]+$/.test(trimmed)) return null;

    const normalized = trimmed.replace(/\s+/g, '').replace(/,/g, '.');
    const value = Number(normalized);
    if (!Number.isFinite(value) || value <= 0) return null;

    if (value < 10) {
      const base = value * 100000;
      const hasDecimal = normalized.includes('.');
      return {
        min: Math.round(base),
        max: Math.round(base + (hasDecimal ? 9999 : 99999)),
      };
    }

    if (value < 1000) {
      const base = value * 1000;
      return { min: Math.round(base), max: Math.round(base + 999) };
    }

    return { min: Math.round(value), max: Math.round(value) };
  }

  private matchesPriceSearch(
    carpet: { price: any; size: string },
    range: { min: number; max: number },
  ): boolean {
    const perM2 = this.getPricePerM2(carpet.price, carpet.size);
    const total = Math.round(Number(carpet.price));
    const values = [
      Number.isFinite(total) ? total : null,
      perM2 ? Math.round(perM2) : null,
    ].filter((value): value is number => value !== null);

    return values.some((value) => value >= range.min && value <= range.max);
  }

  private getPricePerM2(
    totalPrice: number | string,
    size: string,
  ): number | null {
    const area = this.parseAreaFromSize(size);
    if (!area) return null;

    const price = Number(totalPrice);
    if (!Number.isFinite(price) || price <= 0) return null;

    return price / area;
  }

  private parseAreaFromSize(size: string): number | null {
    if (!size) return null;

    const normalized = size.toLowerCase().replace(/,/g, '.');
    const matches = normalized.match(/\d+(\.\d+)?/g);
    if (!matches || matches.length === 0) return null;

    const numbers = matches
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (numbers.length === 0) return null;

    if (numbers.length === 1) {
      const value = numbers[0];
      return value > 0 ? value : null;
    }
    const [rawA, rawB] = numbers;
    const hasCm = normalized.includes('cm') || normalized.includes('ÑÐ¼');
    const useCm = hasCm || rawA > 20 || rawB > 20;
    const a = useCm ? rawA / 100 : rawA;
    const b = useCm ? rawB / 100 : rawB;
    const area = a * b;

    return area > 0 ? area : null;
  }

  private readPositiveIntEnv(key: string, fallback: number): number {
    const raw = Number(process.env[key] ?? fallback);
    if (!Number.isFinite(raw) || raw <= 0) return fallback;
    return Math.round(raw);
  }

  private limitCarpetCandidates<T>(items: T[]): T[] {
    if (items.length <= this.imageSearchMaxCandidates) return items;
    return items.slice(0, this.imageSearchMaxCandidates);
  }

  private async processInBatches<T>(
    items: T[],
    requestedBatchSize: number,
    processor: (item: T) => Promise<void>,
  ): Promise<void> {
    const batchSize = Math.max(1, requestedBatchSize);
    for (let i = 0; i < items.length; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      await Promise.all(batch.map((item) => processor(item)));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  private resolveCollectionImageForCarpet(
    name: string,
    description?: string | null,
    categoryName?: string | null,
  ): string | null {
    this.ensureCollectionManifestLoaded();
    if (!this.collectionCodeMap || this.collectionCodeMap.size === 0)
      return null;

    const combined = [name, description].filter(Boolean).join(' ');
    if (!combined) return null;

    const preferredSlug =
      this.resolveCollectionSlug(categoryName) ||
      this.resolveCollectionSlug(name);
    const codes = this.extractCodeCandidates(combined);

    for (const code of codes) {
      const entries = this.collectionCodeMap.get(code);
      if (!entries || entries.length === 0) continue;

      if (preferredSlug) {
        const match = entries.find((entry) => entry.slug === preferredSlug);
        if (match) return match.path;
      }

      if (entries.length === 1) {
        return entries[0].path;
      }
    }

    return null;
  }

  private resolveFrontPublicAsset(relativePath: string): string | null {
    this.ensureCollectionManifestLoaded();
    if (!this.frontPublicDir) return null;
    const fullPath = join(this.frontPublicDir, relativePath);
    return existsSync(fullPath) ? fullPath : null;
  }

  private ensureCollectionManifestLoaded(): void {
    if (this.collectionCodeMap) return;

    const manifestPath = this.resolveManifestPath();
    if (!manifestPath) {
      this.collectionCodeMap = new Map();
      this.collectionNameToSlug = new Map();
      return;
    }

    try {
      const raw = readFileSync(manifestPath, 'utf-8');
      const parsed = JSON.parse(raw) as {
        images?: Record<string, Record<string, string>>;
        collections?: { name: string; slug: string }[];
      };
      const map = new Map<string, CollectionCodeEntry[]>();
      if (parsed.images) {
        for (const [slug, group] of Object.entries(parsed.images)) {
          for (const [code, path] of Object.entries(group)) {
            const list = map.get(code) ?? [];
            list.push({ slug, path });
            map.set(code, list);
          }
        }
      }

      const nameMap = new Map<string, string>();
      if (parsed.collections) {
        for (const collection of parsed.collections) {
          const normalizedName = this.normalizeCollection(collection.name);
          const normalizedSlug = this.normalizeCollection(collection.slug);
          if (normalizedName) nameMap.set(normalizedName, collection.slug);
          if (normalizedSlug) nameMap.set(normalizedSlug, collection.slug);
        }
      }

      this.collectionCodeMap = map;
      this.collectionNameToSlug = nameMap;
      this.frontPublicDir =
        this.resolveFrontPublicDirFromManifest(manifestPath);
    } catch (e) {
      this.logger.error(`Collection manifest o'qishda xatolik: ${e.message}`);
      this.collectionCodeMap = new Map();
      this.collectionNameToSlug = new Map();
    }
  }

  private resolveManifestPath(): string | null {
    const explicit = process.env.COLLECTIONS_MANIFEST_PATH;
    const candidates = [
      explicit,
      join(
        process.cwd(),
        'front',
        'public',
        'images',
        'collections',
        'manifest.json',
      ),
      join(
        process.cwd(),
        '..',
        'front',
        'public',
        'images',
        'collections',
        'manifest.json',
      ),
      join(process.cwd(), 'public', 'images', 'collections', 'manifest.json'),
      join(
        process.cwd(),
        '..',
        'public',
        'images',
        'collections',
        'manifest.json',
      ),
    ].filter(Boolean) as string[];

    for (const path of candidates) {
      if (existsSync(path)) return path;
    }

    return null;
  }

  private resolveFrontPublicDirFromManifest(
    manifestPath: string,
  ): string | null {
    const collectionsDir = dirname(manifestPath);
    const frontPublicDir = join(collectionsDir, '..', '..');
    return existsSync(frontPublicDir) ? frontPublicDir : null;
  }

  private extractCodeCandidates(text: string): string[] {
    const upper = text.toUpperCase();
    const candidates = new Set<string>();

    const tokens = upper
      .replace(/[^A-Z0-9]+/g, ' ')
      .split(' ')
      .map((t) => t.trim())
      .filter(Boolean);

    for (const token of tokens) {
      if (token.length >= 4) {
        candidates.add(token);
      }
    }

    const regexMatches = upper.match(/[A-Z]{1,3}\d{2,4}[A-Z]{1,3}/g) || [];
    for (const match of regexMatches) {
      candidates.add(match);
    }

    return Array.from(candidates);
  }

  private resolveCollectionSlug(name?: string | null): string | null {
    if (!name) return null;
    this.ensureCollectionManifestLoaded();
    if (!this.collectionNameToSlug) return null;

    const normalized = this.normalizeCollection(name);
    if (!normalized) return null;

    const alias = this.resolveCollectionAlias(normalized);
    if (alias && this.collectionNameToSlug.has(alias)) {
      return this.collectionNameToSlug.get(alias) || null;
    }

    const direct = this.collectionNameToSlug.get(normalized);
    if (direct) return direct;

    const compact = normalized.replace(/-/g, '');
    const compactMatch = this.collectionNameToSlug.get(compact);
    if (compactMatch) return compactMatch;

    return null;
  }

  private normalizeCollection(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  private resolveCollectionAlias(normalizedName: string): string {
    if (!normalizedName) return '';

    const compact = normalizedName.replace(/-/g, '');

    if (
      normalizedName === 'touch' ||
      normalizedName.startsWith('touch-') ||
      compact.startsWith('touch')
    ) {
      return 'touch';
    }

    if (
      normalizedName === 'iran' ||
      normalizedName.startsWith('iran-') ||
      normalizedName === 'iran-soft' ||
      normalizedName === 'eron' ||
      normalizedName.startsWith('eron-') ||
      normalizedName === 'eron-soft' ||
      normalizedName === 'soft' ||
      normalizedName.startsWith('soft-')
    ) {
      return 'iran-soft';
    }

    if (
      normalizedName === 'trio' ||
      normalizedName.startsWith('trio-') ||
      compact === 'triowhite' ||
      compact === 'trioblack'
    ) {
      return 'trio';
    }

    if (
      normalizedName === 'new-luna' ||
      normalizedName.startsWith('luna-') ||
      compact === 'newluna'
    ) {
      return 'luna';
    }

    return '';
  }

  private formatPhoneNumber(value: string): string {
    const digits = (value || '').replace(/\D/g, '');
    let localDigits = '';
    if (digits.startsWith('998')) {
      localDigits = digits.slice(3, 12);
    } else {
      localDigits = digits.slice(0, 9);
    }

    const compact = localDigits.padEnd(9, '');
    return `+998${compact}`;
  }

  private normalizeQuery(query: string): string {
    const q = query.toLowerCase();
    // Common synonyms/transliterations
    if (q === 'eron' || q.includes('eron')) return q.replace('eron', 'iran');
    if (q === 'turkiya' || q.includes('turk'))
      return q.replace('turkiya', 'turk');
    return q;
  }

  private rankSearchResults(
    query: string,
    normalized: string,
    carpets: any[],
  ): any[] {
    const q = query.toLowerCase();
    const n = normalized.toLowerCase();

    return carpets.sort((a, b) => {
      const nameA = (a.name || '').toLowerCase();
      const nameB = (b.name || '').toLowerCase();

      const getScore = (name: string) => {
        if (!name) return 0;
        if (name === q || name === n) return 100; // Exact match
        if (name.startsWith(q) || name.startsWith(n)) return 80; // Starts with

        // Whole word match
        const words = name.split(/[\s_-]+/);
        if (words.includes(q) || words.includes(n)) return 60;

        // Substring match
        if (name.includes(q) || name.includes(n)) {
          // If it's a substring match, shorter names are usually more relevant
          // or matches closer to the start
          const idx =
            name.indexOf(q) !== -1 ? name.indexOf(q) : name.indexOf(n);
          return 40 - idx - name.length / 10;
        }
        return 0;
      };

      return getScore(nameB) - getScore(nameA);
    });
  }

  private calculateGridColorDistance(img1: any, img2: any): number {
    const GRID_SIZE = 16;
    const cellW = Math.floor(img1.bitmap.width / GRID_SIZE);
    const cellH = Math.floor(img1.bitmap.height / GRID_SIZE);

    let totalDist = 0;
    let totalWeight = 0;

    for (let gy = 0; gy < GRID_SIZE; gy++) {
      for (let gx = 0; gx < GRID_SIZE; gx++) {
        // Center-priority weighting: inner 8x8 region gets 2x weight
        const isCenter = gx >= 4 && gx < 12 && gy >= 4 && gy < 12;
        const weight = isCenter ? 2 : 1;

        const avg1 = this.getAverageColorInRegion(
          img1,
          gx * cellW,
          gy * cellH,
          cellW,
          cellH,
        );
        const avg2 = this.getAverageColorInRegion(
          img2,
          gx * cellW,
          gy * cellH,
          cellW,
          cellH,
        );

        const rD = avg1.r - avg2.r;
        const gD = avg1.g - avg2.g;
        const bD = avg1.b - avg2.b;

        // Weighted Euclidean distance for human perception: sqrt(2*rD^2 + 4*gD^2 + 3*bD^2)
        // Normalized by max possible distance (sqrt(2*255^2 + 4*255^2 + 3*255^2) ≈ 765)
        const d = Math.sqrt(2 * rD * rD + 4 * gD * gD + 3 * bD * bD) / 765;

        totalDist += d * weight;
        totalWeight += weight;
      }
    }

    return totalDist / totalWeight;
  }

  private async smartCrop(img: any): Promise<any> {
    const w = img.bitmap.width;
    const h = img.bitmap.height;

    // Simple edge detection/content discovery
    // We sample pixels to find the bounding box that excludes low-variance outer regions
    let minX = w,
      maxX = 0,
      minY = h,
      maxY = 0;
    const threshold = 30; // Contrast threshold

    // Skip every few pixels for performance
    const step = 4;
    for (let y = step; y < h - step; y += step) {
      for (let x = step; x < w - step; x += step) {
        const idx = (w * y + x) << 2;
        const r = img.bitmap.data[idx];
        const g = img.bitmap.data[idx + 1];
        const b = img.bitmap.data[idx + 2];

        // Compare with neighbors to find edges
        const rightIdx = (w * y + (x + step)) << 2;
        const downIdx = (w * (y + step) + x) << 2;

        const dr = Math.abs(r - img.bitmap.data[rightIdx]);
        const dg = Math.abs(g - img.bitmap.data[rightIdx + 1]);
        const db = Math.abs(b - img.bitmap.data[rightIdx + 2]);

        const dr2 = Math.abs(r - img.bitmap.data[downIdx]);
        const dg2 = Math.abs(g - img.bitmap.data[downIdx + 1]);
        const db2 = Math.abs(b - img.bitmap.data[downIdx + 2]);

        if (
          dr > threshold ||
          dg > threshold ||
          db > threshold ||
          dr2 > threshold ||
          dg2 > threshold ||
          db2 > threshold
        ) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }

    // If we found a valid "active" region, crop to it with a small margin
    if (maxX > minX && maxY > minY) {
      const margin = 10;
      const cropX = Math.max(0, minX - margin);
      const cropY = Math.max(0, minY - margin);
      const cropW = Math.min(w - cropX, maxX - minX + 2 * margin);
      const cropH = Math.min(h - cropY, maxY - minY + 2 * margin);

      if (cropW > w * 0.2 && cropH > h * 0.2) {
        // Ensure we don't crop too aggressively
        return img.clone().crop(cropX, cropY, cropW, cropH);
      }
    }

    return img;
  }

  private getAverageColorInRegion(
    img: any,
    x: number,
    y: number,
    w: number,
    h: number,
  ): { r: number; g: number; b: number } {
    let r = 0,
      g = 0,
      b = 0;
    let count = 0;

    for (let py = y; py < y + h; py++) {
      for (let px = x; px < x + w; px++) {
        const idx = (img.bitmap.width * py + px) << 2;
        if (idx < 0 || idx >= img.bitmap.data.length) continue;
        r += img.bitmap.data[idx];
        g += img.bitmap.data[idx + 1];
        b += img.bitmap.data[idx + 2];
        count++;
      }
    }

    return {
      r: Math.round(r / (count || 1)),
      g: Math.round(g / (count || 1)),
      b: Math.round(b / (count || 1)),
    };
  }

  private async generateUniqueBarcode(tx: any): Promise<string> {
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const num = Math.floor(10000000 + Math.random() * 90000000);
      const barcodeStr = String(num);
      const existing = await tx.carpet.findUnique({
        where: { barcode: barcodeStr },
      });
      if (!existing) {
        return barcodeStr;
      }
    }
    throw new BadRequestException(
      'Barcode generatsiya qilish urinishlari soni oshib ketdi (100 marta).',
    );
  }

  private async generateUniqueSku(
    tx: any,
    designCode: string,
    widthCm: number,
    lengthCm: number,
  ): Promise<string> {
    const cleanDesign = (designCode || 'UNKNOWN')
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase();
    let counter = 1;
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const paddedCounter = String(counter).padStart(4, '0');
      const skuStr = `RET-${cleanDesign}-${widthCm}-${lengthCm}-${paddedCounter}`;
      const existing = await tx.carpet.findUnique({
        where: { sku: skuStr },
      });
      if (!existing) {
        return skuStr;
      }
      counter++;
    }
    throw new BadRequestException(
      'SKU generatsiya qilish urinishlari soni oshib ketdi.',
    );
  }

  // New Search & Filter Helper Methods
  private async handleCategoriesMenu(ctx: Context) {
    // Include all categories that have at least 1 carpet (not archived)
    const categories = await this.prisma.category.findMany({
      where: {
        carpets: {
          some: { isArchived: false },
        },
      },
      select: { id: true, name: true, _count: { select: { carpets: true } } },
      orderBy: { name: 'asc' },
      take: 30,
    });

    if (categories.length === 0) {
      await ctx.reply('Hozircha kategoriyalar mavjud emas.');
      return;
    }

    // Show categories in 2-column inline keyboard
    const inlineKeyboard: any[][] = [];
    for (let i = 0; i < categories.length; i += 2) {
      const row: any[] = [
        {
          text: `${categories[i].name} (${categories[i]._count.carpets})`,
          callback_data: `filter_category_set_${categories[i].id}`,
        },
      ];
      if (categories[i + 1]) {
        row.push({
          text: `${categories[i + 1].name} (${categories[i + 1]._count.carpets})`,
          callback_data: `filter_category_set_${categories[i + 1].id}`,
        });
      }
      inlineKeyboard.push(row);
    }

    await ctx.reply('📂 Kategoriyani tanlang:', {
      reply_markup: {
        inline_keyboard: inlineKeyboard,
      },
    });
  }

  private async handleSizesMenu(ctx: Context) {
    // Fetch real sizes from DB (ACTIVE inventory items)
    const items = await this.prisma.inventoryItem.findMany({
      where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
      select: { size: true },
      take: 1000,
    });

    const sizeSet = new Set<string>();
    for (const item of items) {
      const s = (item.size || '').trim();
      if (s) sizeSet.add(s);
    }

    // Sort sizes intelligently (by area: width * length)
    const sizes = Array.from(sizeSet).sort((a, b) => {
      const [aw, al] = a.split('x').map(Number);
      const [bw, bl] = b.split('x').map(Number);
      return (aw * al || 0) - (bw * bl || 0);
    });

    if (sizes.length === 0) {
      await ctx.reply("O'lchamlar topilmadi. Qidiruv uchun o'lchamni yozib yuboring (masalan: 200x300)");
      return;
    }

    const inline_keyboard: any[][] = [];
    for (let i = 0; i < Math.min(sizes.length, 24); i += 3) {
      const row: any[] = [];
      for (let j = 0; j < 3 && i + j < sizes.length; j++) {
        const sz = sizes[i + j];
        row.push({
          text: sz,
          callback_data: `filter_size_set_${sz}`,
        });
      }
      inline_keyboard.push(row);
    }

    await ctx.reply(`📏 O'lchamni tanlang (${sizes.length} xil o'lcham mavjud):`, {
      reply_markup: {
        inline_keyboard,
      },
    });
  }

  private async handlePremiumSearch(ctx: Context) {
    const chatId = ctx.chat!.id.toString();
    const state = {
      query: '',
      onlyAvailable: true,
      minPrice: 400000,
      page: 1,
    };
    this.userSearchState.set(chatId, state);
    await this.renderSearchResults(ctx, state);
  }

  private async handleFavoritesMenu(ctx: Context) {
    const chatId = ctx.chat!.id.toString();
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    if (!user) {
      await ctx.reply(
        "Siz hali ro'yxatdan o'tmagansiz. Iltimos, /start bosing.",
      );
      return;
    }

    const likes = await this.prisma.carpetLike.findMany({
      where: { userId: user.id },
      include: {
        carpet: {
          include: {
            category: true,
            inventoryItems: {
              where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
            rollInventories: true,
          },
        },
      },
    });

    if (likes.length === 0) {
      await ctx.reply("❤️ Sevimli gilamlaringiz ro'yxati bo'sh.");
      return;
    }

    await ctx.reply(`❤️ Sevimli gilamlaringiz (${likes.length} ta):`);
    for (const like of likes.slice(0, 5)) {
      const carpet = like.carpet;
      let stockCount = 0;
      let sizesList = '';
      if (carpet.type === 'ROLL') {
        const rolls = await this.prisma.rollInventory.findMany({
          where: { carpetId: carpet.id },
          select: { widthCm: true, currentLengthCm: true },
        });
        sizesList =
          rolls
            .map((r) => `${r.widthCm / 100} x ${r.currentLengthCm / 100} m`)
            .join(', ') || "Noma'lum";
        stockCount = rolls.reduce(
          (sum, r) => sum + (r.currentLengthCm > 0 ? 1 : 0),
          0,
        );
      } else {
        sizesList =
          carpet.inventoryItems
            .map(
              (i) =>
                `${Math.round(i.widthMm / 10) / 100} x ${Math.round(i.lengthMm / 10) / 100} m`,
            )
            .join(', ') || "Noma'lum";
        stockCount = carpet.inventoryItems.length;
      }

      const msg =
        `✨ <b>${carpet.name}</b> ✨\n\n` +
        `📂 <b>Kategoriya:</b> ${carpet.category?.name || "Noma'lum"}\n` +
        `💰 <b>Narxi:</b> ${Number(carpet.price).toLocaleString()} so'm / m²\n` +
        `📍 <b>O'lchamlari:</b> ${sizesList}\n` +
        `📦 <b>Zaxirada:</b> ${stockCount} dona\n\n` +
        `🔗 <a href="https://yecmarket.uz/carpets/${carpet.id}">Veb-saytda ko'rish</a>`;

      const inlineKeyboard = {
        inline_keyboard: [
          [
            {
              text: '🛒 Sotib olish',
              url: `https://yecmarket.uz/carpets/${carpet.id}`,
            },
            { text: "❌ O'chirish", callback_data: `like_toggle_${carpet.id}` },
          ],
        ],
      };

      const image = carpet.images?.[0]?.trim() || '';
      const photoInput = this.resolveCarpetPhoto(image);
      if (photoInput) {
        await this.telegramService.sendPhoto(
          chatId,
          photoInput,
          msg,
          inlineKeyboard,
        );
      } else {
        await ctx.reply(msg, {
          parse_mode: 'HTML',
          reply_markup: inlineKeyboard,
        });
      }
    }
  }

  private async handleSettingsMenu(ctx: Context) {
    const chatId = ctx.chat!.id.toString();
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    const name = user ? user.name : ctx.from?.first_name || 'Foydalanuvchi';
    const phone = user ? user.phone : "Bog'lanmagan";

    const msg =
      `⚙ <b>Sozlamalar va ma'lumotlar</b>\n\n` +
      `👤 <b>Ism:</b> ${name}\n` +
      `📞 <b>Telefon:</b> ${phone}\n` +
      `🤖 <b>Bot statusi:</b> Faol\n\n` +
      `Quyidagi tugmalar orqali profilingiz va buyurtmalaringizni boshqarishingiz mumkin:`;

    const inline_keyboard = [
      [
        { text: '📦 Mening buyurtmalarim', callback_data: 'settings_orders' },
        { text: '🏢 Filiallar', callback_data: 'settings_branches' },
      ],
      [{ text: '🌐 YEC Market sayti', url: 'https://yecmarket.uz' }],
    ];

    await ctx.reply(msg, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard,
      },
    });
  }

  private async renderSearchResults(
    ctx: Context,
    state: {
      query: string;
      categoryId?: string;
      shape?: string;
      size?: string;
      minPrice?: number;
      maxPrice?: number;
      material?: string;
      onlyAvailable?: boolean;
      onlyPromo?: boolean;
      onlyNew?: boolean;
      page: number;
    },
  ) {
    const chatId = ctx.chat!.id.toString();
    const searchOptions = {
      categoryId: state.categoryId,
      shape: state.shape,
      size: state.size,
      minPrice: state.minPrice,
      maxPrice: state.maxPrice,
      material: state.material,
      onlyAvailable: state.onlyAvailable,
      onlyPromo: state.onlyPromo,
      onlyNew: state.onlyNew,
      page: state.page,
      limit: 5,
    };

    let results: any[] = [];
    let totalCount = 0;
    try {
      const searchRes = await this.searchService.search(
        state.query,
        searchOptions,
      );
      results = searchRes.results;
      totalCount = searchRes.totalCount;
    } catch (err: any) {
      this.logger.error(
        `SearchService error for query "${state.query}": ${err?.message || err}`,
      );
      await ctx.reply(
        "🔍 Qidiruv xizmatida vaqtincha nosozlik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.",
      );
      return;
    }

    if (results.length === 0) {
      const safeQuery = escapeHtml(state.query || 'Filtrlar');
      const msg = `🔍 "<b>${safeQuery}</b>" bo'yicha hech qanday gilam topilmadi.`;
      const hasFilters =
        state.categoryId ||
        state.shape ||
        state.size ||
        state.minPrice ||
        state.maxPrice ||
        state.material ||
        state.onlyPromo ||
        state.onlyNew;
      const inline_keyboard = hasFilters
        ? [[{ text: '❌ Filtrlarni tozalash', callback_data: 'filter_clear' }]]
        : [];

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard },
      });
      return;
    }

    for (const carpet of results) {
      try {
        const stockCount = carpet.sizes.reduce(
          (sum: number, s: any) => sum + s.stock,
          0,
        );
        // widthCm and lengthCm are already in centimeters (mm / 10)
        // Display as meters: cm / 100
        const sizesList =
          carpet.sizes
            .map((s: any) => {
              // sizes are stored as cm, show as e.g. "200x300" or "2x3m"
              const wCm = s.widthCm;
              const lCm = s.lengthCm;
              if (wCm >= 100 || lCm >= 100) {
                // Already in cm (e.g. 200cm x 300cm) → show as "200x300 sm"
                return `${wCm}x${lCm} sm`;
              }
              // Small values likely already meters representation
              return `${wCm}x${lCm}`;
            })
            .join(', ') || "Noma'lum";

        let priceText = `${carpet.price.toLocaleString()} so'm / m²`;
        if (carpet.discountPercent > 0) {
          const discountedPrice = Math.round(
            carpet.price * (1 - carpet.discountPercent / 100),
          );
          priceText = `<s>${carpet.price.toLocaleString()}</s> <b>${discountedPrice.toLocaleString()}</b> so'm / m² (-${carpet.discountPercent}%)`;
        }

        const safeCarpetName = escapeHtml(carpet.name);
        const safeCatName = escapeHtml(carpet.categoryName || "Noma'lum");
        const safeCode = escapeHtml(carpet.designCode || carpet.uniqueCode);
        const safeMaterial = escapeHtml(carpet.material || "Noma'lum");

        let textMsg =
          `✨ <b>${safeCarpetName}</b> ✨\n\n` +
          `📂 <b>Kategoriya:</b> ${safeCatName}\n` +
          `🔢 <b>Gul kodi:</b> ${safeCode}\n` +
          `💰 <b>Narxi:</b> ${priceText}\n` +
          `🧵 <b>Material:</b> ${safeMaterial}\n` +
          `📍 <b>O'lchamlar:</b> ${escapeHtml(sizesList)}\n` +
          `📦 <b>Status:</b> ${stockCount > 0 ? '✅ Sotuvda bor' : '❌ Tugagan'}\n`;

        if (carpet.description) {
          textMsg += `📝 <b>Tavsif:</b> ${escapeHtml(carpet.description)}\n`;
        }

        const user = await this.prisma.user.findFirst({
          where: { telegramChatId: chatId },
        });
        let isLiked = false;
        if (user) {
          const like = await this.prisma.carpetLike.findUnique({
            where: {
              userId_carpetId: { userId: user.id, carpetId: carpet.id },
            },
          });
          isLiked = !!like;
        }

        const inlineKeyboard = {
          inline_keyboard: [
            [
              {
                text: '🛒 Sotib olish',
                url: `https://yecmarket.uz/carpets/${carpet.id}`,
              },
              {
                text: isLiked ? '❤️ Saqlangan' : '🖤 Saqlash',
                callback_data: `like_toggle_${carpet.id}`,
              },
            ],
            [
              {
                text: '📤 Ulashish',
                url: `https://t.me/share/url?url=https://yecmarket.uz/carpets/${carpet.id}&text=${encodeURIComponent('YEC Marketda ajoyib gilam topdim: ' + carpet.name)}`,
              },
              {
                text: "🔍 O'xshashlar",
                callback_data: `similar_search_${carpet.id}`,
              },
            ],
            [{ text: '📞 Operator', url: 'https://t.me/Saloxiddin_977' }],
          ],
        };

        const image = carpet.images?.[0]?.trim() || '';
        const photoInput = this.resolveCarpetPhoto(image);
        if (photoInput) {
          await this.telegramService.sendPhoto(
            chatId,
            photoInput,
            textMsg,
            inlineKeyboard,
          );
        } else {
          await this.telegramService.sendMessageSafe(
            chatId,
            textMsg,
            inlineKeyboard,
          );
        }
      } catch (itemErr: any) {
        this.logger.error(
          `Error displaying carpet ${carpet?.id}: ${itemErr?.message || itemErr}`,
        );
      }
    }

    const totalPages = Math.ceil(totalCount / 5);
    let controlText = `🔍 <b>Natijalar:</b> ${totalCount} ta gilam topildi.\nSahifa: <b>${state.page}/${totalPages}</b>`;

    const activeFilters: string[] = [];
    if (state.categoryId) activeFilters.push('Kategoriya');
    if (state.size) activeFilters.push(`O'lcham (${state.size})`);
    if (state.shape) activeFilters.push(`Shakl (${state.shape})`);
    if (state.material) activeFilters.push(`Material (${state.material})`);
    if (state.minPrice || state.maxPrice) activeFilters.push('Narx');
    if (state.onlyPromo) activeFilters.push('Aksiya');
    if (state.onlyNew) activeFilters.push('Yangi');
    if (activeFilters.length > 0) {
      controlText += `\n⚠️ Faol filtrlar: <i>${activeFilters.join(', ')}</i>`;
    }

    const inline_keyboard: any[] = [];
    const pagerRow: any[] = [];
    if (state.page > 1) {
      pagerRow.push({ text: '◀ Oldingi', callback_data: 'search_page_prev' });
    }
    if (state.page < totalPages) {
      pagerRow.push({ text: 'Keyingi ▶', callback_data: 'search_page_next' });
    }
    if (pagerRow.length > 0) {
      inline_keyboard.push(pagerRow);
    }

    inline_keyboard.push([
      { text: '🎨 Rang', callback_data: 'filter_menu_color' },
      { text: "📏 O'lcham", callback_data: 'filter_menu_size' },
      { text: '🔄 Shakl', callback_data: 'filter_menu_shape' },
    ]);
    inline_keyboard.push([
      { text: '🧵 Material', callback_data: 'filter_menu_material' },
      { text: '💰 Narx', callback_data: 'filter_menu_price' },
      { text: '🏷️ Status', callback_data: 'filter_menu_status' },
    ]);
    inline_keyboard.push([
      { text: '❌ Filtrlarni tozalash', callback_data: 'filter_clear' },
    ]);

    await ctx.reply(controlText, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard },
    });
  }

  private async handleLikeToggle(ctx: Context, carpetId: string) {
    const chatId = ctx.chat!.id.toString();
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    if (!user) {
      await ctx.reply(
        "Siz hali ro'yxatdan o'tmagansiz. Iltimos, /start bosing.",
      );
      return;
    }

    const like = await this.prisma.carpetLike.findUnique({
      where: { userId_carpetId: { userId: user.id, carpetId } },
    });

    if (like) {
      await this.prisma.carpetLike.delete({
        where: { id: like.id },
      });
      await ctx.reply("❌ Gilam sevimlilar ro'yxatidan o'chirildi.");
    } else {
      await this.prisma.carpetLike.create({
        data: { userId: user.id, carpetId },
      });
      await ctx.reply("❤️ Gilam sevimlilar ro'yxatiga qo'shildi!");
    }
  }

  private async handleSimilarSearch(ctx: Context, carpetId: string) {
    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
      include: { category: true },
    });

    if (!carpet) {
      await ctx.reply('Gilam topilmadi.');
      return;
    }

    const categoryName = carpet.category?.name || '';
    const chatId = ctx.chat!.id.toString();

    const state = {
      query: categoryName,
      page: 1,
    };
    this.userSearchState.set(chatId, state);
    await ctx.reply(
      `🔍 <b>${carpet.name}</b> uchun o'xshash gilamlar qidirilmoqda...`,
      { parse_mode: 'HTML' },
    );
    await this.renderSearchResults(ctx, state);
  }

  private async handleFilterMenu(ctx: Context, type: string) {
    const inline_keyboard: any[][] = [];
    if (type === 'color') {
      const colors = [
        'oq',
        'beige',
        'cream',
        "ko'k",
        'yashil',
        'qizil',
        'qora',
        'kulrang',
      ];
      for (let i = 0; i < colors.length; i += 2) {
        inline_keyboard.push([
          { text: colors[i], callback_data: `filter_color_set_${colors[i]}` },
          {
            text: colors[i + 1],
            callback_data: `filter_color_set_${colors[i + 1]}`,
          },
        ]);
      }
    } else if (type === 'size') {
      const sizes = ['2x3', '3x4', '2.5x3.5', '1.5x2.3', '4x5', '1x2'];
      for (let i = 0; i < sizes.length; i += 2) {
        inline_keyboard.push([
          { text: sizes[i], callback_data: `filter_size_set_${sizes[i]}` },
          {
            text: sizes[i + 1],
            callback_data: `filter_size_set_${sizes[i + 1]}`,
          },
        ]);
      }
    } else if (type === 'shape') {
      inline_keyboard.push([
        {
          text: "Rectangle (To'rtburchak)",
          callback_data: 'filter_shape_set_RECTANGLE',
        },
      ]);
      inline_keyboard.push([
        { text: 'Oval', callback_data: 'filter_shape_set_OVAL' },
      ]);
      inline_keyboard.push([
        { text: 'Circle (Dumaloq)', callback_data: 'filter_shape_set_CIRCLE' },
      ]);
    } else if (type === 'material') {
      const materials = ['Bambuk', 'Paxta', 'Sintetika', 'Ipak', 'Jun'];
      for (let i = 0; i < materials.length; i += 2) {
        const row = [
          {
            text: materials[i],
            callback_data: `filter_material_set_${materials[i]}`,
          },
        ];
        if (materials[i + 1]) {
          row.push({
            text: materials[i + 1],
            callback_data: `filter_material_set_${materials[i + 1]}`,
          });
        }
        inline_keyboard.push(row);
      }
    } else if (type === 'price') {
      inline_keyboard.push([
        { text: 'Arzon (< 300k)', callback_data: 'filter_price_set_low' },
      ]);
      inline_keyboard.push([
        {
          text: "O'rtacha (300k - 600k)",
          callback_data: 'filter_price_set_mid',
        },
      ]);
      inline_keyboard.push([
        { text: 'Qimmat (> 600k)', callback_data: 'filter_price_set_high' },
      ]);
    } else if (type === 'status') {
      inline_keyboard.push([
        {
          text: 'Mavjud (Sotuvda bor)',
          callback_data: 'filter_status_set_available',
        },
      ]);
      inline_keyboard.push([
        {
          text: 'Aksiyadagilar (Chegirma)',
          callback_data: 'filter_status_set_promo',
        },
      ]);
      inline_keyboard.push([
        { text: 'Yangi kelganlar', callback_data: 'filter_status_set_new' },
      ]);
    }

    await ctx.reply(`Select option for filter [${type}]:`, {
      reply_markup: { inline_keyboard },
    });
  }
}
