import { Injectable, Logger } from '@nestjs/common';
import { Context } from 'telegraf';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import { BaskoSyncLogService } from '../basko/basko-sync-log.service';
import { BaskoIntegrationService } from '../basko/basko-integration.service';
import { DimensionParserService } from '../carpets/dimension-parser.service';
import { CarpetDistanceRankingService } from '../carpets/carpet-distance-ranking.service';
import { PricingService } from '../carpets/pricing.service';
import { SELLER_BUTTONS, escapeHtml, maskChatId } from './telegram.constants';
import { existsSync } from 'fs';
import { join } from 'path';
import { CarpetInventoryStatus } from '@prisma/client';

export type SellerState =
  | 'IDLE'
  | 'AWAITING_DIMENSION_READY'
  | 'AWAITING_DIMENSION_METRAJ'
  | 'AWAITING_DIMENSION_OVAL'
  | 'AWAITING_BARCODE';

export interface SellerProductCardItem {
  carpetId: string;
  designCode: string;
  name: string;
  sizeDisplay: string;
  priceDisplay: string;
  priceNumeric: number;
  barcode?: string;
  image?: string;
  material?: string;
  yarnType?: string;
  color?: string;
  stockText: string;
  isAvailable: boolean;
  shape?: string;
  productType?: string;
}

export interface SellerSearchSession {
  sessionId: string;
  chatId: string;
  type: 'READY' | 'METRAJ' | 'OVAL' | 'FAVORITES' | 'BARCODE';
  queryText: string;
  bannerText?: string;
  items: SellerProductCardItem[];
  currentPage: number;
  totalPages: number;
  createdAt: number;
}

@Injectable()
export class TelegramSellerService {
  private readonly logger = new Logger(TelegramSellerService.name);

  // In-memory state tracking per seller chat
  private readonly sellerStates = new Map<string, SellerState>();

  // In-memory search sessions for pagination
  private readonly searchSessions = new Map<string, SellerSearchSession>();

  private readonly PAGE_SIZE = 4;
  private readonly SESSION_TTL_MS = 1000 * 60 * 30; // 30 minutes

  constructor(
    private readonly prisma: PrismaService,
    private readonly telegramService: TelegramService,
    private readonly baskoSyncLogService: BaskoSyncLogService,
    private readonly baskoIntegrationService: BaskoIntegrationService,
    private readonly dimensionParserService: DimensionParserService,
    private readonly carpetDistanceRankingService: CarpetDistanceRankingService,
    private readonly pricingService: PricingService,
  ) {}

