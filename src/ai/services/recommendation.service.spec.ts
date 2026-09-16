import { Test, TestingModule } from '@nestjs/testing';
import { RecommendationService } from './recommendation.service';
import { PrismaService } from '../../prisma/prisma.service';

describe('RecommendationService', () => {
  let service: RecommendationService;
  let prisma: PrismaService;

  const mockPrismaService = {
    recommendationSettings: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'singleton',
        roomWeight: 0.35,
        clearanceWeight: 0.25,
        colorWeight: 0.15,
        styleWeight: 0.1,
        fifoWeight: 0.1,
        popularityWeight: 0.05,
      }),
      create: jest.fn().mockResolvedValue({}),
    },
    carpet: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    aiRecommendationLog: {
      create: jest.fn().mockResolvedValue({}),
    },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RecommendationService,
        { provide: PrismaService, useValue: mockPrismaService },
      ],
    }).compile();

    service = module.get<RecommendationService>(RecommendationService);
    prisma = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('recommendSizes', () => {
    it('should return size recommendations fitting geometry', () => {
      const result = service.recommendSizes(4.5, 5.5);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].score).toBeLessThanOrEqual(99);
    });
  });
});
