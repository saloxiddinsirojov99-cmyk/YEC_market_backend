import { BadRequestException } from '@nestjs/common';
import { ProductType, Shape, CarpetType } from '@prisma/client';
import { CreateCarpetDto } from './dto/create-carpet.dto';

export function normalizeHeader(h: unknown): string {
  if (h === undefined || h === null) return '';
  if (typeof h !== 'string' && typeof h !== 'number' && typeof h !== 'boolean')
    return '';
  return String(h)
    .replace(
      /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b\u200c\u200d]/g,
      ' ',
    )
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function cleanHeaderForMatching(h: string): string {
  return h
    .replace(/\(.*\)/g, '') // remove everything in parentheses
    .replace(/[^a-z0-9а-яё]/g, '') // remove non-alphanumeric (including cyrillic)
    .trim();
}

export function getRowValueByAliases(
  row: Record<string, unknown>,
  aliases: string[],
): unknown {
  if (!row || typeof row !== 'object') return undefined;

  const normalizedAliases = aliases.map(normalizeHeader);
  // 1. Try exact normalized match first
  for (const key of Object.keys(row)) {
    const normKey = normalizeHeader(key);
    if (normalizedAliases.includes(normKey)) {
      return row[key];
    }
  }

  // 2. Try cleaned match second to handle suffixes/parentheses
  const cleanAliases = aliases.map((a) =>
    cleanHeaderForMatching(normalizeHeader(a)),
  );
  for (const key of Object.keys(row)) {
    const cleanKey = cleanHeaderForMatching(normalizeHeader(key));
    if (cleanAliases.includes(cleanKey)) {
      return row[key];
    }
  }

  return undefined;
}

export function parseProductName(name: string): {
  cleanName: string;
  weightKg: number | null;
  pileHeight: number | null;
} {
  let cleanName = String(name).trim();
  let weightKg: number | null = null;
  let pileHeight: number | null = null;

  if (cleanName.includes('_')) {
    const parts = cleanName.split('_');
    if (parts[0]) {
      cleanName = parts[0].trim();
    }
    if (parts[1]) {
      const wPart = parts[1].trim();
      const wMatch = wPart.match(/^(\d+)(?:gr|g)?$/i);
      if (wMatch) {
        weightKg = parseFloat(wMatch[1]) / 1000;
      }
    }
    if (parts[2]) {
      const pPart = parts[2].trim();
      const pMatch = pPart.match(/^(\d+)(?:mm)?$/i);
      if (pMatch) {
        pileHeight = parseInt(pMatch[1], 10);
      }
    }
  }

  return { cleanName, weightKg, pileHeight };
}

export function parseDimensions(
  width: unknown,
  length: unknown,
  isRoll = false,
): { widthMm: number; lengthMm: number } {
  const parseNum = (val: unknown): number => {
    if (val === undefined || val === null) return 0;
    if (typeof val !== 'string' && typeof val !== 'number') return 0;
    const cleanStr = String(val)
      .replace(
        /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b\u200c\u200d]/g,
        '',
      )
      .replace(/\s+/g, '')
      .replace(/,/g, '.');
    const parsed = parseFloat(cleanStr);
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const w = parseNum(width);
  const l = parseNum(length);

  const scaleValue = (val: number): number => {
    if (val <= 0) return 0;
    if (isRoll) {
      if (val < 100) {
        return val * 1000; // e.g. 5m -> 5000mm, 25m -> 25000mm
      } else {
        return val * 10; // e.g. 500cm -> 5000mm, 2500cm -> 25000mm
      }
    } else {
      if (val < 10) {
        return val * 1000; // e.g. 3.5m -> 3500mm, 8m -> 8000mm
      }
      if (val >= 10 && val < 100) {
        return val * 100; // e.g. 35dm -> 3500mm, 80dm -> 8000mm
      }
      if (val >= 100 && val < 1000) {
        return val * 10; // e.g. 350cm -> 3500mm, 800cm -> 8000mm
      }
      return val; // e.g. 3500mm -> 3500mm
    }
  };

  return { widthMm: scaleValue(w), lengthMm: scaleValue(l) };
}

export function normalizeEnums(appearance: string): {
  productType: ProductType;
  shape: Shape;
} {
  const norm = String(appearance).trim().toUpperCase();
  if (norm === 'W' || norm === 'S' || norm === 'METRAJ') {
    return { productType: ProductType.METRAJ, shape: Shape.RECTANGLE };
  }
  if (norm === 'R' || norm === 'READY') {
    return { productType: ProductType.READY, shape: Shape.RECTANGLE };
  }
  if (norm === 'O' || norm === 'M' || norm === 'OVAL') {
    return { productType: ProductType.READY, shape: Shape.OVAL };
  }
  if (norm === 'CIRCLE') {
    return { productType: ProductType.READY, shape: Shape.CIRCLE };
  }
  return { productType: ProductType.READY, shape: Shape.RECTANGLE };
}