  /**
   * Builds the dedicated seller main reply keyboard (tablet & mobile friendly).
   */
  public buildSellerKeyboard() {
    return {
      reply_markup: {
        keyboard: [
          [{ text: SELLER_BUTTONS.REFRESH }],
          [
            { text: SELLER_BUTTONS.READY_CARPETS },
            { text: SELLER_BUTTONS.METRAJ_CARPETS },
          ],
          [
            { text: SELLER_BUTTONS.OVAL_CARPETS },
            { text: SELLER_BUTTONS.SEARCH_BARCODE },
          ],
          [{ text: SELLER_BUTTONS.FAVORITES }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
        input_field_placeholder: 'Kerakli bo‘limni tanlang...',
      },
    };
  }

  /**
   * Sets the active state for a seller chat.
   */
  public setSellerState(chatId: string, state: SellerState) {
    this.sellerStates.set(chatId, state);
  }

  /**
   * Gets the active state for a seller chat.
   */
  public getSellerState(chatId: string): SellerState {
    return this.sellerStates.get(chatId) || 'IDLE';
  }

  /**
   * Clears the active state for a seller chat.
   */
  public clearSellerState(chatId: string) {
    this.sellerStates.delete(chatId);
  }

  /**
   * Displays the main menu for seller.
   */
  public async showSellerMainMenu(chatId: string, message?: string) {
    this.clearSellerState(chatId);
    const text =
      message ||
      `🏪 <b>YEC Sotuvchi Paneli</b>\n\nQuyidagi bo‘limlardan birini tanlang:`;

    await this.telegramService.sendMessageSafe(
      chatId,
      text,
      this.buildSellerKeyboard().reply_markup,
    );
  }

  /**
   * Handles incoming text messages when seller is in an active state or taps menu buttons.
   * Returns true if handled, false otherwise.
   */
  public async handleSellerTextInput(
    chatId: string,
    rawText: string,
  ): Promise<boolean> {
    try {
      const text = rawText.trim();
      if (!text) return false;

    // Check menu button triggers first
    if (text === SELLER_BUTTONS.REFRESH) {
      await this.handleSyncFlow(chatId);
      return true;
    }

    if (text === SELLER_BUTTONS.READY_CARPETS) {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_READY');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🏠 <b>Tayyor gilamlar bo‘yicha qidiruv</b>\n\n` +
          `Iltimos, gilam o‘lchamini kiriting:\n` +
          `<i>Masalan: 2x3, 200x300, 4x6.11, 4 6,11</i>`,
      );
      return true;
    }

    if (text === SELLER_BUTTONS.METRAJ_CARPETS) {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_METRAJ');
      await this.telegramService.sendMessageSafe(
        chatId,
        `📏 <b>Metraj gilamlar bo‘yicha qidiruv</b>\n\n` +
          `Iltimos, kerakli eni va bo‘yini kiriting:\n` +
          `<i>Masalan: 4x6.11, 4 6,11, 3x5</i>`,
      );
      return true;
    }

    if (text === SELLER_BUTTONS.OVAL_CARPETS) {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_OVAL');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🟠 <b>Oval gilamlar bo‘yicha qidiruv</b>\n\n` +
          `Iltimos, oval gilam o‘lchamini kiriting:\n` +
          `<i>Masalan: 2x3, 1.5x2.3</i>`,
      );
      return true;
    }

    if (text === SELLER_BUTTONS.SEARCH_BARCODE) {
      this.setSellerState(chatId, 'AWAITING_BARCODE');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🔎 <b>Shtrix-kod (barcode) bo‘yicha qidiruv</b>\n\n` +
          `Shtrix-kod raqamini kiriting yoki shtrix-kod skaner orqali yuboring:\n` +
          `<i>(Boshidagi nollar to‘liq saqlanadi, masalan: 00123456)</i>`,
      );
      return true;
    }

    if (text === SELLER_BUTTONS.FAVORITES) {
      await this.handleFavoritesList(chatId);
      return true;
    }

    if (text === SELLER_BUTTONS.BACK_MAIN || text === '🏠 Bosh menyu') {
      await this.showSellerMainMenu(chatId);
      return true;
    }

    // Process active awaiting states
    const currentState = this.getSellerState(chatId);

    if (currentState === 'AWAITING_BARCODE') {
      await this.handleBarcodeSearch(chatId, text);
      return true;
    }

    if (currentState === 'AWAITING_DIMENSION_READY') {
      await this.handleReadySearch(chatId, text);
      return true;
    }

    if (currentState === 'AWAITING_DIMENSION_METRAJ') {
      await this.handleMetrajSearch(chatId, text);
      return true;
    }

    if (currentState === 'AWAITING_DIMENSION_OVAL') {
      await this.handleOvalSearch(chatId, text);
      return true;
    }

    return false;
    } catch (err: any) {
      this.logger.error(
        `Error handling seller text input for ${maskChatId(chatId)}: ${err?.message}`,
        err?.stack,
      );
      await this.telegramService.sendMessageSafe(
        chatId,
        `⚠️ Server bilan vaqtinchalik aloqa xatoligi yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring.`,
        this.buildSellerKeyboard().reply_markup,
      );
      return true;
    }
  }

  /**
   * Barcode Search:
   * STRICT: Preserves leading zeros! Operates strictly with string type.
   */
  public async handleBarcodeSearch(chatId: string, rawBarcode: string) {
    this.clearSellerState(chatId);
    const barcode = rawBarcode.trim();

    if (!barcode) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ Shtrix-kod bo‘sh bo‘lishi mumkin emas. Iltimos, qayta kiriting:`,
      );
      return;
    }

    this.logger.log(
      `Barcode search initiated by ${maskChatId(chatId)}: "${barcode}" (length=${barcode.length})`,
    );

    // Exact string search in inventory_items
    const inventoryItem = await this.prisma.inventoryItem.findFirst({
      where: {
        barcode: barcode,
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
      },
      include: {
        carpet: {
          include: {
            inventoryItems: {
              where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
            rollInventories: true,
          },
        },
      },
    });

    if (!inventoryItem || !inventoryItem.carpet) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ Ushbu shtrix-kodga (<code>${escapeHtml(barcode)}</code>) mos mahsulot omborda topilmadi.`,
        {
          inline_keyboard: [
            [
              {
                text: '🔎 Boshqa shtrix-kod',
                callback_data: 'seller_ask_barcode',
              },
              { text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' },
            ],
          ],
        },
      );
      return;
    }

    // Render product detail card directly
    await this.renderProductDetailCard(
      chatId,
      inventoryItem.carpet.id,
      undefined,
      1,
      barcode,
    );
  }

  /**
   * Metraj Search:
   * 1. Parse dimension
   * 2. Search metraj rolls via ranking service
   * 3. Fallback: Closest ready carpets (Euclidean ranked, <=120cm)
   * 4. Fallback: Oval carpets
   * 5. "Ushbu o‘lchamga mos gilam topilmadi"
   * CRITICAL: Never auto-suggest 5m metraj for 4m request.
   */
  public async handleMetrajSearch(chatId: string, input: string) {
    this.clearSellerState(chatId);
    const parsed = this.dimensionParserService.parse(input);

    if (!parsed.success || !parsed.widthCm || !parsed.lengthCm) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ ${parsed.message || "O'lcham noto'g'ri kiritildi."}\n` +
          `<i>Masalan: 4x6.11 yoki 4 6,11 ko‘rinishida kiriting.</i>`,
      );
      return;
    }

