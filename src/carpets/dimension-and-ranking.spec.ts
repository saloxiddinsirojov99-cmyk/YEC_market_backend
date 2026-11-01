import { DimensionParserService } from './dimension-parser.service';
import { PricingService } from './pricing.service';
import { CarpetDistanceRankingService } from './carpet-distance-ranking.service';
import { ProductType, Shape, CarpetInventoryStatus } from '@prisma/client';

describe('CHECKPOINT 4: Dimension Parser, Distance Ranking & Exact Pricing Services', () => {
  let parser: DimensionParserService;
  let pricing: PricingService;
  let ranking: CarpetDistanceRankingService;
  let mockPrisma: any;

  beforeEach(() => {
    parser = new DimensionParserService();
    pricing = new PricingService();

    mockPrisma = {
      rollInventory: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      inventoryItem: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };

    ranking = new CarpetDistanceRankingService(mockPrisma);
  });

  describe('1. DimensionParserService (Normalization & Format Support)', () => {
    it('should normalize all standard flexible formats to 400 × 611 cm and "4 × 6,11 m"', () => {
      const equivalentFormats = [
        '4x6.11',
        '4 6,11',
        '400 611',
        '400x611',
        '611x4',        // reversed
        '4x611cm',      // explicit unit
        '4m 6.11m',     // explicit meter units
        '400cm 611cm',  // explicit cm units
        '4 × 6,11',     // multiplication symbol
        '4X6.11',       // capital X
      ];

      for (const fmt of equivalentFormats) {
        const res = parser.parse(fmt);
        expect(res.success).toBe(true);
        expect(res.widthCm).toBe(400);
        expect(res.lengthCm).toBe(611);
        expect(res.widthMeters).toBe(4);
        expect(res.lengthMeters).toBe(6.11);
        expect(res.areaSquareMeters).toBe(24.44);
        expect(res.displayMeters).toBe('4 × 6,11 m');
        expect(res.displayCm).toBe('400 × 611 cm');
      }
    });

    it('should normalize 2x3 and 200x300 to 200 × 300 cm and "2 × 3 m"', () => {
      const formats = ['2x3', '2 3', '200x300', '200 300', '3x2', '300x200'];
      for (const fmt of formats) {
        const res = parser.parse(fmt);
        expect(res.success).toBe(true);
        expect(res.widthCm).toBe(200);
        expect(res.lengthCm).toBe(300);
        expect(res.areaSquareMeters).toBe(6.0);
        expect(res.displayMeters).toBe('2 × 3 m');
      }
    });

    it('should normalize 5 5 to 500 × 500 cm and "5 × 5 m"', () => {
      const res = parser.parse('5 5');
      expect(res.success).toBe(true);
      expect(res.widthCm).toBe(500);
      expect(res.lengthCm).toBe(500);
      expect(res.areaSquareMeters).toBe(25.0);
      expect(res.displayMeters).toBe('5 × 5 m');
    });

    it('should reject ambiguous inputs with clear error reason', () => {
      const ambiguous = ['2 3 4', 'gilam', '', '   '];
      for (const amb of ambiguous) {
        const res = parser.parse(amb);
        expect(res.success).toBe(false);
        expect(['EMPTY', 'AMBIGUOUS', 'INVALID_CHARACTERS']).toContain(res.reason);
      }
    });

    it('should reject out-of-bounds, negative, or absurd dimensions', () => {
      const invalid = [
        '-2x3',       // negative
        '0x0',        // zero
        '5x10cm',     // < 40cm
        '100x200m',   // > 50m
      ];
      for (const inv of invalid) {
        const res = parser.parse(inv);
        expect(res.success).toBe(false);
      }
    });
  });

  describe('2. CarpetDistanceRankingService (Closest Ready Carpet & Euclidean Distance)', () => {
    it('should rank 4 × 6.50 m BEFORE 4 × 6.00 m when customer requests 4 × 6.66 m', () => {
      const targetW = 400; // 4m
      const targetL = 666; // 6.66m

      const candidateA = {
        carpetId: 'carpet-600',
        uniqueCode: 'C-600',
        name: 'Mardin 4x6',
        patternCode: 'M101',
        widthCm: 400,
        lengthCm: 600, // Distance = |600 - 666| = 66 cm
        shape: Shape.RECTANGLE,
        productType: ProductType.READY,
        price: 150000,
        stock: 2,
        images: ['/img1.jpg'],
      };

      const candidateB = {
        carpetId: 'carpet-650',
        uniqueCode: 'C-650',
        name: 'Steffano 4x6.5',
        patternCode: 'L100',
        widthCm: 400,
        lengthCm: 650, // Distance = |650 - 666| = 16 cm
        shape: Shape.RECTANGLE,
        productType: ProductType.READY,
        price: 160000,
        stock: 1,
        images: ['/img2.jpg'],
      };

      const ranked = ranking.rankCandidates(targetW, targetL, [candidateA, candidateB]);

      expect(ranked.length).toBe(2);
      // Candidate B must be first because 16 cm < 66 cm!
      expect(ranked[0].carpetId).toBe('carpet-650');
      expect(ranked[0].distanceCm).toBe(16.0);
      expect(ranked[1].carpetId).toBe('carpet-600');
      expect(ranked[1].distanceCm).toBe(66.0);
    });

    it('should check rotated dimensions (orientation independence)', () => {
      const targetW = 200;
      const targetL = 300;

      const candidate = {
        carpetId: 'c-rot',
        uniqueCode: 'C-ROT',
        name: 'Luna 3x2',
        patternCode: 'LUNA',
        widthCm: 300,
        lengthCm: 200,
        shape: Shape.RECTANGLE,
        productType: ProductType.READY,
        price: 100000,
        stock: 1,
        images: [],
      };

      const ranked = ranking.rankCandidates(targetW, targetL, [candidate]);
      expect(ranked.length).toBe(1);
      expect(ranked[0].distanceCm).toBe(0);
      expect(ranked[0].orientation).toBe('ROTATED');
    });

    it('should exclude carpets exceeding the maximum distance cutoff', () => {
      const targetW = 400;
      const targetL = 600;

      const tinyRunner = {
        carpetId: 'c-tiny',
        uniqueCode: 'TINY',
        name: 'Bedside Runner',
        patternCode: 'R01',
        widthCm: 80,
        lengthCm: 150, // Distance is > 300cm!
        shape: Shape.RECTANGLE,
        productType: ProductType.READY,
        price: 50000,
        stock: 1,
        images: [],
      };

      const ranked = ranking.rankCandidates(targetW, targetL, [tinyRunner]);
      expect(ranked.length).toBe(0);
    });
  });

  describe('3. Metraj Inventory Cut Length & Reserved Stock Rules', () => {
    it('should accept 4m roll with 8m available, but reject 4m roll with only 5m available for a 6.11m cut', async () => {
      mockPrisma.rollInventory.findMany.mockResolvedValue([
        {
          id: 'roll-sufficient-8m',
          carpetId: 'c-roll-1',
          widthCm: 400,
          currentLengthCm: 800, // 8 meters
          reservedLengthCm: 0,
          pricePerM2: 100000,
          carpet: {
            uniqueCode: 'R-8M',
            name: 'Etalon 4m Roll',
            patternCode: 'E1',
            images: [],
          },
        },
        {
          id: 'roll-insufficient-5m',
          carpetId: 'c-roll-2',
          widthCm: 400,
          currentLengthCm: 500, // 5 meters (< 6.11m)
          reservedLengthCm: 0,
          pricePerM2: 100000,
          carpet: {
            uniqueCode: 'R-5M',
            name: 'Steffano 4m Roll',
            patternCode: 'S1',
            images: [],
          },
        },
      ]);

      const cutLengthCm = 611; // 6.11 meters
      const matches = await ranking.searchMetrajRolls(400, cutLengthCm);

      expect(matches.length).toBe(1);
      expect(matches[0].rollInventoryId).toBe('roll-sufficient-8m');
      expect(matches[0].effectiveAvailableLengthCm).toBe(800);
    });

    it('should deduct reservedLengthCm from currentLengthCm to determine real stock', async () => {
      mockPrisma.rollInventory.findMany.mockResolvedValue([
        {
          id: 'roll-reserved',
          carpetId: 'c-roll-3',
          widthCm: 400,
          currentLengthCm: 800, // 8m total
          reservedLengthCm: 300, // 3m reserved by other order -> effective is only 5m!
          pricePerM2: 100000,
          carpet: {
            uniqueCode: 'R-RES',
            name: 'Terra 4m Roll',
            patternCode: 'T1',
            images: [],
          },
        },
      ]);

      const matches = await ranking.searchMetrajRolls(400, 611);
      // Effective is 500cm, which is less than 611cm -> must NOT match!
      expect(matches.length).toBe(0);
    });
  });

  describe('4. PricingService (Exact Monetary Precision & UZS Formatting)', () => {
    it('should calculate 4 × 6.11 m at 100,000 UZS/m² to exactly 2,444,000 UZS without floating-point error', () => {
      const res = pricing.calculateMetrajPrice(4, 6.11, 100000);

      expect(res.areaSquareMeters).toBe(24.44);
      expect(res.totalPriceUzs).toBe(2444000);
      expect(res.formattedTotalPrice).toBe('2 444 000 so‘m');
      expect(res.formattedPricePerM2).toBe('100 000 so‘m');
    });

    it('should format numbers with thousands spaces accurately', () => {
      expect(pricing.formatUzbekCurrency(150000)).toBe('150 000 so‘m');
      expect(pricing.formatUzbekCurrency(5000000)).toBe('5 000 000 so‘m');
      expect(pricing.formatUzbekCurrency(950)).toBe('950 so‘m');
    });

    it('should prefer fixed piecePrice for ready carpets when available', () => {
      const res = pricing.calculateReadyCarpetPrice({
        piecePrice: 850000,
        widthMeters: 2,
        lengthMeters: 3,
        pricePerM2: 150000, // 2x3x150k would be 900k, but piecePrice is 850k
      });

      expect(res.totalPriceUzs).toBe(850000);
      expect(res.isFixedPiecePrice).toBe(true);
      expect(res.formattedTotalPrice).toBe('850 000 so‘m');
    });
  });

  describe('5. Fallback Hierarchy & 5-Meter Prohibition Rule', () => {
    it('should follow Metraj -> Ready -> Oval -> NOT_FOUND and NEVER auto-substitute 5-meter metraj', async () => {
      // 1. Mock: No metraj rolls available for 4m
      mockPrisma.rollInventory.findMany.mockResolvedValue([]);
      // 2. Mock: No ready carpets available
      mockPrisma.inventoryItem.findMany.mockResolvedValue([]);

      const flow = await ranking.executeFallbackSearch(400, 611, '4 × 6,11 m');

      // Must stop at NOT_FOUND with exact message
      expect(flow.stage).toBe('NOT_FOUND');
      expect(flow.results.length).toBe(0);
      expect(flow.message).toBe('Ushbu o‘lchamga mos gilam topilmadi.');

      // Invariant check: 5-meter metraj is NEVER returned
      const any5m = flow.results.some((r) => r.widthCm === 500);
      expect(any5m).toBe(false);
    });
  });
});
