import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BaskoProductNormalizer } from './basko-product.normalizer';
import { BaskoSyncLogService } from './basko-sync-log.service';
import {
  BaskoRawProduct,
  BaskoNormalizedProduct,
  BaskoSyncStats,
  BaskoSyncResult,
  BaskoValidationError,
} from './types/basko.types';
import { CarpetInventoryStatus, CarpetType, ProductType, Shape } from '@prisma/client';

@Injectable()
export class BaskoSyncService {
  private readonly logger = new Logger(BaskoSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly normalizer: BaskoProductNormalizer,
    private readonly syncLogService: BaskoSyncLogService,
  ) {}

  /**
   * Phase 1: Previews and validates the sync without writing anything to the database.
   * Identifies duplicates, invalid records, and computes change diffs.
   */
  async previewSync(
    rawProducts: BaskoRawProduct[],
  ): Promise<{
    isSafeToExecute: boolean;
    validItems: BaskoNormalizedProduct[];
    errors: BaskoValidationError[];
    stats: BaskoSyncStats;
  }> {
    const startTime = Date.now();

    // 1. In-memory batch normalization & duplicate detection
    const { valid, errors, duplicateBarcodesCount } =
      this.normalizer.normalizeBatch(rawProducts);

    // 2. Fetch existing active barcodes in ONE query (O(n))
    const existingActiveItems = await this.prisma.inventoryItem.findMany({
      where: {
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
      },
      select: {
        barcode: true,
        carpetId: true,
      },
    });

    const existingBarcodeSet = new Set(existingActiveItems.map((i) => i.barcode));
    const incomingBarcodeSet = new Set(valid.map((v) => v.barcode));

    let newProducts = 0;
    let updatedProducts = 0;
    let unchangedProducts = 0;

    for (const item of valid) {
      if (existingBarcodeSet.has(item.barcode)) {
        updatedProducts++;
      } else {
        newProducts++;
      }
    }

    // Products present in DB but missing from complete incoming dataset
    let archivedProducts = 0;
    for (const existingBarcode of existingBarcodeSet) {
      if (!incomingBarcodeSet.has(existingBarcode)) {
        archivedProducts++;
      }
    }

    const durationMs = Date.now() - startTime;

    // Safety rule: if more than 30% of records are invalid or empty, consider the batch corrupted/unsafe!
    const invalidRatio = rawProducts.length > 0 ? errors.length / rawProducts.length : 1;
    const isSafeToExecute = valid.length > 0 && invalidRatio < 0.3;

    const stats: BaskoSyncStats = {
      totalReceived: rawProducts.length,
      totalValidated: valid.length,
      newProducts,
      updatedProducts,
      archivedProducts,
      unchangedProducts,
      duplicateBarcodes: duplicateBarcodesCount,
      invalidRecords: errors.length,
      missingImages: 0,
      durationMs,
    };

    return {
      isSafeToExecute,
      validItems: valid,
      errors,
      stats,
    };
  }