    const { widthCm, lengthCm } = parsed;
    const displayMeters = parsed.displayMeters || parsed.displayCm || `${widthCm}x${lengthCm}cm`;

    // Execute strict fallback hierarchy: Metraj -> Closest Ready -> Oval -> Not Found
    const flow = await this.carpetDistanceRankingService.executeFallbackSearch(
      widthCm,
      lengthCm,
      displayMeters,
    );

    if (flow.stage === 'METRAJ_EXACT' && flow.metrajResults && flow.metrajResults.length > 0) {
      const items: SellerProductCardItem[] = flow.metrajResults.map((r) => {
        const areaM2 = (widthCm * lengthCm) / 10000;
        const priceNum = Math.round(r.pricePerM2 * areaM2);
        return {
          carpetId: r.carpetId,
          designCode: r.patternCode || r.uniqueCode || r.name,
          name: r.name,
          sizeDisplay: displayMeters,
          priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
          priceNumeric: priceNum,
          barcode: r.uniqueCode || r.carpetId.slice(0, 8),
          image: r.images?.[0],
          material: 'Standart',
          yarnType: 'Heatset',
          stockText: `${r.effectiveAvailableLengthMeters} m rulonda mavjud`,
          isAvailable: true,
          productType: 'METRAJ',
        };
      });

      const session = this.createSearchSession(
        chatId,
        'METRAJ',
        input,
        items,
        `📏 <b>Metraj natijalari:</b> ${displayMeters}`,
      );
      await this.renderProductAlbum(chatId, session, 1);
      return;
    }

    if (flow.stage === 'READY_CLOSEST' && flow.results.length > 0) {
      const items: SellerProductCardItem[] = flow.results.map((r) => {
        const priceNum = Number(r.price);
        return {
          carpetId: r.carpetId,
          designCode: r.patternCode || r.uniqueCode || r.name,
          name: r.name,
          sizeDisplay: `${r.widthCm} × ${r.lengthCm} cm (${Math.round(r.distanceCm)} cm farq)`,
          priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
          priceNumeric: priceNum,
          barcode: r.uniqueCode,
          image: r.images?.[0],
          material: 'Standart',
          yarnType: 'Heatset',
          stockText: `${r.stock} dona mavjud`,
          isAvailable: r.stock > 0,
          productType: 'READY',
        };
      });

      const session = this.createSearchSession(
        chatId,
        'READY',
        input,
        items,
        `ℹ️ <i>So‘ralgan metraj bo‘yicha rulon topilmadi.</i>\n` +
          `<b>Eng yaqin mos tayyor gilamlar (${displayMeters}):</b>`,
      );
      await this.renderProductAlbum(chatId, session, 1);
      return;
    }

    if (flow.stage === 'OVAL_CLOSEST' && flow.results.length > 0) {
      const items: SellerProductCardItem[] = flow.results.map((r) => {
        const priceNum = Number(r.price);
        return {
          carpetId: r.carpetId,
          designCode: r.patternCode || r.uniqueCode || r.name,
          name: r.name,
          sizeDisplay: `${r.widthCm} × ${r.lengthCm} cm (${Math.round(r.distanceCm)} cm farq)`,
          priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
          priceNumeric: priceNum,
          barcode: r.uniqueCode,
          image: r.images?.[0],
          material: 'Standart',
          yarnType: 'Heatset',
          stockText: `${r.stock} dona mavjud`,
          isAvailable: r.stock > 0,
          shape: 'OVAL',
        };
      });

      const session = this.createSearchSession(
        chatId,
        'OVAL',
        input,
        items,
        `ℹ️ <i>So‘ralgan o‘lcham bo‘yicha to‘g‘ri to‘rtburchak gilam topilmadi.</i>\n` +
          `<b>Eng yaqin oval gilamlar (${displayMeters}):</b>`,
      );
      await this.renderProductAlbum(chatId, session, 1);
      return;
    }

    // Fallback 3: No match
    await this.telegramService.sendMessageSafe(
      chatId,
      `❌ <b>Ushbu o‘lchamga mos gilam topilmadi.</b>\n\n` +
        `Kiritilgan o‘lcham: <code>${displayMeters}</code>\n` +
        `Boshqa o‘lcham kiritib ko‘ring yoki bosh menyuga qayting.`,
      {
        inline_keyboard: [
          [
            {
              text: '📏 Boshqa metraj kiritish',
              callback_data: 'seller_ask_metraj',
            },
            { text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' },
          ],
        ],
      },
    );
  }

