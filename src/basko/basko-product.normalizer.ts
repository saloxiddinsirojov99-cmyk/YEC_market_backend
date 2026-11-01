import { Injectable, Logger } from '@nestjs/common';
import { ProductType, Shape, CarpetType } from '@prisma/client';
import {
  BaskoRawProduct,
  BaskoNormalizedProduct,
  BaskoValidationError,
} from './types/basko.types';

@Injectable()
export class BaskoProductNormalizer {
  private readonly logger = new Logger(BaskoProductNormalizer.name);

  // Known yarn processing technologies (not raw fiber)
  private readonly YARN_TECHNOLOGIES = [
    'heatset',
    'frize',
    'frise',
    'bcf',
    'shaggy',
    'relyef',
    'carving',
    'chenille',
    'shenill',
    'boucle',
    'bukle',
  ];

  // Known raw fiber materials
  private readonly RAW_FIBERS = [
    'akril',
    'acrylic',
    'polyester',
    'poliester',
    'polister',
    'mikropoliester',
    'mikropolister',
    'micro-polyester',
    'polipropilen',
    'polypropylene',
    'jun',
    'wool',
    'paxta',
    'cotton',
    'ipak',
    'silk',
    'viskoza',
    'viscose',
    'bambuk',
    'bamboo',
  ];

  /**
   * Normalizes barcode string while strictly preserving leading zeros.
   * Returns empty string if invalid or empty.
   */
  normalizeBarcode(val: unknown): string {
    if (val === undefined || val === null) return '';
    let str = String(val).trim();
    // Remove invisible characters, zero-width spaces, and control characters
    str = str.replace(/[\u200B-\u200D\uFEFF]/g, '').trim();

    // Check if it's scientific notation (e.g. 1.23E+07) - dangerous!
    if (/e\+/i.test(str)) {
      throw new Error(`Xato shtrix-kod: Ilmiy formatdagi qiymat (${str}) aniqlandi. Raqamga o'girishda nollar yo'qolgan bo'lishi mumkin.`);
    }

    return str;
  }

  /**
   * Normalizes and separates raw material (fiber) and yarn processing technology.
   * e.g. "Akril Heatset" -> material: "Akril", yarnType: "Heatset"
   * e.g. "Heatset" -> material: "Polipropilen", yarnType: "Heatset"
   */
  separateMaterialAndYarn(rawMaterial: string | null | undefined): {
    material: string;
    yarnType: string | null;
  } {
    if (!rawMaterial) {
      return { material: '', yarnType: null };
    }

    const trimmed = rawMaterial.trim();
    const lower = trimmed.toLowerCase();

    let detectedYarnType: string | null = null;
    let cleanMaterial = trimmed;

    // Check for yarn technologies in string
    for (const tech of this.YARN_TECHNOLOGIES) {
      const regex = new RegExp(`\\b${tech}\\b`, 'i');
      if (regex.test(lower)) {
        detectedYarnType = tech.charAt(0).toUpperCase() + tech.slice(1);
        cleanMaterial = cleanMaterial.replace(regex, '').replace(/[\s\-_]+/g, ' ').trim();
      }
    }

    // Capitalize remaining material
    if (!cleanMaterial && detectedYarnType) {
      cleanMaterial = 'Polipropilen'; // Default raw fiber for Heatset/BCF/Frize
    } else if (cleanMaterial) {
      cleanMaterial = cleanMaterial.charAt(0).toUpperCase() + cleanMaterial.slice(1);
    }

    return {
      material: cleanMaterial,
      yarnType: detectedYarnType,
    };
  }

  /**
   * Normalizes appearance/type to Prisma ProductType and Shape.
   */
  normalizeAppearance(appearance: string | null | undefined): {
    productType: ProductType;
    shape: Shape;
    type: CarpetType;
  } {
    const raw = String(appearance || '').trim().toUpperCase();

    if (raw === 'W' || raw === 'S' || raw === 'METRAJ' || raw === 'ROLL') {
      return {
        productType: ProductType.METRAJ,
        shape: Shape.RECTANGLE,
        type: CarpetType.ROLL,
      };
    }

    if (raw === 'O' || raw === 'M' || raw === 'OVAL') {
      return {
        productType: ProductType.READY,
        shape: Shape.OVAL,
        type: CarpetType.READY,
      };
    }

    if (raw === 'CIRCLE' || raw === 'DUMALOQ') {
      return {
        productType: ProductType.READY,
        shape: Shape.CIRCLE,
        type: CarpetType.READY,
      };
    }

    if (raw === 'RUNNER' || raw === 'DOROZHKA') {
      return {
        productType: ProductType.RUNNER,
        shape: Shape.RECTANGLE,
        type: CarpetType.READY,
      };
    }

    // Default: READY RECTANGLE
    return {
      productType: ProductType.READY,
      shape: Shape.RECTANGLE,
      type: CarpetType.READY,
    };
  }

