import { Injectable, Logger } from '@nestjs/common';

export interface ParsedDimensionResult {
  success: boolean;
  widthCm?: number;
  lengthCm?: number;
  widthMeters?: number;
  lengthMeters?: number;
  areaSquareMeters?: number;
  displayMeters?: string; // e.g. "4 × 6,11 m"
  displayCm?: string;     // e.g. "400 × 611 cm"
  reason?: 'EMPTY' | 'AMBIGUOUS' | 'OUT_OF_BOUNDS' | 'INVALID_CHARACTERS';
  message?: string;
}

@Injectable()
export class DimensionParserService {
  private readonly logger = new Logger(DimensionParserService.name);

  // Minimum and maximum reasonable carpet dimensions in centimeters
  private readonly MIN_DIMENSION_CM = 40;     // 40 cm
  private readonly MAX_DIMENSION_CM = 5000;   // 50 meters (5000 cm)

  /**
   * Normalizes flexible user dimension inputs (e.g. "4x6.11", "4 6,11", "400 611", "611x4", "2x3", "200x300", "5 5")
   * into standardized centimeters, meters, area, and human-readable Uzbek format.
   */
  parse(input: string | null | undefined): ParsedDimensionResult {
    if (!input || !input.trim()) {
      return {
        success: false,
        reason: 'EMPTY',
        message: "O‘lcham kiritilmadi. Iltimos, masalan '4x6.11' yoki '2x3' ko‘rinishida kiriting.",
      };
    }

    let clean = input
      .trim()
      .toLowerCase()
      // Replace non-breaking spaces and unicode spaces
      .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b\u200c\u200d]/g, ' ')
      // Standardize multiplication characters (x, X, ×, *, .)
      .replace(/[xX\u00d7*]/g, ' ')
      // Remove trailing unit words if standalone
      .replace(/\s+/g, ' ')
      .trim();

    // Check for suspicious characters (not numbers, dots, commas, spaces, or valid units m/cm/mm)
    if (/[^0-9.,\s(cm)(mm)m]/.test(clean)) {
      return {
        success: false,
        reason: 'INVALID_CHARACTERS',
        message: "O‘lchamda noto‘g‘ri belgilar mavjud. Faqat raqamlar va o‘lchamlarni kiriting (masalan: 4x6.11).",
      };
    }

    // Split by whitespace
    const tokens = clean.split(/\s+/).filter(Boolean);

    if (tokens.length !== 2) {
      return {
        success: false,
        reason: 'AMBIGUOUS',
        message:
          "O‘lcham noaniq kiritildi. Ikkita o‘lchamni (en va bo‘y) kiriting, masalan: '4x6.11' yoki '200x300'.",
      };
    }

    const d1 = this.parseTokenToCm(tokens[0]);
    const d2 = this.parseTokenToCm(tokens[1]);

    if (d1 === null || d2 === null || isNaN(d1) || isNaN(d2)) {
      return {
        success: false,
        reason: 'AMBIGUOUS',
        message: "O‘lchamlarni aniqlab bo‘lmadi. Iltimos, qiymatlarni to‘g‘ri kiriting (masalan: 4x6.11).",
      };
    }

    if (d1 <= 0 || d2 <= 0) {
      return {
        success: false,
        reason: 'OUT_OF_BOUNDS',
        message: "O‘lcham noldan katta bo‘lishi shart.",
      };
    }

    if (
      d1 < this.MIN_DIMENSION_CM ||
      d1 > this.MAX_DIMENSION_CM ||
      d2 < this.MIN_DIMENSION_CM ||
      d2 > this.MAX_DIMENSION_CM
    ) {
      return {
        success: false,
        reason: 'OUT_OF_BOUNDS',
        message: `O‘lcham noto‘g‘ri kiritildi. Eni va bo‘yi ${this.MIN_DIMENSION_CM} sm dan ${this.MAX_DIMENSION_CM / 100} metrgacha bo‘lishi kerak.`,
      };
    }

    // Standardize orientation: width is the smaller dimension, length is the larger dimension
    const widthCm = Math.min(d1, d2);
    const lengthCm = Math.max(d1, d2);

    const widthMeters = parseFloat((widthCm / 100).toFixed(4));
    const lengthMeters = parseFloat((lengthCm / 100).toFixed(4));
    const areaSquareMeters = parseFloat(((widthCm * lengthCm) / 10000).toFixed(4));

    // Format display string with Uzbek decimal comma (e.g. "4 × 6,11 m")
    const formatMeterNumber = (m: number): string => {
      // If integer like 4 -> "4", if decimal like 6.11 -> "6,11"
      return m.toString().replace('.', ',');
    };

    const displayMeters = `${formatMeterNumber(widthMeters)} × ${formatMeterNumber(lengthMeters)} m`;
    const displayCm = `${widthCm} × ${lengthCm} cm`;

    return {
      success: true,
      widthCm,
      lengthCm,
      widthMeters,
      lengthMeters,
      areaSquareMeters,
      displayMeters,
      displayCm,
    };
  }

  /**
   * Converts a single raw dimension token (e.g. "4", "6.11", "6,11", "400", "611cm", "4m") to centimeters.
   */
  private parseTokenToCm(token: string): number | null {
    let t = token.trim();
    if (!t) return null;

    let explicitUnit: 'm' | 'cm' | 'mm' | null = null;

    if (t.endsWith('mm')) {
      explicitUnit = 'mm';
      t = t.slice(0, -2);
    } else if (t.endsWith('cm')) {
      explicitUnit = 'cm';
      t = t.slice(0, -2);
    } else if (t.endsWith('m')) {
      explicitUnit = 'm';
      t = t.slice(0, -1);
    }

    // Replace decimal comma with dot
    t = t.replace(',', '.');
    const val = parseFloat(t);

    if (isNaN(val) || !Number.isFinite(val)) {
      return null;
    }

    // 1. Explicit unit handling
    if (explicitUnit === 'm') {
      return Math.round(val * 100);
    }
    if (explicitUnit === 'cm') {
      return Math.round(val);
    }
    if (explicitUnit === 'mm') {
      return Math.round(val / 10);
    }

    // 2. Inferred unit handling:
    // If it contains a decimal point (e.g. 6.11, 3.5, 2.0) -> meters
    if (t.includes('.')) {
      return Math.round(val * 100);
    }

    // If small integer <= 15 (e.g. 2, 3, 4, 5, 6, 7, 8, 9, 10, 12) -> meters!
    if (val <= 15) {
      return Math.round(val * 100);
    }

    // If integer between 16 and 49 -> ambiguous/invalid (e.g. 25 meters or 25 cm?)
    // In carpet domain: sizes are either meters (2, 3, 4, 5) or cm (150, 200, 300, 400).
    if (val > 15 && val < 50) {
      // 20, 25, 30 could be meters for metraj roll length, or cm
      // But for customer search, a 25cm carpet is smaller than MIN_DIMENSION_CM (40cm).
      // So if val >= 40, treat as cm:
      if (val >= 40) return Math.round(val);
      return null;
    }

    // If integer between 50 and 1500 (e.g. 80, 120, 150, 200, 300, 400, 611) -> centimeters
    if (val >= 50 && val <= 1500) {
      return Math.round(val);
    }

    // If integer > 1500 (e.g. 2000, 3000, 4000) -> millimeters
    if (val > 1500) {
      return Math.round(val / 10);
    }

    return Math.round(val);
  }
}
