import { Test, TestingModule } from '@nestjs/testing';
import { CarpetsService } from './carpets.service';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../common/cache.service';
import { CarpetsRepository } from './carpets.repository';
import { CatalogDesignService } from './catalog-design.service';

describe('Carpets Filter Regression Tests', () => {
  let carpetsService: CarpetsService;

  const mockPrisma = {
    carpet: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn().mockImplementation((promises) => Promise.all(promises)),
  };

  const mockCache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockRepo = {};
  const mockCatalog = {};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CarpetsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: CacheService, useValue: mockCache },
        { provide: CarpetsRepository, useValue: mockRepo },
        { provide: CatalogDesignService, useValue: mockCatalog },
      ],
    }).compile();

    carpetsService = module.get<CarpetsService>(CarpetsService);
    jest.clearAllMocks();
  });

  it('should filter by kind="returned" using type RETURN_ROLL and RETURN_READY (not non-existent isReturned field)', async () => {
    await carpetsService.findAll({ kind: 'returned', page: 1, limit: 10 });

    expect(mockPrisma.carpet.findMany).toHaveBeenCalled();
    const callArgs = mockPrisma.carpet.findMany.mock.calls[0][0];
    const whereAnd = callArgs.where.AND;

    // Must NOT contain { isReturned: true }
    const hasInvalidField = whereAnd.some((cond: any) => 'isReturned' in cond);
    expect(hasInvalidField).toBe(false);

    // Must contain type: { in: ['RETURN_ROLL', 'RETURN_READY'] }
    const typeCond = whereAnd.find(
      (cond: any) => cond.type && cond.type.in && cond.type.in.includes('RETURN_ROLL'),
    );
    expect(typeCond).toBeDefined();
    expect(typeCond.type.in).toEqual(['RETURN_ROLL', 'RETURN_READY']);
  });

  it('should filter by kind="normal" using type READY and ROLL', async () => {
    await carpetsService.findAll({ kind: 'normal', page: 1, limit: 10 });

    const callArgs = mockPrisma.carpet.findMany.mock.calls[0][0];
    const whereAnd = callArgs.where.AND;

    // Must NOT contain { isReturned: false }
    const hasInvalidField = whereAnd.some((cond: any) => 'isReturned' in cond);
    expect(hasInvalidField).toBe(false);

    // Must contain type: { in: ['READY', 'ROLL'] }
    const typeCond = whereAnd.find(
      (cond: any) => cond.type && cond.type.in && cond.type.in.includes('READY'),
    );
    expect(typeCond).toBeDefined();
    expect(typeCond.type.in).toEqual(['READY', 'ROLL']);
  });

  it('should filter by kind="normal_ready" using type READY', async () => {
    await carpetsService.findAll({ kind: 'normal_ready', page: 1, limit: 10 });

    const callArgs = mockPrisma.carpet.findMany.mock.calls[0][0];
    const whereAnd = callArgs.where.AND;

    const typeCond = whereAnd.find((cond: any) => cond.type === 'READY');
    expect(typeCond).toBeDefined();
  });

  it('should filter by kind="normal_roll" using type ROLL', async () => {
    await carpetsService.findAll({ kind: 'normal_roll', page: 1, limit: 10 });

    const callArgs = mockPrisma.carpet.findMany.mock.calls[0][0];
    const whereAnd = callArgs.where.AND;

    const typeCond = whereAnd.find((cond: any) => cond.type === 'ROLL');
    expect(typeCond).toBeDefined();
  });
});