  /**
   * Normalizes dimensions to millimeters and centimeters.
   */
  normalizeDimensions(
    rawWidth: unknown,
    rawLength: unknown,
    isMetraj = false,
  ): {
    widthMm: number;
    lengthMm: number;
    widthCm: number;
    lengthCm: number;
    areaM2: number;
  } {
    const parseNumber = (val: unknown): number => {
      if (val === undefined || val === null) return 0;
      const str = String(val)
        .replace(/[\s\u00a0]/g, '')
        .replace(/,/g, '.');
      const num = parseFloat(str);
      return Number.isFinite(num) ? num : 0;
    };

    let w = parseNumber(rawWidth);
    let l = parseNumber(rawLength);

    // Convert to mm
    const toMm = (val: number, isRollLength = false): number => {
      if (val <= 0) return 0;
      if (isRollLength) {
        return val < 100 ? Math.round(val * 1000) : Math.round(val * 10);
      }
      if (val < 10) return Math.round(val * 1000); // 2 -> 2000mm, 3.5 -> 3500mm
      if (val < 100) return Math.round(val * 100);  // 35dm -> 3500mm
      if (val < 1000) return Math.round(val * 10);  // 350cm -> 3500mm
      return Math.round(val);
    };

    const widthMm = toMm(w);
    const lengthMm = toMm(l, isMetraj);

    const widthCm = Math.round(widthMm / 10);
    const lengthCm = Math.round(lengthMm / 10);
    const areaM2 = parseFloat(((widthMm * lengthMm) / 1_000_000).toFixed(4));

    return {
      widthMm,
      lengthMm,
      widthCm,
      lengthCm,
      areaM2,
    };
  }

  /**
   * Normalizes an entire batch of raw BASKO products, detecting duplicates
   * and generating structured validation errors.
   */
  normalizeBatch(rawItems: BaskoRawProduct[]): {
    valid: BaskoNormalizedProduct[];
    errors: BaskoValidationError[];
    duplicateBarcodesCount: number;
  } {
    const valid: BaskoNormalizedProduct[] = [];
    const errors: BaskoValidationError[] = [];
    const seenBarcodes = new Set<string>();
    let duplicateBarcodesCount = 0;

    for (let i = 0; i < rawItems.length; i++) {
      const item = rawItems[i];
      const rowNum = item.__rowNum__ ?? (i + 1);

      let barcode = '';
      try {
        barcode = this.normalizeBarcode(item.barcode ?? item.code);
      } catch (err: any) {
        errors.push({
          row: rowNum,
          field: 'barcode',
          reason: err.message || 'Shtrix-kod o\'qishda xatolik',
          originalValue: item.barcode ?? item.code,
        });
        continue;
      }

      if (!barcode) {
        errors.push({
          row: rowNum,
          field: 'barcode',
          reason: 'Shtrix-kod (barcode) bo\'sh bo\'lishi mumkin emas',
          originalValue: null,
        });
        continue;
      }

      // Check for duplicate barcode within current batch
      if (seenBarcodes.has(barcode)) {
        duplicateBarcodesCount++;
        errors.push({
          row: rowNum,
          barcode,
          field: 'barcode',
          reason: `Faylda takrorlangan shtrix-kod: "${barcode}". Takrorlangan yozuv xavfsizlik maqsadida chetlatildi.`,
          originalValue: barcode,
        });
        continue;
      }
      seenBarcodes.add(barcode);

      const name = String(item.name || '').trim();
      if (!name) {
        errors.push({
          row: rowNum,
          barcode,
          field: 'name',
          reason: 'Mahsulot nomi bo\'sh bo\'lishi mumkin emas',
          originalValue: item.name,
        });
        continue;
      }

      const designCode = String(item.designCode || item.patternCode || '').trim();
      if (!designCode) {
        errors.push({
          row: rowNum,
          barcode,
          field: 'designCode',
          reason: 'Dizayn/gul kodi bo\'sh bo\'lishi mumkin emas',
          originalValue: item.designCode,
        });
        continue;
      }

      const { productType, shape, type } = this.normalizeAppearance(item.appearance);
      const isMetraj = productType === ProductType.METRAJ;
      const dims = this.normalizeDimensions(item.width, item.length, isMetraj);

      if (dims.widthMm <= 0 || dims.lengthMm <= 0) {
        errors.push({
          row: rowNum,
          barcode,
          field: 'dimensions',
          reason: `O'lchamlar noto'g'ri (en: ${item.width}, bo'y: ${item.length})`,
          originalValue: { width: item.width, length: item.length },
        });
        continue;
      }

      const { material, yarnType } = this.separateMaterialAndYarn(item.material);

      const pricePerM2 = typeof item.pricePerM2 === 'number'
        ? item.pricePerM2
        : parseFloat(String(item.pricePerM2 || '0').replace(/[\s,]/g, '')) || 0;

      const piecePrice = item.piecePrice
        ? parseFloat(String(item.piecePrice).replace(/[\s,]/g, '')) || null
        : null;

      const stockQuantity = parseInt(String(item.stock ?? 1), 10) || 0;
      const availableLengthMeters = isMetraj ? dims.lengthMm / 1000 : null;

      valid.push({
        barcode,
        baskoProductId: item.baskoProductId ? String(item.baskoProductId).trim() : undefined,
        name,
        cleanName: name.split('_')[0].trim(),
        designCode,
        productType,
        shape,
        type,
        widthCm: dims.widthCm,
        lengthCm: dims.lengthCm,
        widthMm: dims.widthMm,
        lengthMm: dims.lengthMm,
        areaM2: dims.areaM2,
        pricePerM2,
        piecePrice,
        material,
        yarnType: item.yarnType ? String(item.yarnType).trim() : yarnType,
        color: item.color ? String(item.color).trim() : null,
        stockQuantity,
        availableLengthMeters,
        brand: item.brand ? String(item.brand).trim() : null,
        categorySuggestion: item.category ? String(item.category).trim() : null,
        sourceRow: rowNum,
      });
    }

    return {
      valid,
      errors,
      duplicateBarcodesCount,
    };
  }
}