  /**
   * Phase 2: Executes O(n + m) safe synchronization against the database.
   * Strictly preserves all YEC photos and CatalogDesign links.
   */
  async executeSync(
    validItems: BaskoNormalizedProduct[],
    jobContext: {
      jobId: string;
      startedAt: Date;
      source: 'EXCEL' | 'API';
      fileName?: string;
      performedBy?: string;
      rawCount: number;
      errors: BaskoValidationError[];
      duplicateCount: number;
    },
  ): Promise<BaskoSyncResult> {
    const startTime = Date.now();
    this.logger.log(`🚀 O(n + m) Sinxronizatsiya boshlandi: ${validItems.length} ta tekshirilgan tovar`);

    // 1. Preload existing CatalogDesigns for YEC image matching in ONE query
    const catalogDesigns = await this.prisma.catalogDesign.findMany({
      select: {
        id: true,
        designCode: true,
        image: true,
      },
    });
    // Map designCode (case-insensitive) -> CatalogDesign
    const designMap = new Map<string, { id: string; image: string }>();
    for (const cd of catalogDesigns) {
      designMap.set(cd.designCode.toUpperCase(), cd);
    }

    // 2. Preload existing InventoryItems with their parent Carpet in ONE query (O(n))
    const existingInventory = await this.prisma.inventoryItem.findMany({
      include: {
        carpet: {
          select: {
            id: true,
            uniqueCode: true,
            images: true,
            catalogDesignId: true,
            price: true,
            material: true,
            type: true,
            productType: true,
            shape: true,
          },
        },
      },
    });

    // Map barcode -> InventoryItem & Carpet
    const inventoryMap = new Map<string, (typeof existingInventory)[0]>();
    for (const inv of existingInventory) {
      inventoryMap.set(inv.barcode, inv);
    }

    // 3. Preload Categories for category matching
    const categories = await this.prisma.category.findMany();
    const defaultCategory = categories.find((c) => c.name === 'Modern') || categories[0];

    const incomingBarcodeSet = new Set<string>();
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let missingImagesCount = 0;

    // 4. Process incoming items using Map lookups (O(m))
    for (const item of validItems) {
      incomingBarcodeSet.add(item.barcode);
      const existing = inventoryMap.get(item.barcode);

      if (existing) {
        // --- UPDATE EXISTING PRODUCT ---
        // INVARIANT: YEC images MUST be preserved
        const existingImages = existing.carpet.images || [];
        const existingCatalogId = existing.carpet.catalogDesignId;

        // Check matching catalog design if image is somehow missing
        let resolvedCatalogId = existingCatalogId;
        let resolvedImages = existingImages;
        if (resolvedImages.length === 0) {
          const matchedDesign = designMap.get(item.designCode.toUpperCase());
          if (matchedDesign) {
            resolvedCatalogId = matchedDesign.id;
            resolvedImages = [matchedDesign.image];
          } else {
            missingImagesCount++;
          }
        }

        // Update database records
        await this.prisma.carpet.update({
          where: { id: existing.carpetId },
          data: {
            price: item.pricePerM2,
            material: item.material || existing.carpet.material,
            isArchived: false,
            images: resolvedImages,
            catalogDesignId: resolvedCatalogId,
          },
        });

        await this.prisma.inventoryItem.update({
          where: { id: existing.id },
          data: {
            size: `${item.widthCm}x${item.lengthCm}`,
            widthMm: item.widthMm,
            lengthMm: item.lengthMm,
            pricePerM2: item.pricePerM2,
            piecePrice: item.piecePrice,
            inventoryStatus: CarpetInventoryStatus.ACTIVE,
          },
        });

        // Update Metraj Roll length if applicable
        if (item.productType === ProductType.METRAJ && item.availableLengthMeters != null) {
          await this.prisma.rollInventory.upsert({
            where: {
              carpetId_widthCm: {
                carpetId: existing.carpetId,
                widthCm: item.widthCm,
              },
            },
            update: {
              currentLengthCm: Math.round(item.availableLengthMeters * 100),
              pricePerM2: item.pricePerM2,
            },
            create: {
              carpetId: existing.carpetId,
              widthCm: item.widthCm,
              originalLengthCm: Math.round(item.availableLengthMeters * 100),
              currentLengthCm: Math.round(item.availableLengthMeters * 100),
              pricePerM2: item.pricePerM2,
            },
          });
        }

        updatedCount++;
      } else {
        // --- INSERT NEW PRODUCT ---
        // Look up image from YEC CatalogDesign
        const matchedDesign = designMap.get(item.designCode.toUpperCase());
        const images = matchedDesign ? [matchedDesign.image] : [];
        const catalogDesignId = matchedDesign?.id || null;

        if (images.length === 0) {
          missingImagesCount++;
        }

        // Resolve category
        let categoryId = defaultCategory?.id;
        if (item.categorySuggestion) {
          const matchedCat = categories.find(
            (c) => c.name.toLowerCase() === item.categorySuggestion!.toLowerCase(),
          );
          if (matchedCat) categoryId = matchedCat.id;
        }

        const newCarpet = await this.prisma.carpet.create({
          data: {
            uniqueCode: item.barcode,
            name: item.name,
            patternCode: item.designCode,
            designCode: item.designCode,
            productType: item.productType,
            shape: item.shape,
            type: item.type,
            price: item.pricePerM2,
            material: item.material,
            images,
            catalogDesignId,
            categoryId,
            isArchived: false,
          },
        });

        await this.prisma.inventoryItem.create({
          data: {
            carpetId: newCarpet.id,
            barcode: item.barcode,
            sku: `SKU-${item.barcode}`,
            size: `${item.widthCm}x${item.lengthCm}`,
            widthMm: item.widthMm,
            lengthMm: item.lengthMm,
            pricePerM2: item.pricePerM2,
            piecePrice: item.piecePrice,
            inventoryStatus: CarpetInventoryStatus.ACTIVE,
          },
        });

        if (item.productType === ProductType.METRAJ && item.availableLengthMeters != null) {
          await this.prisma.rollInventory.create({
            data: {
              carpetId: newCarpet.id,
              widthCm: item.widthCm,
              originalLengthCm: Math.round(item.availableLengthMeters * 100),
              currentLengthCm: Math.round(item.availableLengthMeters * 100),
              pricePerM2: item.pricePerM2,
            },
          });
        }

        newCount++;
      }
    }

    // 5. Safe Archive: Only archive DB products that were missing from this 100% verified dataset
    let archivedCount = 0;
    const itemsToArchive: string[] = [];

    for (const [barcode, invItem] of inventoryMap.entries()) {
      if (!incomingBarcodeSet.has(barcode) && invItem.inventoryStatus === CarpetInventoryStatus.ACTIVE) {
        itemsToArchive.push(invItem.id);
      }
    }

    if (itemsToArchive.length > 0) {
      await this.prisma.inventoryItem.updateMany({
        where: { id: { in: itemsToArchive } },
        data: { inventoryStatus: CarpetInventoryStatus.ARCHIVED },
      });
      archivedCount = itemsToArchive.length;
      this.logger.log(`📁 ${archivedCount} ta tovar muvaffaqiyatli arxivlandi (o'chirilmadi, rasm saqlangan).`);
    }

    const durationMs = Date.now() - startTime;
    const stats: BaskoSyncStats = {
      totalReceived: jobContext.rawCount,
      totalValidated: validItems.length,
      newProducts: newCount,
      updatedProducts: updatedCount,
      archivedProducts: archivedCount,
      unchangedProducts: unchangedCount,
      duplicateBarcodes: jobContext.duplicateCount,
      invalidRecords: jobContext.errors.length,
      missingImages: missingImagesCount,
      durationMs,
    };

    const syncResult: BaskoSyncResult = {
      jobId: jobContext.jobId,
      status: jobContext.errors.length === 0 ? 'SUCCESS' : 'PARTIAL',
      stats,
      errors: jobContext.errors,
      startedAt: jobContext.startedAt,
      finishedAt: new Date(),
      source: jobContext.source,
      fileName: jobContext.fileName,
    };

    // Save final audit record
    await this.syncLogService.completeSyncJob(syncResult);

    return syncResult;
  }
}
