import { Test, TestingModule } from '@nestjs/testing';
import { TelegramSellerService } from './telegram-seller.service';
import { PrismaService } from '../prisma/prisma.service';
import { TelegramService } from './telegram.service';
import { BaskoSyncLogService } from '../basko/basko-sync-log.service';
import { BaskoIntegrationService } from '../basko/basko-integration.service';
import { DimensionParserService } from '../carpets/dimension-parser.service';
import { CarpetDistanceRankingService } from '../carpets/carpet-distance-ranking.service';
import { PricingService } from '../carpets/pricing.service';
import { TelegramUpdate } from './telegram.update';
import { SearchService } from '../carpets/search.service';
import { SimilarityService } from '../ai/services/similarity.service';
import { UserRole, CarpetInventoryStatus } from '@prisma/client';

describe('TelegramSeller Concurrency, Security & Edge Cases', () => {
  let sellerService: TelegramSellerService;
  let telegramUpdate: TelegramUpdate;
  let telegramService: TelegramService;
  let prismaMock: any;
  let telegramServiceMock: any;
  let distanceRankingMock: any;

  beforeEach(async () => {
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
        findUnique: jest.fn(),
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

    distanceRankingMock = {
      executeFallbackSearch: jest.fn(),
      findClosestReadyCarpets: jest.fn().mockResolvedValue([]),
      findClosestOvalCarpets: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TelegramSellerService,
        TelegramUpdate,
        { provide: PrismaService, useValue: prismaMock },
        { provide: TelegramService, useValue: telegramServiceMock },
        { provide: BaskoSyncLogService, useValue: { formatTelegramSyncReport: jest.fn().mockResolvedValue('Report') } },
        { provide: BaskoIntegrationService, useValue: {} },
        { provide: DimensionParserService, useValue: new DimensionParserService() },
        { provide: CarpetDistanceRankingService, useValue: distanceRankingMock },
        { provide: PricingService, useValue: new PricingService() },
        { provide: SearchService, useValue: {} },
        { provide: SimilarityService, useValue: {} },
      ],
    }).compile();

    sellerService = module.get<TelegramSellerService>(TelegramSellerService);
    telegramUpdate = module.get<TelegramUpdate>(TelegramUpdate);
  });

  describe('1. Multi-Seller Concurrency & Session Isolation', () => {
    it('should completely isolate search sessions between different sellers', async () => {
      const seller1ChatId = 'seller_1001';
      const seller2ChatId = 'seller_1002';

      // Seller 1 creates a search session for 2x3
      const session1 = (sellerService as any).createSearchSession(
        seller1ChatId,
        'READY',
        '2x3',
        [
          {
            carpetId: 'c1',
            designCode: 'DES-1',
            name: 'Gilam 1',
            sizeDisplay: '200 × 300 cm',
            priceDisplay: '1 000 000 so‘m',
            priceNumeric: 1000000,
            stockText: '1 dona',
            isAvailable: true,
          },
        ],
      );

      // Seller 2 attempts to open Seller 1's item card using session1.sessionId
      const maliciousCallbackCtx: any = {
        chat: { id: seller2ChatId },
        callbackQuery: { data: `seller_item_${session1.sessionId}_0` },
        answerCbQuery: jest.fn().mockResolvedValue(true),
      };

      const handled = await sellerService.handleCallbackQuery(maliciousCallbackCtx);
      expect(handled).toBe(true);

      // Verify that access was rejected with security message
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        seller2ChatId,
        expect.stringContaining('Ushbu qidiruv natijasi sizga tegishli emas'),
        expect.any(Object),
      );

      // Detail card was NOT rendered for Seller 2
      expect(telegramServiceMock.sendPhoto).not.toHaveBeenCalled();
    });

    it('should support 20 parallel sellers without race conditions or cross-contamination', async () => {
      const parallelSellers = 20;
      const promises: Promise<any>[] = [];

      for (let i = 1; i <= parallelSellers; i++) {
        const chatId = `seller_${i}`;
        sellerService.setSellerState(chatId, 'AWAITING_DIMENSION_READY');

        // Simulate concurrent dimension input
        promises.push(
          sellerService.handleSellerTextInput(chatId, `${i}x${i + 1}`),
        );
      }

      await Promise.all(promises);

      // Verify all 20 sellers had their states safely processed and reset to IDLE
      for (let i = 1; i <= parallelSellers; i++) {
        const chatId = `seller_${i}`;
        expect(sellerService.getSellerState(chatId)).toBe('IDLE');
      }
    });
  });

  describe('2. Favorites User Isolation', () => {
    it('should strictly isolate favorites so Seller A cannot see Seller B\'s favorites', async () => {
      const sellerAChat = 'seller_A_chat';
      const sellerBChat = 'seller_B_chat';

      // Seller A user
      prismaMock.user.findFirst.mockImplementation(async (params: any) => {
        if (params.where.telegramChatId === sellerAChat) {
          return { id: 'user_A', telegramChatId: sellerAChat, name: 'Sotuvchi A' };
        }
        if (params.where.telegramChatId === sellerBChat) {
          return { id: 'user_B', telegramChatId: sellerBChat, name: 'Sotuvchi B' };
        }
        return null;
      });

      // Seller A has 1 favorite, Seller B has 0 favorites
      prismaMock.carpetLike.findMany.mockImplementation(async (params: any) => {
        if (params.where.userId === 'user_A') {
          return [
            {
              id: 'like_1',
              carpetId: 'carpet_A_fav',
              carpet: {
                id: 'carpet_A_fav',
                name: 'Seller A Private Carpet',
                price: 1000000,
                images: ['https://yecmarket.uz/a.jpg'],
                inventoryItems: [],
              },
            },
          ];
        }
        return []; // Seller B has none
      });

      // Seller B requests favorites list
      await sellerService.handleFavoritesList(sellerBChat);

      // Seller B gets "empty favorites" message
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        sellerBChat,
        expect.stringContaining('Saralanganlar ro‘yxati bo‘sh'),
        expect.any(Object),
      );

      // Seller A's private carpet was NEVER sent to Seller B
      expect(telegramServiceMock.sendMediaGroupSafe).not.toHaveBeenCalled();
    });
  });

  describe('3. Role Authorization on Seller Callbacks', () => {
    it('should block non-seller customer from executing seller_ callbacks', async () => {
      const customerCtx: any = {
        chat: { id: 'customer_999' },
        from: { id: 999, username: 'some_customer' },
        callbackQuery: { data: 'seller_main_menu' },
        answerCbQuery: jest.fn().mockResolvedValue(true),
      };

      // Mock user role as CUSTOMER
      prismaMock.user.findUnique.mockResolvedValue({
        id: 'cust_1',
        telegramChatId: 'customer_999',
        role: UserRole.CUSTOMER,
      });

      await telegramUpdate.onCallbackQuery(customerCtx);

      // Verify that authorization blocked the call
      expect(customerCtx.answerCbQuery).toHaveBeenCalledWith(
        expect.stringContaining('faqat do\'kon sotuvchilari uchun ruxsat etilgan'),
        expect.objectContaining({ show_alert: true }),
      );

      // Main menu was not sent
      expect(telegramServiceMock.sendMessageSafe).not.toHaveBeenCalledWith(
        'customer_999',
        expect.stringContaining('YEC Sotuvchi Paneli'),
        expect.any(Object),
      );
    });
  });

  describe('4. Database Failure & Exception Boundary', () => {
    it('should catch database connection timeouts and reply politely without crashing the app', async () => {
      const chatId = 'seller_db_fail_chat';
      sellerService.setSellerState(chatId, 'AWAITING_BARCODE');

      // Simulate database connection failure
      prismaMock.inventoryItem.findFirst.mockRejectedValue(
        new Error('Database connection timeout (Neon pool exhausted)'),
      );

      const handled = await sellerService.handleSellerTextInput(chatId, '00123456');

      expect(handled).toBe(true);
      expect(telegramServiceMock.sendMessageSafe).toHaveBeenCalledWith(
        chatId,
        expect.stringContaining('Server bilan vaqtinchalik aloqa xatoligi yuz berdi'),
        expect.any(Object),
      );
    });
  });
});
