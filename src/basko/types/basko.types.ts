import { ProductType, Shape, CarpetType, CarpetInventoryStatus } from '@prisma/client';

export interface BaskoRawProduct {
  __rowNum__?: number;
  barcode?: string | number | null;
  code?: string | number | null;
  name?: string | null;
  designCode?: string | null;
  width?: string | number | null;
  length?: string | number | null;
  appearance?: string | null; // e.g. 'W', 'S', 'METRAJ', 'R', 'READY', 'O', 'M', 'OVAL', 'CIRCLE'
  pricePerM2?: string | number | null;
  piecePrice?: string | number | null;
  material?: string | null;
  yarnType?: string | null;
  color?: string | null;
  stock?: string | number | null;
  remainingLengthMeters?: string | number | null;
  brand?: string | null;
  category?: string | null;
  [key: string]: any;
}

export interface BaskoNormalizedProduct {
  barcode: string; // Preserves leading zeros, e.g. "00123456"
  baskoProductId?: string;
  name: string;
  cleanName: string;
  designCode: string;
  productType: ProductType;
  shape: Shape;
  type: CarpetType;
  widthCm: number;
  lengthCm: number;
  widthMm: number;
  lengthMm: number;
  areaM2: number;
  pricePerM2: number;
  piecePrice: number | null;
  material: string; // Raw fiber, e.g. 'Akril', 'Polyester', 'Jun'
  yarnType: string | null; // e.g. 'Heatset', 'Frize', 'BCF'
  color: string | null;
  stockQuantity: number;
  availableLengthMeters: number | null; // For METRAJ rolls
  brand: string | null;
  categorySuggestion: string | null;
  sourceRow?: number;
}

export interface BaskoValidationError {
  row: number;
  barcode?: string;
  field: string;
  reason: string;
  originalValue?: any;
}

export interface BaskoSyncStats {
  totalReceived: number;
  totalValidated: number;
  newProducts: number;
  updatedProducts: number;
  archivedProducts: number;
  unchangedProducts: number;
  duplicateBarcodes: number;
  invalidRecords: number;
  missingImages: number;
  durationMs: number;
}

export interface BaskoSyncResult {
  jobId: string;
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  stats: BaskoSyncStats;
  errors: BaskoValidationError[];
  startedAt: Date;
  finishedAt: Date;
  source: 'EXCEL' | 'API';
  fileName?: string;
}