  /**
   * Ready Carpets Search:
   * Parses dimension and ranks ready carpets by Euclidean distance.
   */
  public async handleReadySearch(chatId: string, input: string) {
    this.clearSellerState(chatId);
    const parsed = this.dimensionParserService.parse(input);

    if (!parsed.success || !parsed.widthCm || !parsed.lengthCm) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ ${parsed.message || "O'lcham noto'g'ri kiritildi."}\n` +
          `<i>Masalan: 2x3, 200x300 yoki 4x6.11 ko‘rinishida kiriting.</i>`,
      );
      return;
    }

    const { widthCm, lengthCm } = parsed;
    const displayMeters = parsed.displayMeters || parsed.displayCm || `${widthCm}x${lengthCm}cm`;

    const closestReady =
      await this.carpetDistanceRankingService.findClosestReadyCarpets(
        widthCm,
        lengthCm,
        120,
      );

    if (closestReady.length === 0) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ <b>Ushbu o‘lchamga mos tayyor gilam topilmadi.</b>\n\n` +
          `Kiritilgan o‘lcham: <code>${displayMeters}</code>`,
        {
          inline_keyboard: [
            [
              {
                text: '🏠 Boshqa o‘lcham',
                callback_data: 'seller_ask_ready',
              },
              { text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' },
            ],
          ],
        },
      );
      return;
    }

    const items: SellerProductCardItem[] = closestReady.map((r) => {
      const priceNum = Number(r.price);
      return {
        carpetId: r.carpetId,
        designCode: r.patternCode || r.uniqueCode || r.name,
        name: r.name,
        sizeDisplay: `${r.widthCm} × ${r.lengthCm} cm (${Math.round(r.distanceCm)} cm farq)`,
        priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
        priceNumeric: priceNum,
        barcode: r.uniqueCode,
        image: r.images?.[0],
        material: 'Standart',
        yarnType: 'Heatset',
        stockText: `${r.stock} dona mavjud`,
        isAvailable: r.stock > 0,
        productType: 'READY',
      };
    });

