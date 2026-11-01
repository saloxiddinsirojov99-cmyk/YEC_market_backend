import { Test, TestingModule } from '@nestjs/testing';
import { TelegramSellerService } from './telegram-seller.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import { BaskoSyncLogService } from '../basko/basko-sync-log.service';
import { BaskoIntegrationService } from '../basko/basko-integration.service';
import { DimensionParserService } from '../carpets/dimension-parser.service';
import { CarpetDistanceRankingService } from '../carpets/carpet-distance-ranking.service';
import { PricingService } from '../carpets/pricing.service';
import { SELLER_BUTTONS } from './telegram.constants';
import { CarpetInventoryStatus } from '@prisma/client';

describe('TelegramSellerService — Checkpoint 5 Seller Bot Flow', () => {
  let service: TelegramSellerService;
  let prismaMock: any;
  let telegramServiceMock: any;
  let baskoSyncLogMock: any;
  let dimensionParser: DimensionParserService;
  let distanceRankingMock: any;
  let pricingService: PricingService;

  beforeEach(async () => {
    jest.useFakeTimers();

    prismaMock = {
      inventoryItem: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      },
      carpet: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      user: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      carpetLike: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        count: jest.fn(),
      },
      importLog: {
        findFirst: jest.fn(),
      },
    };

    telegramServiceMock = {
      sendMessageSafe: jest.fn().mockResolvedValue(true),
      sendPhoto: jest.fn().mockResolvedValue(true),
      sendMediaGroupSafe: jest.fn().mockResolvedValue([]),
    };

    baskoSyncLogMock = {
      formatTelegramSyncReport: jest
        .fn()
        .mockResolvedValue('📊 <b>BASKO Sinxronizatsiya Hisoboti:</b>\nJami: 100 ta'),
    };

    distanceRankingMock = {
      executeFallbackSearch: jest.fn(),
      findClosestReadyCarpets: jest.fn(),
      findClosestOvalCarpets: jest.fn(),
    };

    dimensionParser = new DimensionParserService();
    pricingService = new PricingService();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramSellerService,
        { provide: PrismaService, useValue: prismaMock },
        { provide: TelegramService, useValue: telegramServiceMock },
        { provide: BaskoSyncLogService, useValue: baskoSyncLogMock },
        { provide: BaskoIntegrationService, useValue: {} },
        { provide: DimensionParserService, useValue: dimensionParser },
        { provide: CarpetDistanceRankingService, useValue: distanceRankingMock },
        { provide: PricingService, useValue: pricingService },
      ],
    }).compile();

    service = module.get<TelegramSellerService>(TelegramSellerService);
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('1. Seller Keyboard & Menu', () => {
    it('should build tablet-optimized 6-button keyboard with exact labels', () => {
      const keyboardObj = service.buildSellerKeyboard();
      const keyboard = keyboardObj.reply_markup.keyboard;

      expect(keyboard).toBeDefined();
      expect(keyboard.length).toBe(4);

      // Row 1: Refresh
      expect(keyboard[0][0].text).toBe(SELLER_BUTTONS.REFRESH);
      // Row 2: Ready & Metraj
      expect(keyboard[1][0].text).toBe(SELLER_BUTTONS.READY_CARPETS);
      expect(keyboard[1][1].text).toBe(SELLER_BUTTONS.METRAJ_CARPETS);
      // Row 3: Oval & Barcode
      expect(keyboard[2][0].text).toBe(SELLER_BUTTONS.OVAL_CARPETS);
      expect(keyboard[2][1].text).toBe(SELLER_BUTTONS.SEARCH_BARCODE);
      // Row 4: Favorites
      expect(keyboard[3][0].text).toBe(SELLER_BUTTONS.FAVORITES);
    });

    it('should show seller main menu and reset state', async () => {
      const chatId = '998901234567';
      service.setSellerState(chatId, 'AWAITING_BARCODE');

      await service.showSellerMainMenu(chatId);

      expect(service.getSellerState(chatId)).toBe('IDLE');
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('YEC Sotuvchi Paneli'),
        expect.any(Object),
      );
    });
  });

  describe('2. State Transitions & Menu Button Navigation', () => {
    const chatId = '111222333';

    it('should transition to AWAITING_DIMENSION_READY on Ready button', async () => {
      const handled = await service.handleSellerTextInput(
        chatId,
        SELLER_BUTTONS.READY_CARPETS,
      );
      expect(handled).toBe(true);
      expect(service.getSellerState(chatId)).toBe('AWAITING_DIMENSION_READY');
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Tayyor gilamlar bo‘yicha qidiruv'),
      );
    });

    it('should transition to AWAITING_DIMENSION_METRAJ on Metraj button', async () => {
      const handled = await service.handleSellerTextInput(
        chatId,
        SELLER_BUTTONS.METRAJ_CARPETS,
      );
      expect(handled).toBe(true);
      expect(service.getSellerState(chatId)).toBe('AWAITING_DIMENSION_METRAJ');
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Metraj gilamlar bo‘yicha qidiruv'),
      );
    });

    it('should transition to AWAITING_DIMENSION_OVAL on Oval button', async () => {
      const handled = await service.handleSellerTextInput(
        chatId,
        SELLER_BUTTONS.OVAL_CARPETS,
      );
      expect(handled).toBe(true);
      expect(service.getSellerState(chatId)).toBe('AWAITING_DIMENSION_OVAL');
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Oval gilamlar bo‘yicha qidiruv'),
      );
    });

    it('should transition to AWAITING_BARCODE on Barcode button', async () => {
      const handled = await service.handleSellerTextInput(
        chatId,
        SELLER_BUTTONS.SEARCH_BARCODE,
      );
      expect(handled).toBe(true);
      expect(service.getSellerState(chatId)).toBe('AWAITING_BARCODE');
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Shtrix-kod (barcode) bo‘yicha qidiruv'),
      );
    });
  });

  describe('3. Barcode Search with Leading Zeros Preservation', () => {
    const chatId = '555666777';

    it('should query Prisma with exact string preserving leading zeros (e.g. "00123456")', async () => {
      service.setSellerState(chatId, 'AWAITING_BARCODE');

      prismaMock.inventoryItem.findFirst.mockResolvedValue({
        id: 'inv_1',
        barcode: '00123456',
        size: '200x300',
        piecePrice: 1500000,
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
        carpet: {
          id: 'carpet_101',
          name: 'YEC Saroy Premium',
          designCode: 'DES-001',
          patternCode: 'L102',
          price: 1500000,
          material: 'Heatset Frize',
          dominantColor: 'Krem',
          images: ['images/carpet101.jpg'],
          inventoryItems: [
            {
              id: 'inv_1',
              barcode: '00123456',
              size: '200 × 300 cm',
              piecePrice: 1500000,
              inventoryStatus: CarpetInventoryStatus.ACTIVE,
            },
          ],
        },
      });

      prismaMock.carpet.findUnique.mockResolvedValue({
        id: 'carpet_101',
        name: 'YEC Saroy Premium',
        designCode: 'DES-001',
        patternCode: 'L102',
        price: 1500000,
        material: 'Heatset Frize',
        dominantColor: 'Krem',
        images: ['images/carpet101.jpg'],
        inventoryItems: [
          {
            id: 'inv_1',
            barcode: '00123456',
            size: '200 × 300 cm',
            piecePrice: 1500000,
            inventoryStatus: CarpetInventoryStatus.ACTIVE,
          },
        ],
      });

      const handled = await service.handleSellerTextInput(chatId, '00123456');
      expect(handled).toBe(true);

      // Verify Prisma received string '00123456'
      expect(prismaMock.inventoryItem.findFirst).toHaveBeenCalledWith({
        where: {
          barcode: '00123456',
          inventoryStatus: CarpetInventoryStatus.ACTIVE,
        },
        include: expect.any(Object),
      });

      // State is cleared back to IDLE
      expect(service.getSellerState(chatId)).toBe('IDLE');
    });

    it('should display friendly error when barcode is not found in database', async () => {
      service.setSellerState(chatId, 'AWAITING_BARCODE');
      prismaMock.inventoryItem.findFirst.mockResolvedValue(null);

      const handled = await service.handleSellerTextInput(chatId, '00999999');
      expect(handled).toBe(true);

      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('00999999'),
        expect.objectContaining({
          inline_keyboard: expect.any(Array),
        }),
      );
    });
  });

  describe('4. Product Detail Card & Strict Exclusions', () => {
    it('should include required fields and strictly EXCLUDE density, taroq, and manufacturer', async () => {
      const chatId = '777888999';
      prismaMock.carpet.findUnique.mockResolvedValue({
        id: 'carpet_abc',
        name: 'Afsona Gilam',
        designCode: 'AF-777',
        patternCode: 'P-99',
        price: 2444000,
        material: 'Frize Ip',
        dominantColor: 'Moviy',
        images: ['https://yecmarket.uz/afsona.jpg'],
        inventoryItems: [
          {
            id: 'inv_abc',
            barcode: '00543210',
            size: '400 × 611 cm',
            piecePrice: 2444000,
            inventoryStatus: CarpetInventoryStatus.ACTIVE,
          },
        ],
      });

      await service.renderProductDetailCard(
        chatId,
        'carpet_abc',
        undefined,
        1,
        '00543210',
      );

      expect(telegramServiceMock.sendPhoto).toHaveBeenCalled();
      const call = telegramServiceMock.sendPhoto.mock.calls[0];
      const caption: string = call[2];

      // REQUIRED FIELDS:
      expect(caption).toContain('Gilam ma\'lumotlari');
      expect(caption).toContain('AF-777'); // Design/Code
      expect(caption).toContain('400 × 611 cm'); // Size
      expect(caption).toContain('2 444 000 so‘m'); // Formatted Price
      expect(caption).toContain('Frize Ip'); // Material
      expect(caption).toContain('Frize'); // Yarn Type
      expect(caption).toContain('Moviy'); // Color
      expect(caption).toContain('00543210'); // Barcode with leading zero
      expect(caption).toContain('1 dona mavjud'); // Stock availability

      // STRICT EXCLUSIONS:
      expect(caption.toLowerCase()).not.toContain('zichlik');
      expect(caption.toLowerCase()).not.toContain('density');
      expect(caption.toLowerCase()).not.toContain('taroq');
      expect(caption.toLowerCase()).not.toContain('ishlab chiqaruvchi');
      expect(caption.toLowerCase()).not.toContain('manufacturer');
    });
  });

  describe('5. 4-Product Album Carousel & Navigation Message', () => {
    it('should render media group of up to 4 items and separate control message underneath', async () => {
      const chatId = '333444555';
      const items = [
        {
          carpetId: 'c1',
          designCode: 'D-01',
          name: 'Carpet 1',
          sizeDisplay: '200 × 300 cm',
          priceDisplay: '1 000 000 so‘m',
          priceNumeric: 1000000,
          image: 'https://yecmarket.uz/1.jpg',
          stockText: '2 dona mavjud',
          isAvailable: true,
        },
        {
          carpetId: 'c2',
          designCode: 'D-02',
          name: 'Carpet 2',
          sizeDisplay: '200 × 300 cm',
          priceDisplay: '1 200 000 so‘m',
          priceNumeric: 1200000,
          image: 'https://yecmarket.uz/2.jpg',
          stockText: '1 dona mavjud',
          isAvailable: true,
        },
      ];

      const session: any = {
        sessionId: 's_test_1',
        chatId,
        type: 'READY',
        items,
        currentPage: 1,
        totalPages: 1,
        createdAt: Date.now(),
      };

      await service.renderProductAlbum(chatId, session, 1);

      // Verify media group sent
      expect(telegramServiceMock.sendMediaGroupSafe).toHaveBeenCalledWith(
        chatId,
        expect.arrayContaining([
          expect.objectContaining({ type: 'photo' }),
        ]),
      );

      // Verify separate control message sent underneath
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Natijalar: Sahifa 1/1'),
        expect.objectContaining({
          inline_keyboard: expect.arrayContaining([
            // Row 1 has number buttons [1️⃣, 2️⃣]
            expect.arrayContaining([
              expect.objectContaining({ text: '1️⃣' }),
              expect.objectContaining({ text: '2️⃣' }),
            ]),
          ]),
        }),
      );
    });
  });

  describe('6. Metraj Search & Strict Fallback Sequence', () => {
    const chatId = '444555666';

    it('should return exact metraj rolls when available', async () => {
      service.setSellerState(chatId, 'AWAITING_DIMENSION_METRAJ');

      distanceRankingMock.executeFallbackSearch.mockResolvedValue({
        stage: 'METRAJ_EXACT',
        queryWidthCm: 400,
        queryLengthCm: 611,
        displayMeters: '4 × 6,11 m',
        results: [],
        metrajResults: [
          {
            carpetId: 'roll_c1',
            uniqueCode: 'MET-01',
            name: 'Metraj Roll 1',
            rollInventoryId: 'r1',
            rollWidthCm: 400,
            effectiveAvailableLengthMeters: 25.5,
            pricePerM2: 100000,
            images: ['https://yecmarket.uz/metraj1.jpg'],
          },
        ],
      });

      const handled = await service.handleSellerTextInput(chatId, '4x6.11');
      expect(handled).toBe(true);

      expect(distanceRankingMock.executeFallbackSearch).toHaveBeenCalledWith(
        400,
        611,
        '4 × 6,11 m',
      );
      expect(telegramServiceMock.sendMediaGroupSafe).toHaveBeenCalled();
    });

    it('should fallback to closest ready carpets if metraj is not found', async () => {
      service.setSellerState(chatId, 'AWAITING_DIMENSION_METRAJ');

      distanceRankingMock.executeFallbackSearch.mockResolvedValue({
        stage: 'READY_CLOSEST',
        queryWidthCm: 400,
        queryLengthCm: 611,
        displayMeters: '4 × 6,11 m',
        results: [
          {
            carpetId: 'ready_c1',
            uniqueCode: 'READY-01',
            name: 'Ready Carpet 4x6',
            patternCode: 'PAT-46',
            widthCm: 400,
            lengthCm: 600,
            distanceCm: 11,
            price: 2400000,
            stock: 2,
            images: ['https://yecmarket.uz/ready1.jpg'],
          },
        ],
      });

      const handled = await service.handleSellerTextInput(chatId, '4x6.11');
      expect(handled).toBe(true);

      expect(telegramServiceMock.sendMediaGroupSafe).toHaveBeenCalled();
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('So‘ralgan metraj bo‘yicha rulon topilmadi'),
        expect.any(Object),
      );
    });

    it('should stop with "Ushbu o‘lchamga mos gilam topilmadi" when no match found', async () => {
      service.setSellerState(chatId, 'AWAITING_DIMENSION_METRAJ');

      distanceRankingMock.executeFallbackSearch.mockResolvedValue({
        stage: 'NOT_FOUND',
        queryWidthCm: 400,
        queryLengthCm: 611,
        displayMeters: '4 × 6,11 m',
        results: [],
        message: 'Ushbu o‘lchamga mos gilam topilmadi.',
      });

      const handled = await service.handleSellerTextInput(chatId, '4x6.11');
      expect(handled).toBe(true);

      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Ushbu o‘lchamga mos gilam topilmadi'),
        expect.any(Object),
      );
    });
  });

  describe('7. Favorites Persistent Storage in PostgreSQL', () => {
    const chatId = '888999000';
    const carpetId = 'carpet_fav_test';

    it('should persist favorite in CarpetLike and toggle on/off', async () => {
      prismaMock.user.findFirst.mockResolvedValue({
        id: 'user_seller_1',
        telegramChatId: chatId,
      });

      // 1. Add to favorites (not liked yet)
      prismaMock.carpetLike.findUnique.mockResolvedValue(null);
      prismaMock.carpet.findUnique.mockResolvedValue({ id: carpetId, likes: 1 });

      const res1 = await service.handleFavoriteToggle(chatId, carpetId);
      expect(res1.liked).toBe(true);
      expect(prismaMock.carpetLike.create).toHaveBeenCalledWith({
        data: {
          userId: 'user_seller_1',
          carpetId: carpetId,
        },
      });
      expect(prismaMock.carpet.update).toHaveBeenCalledWith({
        where: { id: carpetId },
        data: { likes: { increment: 1 } },
      });

      // 2. Remove from favorites (already liked)
      prismaMock.carpetLike.findUnique.mockResolvedValue({
        id: 'like_id_1',
        userId: 'user_seller_1',
        carpetId: carpetId,
      });
      prismaMock.carpet.findUnique.mockResolvedValue({ id: carpetId, likes: 0 });

      const res2 = await service.handleFavoriteToggle(chatId, carpetId);
      expect(res2.liked).toBe(false);
      expect(prismaMock.carpetLike.delete).toHaveBeenCalledWith({
        where: { id: 'like_id_1' },
      });
      expect(prismaMock.carpet.update).toHaveBeenCalledWith({
        where: { id: carpetId },
        data: { likes: { decrement: 1 } },
      });
    });
  });

  describe('8. Sync Report & 5-Second Auto-Menu Redirect', () => {
    it('should output sync report and automatically invoke main menu after 5000ms', async () => {
      const chatId = '123456789';
      const showMainMenuSpy = jest.spyOn(service, 'showSellerMainMenu');

      await service.handleSyncFlow(chatId);

      // Report sent
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('5 soniyadan keyin asosiy menyu avtomatik ravishda ochiladi'),
        expect.anything(),
      );

      // Before 5 seconds, menu is not shown yet
      expect(showMainMenuSpy).not.toHaveBeenCalled();

      // Fast-forward 5000ms
      jest.advanceTimersByTime(5000);

      // Auto-menu was triggered!
      expect(showMainMenuSpy).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Asosiy menyu tiklandi'),
      );
    });
  });

  describe('9. Callback Query Routing', () => {
    it('should route seller_fav_ toggle callbacks', async () => {
      const ctxMock: any = {
        chat: { id: 12345 },
        callbackQuery: { data: 'seller_fav_carpet_999' },
        answerCbQuery: jest.fn().mockResolvedValue(true),
      };

      prismaMock.user.findFirst.mockResolvedValue({
        id: 'user_1',
        telegramChatId: '12345',
      });
      prismaMock.carpetLike.findUnique.mockResolvedValue(null);

      const handled = await service.handleCallbackQuery(ctxMock);
      expect(handled).toBe(true);
      expect(ctxMock.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('saralanganlarga saqlandi'),
        expect.objectContaining({ show_alert: true }),
      );
    });

    it('should route seller_main_menu callback', async () => {
      const ctxMock: any = {
        chat: { id: 12345 },
        callbackQuery: { data: 'seller_main_menu' },
        answerCbQuery: jest.fn().mockResolvedValue(true),
      };

      const showMainMenuSpy = jest.spyOn(service, 'showSellerMainMenu');
      const handled = await service.handleCallbackQuery(ctxMock);

      expect(handled).toBe(true);
      expect(showMainMenuSpy).toHaveBeenCalledWith('12345');
    });
  });
});
