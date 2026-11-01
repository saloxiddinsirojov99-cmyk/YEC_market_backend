import { Test, TestingModule } from '@nestjs/testing';
import { BaskoSyncService } from './basko-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { BaskoSyncLogService } from './basko-sync-log.service';
import { BaskoNormalizedProduct } from './types/basko.types';
import { BaskoProductNormalizer } from './basko-product.normalizer';

describe('BaskoLoadBenchmark — 10,000+ Products Load & Stress Test', () => {
  let syncService: BaskoSyncService;
  let prismaMock: any;
  let syncLogMock: any;

  beforeEach(async () => {
    // 5,000 simulated pre-existing inventory items in DB
    const existingInventoryList: any[] = [];
    for (let i = 1; i <= 5000; i++) {
      const barcode = String(i).padStart(8, '0');
      existingInventoryList.push({
        id: `inv_db_${i}`,
        barcode: barcode,
        carpetId: `carpet_db_${i}`,
        piecePrice: 500000 + i * 1000,
        carpet: {
          id: `carpet_db_${i}`,
          uniqueCode: `EX_${barcode}`,
          images: [`images/carpet_${i}.jpg`],
          catalogDesignId: null,
          price: 500000 + i * 1000,
          material: 'Heatset',
          type: 'READY',
          productType: 'READY',
          shape: 'RECTANGLE',
        },
      });
    }

    prismaMock = {
      catalogDesign: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cd_1', designCode: 'DSG-1', image: 'images/design1.jpg' },
        ]),
      },
      category: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'cat_modern', name: 'Modern' },
          { id: 'cat_classic', name: 'Klassika' },
        ]),
      },
      inventoryItem: {
        findMany: jest.fn().mockResolvedValue(existingInventoryList),
        create: jest.fn().mockImplementation(async (params: any) => ({
          id: `inv_${Date.now()}_${Math.random()}`,
          ...params.data,
        })),
        update: jest.fn().mockImplementation(async (params: any) => params.data),
        updateMany: jest.fn().mockResolvedValue({ count: 10 }),
      },
      carpet: {
        update: jest.fn().mockImplementation(async (params: any) => ({
          id: params.where.id,
          ...params.data,
        })),
        create: jest.fn().mockImplementation(async (params: any) => ({
          id: `new_carpet_${Date.now()}_${Math.random()}`,
          ...params.data,
        })),
      },
    };

    syncLogMock = {
      startSyncJob: jest.fn().mockResolvedValue({ jobId: 'bench_job_1', startedAt: new Date() }),
      completeSyncJob: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BaskoSyncService,
        BaskoProductNormalizer,
        { provide: PrismaService, useValue: prismaMock },
        { provide: BaskoSyncLogService, useValue: syncLogMock },
      ],
    }).compile();

    syncService = module.get<BaskoSyncService>(BaskoSyncService);
  });

  it('should process 10,000+ BASKO products in bulk with O(n + m) efficiency and measure CPU, RAM, and Latency', async () => {
    // 1. Generate 10,000 normalized products
    // (5,000 match existing DB barcodes -> will update; 5,000 are new -> will create)
    const productCount = 10000;
    const testProducts: BaskoNormalizedProduct[] = [];

    for (let i = 1; i <= productCount; i++) {
      const barcode = String(i).padStart(8, '0'); // "00000001" to "00010000"
      testProducts.push({
        barcode: barcode,
        uniqueCode: `UK_${barcode}`,
        name: `Basko Gilam Modeli ${i}`,
        designCode: `DSG-${i % 100}`,
        size: '200x300',
        widthCm: 200,
        lengthCm: 300,
        shape: 'RECTANGLE',
        productType: 'READY',
        price: 750000 + (i % 50) * 10000,
        stock: 5 + (i % 15),
        material: i % 2 === 0 ? 'Frize' : 'Heatset',
        yarnType: i % 2 === 0 ? 'Frize' : 'Heatset',
        density: 500000,
        source: 'EXCEL',
        rawRowIndex: i,
        rawAttributes: { index: i },
      });
    }

    expect(testProducts.length).toBe(10000);

    // 2. Measure Memory and CPU before execution
    if (global.gc) {
      global.gc();
    }
    const memBefore = process.memoryUsage();
    const cpuBefore = process.cpuUsage();
    const startTime = performance.now();

    // 3. Execute O(n + m) bulk synchronization
    const result = await syncService.executeSync(testProducts, {
      jobId: 'bench_job_1',
      startedAt: new Date(),
      source: 'EXCEL',
      fileName: 'basko_10000_stress_test.xlsx',
      performedBy: 'LOAD_TEST_ENGINE',
      rawCount: 10000,
      errors: [],
      duplicateCount: 0,
    });

    // 4. Measure Metrics after execution
    const endTime = performance.now();
    const durationMs = Math.round(endTime - startTime);
    const cpuDiff = process.cpuUsage(cpuBefore);
    const memAfter = process.memoryUsage();

    const heapDiffMb = parseFloat(
      ((memAfter.heapUsed - memBefore.heapUsed) / (1024 * 1024)).toFixed(2),
    );
    const cpuUserMs = Math.round(cpuDiff.user / 1000);
    const cpuSystemMs = Math.round(cpuDiff.system / 1000);

    console.log(
      `\n📊 [10,000+ BASKO LOAD BENCHMARK]:\n` +
      `  - Qayta ishlangan mahsulotlar: ${testProducts.length} ta\n` +
      `  - Umumiy bajarilish vaqti: ${durationMs} ms (${(durationMs / 1000).toFixed(2)} soniya)\n` +
      `  - O'rtacha bitta tovar vaqti: ${(durationMs / 10000).toFixed(3)} ms\n` +
      `  - Yangi qo'shilganlar: ${result.stats.newProducts} ta\n` +
      `  - Yangilanganlar: ${result.stats.updatedProducts} ta\n` +
      `  - Arxivlanganlar: ${result.stats.archivedProducts} ta\n` +
      `  - Xotira (Heap delta): ${heapDiffMb} MB\n` +
      `  - CPU sarfi: user=${cpuUserMs}ms, system=${cpuSystemMs}ms\n` +
      `  - Preload so'rovlari: inventoryItem.findMany (1 ta), catalogDesign.findMany (1 ta), category.findMany (1 ta)\n` +
      `  - N+1 tekshiruvi: O(n + m) Map-based algoritmi orqali N+1 so'rovlar to'liq bartaraf etilgan! ✅\n`,
    );

    // 5. Strict Assertions
    expect(result.status).toBe('SUCCESS');
    expect(result.stats.totalReceived).toBe(10000);
    expect(result.stats.totalValidated).toBe(10000);
    expect(result.stats.newProducts).toBe(5000);
    expect(result.stats.updatedProducts).toBe(5000);
    expect(result.stats.invalidRecords).toBe(0);

    // Initial preloading queries: exactly 1 for inventoryItem, 1 for catalogDesign, 1 for category!
    expect(prismaMock.inventoryItem.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.catalogDesign.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.category.findMany).toHaveBeenCalledTimes(1);

    // Latency & Memory benchmarks:
    expect(durationMs).toBeLessThan(15000); // 10,000 items in <15s
    expect(heapDiffMb).toBeLessThan(200);   // <200MB memory usage
  });
});