    const session = this.createSearchSession(
      chatId,
      'READY',
      input,
      items,
      `🏠 <b>Tayyor gilamlar natijalari (${displayMeters}):</b>`,
    );
    await this.renderProductAlbum(chatId, session, 1);
  }

  /**
   * Oval Carpets Search:
   */
  public async handleOvalSearch(chatId: string, input: string) {
    this.clearSellerState(chatId);
    const parsed = this.dimensionParserService.parse(input);

    if (!parsed.success || !parsed.widthCm || !parsed.lengthCm) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ ${parsed.message || "O'lcham noto'g'ri kiritildi."}\n` +
          `<i>Masalan: 2x3 yoki 1.5x2.3 ko‘rinishida kiriting.</i>`,
      );
      return;
    }

    const { widthCm, lengthCm } = parsed;
    const displayMeters = parsed.displayMeters || parsed.displayCm || `${widthCm}x${lengthCm}cm`;

    const closestOval =
      await this.carpetDistanceRankingService.findClosestOvalCarpets(
        widthCm,
        lengthCm,
        120,
      );

    if (closestOval.length === 0) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ <b>Ushbu o‘lchamga mos oval gilam topilmadi.</b>\n\n` +
          `Kiritilgan o‘lcham: <code>${displayMeters}</code>`,
        {
          inline_keyboard: [
            [
              {
                text: '🟠 Boshqa oval o‘lcham',
                callback_data: 'seller_ask_oval',
              },
              { text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' },
            ],
          ],
        },
      );
      return;
    }

    const items: SellerProductCardItem[] = closestOval.map((r) => {
      const priceNum = Number(r.price);
      return {
        carpetId: r.carpetId,
        designCode: r.patternCode || r.uniqueCode || r.name,
        name: r.name,
        sizeDisplay: `${r.widthCm} × ${r.lengthCm} cm (${Math.round(r.distanceCm)} cm farq)`,
        priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
        priceNumeric: priceNum,
        barcode: r.uniqueCode,
        image: r.images?.[0],
        material: 'Standart',
        yarnType: 'Heatset',
        stockText: `${r.stock} dona mavjud`,
        isAvailable: r.stock > 0,
        shape: 'OVAL',
      };
    });

    const session = this.createSearchSession(
      chatId,
      'OVAL',
      input,
      items,
      `🟠 <b>Oval gilamlar natijalari (${displayMeters}):</b>`,
    );
    await this.renderProductAlbum(chatId, session, 1);
  }

  /**
   * Favorites Flow:
   * Persists in PostgreSQL `CarpetLike` model.
   */
  public async handleFavoritesList(chatId: string) {
    this.clearSellerState(chatId);

    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    if (!user) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `ℹ️ Profil topilmadi. Botdan foydalanish uchun /start bosing.`,
      );
      return;
    }

    const likes = await this.prisma.carpetLike.findMany({
      where: { userId: user.id },
      include: {
        carpet: {
          include: {
            inventoryItems: {
              where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            },
            rollInventories: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (likes.length === 0) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❤️ <b>Saralanganlar ro‘yxati bo‘sh</b>\n\n` +
          `Mahsulot kartasidagi [ ❤️ Saqlash ] tugmasini bosib, gilamlarni bu yerga qo‘shishingiz mumkin.`,
        {
          inline_keyboard: [
            [{ text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' }],
          ],
        },
      );
      return;
    }

    const items: SellerProductCardItem[] = likes
      .filter((l) => l.carpet && !l.carpet.isArchived)
      .map((l) => {
        const carpet = l.carpet;
        const inv = carpet.inventoryItems?.[0];
        const priceNum = inv?.piecePrice
          ? Number(inv.piecePrice)
          : Number(carpet.price || 0);

        return {
          carpetId: carpet.id,
          designCode: carpet.designCode || carpet.patternCode || carpet.name,
          name: carpet.name,
          sizeDisplay: inv?.size || 'Standart',
          priceDisplay: this.pricingService.formatUzbekCurrency(priceNum),
          priceNumeric: priceNum,
          barcode: inv?.barcode || '',
          image: carpet.images?.[0] || '',
          material: carpet.material || '',
          yarnType: this.extractYarnType(carpet.material),
          stockText: `${carpet.inventoryItems?.length || 0} dona mavjud`,
          isAvailable: (carpet.inventoryItems?.length || 0) > 0,
        };
      });

    const session = this.createSearchSession(
      chatId,
      'FAVORITES',
      'favorites',
      items,
      `❤️ <b>Saralangan gilamlar:</b>`,
    );
    await this.renderProductAlbum(chatId, session, 1);
  }

  /**
   * Toggles favorite status in PostgreSQL `CarpetLike`.
   */
  public async handleFavoriteToggle(
    chatId: string,
    carpetId: string,
  ): Promise<{ liked: boolean; totalLikes: number }> {
    let user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });

    if (!user) {
      // Auto-create/find placeholder user if needed
      user = await this.prisma.user.create({
        data: {
          name: `Sotuvchi ${chatId.slice(-4)}`,
          phone: `+998${chatId.replace(/\D/g, '').slice(-9).padStart(9, '0')}`,
          telegramChatId: chatId,
          role: 'SELLER',
        },
      });
    }

    const existing = await this.prisma.carpetLike.findUnique({
      where: {
        userId_carpetId: {
          userId: user.id,
          carpetId: carpetId,
        },
      },
    });

    let liked = false;
    if (existing) {
      await this.prisma.carpetLike.delete({
        where: { id: existing.id },
      });
      await this.prisma.carpet.update({
        where: { id: carpetId },
        data: { likes: { decrement: 1 } },
      });
      liked = false;
    } else {
      await this.prisma.carpetLike.create({
        data: {
          userId: user.id,
          carpetId: carpetId,
        },
      });
      await this.prisma.carpet.update({
        where: { id: carpetId },
        data: { likes: { increment: 1 } },
      });
      liked = true;
    }

    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
      select: { likes: true },
    });

    return { liked, totalLikes: carpet?.likes || 0 };
  }

  /**
   * 4-Product Album Carousel (`renderProductAlbum`):
   * Sends up to 4 images as an album, followed immediately by a navigation control message.
   */
  public async renderProductAlbum(
    chatId: string,
    session: SellerSearchSession,
    page: number,
  ) {
    this.purgeExpiredSessions();

    const totalPages = Math.max(1, Math.ceil(session.items.length / this.PAGE_SIZE));
    const safePage = Math.min(Math.max(1, page), totalPages);
    session.currentPage = safePage;
    session.totalPages = totalPages;

    const startIndex = (safePage - 1) * this.PAGE_SIZE;
    const pageItems = session.items.slice(startIndex, startIndex + this.PAGE_SIZE);

    if (pageItems.length === 0) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ Ushbu sahifada mahsulot topilmadi.`,
      );
      return;
    }

    // 1. Build Media Group (up to 4 items)
    const mediaGroup: Array<{
      type: 'photo';
      media: any;
      caption?: string;
      parse_mode?: 'HTML';
    }> = [];

    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      const photoInput = this.resolveCarpetPhoto(item.image);
      const emojiNum = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'][i];

      mediaGroup.push({
        type: 'photo',
        media: photoInput || this.getFallbackPhoto(),
        caption: `${emojiNum} <b>${escapeHtml(item.designCode)}</b> — ${escapeHtml(item.sizeDisplay)} (${escapeHtml(item.priceDisplay)})`,
        parse_mode: 'HTML',
      });
    }

    // Send album
    await this.telegramService.sendMediaGroupSafe(chatId, mediaGroup);

    // 2. Build Navigation Control Message underneath the album
    let controlText = '';
    if (session.bannerText) {
      controlText += `${session.bannerText}\n\n`;
    }
    controlText += `📦 <b>Natijalar: Sahifa ${safePage}/${totalPages}</b> (Jami: ${session.items.length} ta)\n\n`;

    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    for (let i = 0; i < pageItems.length; i++) {
      const item = pageItems[i];
      controlText += `${numberEmojis[i]} <b>${escapeHtml(item.designCode)}</b> | ${escapeHtml(item.sizeDisplay)} | <b>${escapeHtml(item.priceDisplay)}</b>\n`;
    }
    controlText += `\n👇 <i>Batafsil ma'lumot olish uchun quyidagi tugmalardan birini bosing:</i>`;

    const inlineKeyboard = this.buildCarouselInlineKeyboard(
      session.sessionId,
      safePage,
      totalPages,
      pageItems.length,
    );

    await this.telegramService.sendMessageSafe(
      chatId,
      controlText,
      inlineKeyboard,
    );
  }

  /**
   * Product Detail Card:
   * STRICT: Includes Photo, Price, Design/Code, Size, Material, YarnType, Color, Barcode, Stock.
   * STRICT EXCLUSION: DOES NOT include Density (zichlik), Taroq count, or Manufacturer.
   */
  public async renderProductDetailCard(
    chatId: string,
    carpetId: string,
    sessionId?: string,
    page?: number,
    specificBarcode?: string,
  ) {
    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
      include: {
        inventoryItems: {
          where: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
        },
        rollInventories: true,
      },
    });

    if (!carpet) {
      await this.telegramService.sendMessageSafe(
        chatId,
        `❌ Gilam ma'lumotlari topilmadi.`,
      );
      return;
    }

    // Determine matching inventory item
    let matchedItem = carpet.inventoryItems?.[0];
    if (specificBarcode) {
      matchedItem =
        carpet.inventoryItems?.find((i) => i.barcode === specificBarcode) ||
        matchedItem;
    }

    const priceNum = matchedItem?.piecePrice
      ? Number(matchedItem.piecePrice)
      : Number(carpet.price || 0);
    const formattedPrice = this.pricingService.formatUzbekCurrency(priceNum);
    const barcodeStr = matchedItem?.barcode || carpet.uniqueCode || "Mavjud emas";
    const sizeDisplay = matchedItem?.size || "Standart o'lcham";
    const materialDisplay = carpet.material || "Standart";
    const yarnTypeDisplay = this.extractYarnType(carpet.material);
    const colorDisplay = carpet.dominantColor || "Ko'p rangli";
    const stockCount = carpet.inventoryItems?.length || 0;
    const stockDisplay =
      stockCount > 0 ? `✅ ${stockCount} dona mavjud` : `❌ Zaxirada tugagan`;

    // Check favorite status
    const isLiked = await this.isCarpetLiked(chatId, carpetId);

    const caption =
      `🏷 <b>Gilam ma'lumotlari</b>\n\n` +
      `🔹 <b>Dizayn/Kod:</b> ${escapeHtml(carpet.designCode || carpet.patternCode || carpet.name)}\n` +
      `🔹 <b>O'lcham:</b> ${escapeHtml(sizeDisplay)}\n` +
      `🔹 <b>Narxi:</b> ${escapeHtml(formattedPrice)}\n` +
      `🔹 <b>Material:</b> ${escapeHtml(materialDisplay)}\n` +
      `🔹 <b>Ip turi:</b> ${escapeHtml(yarnTypeDisplay)}\n` +
      `🔹 <b>Rang:</b> ${escapeHtml(colorDisplay)}\n` +
      `🔹 <b>Shtrix-kod:</b> <code>${escapeHtml(barcodeStr)}</code>\n` +
      `🔹 <b>Mavjudligi:</b> ${escapeHtml(stockDisplay)}`;

    const inlineKeyboard = {
      inline_keyboard: [
        [
          {
            text: isLiked ? '💔 O‘chirish' : '❤️ Saqlash',
            callback_data: `seller_fav_${carpetId}`,
          },
        ],
        ...(sessionId
          ? [
              [
                {
                  text: '⬅️ Ro‘yxatga qaytish',
                  callback_data: `seller_back_${sessionId}_${page || 1}`,
                },
              ],
            ]
          : []),
        [{ text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' }],
      ],
    };

    const photoInput = this.resolveCarpetPhoto(carpet.images?.[0]);
    if (photoInput) {
      await this.telegramService.sendPhoto(
        chatId,
        photoInput,
        caption,
        inlineKeyboard,
      );
    } else {
      await this.telegramService.sendMessageSafe(
        chatId,
        caption,
        inlineKeyboard,
      );
    }
  }

  /**
   * Sync Flow (`🔄 Yangilash`):
   * Outputs sync report and automatically shows the main menu after exactly 5 seconds.
   */
  public async handleSyncFlow(chatId: string) {
    this.clearSellerState(chatId);

    await this.telegramService.sendMessageSafe(
      chatId,
      `⏳ <b>Basko sinxronizatsiya holati tekshirilmoqda...</b>`,
    );

    const reportHtml =
      await this.baskoSyncLogService.formatTelegramSyncReport();

    const fullMessage =
      `${reportHtml}\n\n` +
      `⏳ <i>5 soniyadan keyin asosiy menyu avtomatik ravishda ochiladi...</i>`;

    await this.telegramService.sendMessageSafe(chatId, fullMessage, {
      inline_keyboard: [
        [{ text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' }],
      ],
    });

    // Schedule 5-second automatic redirect to Seller Main Menu
    setTimeout(async () => {
      try {
        await this.showSellerMainMenu(
          chatId,
          `🏪 <b>Asosiy menyu tiklandi.</b> Kerakli bo‘limni tanlang:`,
        );
      } catch (err: any) {
        this.logger.error(
          `Auto-menu redirect error for ${maskChatId(chatId)}: ${err.message}`,
        );
      }
    }, 5000);
  }

  /**
   * Handles all callback queries starting with `seller_`.
   */
  public async handleCallbackQuery(ctx: Context): Promise<boolean> {
    const callbackData = (ctx.callbackQuery as any)?.data || '';
    if (!callbackData.startsWith('seller_')) return false;

    const chatId = ctx.chat?.id.toString();
    if (!chatId) return false;

    try {
      await ctx.answerCbQuery();
    } catch (e) {
      // Ignore cb answer expiration
    }

    if (callbackData === 'seller_noop') {
      return true;
    }

    if (callbackData === 'seller_main_menu') {
      await this.showSellerMainMenu(chatId);
      return true;
    }

    if (callbackData === 'seller_fav_list') {
      await this.handleFavoritesList(chatId);
      return true;
    }

    if (callbackData === 'seller_ask_barcode') {
      this.setSellerState(chatId, 'AWAITING_BARCODE');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🔎 Shtrix-kod raqamini kiriting:`,
      );
      return true;
    }

    if (callbackData === 'seller_ask_metraj') {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_METRAJ');
      await this.telegramService.sendMessageSafe(
        chatId,
        `📏 Metraj gilam o‘lchamini kiriting (masalan: 4x6.11):`,
      );
      return true;
    }

    if (callbackData === 'seller_ask_ready') {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_READY');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🏠 Tayyor gilam o‘lchamini kiriting (masalan: 2x3, 200x300):`,
      );
      return true;
    }

    if (callbackData === 'seller_ask_oval') {
      this.setSellerState(chatId, 'AWAITING_DIMENSION_OVAL');
      await this.telegramService.sendMessageSafe(
        chatId,
        `🟠 Oval gilam o‘lchamini kiriting (masaran: 2x3):`,
      );
      return true;
    }

    // Item Detail Card: seller_item_{sessionId}_{itemIndex}
    if (callbackData.startsWith('seller_item_')) {
      const payload = callbackData.replace('seller_item_', '');
      const lastSep = payload.lastIndexOf('_');
      const sessionId = payload.substring(0, lastSep);
      const itemIndex = parseInt(payload.substring(lastSep + 1), 10);

      const session = this.searchSessions.get(sessionId);
      if (!session) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `⚠️ Qidiruv sessiyasi muddati tugagan. Iltimos, qaytadan qidiring.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      if (session.chatId !== chatId) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `🔒 Ushbu qidiruv natijasi sizga tegishli emas. Iltimos, o'zingiz yangi qidiruv amalga oshiring.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      const startIndex = (session.currentPage - 1) * this.PAGE_SIZE;
      const targetItem = session.items[startIndex + itemIndex];
      if (!targetItem) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `❌ Tanlangan mahsulot topilmadi.`,
        );
        return true;
      }

      await this.renderProductDetailCard(
        chatId,
        targetItem.carpetId,
        sessionId,
        session.currentPage,
        targetItem.barcode,
      );
      return true;
    }

    // Pagination: seller_page_{sessionId}_{targetPage}
    if (callbackData.startsWith('seller_page_')) {
      const payload = callbackData.replace('seller_page_', '');
      const lastSep = payload.lastIndexOf('_');
      const sessionId = payload.substring(0, lastSep);
      const targetPage = parseInt(payload.substring(lastSep + 1), 10);

      const session = this.searchSessions.get(sessionId);
      if (!session) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `⚠️ Qidiruv sessiyasi muddati tugagan. Iltimos, qaytadan qidiring.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      if (session.chatId !== chatId) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `🔒 Ushbu qidiruv natijasi sizga tegishli emas. Iltimos, o'zingiz yangi qidiruv amalga oshiring.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      await this.renderProductAlbum(chatId, session, targetPage);
      return true;
    }

    // Return back to album: seller_back_{sessionId}_{page}
    if (callbackData.startsWith('seller_back_')) {
      const payload = callbackData.replace('seller_back_', '');
      const lastSep = payload.lastIndexOf('_');
      const sessionId = payload.substring(0, lastSep);
      const targetPage = parseInt(payload.substring(lastSep + 1), 10) || 1;

      const session = this.searchSessions.get(sessionId);
      if (!session) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `⚠️ Qidiruv sessiyasi muddati tugagan. Bosh menyuga qaytishingiz mumkin.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      if (session.chatId !== chatId) {
        await this.telegramService.sendMessageSafe(
          chatId,
          `🔒 Ushbu qidiruv natijasi sizga tegishli emas. Iltimos, o'zingiz yangi qidiruv amalga oshiring.`,
          this.buildSellerKeyboard().reply_markup,
        );
        return true;
      }

      await this.renderProductAlbum(chatId, session, targetPage);
      return true;
    }

    // Toggle favorite: seller_fav_{carpetId}
    if (callbackData.startsWith('seller_fav_')) {
      const carpetId = callbackData.replace('seller_fav_', '');
      const { liked } = await this.handleFavoriteToggle(chatId, carpetId);

      const alertMsg = liked
        ? "❤️ Mahsulot saralanganlarga saqlandi!"
        : "💔 Mahsulot saralanganlardan o'chirildi!";

      try {
        await ctx.answerCbQuery(alertMsg, { show_alert: true });
      } catch (e) {
        await this.telegramService.sendMessageSafe(chatId, alertMsg);
      }
      return true;
    }

    return false;
  }

  // --- Helper Methods ---

  private buildCarouselInlineKeyboard(
    sessionId: string,
    currentPage: number,
    totalPages: number,
    itemCount: number,
  ) {
    const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣'];
    const numberRow: Array<{ text: string; callback_data: string }> = [];
    for (let i = 0; i < itemCount; i++) {
      numberRow.push({
        text: numberEmojis[i],
        callback_data: `seller_item_${sessionId}_${i}`,
      });
    }

    const navRow: Array<{ text: string; callback_data: string }> = [];
    if (currentPage > 1) {
      navRow.push({
        text: '◀️ Oldingi',
        callback_data: `seller_page_${sessionId}_${currentPage - 1}`,
      });
    }

    navRow.push({
      text: `${currentPage}/${totalPages}`,
      callback_data: 'seller_noop',
    });

    if (currentPage < totalPages) {
      navRow.push({
        text: 'Keyingi ▶️',
        callback_data: `seller_page_${sessionId}_${currentPage + 1}`,
      });
    }

    const actionRow = [
      { text: '❤️ Saralanganlar', callback_data: 'seller_fav_list' },
      { text: '🏠 Bosh menyu', callback_data: 'seller_main_menu' },
    ];

    return {
      inline_keyboard: [numberRow, navRow, actionRow],
    };
  }

  private createSearchSession(
    chatId: string,
    type: 'READY' | 'METRAJ' | 'OVAL' | 'FAVORITES' | 'BARCODE',
    queryText: string,
    items: SellerProductCardItem[],
    bannerText?: string,
  ): SellerSearchSession {
    const sessionId = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const totalPages = Math.max(1, Math.ceil(items.length / this.PAGE_SIZE));

    const session: SellerSearchSession = {
      sessionId,
      chatId,
      type,
      queryText,
      bannerText,
      items,
      currentPage: 1,
      totalPages,
      createdAt: Date.now(),
    };

    this.searchSessions.set(sessionId, session);
    return session;
  }

  private purgeExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.searchSessions.entries()) {
      if (now - session.createdAt > this.SESSION_TTL_MS) {
        this.searchSessions.delete(id);
      }
    }
  }

  private async isCarpetLiked(
    chatId: string,
    carpetId: string,
  ): Promise<boolean> {
    const user = await this.prisma.user.findFirst({
      where: { telegramChatId: chatId },
    });
    if (!user) return false;

    const count = await this.prisma.carpetLike.count({
      where: { userId: user.id, carpetId: carpetId },
    });
    return count > 0;
  }

  private extractYarnType(material?: string): string {
    if (!material) return 'Standart (Heatset)';
    const mat = material.toLowerCase();
    if (mat.includes('frize') || mat.includes('friz')) return 'Frize';
    if (mat.includes('bcf')) return 'BCF';
    if (mat.includes('heatset') || mat.includes('xit-set')) return 'Heatset';
    if (mat.includes('akril') || mat.includes('acrylic')) return 'Akril';
    if (mat.includes('viskoz') || mat.includes('viscose')) return 'Viskoza';
    if (mat.includes('polyester')) return 'Polyester';
    if (mat.includes('yun') || mat.includes('jun') || mat.includes('wool'))
      return 'Jun (Wool)';
    return 'Heatset';
  }

  private resolveCarpetPhoto(
    image?: string,
  ): string | { source: string } | null {
    if (!image) return null;
    const trimmed = image.trim();
    if (!trimmed) return null;

    if (/^https?:\/\//i.test(trimmed)) {
      return trimmed;
    }

    const normalized = trimmed.replace(/\\/g, '/').replace(/^\/+/, '');

    // Check local public
    const backendLocal = join(process.cwd(), 'public', normalized);
    if (existsSync(backendLocal)) {
      return { source: backendLocal };
    }

    // Check uploads
    const uploadsLocal = join(process.cwd(), 'uploads', normalized);
    if (existsSync(uploadsLocal)) {
      return { source: uploadsLocal };
    }

    // Check front public
    const frontLocal = join(
      process.cwd(),
      '..',
      'front',
      'public',
      normalized,
    );
    if (existsSync(frontLocal)) {
      return { source: frontLocal };
    }

    const publicUrl = process.env.PUBLIC_URL || 'https://yecmarket.uz';
    return `${publicUrl.replace(/\/+$/, '')}/${normalized}`;
  }

  private getFallbackPhoto(): string {
    return 'https://yecmarket.uz/placeholder-carpet.jpg';
  }
}
