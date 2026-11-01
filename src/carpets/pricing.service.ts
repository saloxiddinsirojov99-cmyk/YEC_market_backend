import { Injectable, Logger } from '@nestjs/common';

export interface PriceCalculationResult {
  widthMeters: number;
  lengthMeters: number;
  areaSquareMeters: number;
  pricePerM2: number;
  totalPriceUzs: number;
  formattedTotalPrice: string; // e.g. "2 444 000 so‘m"
  formattedPricePerM2: string; // e.g. "100 000 so‘m"
  breakdown: string;
}

@Injectable()
export class PricingService {
  private readonly logger = new Logger(PricingService.name);

  /**
   * Calculates metraj carpet total price using actual cut dimensions.
   * Strictly prevents floating-point monetary errors.
   * Formula:
   *   Area = widthMeters * lengthMeters
   *   Total = Math.round(Area * pricePerM2)
   */
  calculateMetrajPrice(
    widthMeters: number,
    lengthMeters: number,
    pricePerM2: number,
  ): PriceCalculationResult {
    // 1. Precise area with 4 decimal places
    const areaSquareMeters = parseFloat((widthMeters * lengthMeters).toFixed(4));

    // 2. Exact integer UZS arithmetic (rounds to nearest integer so'm)
    const totalPriceUzs = Math.round(areaSquareMeters * pricePerM2);

    const formattedTotalPrice = this.formatUzbekCurrency(totalPriceUzs);
    const formattedPricePerM2 = this.formatUzbekCurrency(pricePerM2);

    const breakdown = `${widthMeters} × ${lengthMeters} m = ${areaSquareMeters} m² × ${formattedPricePerM2} = ${formattedTotalPrice}`;

    return {
      widthMeters,
      lengthMeters,
      areaSquareMeters,
      pricePerM2,
      totalPriceUzs,
      formattedTotalPrice,
      formattedPricePerM2,
      breakdown,
    };
  }

  /**
   * Calculates ready-made carpet price based on official product pricing.
   * If fixed piecePrice is provided, piecePrice takes precedence.
   * Otherwise, calculates area * pricePerM2.
   */
  calculateReadyCarpetPrice(params: {
    piecePrice?: number | null;
    widthMeters?: number;
    lengthMeters?: number;
    pricePerM2?: number;
  }): {
    totalPriceUzs: number;
    formattedTotalPrice: string;
    isFixedPiecePrice: boolean;
  } {
    if (params.piecePrice && params.piecePrice > 0) {
      const fixed = Math.round(params.piecePrice);
      return {
        totalPriceUzs: fixed,
        formattedTotalPrice: this.formatUzbekCurrency(fixed),
        isFixedPiecePrice: true,
      };
    }

    const w = params.widthMeters || 0;
    const l = params.lengthMeters || 0;
    const rate = params.pricePerM2 || 0;

    const area = parseFloat((w * l).toFixed(4));
    const total = Math.round(area * rate);

    return {
      totalPriceUzs: total,
      formattedTotalPrice: this.formatUzbekCurrency(total),
      isFixedPiecePrice: false,
    };
  }

  /**
   * Calculates oval carpet price.
   * In YEC, oval carpets have direct piece prices or are calculated by pricing rule.
   * Never forces rectangular calculation unless explicitly designated.
   */
  calculateOvalPrice(params: {
    piecePrice?: number | null;
    widthMeters?: number;
    lengthMeters?: number;
    pricePerM2?: number;
    useTrueEllipseFormula?: boolean;
  }): {
    totalPriceUzs: number;
    formattedTotalPrice: string;
    areaSquareMeters: number;
  } {
    if (params.piecePrice && params.piecePrice > 0) {
      const fixed = Math.round(params.piecePrice);
      const w = params.widthMeters || 0;
      const l = params.lengthMeters || 0;
      const area = parseFloat((w * l).toFixed(4));

      return {
        totalPriceUzs: fixed,
        formattedTotalPrice: this.formatUzbekCurrency(fixed),
        areaSquareMeters: area,
      };
    }

    const w = params.widthMeters || 0;
    const l = params.lengthMeters || 0;
    const rate = params.pricePerM2 || 0;

    let area = 0;
    if (params.useTrueEllipseFormula) {
      // Area of ellipse = π * (W/2) * (L/2) = (π / 4) * W * L
      area = parseFloat(((Math.PI / 4) * w * l).toFixed(4));
    } else {
      area = parseFloat((w * l).toFixed(4));
    }

    const total = Math.round(area * rate);
    return {
      totalPriceUzs: total,
      formattedTotalPrice: this.formatUzbekCurrency(total),
      areaSquareMeters: area,
    };
  }

  /**
   * Formats an integer number with spaces as Uzbek currency:
   * e.g. 2444000 -> "2 444 000 so‘m"
   */
  formatUzbekCurrency(amount: number): string {
    if (isNaN(amount) || amount === null || amount === undefined) {
      return "0 so‘m";
    }
    const cleanInt = Math.round(amount);
    const withSpaces = cleanInt.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${withSpaces} so‘m`;
  }
}