export function buildCreateDto(row: Record<string, unknown>): CreateCarpetDto {
  const rawCode = getRowValueByAliases(row, [
    'коди',
    'code',
    'kodi',
    'kod',
    'artikul',
    'sku',
  ]);
  const rawName = getRowValueByAliases(row, [
    'махсулот номи',
    'product name',
    'mahsulot nomi',
    'nomi',
    'name',
    'наименование',
  ]);
  const rawDesignCode = getRowValueByAliases(row, [
    'дизайн коди',
    'design code',
    'dizayn kodi',
    'designcode',
    'dizayn',
    'рисунок',
  ]);
  const rawWidth = getRowValueByAliases(row, [
    'эni',
    'эni',
    'эни',
    'eni',
    'width',
    'widthmm',
    'kenglik',
    'kengligi',
    'ширина',
  ]);
  const rawLength = getRowValueByAliases(row, [
    'бўйи',
    'буйи',
    'boyi',
    'length',
    'lengthmm',
    'uzunlik',
    'uzunligi',
    'длина',
  ]);
  const rawAppearance = getRowValueByAliases(row, [
    'куриниши',
    'appearance',
    'turi',
    'korinishi',
    'вид',
    'type',
    'тип',
  ]);
  const rawDonabay = getRowValueByAliases(row, [
    'донабай',
    'donabay',
    'pieceprice',
    'price',
    'narxi',
    'narx',
    'цена',
  ]);

  const code =
    typeof rawCode === 'string' || typeof rawCode === 'number'
      ? String(rawCode).trim()
      : '';
  const name =
    typeof rawName === 'string' || typeof rawName === 'number'
      ? String(rawName).trim()
      : '';
  const designCode =
    typeof rawDesignCode === 'string' || typeof rawDesignCode === 'number'
      ? String(rawDesignCode).trim()
      : '';
  const appearance =
    typeof rawAppearance === 'string' || typeof rawAppearance === 'number'
      ? String(rawAppearance).trim()
      : '';

  if (!code) throw new BadRequestException("Kodi bo'sh bo'lishi mumkin emas.");
  if (!name) throw new BadRequestException("Nomi bo'sh bo'lishi mumkin emas.");
  if (!designCode)
    throw new BadRequestException(
      "Gul/dizayn kodi bo'sh bo'lishi mumkin emas.",
    );
  if (!appearance)
    throw new BadRequestException("Ko'rinishi bo'sh bo'lishi mumkin emas.");

  const { cleanName, weightKg, pileHeight } = parseProductName(name);
  const { productType, shape } = normalizeEnums(appearance);
  const isRoll = productType === ProductType.METRAJ;
  const { widthMm, lengthMm } = parseDimensions(rawWidth, rawLength, isRoll);

  if (widthMm <= 0)
    throw new BadRequestException("Eni 0 dan katta bo'lishi shart.");
  if (lengthMm <= 0)
    throw new BadRequestException("Bo'yi 0 dan katta bo'lishi shart.");

  let piecePrice = 0;
  if (typeof rawDonabay === 'number') {
    piecePrice = rawDonabay;
  } else if (typeof rawDonabay === 'string') {
    let cleanStr = rawDonabay
      .replace(
        /[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b\u200c\u200d]/g,
        '',
      )
      .replace(/\s+/g, '')
      .toLowerCase();

    // Clean currency suffixes and non-numeric characters
    cleanStr = cleanStr
      .replace(/so['`‘]m/g, '')
      .replace(/som/g, '')
      .replace(/сўм/g, '')
      .replace(/сум/g, '')
      .replace(/[^0-9.,-]/g, '')
      .replace(/,/g, '.');

    piecePrice = parseFloat(cleanStr);
  }

  // Do not throw on invalid/missing price during excel map phase, set to 0
  if (isNaN(piecePrice) || piecePrice < 0) {
    piecePrice = 0;
  }

  const dto = new CreateCarpetDto();
  dto.barcode = code;
  dto.name = cleanName;
  dto.patternCode = designCode;
  dto.designCode = designCode;
  dto.productType = productType;
  dto.shape = shape;
  dto.widthMm = widthMm;
  dto.lengthMm = lengthMm;
  dto.price = productType === ProductType.METRAJ ? 0 : piecePrice;
  dto.stock = 1;
  dto.type =
    productType === ProductType.METRAJ ? CarpetType.ROLL : CarpetType.READY;
  dto.size =
    productType === ProductType.METRAJ
      ? 'ROLL'
      : `${widthMm / 10}x${lengthMm / 10}`;
  dto.weightKg = weightKg !== null ? weightKg : undefined;
  dto.pileHeight = pileHeight !== null ? pileHeight : undefined;

  return dto;
}
