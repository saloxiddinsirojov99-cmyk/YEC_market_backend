import { Test, TestingModule } from '@nestjs/testing';
import { SimilarityService } from './similarity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CacheService } from '../../cache/cache.service';

describe('SimilarityService', () => {
  let service: SimilarityService;

  const mockPrismaService = {};
  const mockCacheService = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimilarityService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: CacheService, useValue: mockCacheService },
      ],
    }).compile();

    service = module.get<SimilarityService>(SimilarityService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('computeHashSimilarity', () => {
    it('should return 1 for identical hashes', () => {
      const sim = service.computeHashSimilarity('ffff', 'ffff');
      expect(sim).toBe(1);
    });

    it('should return 0.5 for half-matching hashes', () => {
      const sim = service.computeHashSimilarity('f0f0', 'ffff');
      expect(sim).toBe(0.5);
    });
  });

  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const sim = service.cosineSimilarity([1, 0, 1], [1, 0, 1]);
      expect(sim).toBeCloseTo(1);
    });

    it('should return 0 for orthogonal vectors', () => {
      const sim = service.cosineSimilarity([1, 0], [0, 1]);
      expect(sim).toBe(0);
    });
  });

  describe('compareFootprints', () => {
    it('should calculate weighted score capped at 99', () => {
      const fpA = { hash: 'ffff', histogram: [1, 0], edges: [1, 0] };
      const fpB = {
        hash: 'ffff',
        histogram: [1, 0],
        edges: [1, 0],
        clipEmbedding: null,
      };
      const score = service.compareFootprints(fpA, fpB);
      expect(score).toBeLessThanOrEqual(99);
    });
  });
});
