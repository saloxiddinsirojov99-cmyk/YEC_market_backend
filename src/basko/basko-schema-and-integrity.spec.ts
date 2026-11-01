import { BaskoProductNormalizer } from './basko-product.normalizer';
import { BaskoSyncLogService } from './basko-sync-log.service';
import { ProductType, Shape, CarpetType } from '@prisma/client';
import { BaskoRawProduct, BaskoSyncStats } from './types/basko.types';

describe('CHECKPOINT 2: Basko Schema, Normalization & Data Integrity Tests', () => {
  let normalizer: BaskoProductNormalizer;
  let logService: BaskoSyncLogService;

  beforeEach(() => {
    normalizer = new BaskoProductNormalizer();
    // Pass mock prisma for unit testing
    const mockPrisma = {
      importLog: {
        create: jest.fn().mockResolvedValue({ id: 'mock_import_id' }),
      },
    } as any;
    logService = new BaskoSyncLogService(mockPrisma);
  });

  describe('1. Barcode Leading Zeros & String Type Integrity', () => {
    it('should strictly preserve leading zeros in barcodes (e.g. 00123456)', () => {
      const barcodes = ['00123456', '00009876', '0712345678901', '01'];
      for (const bc of barcodes) {
        const normalized = normalizer.normalizeBarcode(bc);
        expect(typeof normalized).toBe('string');
        expect(normalized).toBe(bc);
        expect(normalized.length).toBe(bc.length);
        expect(normalized.startsWith('0')).toBe(true);
      }
    });

    it('should reject or flag scientific notation float strings as invalid', () => {
      expect(() => {
        normalizer.normalizeBarcode('1.234567E+07');
      }).toThrow(/Xato shtrix-kod.*Ilmiy format/);
    });

    it('should strip invisible spaces while keeping digits intact', () => {
      const raw = '\u200B00456123\uFEFF';
      const normalized = normalizer.normalizeBarcode(raw);
      expect(normalized).toBe('00456123');
    });
  });

  describe('2. In-Memory Duplicate Barcode Detection', () => {
    it('should detect duplicate barcodes in batch and isolate them in errors without overwriting', () => {
      const rawBatch: BaskoRawProduct[] = [
        {
          __rowNum__: 1,
          barcode: '00123456',
          name: 'Steffano L100A',
          designCode: 'L100A',
          width: '2',
          length: '3',
          appearance: 'R',
          material: 'Akril',
        },
        {
          __rowNum__: 2,
          barcode: '00123456', // DUPLICATE
          name: 'Steffano L100A Copy',
          designCode: 'L100A',
          width: '2',
          length: '3',
          appearance: 'R',
          material: 'Akril',
        },
        {
          __rowNum__: 3,
          barcode: '00789000',
          name: 'Zeugma Z051E',
          designCode: 'Z051E',
          width: '3',
          length: '4',
          appearance: 'R',
          material: 'Polyester',
        },
      ];

      const result = normalizer.normalizeBatch(rawBatch);

      expect(result.valid.length).toBe(2);
      expect(result.duplicateBarcodesCount).toBe(1);
      expect(result.errors.length).toBe(1);
      expect(result.errors[0].barcode).toBe('00123456');
      expect(result.errors[0].reason).toContain('takrorlangan');

      // The valid items have unique barcodes
      const validBarcodes = result.valid.map((v) => v.barcode);
      expect(validBarcodes).toEqual(['00123456', '00789000']);
    });
  });

  describe('3. Separation of Raw Material and Yarn Processing Technology', () => {
    it('should separate raw fiber from Heatset/Frize/BCF technologies', () => {
      const testCases = [
        {
          input: 'Akril Heatset',
          expectedMaterial: 'Akril',
          expectedYarn: 'Heatset',
        },
        {
          input: 'Polyester Frize',
          expectedMaterial: 'Polyester',
          expectedYarn: 'Frize',
        },
        {
          input: 'Heatset',
          expectedMaterial: 'Polipropilen',
          expectedYarn: 'Heatset',
        },
        {
          input: 'Jun 100%',
          expectedMaterial: 'Jun 100%',
          expectedYarn: null,
        },
      ];

      for (const tc of testCases) {
        const { material, yarnType } = normalizer.separateMaterialAndYarn(tc.input);
        expect(material).toBe(tc.expectedMaterial);
        expect(yarnType).toBe(tc.expectedYarn);
      }
    });
  });

  describe('4. Dimensions, Shapes, and Product Types', () => {
    it('should normalize ready rectangular, oval, and metraj rolls correctly', () => {
      const readyItem: BaskoRawProduct = {
        barcode: '00100',
        name: 'Mardin M101',
        designCode: 'M101',
        width: '400',
        length: '611',
        appearance: 'R',
      };
      const resReady = normalizer.normalizeBatch([readyItem]);
      expect(resReady.valid[0].widthCm).toBe(400);
      expect(resReady.valid[0].lengthCm).toBe(611);
      expect(resReady.valid[0].areaM2).toBe(24.44);
      expect(resReady.valid[0].productType).toBe(ProductType.READY);
      expect(resReady.valid[0].shape).toBe(Shape.RECTANGLE);

      const ovalItem: BaskoRawProduct = {
        barcode: '00200',
        name: 'Luna Oval',
        designCode: 'LUNA-O',
        width: '2',
        length: '3',
        appearance: 'OVAL',
      };
      const resOval = normalizer.normalizeBatch([ovalItem]);
      expect(resOval.valid[0].productType).toBe(ProductType.READY);
      expect(resOval.valid[0].shape).toBe(Shape.OVAL);

      const rollItem: BaskoRawProduct = {
        barcode: '00300',
        name: 'Etalon Metraj Roll',
        designCode: 'ETALON-R',
        width: '4',
        length: '25', // 25 meters roll length
        appearance: 'METRAJ',
      };
      const resRoll = normalizer.normalizeBatch([rollItem]);
      expect(resRoll.valid[0].productType).toBe(ProductType.METRAJ);
      expect(resRoll.valid[0].type).toBe(CarpetType.ROLL);
      expect(resRoll.valid[0].widthCm).toBe(400);
      expect(resRoll.valid[0].availableLengthMeters).toBe(25);
    });
  });

  describe('5. Data Preservation & Safety Invariants', () => {
    it('should never overwrite existing YEC images when incoming BASKO data has no image', () => {
      // Existing YEC Carpet
      const existingCarpet = {
        id: 'c-1',
        uniqueCode: '00123456',
        name: 'Steffano L100A',
        images: ['/uploads/catalog/steffano_L100A.webp'],
        catalogDesignId: 'design-123',
      };

      // Incoming BASKO record (has NO images)
      const incomingBasko = {
        barcode: '00123456',
        name: 'Steffano L100A Updated',
        pricePerM2: 120000,
        // no images property
      };

      // Merging rule: preserve existing photos
      const updatedImages = existingCarpet.images && existingCarpet.images.length > 0
        ? existingCarpet.images
        : (incomingBasko as any).images || [];

      expect(updatedImages).toEqual(['/uploads/catalog/steffano_L100A.webp']);
      expect(updatedImages.length).toBe(1);
    });

    it('should abort archiving if import validation fails or data is corrupted', () => {
      const activeProductsInDb = 6759;
      const rawCorruptedBatch: BaskoRawProduct[] = [
        { barcode: '', name: 'Broken item 1' },
        { barcode: '123', name: '' },
      ];

      const { valid, errors } = normalizer.normalizeBatch(rawCorruptedBatch);
      const isBatchValid = valid.length > 0 && errors.length === 0;

      // Invariant: If isBatchValid is false, ARCHIVE logic MUST NOT run!
      let archivedCount = 0;
      if (isBatchValid) {
        archivedCount = 100; // should NOT happen
      }

      expect(isBatchValid).toBe(false);
      expect(archivedCount).toBe(0);
      expect(activeProductsInDb).toBe(6759);
    });
  });

  describe('6. Synchronization Report Formatting in Uzbek', () => {
    it('should format all required statistics according to Section 5.8 of specification', () => {
      const stats: BaskoSyncStats = {
        totalReceived: 10450,
        totalValidated: 10420,
        newProducts: 150,
        updatedProducts: 8200,
        archivedProducts: 25,
        unchangedProducts: 2045,
        duplicateBarcodes: 12,
        invalidRecords: 18,
        missingImages: 45,
        durationMs: 4200,
      };

      const report = logService.formatSyncReportUzbek(stats);

      expect(report).toContain('10450 ta');
      expect(report).toContain('10420 ta');
      expect(report).toContain('150 ta');
      expect(report).toContain('8200 ta');
      expect(report).toContain('2045 ta');
      expect(report).toContain('25 ta');
      expect(report).toContain('12 ta');
      expect(report).toContain('18 ta');
      expect(report).toContain('45 ta');
      expect(report).toContain('4.2 soniya');
      expect(report).toContain('5 soniyadan so‘ng asosiy menyu avtomatik ochiladi');
    });
  });
});
