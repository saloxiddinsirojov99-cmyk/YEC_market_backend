import * as XLSX from 'xlsx';
import { BaskoFieldMappingService } from './basko-field-mapping.service';
import { BaskoExcelImportService } from './basko-excel-import.service';
import { BaskoProductNormalizer } from './basko-product.normalizer';
import { BaskoSyncService } from './basko-sync.service';
import { BaskoSyncLogService } from './basko-sync-log.service';
import { BaskoIntegrationService } from './basko-integration.service';
import { CarpetInventoryStatus, ProductType, Shape, CarpetType } from '@prisma/client';
import { ConflictException, BadRequestException } from '@nestjs/common';

describe('CHECKPOINT 3: BASKO Excel Import & O(n + m) Synchronization Engine', () => {
  let fieldMappingService: BaskoFieldMappingService;
  let excelImportService: BaskoExcelImportService;
  let normalizer: BaskoProductNormalizer;
  let syncLogService: BaskoSyncLogService;
  let syncService: BaskoSyncService;
  let integrationService: BaskoIntegrationService;

  // Mock Prisma state for in-memory DB tests
  let mockPrisma: any;

  beforeEach(() => {
    fieldMappingService = new BaskoFieldMappingService();
    excelImportService = new BaskoExcelImportService(fieldMappingService);
    normalizer = new BaskoProductNormalizer();

    mockPrisma = {
      importLog: {
        create: jest.fn().mockResolvedValue({ id: 'mock_import_log_id' }),
      },
      inventoryItem: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'inv-new-1' }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      carpet: {
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        create: jest.fn().mockResolvedValue({ id: 'carpet-new-1' }),
      },
      rollInventory: {
        create: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      },
      catalogDesign: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'design-steffano-100',
            designCode: 'L100A',
            image: '/uploads/catalog/steffano_L100A.webp',
          },
        ]),
      },
      category: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cat-modern', name: 'Modern' },
          { id: 'cat-classic', name: 'Classic' },
        ]),
      },
    };

    syncLogService = new BaskoSyncLogService(mockPrisma);
    syncService = new BaskoSyncService(mockPrisma, normalizer, syncLogService);
    integrationService = new BaskoIntegrationService(
      excelImportService,
      syncService,
      syncLogService,
    );
  });

  describe('1. BaskoFieldMappingService (Configurable Dynamic Headers)', () => {
    it('should dynamically map Cyrillic column headers to canonical fields', () => {
      const cyrillicRow = {
        'Штрих код': '00987654',
        'Маҳсулот номи': 'Steffano L100A',
        'Дизайн коди': 'L100A',
        'Эни': '200',
        'Бўйи': '300',
        'Кўриниши': 'READY',
        'Донабай': '150000',
        'Состави': 'Akril Heatset',
        'Қолдиқ': '5',
      };

      const mapped = fieldMappingService.mapRow(cyrillicRow, 2);

      expect(mapped.barcode).toBe('00987654');
      expect(mapped.name).toBe('Steffano L100A');
      expect(mapped.designCode).toBe('L100A');
      expect(mapped.width).toBe('200');
      expect(mapped.length).toBe('300');
      expect(mapped.appearance).toBe('READY');
      expect(mapped.piecePrice).toBe('150000');
      expect(mapped.material).toBe('Akril Heatset');
      expect(mapped.stock).toBe('5');
    });

    it('should map Latin and English column headers correctly', () => {
      const latinRow = {
        'Barcode': '00123456',
        'Product Name': 'Zeugma Z051E',
        'PatternCode': 'Z051E',
        'Width': '3',
        'Length': '4',
        'Appearance': 'METRAJ',
        'PricePerM2': '120000',
        'Material': 'Polyester',
        'Stock': '10',
      };

      const mapped = fieldMappingService.mapRow(latinRow, 3);

      expect(mapped.barcode).toBe('00123456');
      expect(mapped.name).toBe('Zeugma Z051E');
      expect(mapped.designCode).toBe('Z051E');
      expect(mapped.appearance).toBe('METRAJ');
    });
  });

  describe('2. BaskoExcelImportService (Workbook Parsing & Leading Zeros)', () => {
    it('should parse an in-memory Excel workbook buffer and preserve leading zeros in barcodes', () => {
      // Create an in-memory workbook with SheetJS
      const sheetData = [
        ['Штрих-код', 'Номи', 'Дизайн коди', 'Эни', 'Бўйи', 'Кўриниши', 'Нархи'],
        ['00789012', 'Luna L200', 'L200B', '400', '611', 'R', '110000'],
        ['00005555', 'Etalon E10', 'E10A', '4', '20', 'METRAJ', '95000'],
      ];

      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Mahsulotlar');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const parsed = excelImportService.parseWorkbook(buffer);

      expect(parsed.totalRows).toBe(2);
      expect(parsed.rawProducts[0].barcode).toBe('00789012');
      expect(parsed.rawProducts[0].barcode.startsWith('00')).toBe(true);
      expect(parsed.rawProducts[1].barcode).toBe('00005555');
      expect(parsed.rawProducts[1].barcode.startsWith('0000')).toBe(true);
    });
  });

  describe('3. BaskoSyncService (Two-Phase O(n + m) Engine & Safety Guards)', () => {
    it('Phase 1: should preview diff and abort if batch is corrupted or unsafe', async () => {
      mockPrisma.inventoryItem.findMany.mockResolvedValue([
        { barcode: '11111111', carpetId: 'c-1' },
      ]);

      // Corrupted batch where 100% of rows have errors
      const brokenBatch = [
        { barcode: '', name: 'No barcode' },
        { barcode: '123', name: '', designCode: '' },
      ];

      const preview = await syncService.previewSync(brokenBatch);

      expect(preview.isSafeToExecute).toBe(false);
      expect(preview.errors.length).toBe(2);
      expect(preview.validItems.length).toBe(0);
    });

    it('Phase 2: should update existing product while PRESERVING YEC photos and CatalogDesign', async () => {
      // Mock existing item in DB with photos
      mockPrisma.inventoryItem.findMany.mockResolvedValue([
        {
          id: 'inv-existing-1',
          barcode: '00123456',
          carpetId: 'carpet-existing-1',
          carpet: {
            id: 'carpet-existing-1',
            uniqueCode: '00123456',
            images: ['/uploads/collections/steffano/steffano_real_photo.jpg'],
            catalogDesignId: 'design-steffano-100',
            material: 'Old Material',
            price: 100000,
          },
        },
      ]);

      const validItems = [
        {
          barcode: '00123456',
          name: 'Steffano L100A',
          cleanName: 'Steffano',
          designCode: 'L100A',
          productType: ProductType.READY,
          shape: Shape.RECTANGLE,
          type: CarpetType.READY,
          widthCm: 200,
          lengthCm: 300,
          widthMm: 2000,
          lengthMm: 3000,
          areaM2: 6.0,
          pricePerM2: 130000, // Price updated
          piecePrice: null,
          material: 'Akril',
          yarnType: 'Heatset',
          color: 'Bej',
          stockQuantity: 10,
          availableLengthMeters: null,
          brand: null,
          categorySuggestion: null,
        },
      ];

      const result = await syncService.executeSync(validItems, {
        jobId: 'test_job_1',
        startedAt: new Date(),
        source: 'EXCEL',
        rawCount: 1,
        errors: [],
        duplicateCount: 0,
      });

      expect(result.status).toBe('SUCCESS');
      expect(result.stats.updatedProducts).toBe(1);
      expect(result.stats.newProducts).toBe(0);

      // Verify carpet update was called with existing YEC photos preserved
      expect(mockPrisma.carpet.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'carpet-existing-1' },
          data: expect.objectContaining({
            images: ['/uploads/collections/steffano/steffano_real_photo.jpg'],
            catalogDesignId: 'design-steffano-100',
            price: 130000,
            isArchived: false,
          }),
        }),
      );
    });

    it('Phase 2: should create new product and link CatalogDesign photo if designCode matches', async () => {
      mockPrisma.inventoryItem.findMany.mockResolvedValue([]); // No existing items

      const validItems = [
        {
          barcode: '00888999',
          name: 'Steffano L100A New',
          cleanName: 'Steffano',
          designCode: 'L100A', // Matches design-steffano-100 in catalogDesigns
          productType: ProductType.READY,
          shape: Shape.RECTANGLE,
          type: CarpetType.READY,
          widthCm: 300,
          lengthCm: 400,
          widthMm: 3000,
          lengthMm: 4000,
          areaM2: 12.0,
          pricePerM2: 140000,
          piecePrice: null,
          material: 'Akril',
          yarnType: 'Heatset',
          color: null,
          stockQuantity: 5,
          availableLengthMeters: null,
          brand: null,
          categorySuggestion: null,
        },
      ];

      const result = await syncService.executeSync(validItems, {
        jobId: 'test_job_2',
        startedAt: new Date(),
        source: 'EXCEL',
        rawCount: 1,
        errors: [],
        duplicateCount: 0,
      });

      expect(result.stats.newProducts).toBe(1);
      expect(mockPrisma.carpet.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            uniqueCode: '00888999',
            designCode: 'L100A',
            catalogDesignId: 'design-steffano-100',
            images: ['/uploads/catalog/steffano_L100A.webp'],
          }),
        }),
      );
    });

    it('Phase 2: Safe Archive should mark missing items as ARCHIVED without deleting them', async () => {
      // Existing active item '99999999' not present in incoming validItems
      mockPrisma.inventoryItem.findMany.mockResolvedValue([
        {
          id: 'inv-to-archive',
          barcode: '99999999',
          inventoryStatus: CarpetInventoryStatus.ACTIVE,
          carpet: { id: 'c-old', uniqueCode: '99999999', images: [] },
        },
      ]);

      const validItems = [
        {
          barcode: '00111222', // new barcode
          name: 'New Carpet',
          cleanName: 'New',
          designCode: 'N01',
          productType: ProductType.READY,
          shape: Shape.RECTANGLE,
          type: CarpetType.READY,
          widthCm: 200,
          lengthCm: 300,
          widthMm: 2000,
          lengthMm: 3000,
          areaM2: 6.0,
          pricePerM2: 100000,
          piecePrice: null,
          material: 'Polyester',
          yarnType: null,
          color: null,
          stockQuantity: 1,
          availableLengthMeters: null,
          brand: null,
          categorySuggestion: null,
        },
      ];

      const result = await syncService.executeSync(validItems, {
        jobId: 'test_job_archive',
        startedAt: new Date(),
        source: 'EXCEL',
        rawCount: 1,
        errors: [],
        duplicateCount: 0,
      });

      expect(result.stats.archivedProducts).toBe(1);
      expect(mockPrisma.inventoryItem.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['inv-to-archive'] } },
        data: { inventoryStatus: CarpetInventoryStatus.ARCHIVED },
      });
      // Physical delete MUST NOT be called
      expect((mockPrisma.carpet as any).delete).toBeUndefined();
      expect((mockPrisma.inventoryItem as any).delete).toBeUndefined();
    });
  });

  describe('4. BaskoIntegrationService (Concurrency Lock & Façade)', () => {
    it('should prevent simultaneous synchronization runs with ConflictException', async () => {
      const sheetData = [
        ['Barcode', 'Name', 'DesignCode', 'Width', 'Length', 'Price'],
        ['00123', 'Carpet 1', 'D1', '2', '3', '100000'],
      ];
      const ws = XLSX.utils.aoa_to_sheet(sheetData);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
      const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      // Simulate running sync
      const firstSyncPromise = integrationService.syncFromExcel(buffer);

      // Attempt second sync immediately while first is running
      await expect(integrationService.syncFromExcel(buffer)).rejects.toThrow(
        ConflictException,
      );

      // Wait for first to complete
      await firstSyncPromise;
      expect(integrationService.isSyncInProgress()).toBe(false);
    });
  });
});
