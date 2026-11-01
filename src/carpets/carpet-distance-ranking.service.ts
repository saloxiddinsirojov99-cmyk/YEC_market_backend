import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProductType, Shape, CarpetInventoryStatus } from '@prisma/client';

export interface RankedCarpetCandidate {
  carpetId: string;
  uniqueCode: string;
  name: string;
  patternCode: string;
  widthCm: number;
  lengthCm: number;
  distanceCm: number;
  shape: Shape;
  productType: ProductType;
  price: number;
  stock: number;
  images: string[];
  isExactMatch: boolean;
  orientation: 'NORMAL' | 'ROTATED';
}

export interface MetrajSearchCandidate {
  carpetId: string;
  uniqueCode: string;
  name: string;
  patternCode: string;
  rollInventoryId: string;
  rollWidthCm: number;
  currentLengthCm: number;
  reservedLengthCm: number;
  effectiveAvailableLengthCm: number;
  effectiveAvailableLengthMeters: number;
  pricePerM2: number;
  images: string[];
}

export interface CarpetSearchResultFlow {
  stage: 'METRAJ_EXACT' | 'READY_CLOSEST' | 'OVAL_CLOSEST' | 'NOT_FOUND';
  queryWidthCm: number;
  queryLengthCm: number;
  displayMeters: string;
  results: RankedCarpetCandidate[];
  metrajResults?: MetrajSearchCandidate[];
  message?: string;
}

@Injectable()
export class CarpetDistanceRankingService {
  private readonly logger = new Logger(CarpetDistanceRankingService.name);

  // Maximum allowed dimension deviation in cm to consider a ready carpet "close"
  // Default: 120 cm (e.g. if customer wants 4x6.66m, 4x6m (66cm diff) is ok, but 3x4m (266cm diff) is too far!)
  private readonly MAX_ALLOWED_DISTANCE_CM = 120;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Calculates the Euclidean distance between candidate dimensions and target dimensions in centimeters.
   * Checks both normal and rotated orientations:
   *   D1 = sqrt((W_cand - W_target)^2 + (L_cand - L_target)^2)
   *   D2 = sqrt((L_cand - W_target)^2 + (W_cand - L_target)^2)
   * Returns minimum distance and optimal orientation.
   */
  calculateDistance(
    targetW: number,
    targetL: number,
    candW: number,
    candL: number,
  ): { distanceCm: number; orientation: 'NORMAL' | 'ROTATED' } {
    const d1 = Math.sqrt(
      Math.pow(candW - targetW, 2) + Math.pow(candL - targetL, 2),
    );
    const d2 = Math.sqrt(
      Math.pow(candL - targetW, 2) + Math.pow(candW - targetL, 2),
    );

    if (d1 <= d2) {
      return {
        distanceCm: parseFloat(d1.toFixed(2)),
        orientation: 'NORMAL',
      };
    } else {
      return {
        distanceCm: parseFloat(d2.toFixed(2)),
        orientation: 'ROTATED',
      };
    }
  }

  /**
   * Ranks candidate products by Euclidean distance to target dimensions.
   * Filters out candidates exceeding the maximum allowed distance threshold.
   * Tie-breaker: distance asc, price asc, stock desc, ID asc.
   */
  rankCandidates(
    targetW: number,
    targetL: number,
    candidates: {
      carpetId: string;
      uniqueCode: string;
      name: string;
      patternCode: string;
      widthCm: number;
      lengthCm: number;
      shape: Shape;
      productType: ProductType;
      price: number;
      stock: number;
      images: string[];
    }[],
    maxDistanceCm = this.MAX_ALLOWED_DISTANCE_CM,
  ): RankedCarpetCandidate[] {
    const ranked: RankedCarpetCandidate[] = [];

    for (const c of candidates) {
      const { distanceCm, orientation } = this.calculateDistance(
        targetW,
        targetL,
        c.widthCm,
        c.lengthCm,
      );

      if (distanceCm <= maxDistanceCm) {
        ranked.push({
          ...c,
          distanceCm,
          orientation,
          isExactMatch: distanceCm === 0,
        });
      }
    }

    // Deterministic sorting
    ranked.sort((a, b) => {
      if (a.distanceCm !== b.distanceCm) return a.distanceCm - b.distanceCm;
      if (a.price !== b.price) return a.price - b.price;
      if (a.stock !== b.stock) return b.stock - a.stock;
      return a.carpetId.localeCompare(b.carpetId);
    });

    return ranked;
  }

  /**
   * Searches metraj rolls that can fulfill the requested cut dimensions.
   * Condition:
   *   - Roll width must match requested width (e.g. 400cm).
   *   - Available cut length (currentLengthCm - reservedLengthCm) >= requested lengthCm.
   *   - NEVER automatically substitutes a 5m width roll for a 4m request.
   */
  async searchMetrajRolls(
    widthCm: number,
    cutLengthCm: number,
  ): Promise<MetrajSearchCandidate[]> {
    // 1. Find all active roll inventories where roll width equals requested width
    const rolls = await this.prisma.rollInventory.findMany({
      where: {
        widthCm: widthCm,
        carpet: {
          isArchived: false,
          productType: ProductType.METRAJ,
        },
      },
      include: {
        carpet: {
          select: {
            id: true,
            uniqueCode: true,
            name: true,
            patternCode: true,
            images: true,
          },
        },
      },
    });

    const matching: MetrajSearchCandidate[] = [];

    for (const roll of rolls) {
      const effectiveAvailableLengthCm =
        roll.currentLengthCm - roll.reservedLengthCm;

      // Condition: roll must have sufficient remaining length to satisfy the cut
      if (effectiveAvailableLengthCm >= cutLengthCm) {
        matching.push({
          carpetId: roll.carpetId,
          uniqueCode: roll.carpet.uniqueCode,
          name: roll.carpet.name,
          patternCode: roll.carpet.patternCode,
          rollInventoryId: roll.id,
          rollWidthCm: roll.widthCm,
          currentLengthCm: roll.currentLengthCm,
          reservedLengthCm: roll.reservedLengthCm,
          effectiveAvailableLengthCm,
          effectiveAvailableLengthMeters: parseFloat(
            (effectiveAvailableLengthCm / 100).toFixed(2),
          ),
          pricePerM2: Number(roll.pricePerM2),
          images: roll.carpet.images || [],
        });
      }
    }

    // Sort by price asc, then available length desc
    matching.sort((a, b) => {
      if (a.pricePerM2 !== b.pricePerM2) return a.pricePerM2 - b.pricePerM2;
      return b.effectiveAvailableLengthCm - a.effectiveAvailableLengthCm;
    });

    return matching;
  }

  /**
   * Finds closest ready-made carpets ranked by Euclidean distance.
   */
  async findClosestReadyCarpets(
    widthCm: number,
    lengthCm: number,
    maxDistanceCm = this.MAX_ALLOWED_DISTANCE_CM,
  ): Promise<RankedCarpetCandidate[]> {
    const readyCarpets = await this.prisma.inventoryItem.findMany({
      where: {
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
        carpet: {
          isArchived: false,
          shape: Shape.RECTANGLE,
          productType: { not: ProductType.METRAJ },
        },
      },
      include: {
        carpet: {
          select: {
            id: true,
            uniqueCode: true,
            name: true,
            patternCode: true,
            shape: true,
            productType: true,
            price: true,
            images: true,
          },
        },
      },
    });

    const readyCandidates = readyCarpets.map((item) => ({
      carpetId: item.carpet.id,
      uniqueCode: item.barcode,
      name: item.carpet.name,
      patternCode: item.carpet.patternCode,
      widthCm: Math.round(item.widthMm / 10),
      lengthCm: Math.round(item.lengthMm / 10),
      shape: item.carpet.shape,
      productType: item.carpet.productType,
      price: Number(item.pricePerM2 || item.carpet.price),
      stock: 1,
      images: item.carpet.images || [],
    }));

    return this.rankCandidates(widthCm, lengthCm, readyCandidates, maxDistanceCm);
  }

  /**
   * Finds closest oval carpets ranked by Euclidean distance.
   */
  async findClosestOvalCarpets(
    widthCm: number,
    lengthCm: number,
    maxDistanceCm = this.MAX_ALLOWED_DISTANCE_CM,
  ): Promise<RankedCarpetCandidate[]> {
    const ovalCarpets = await this.prisma.inventoryItem.findMany({
      where: {
        inventoryStatus: CarpetInventoryStatus.ACTIVE,
        carpet: {
          isArchived: false,
          shape: Shape.OVAL,
        },
      },
      include: {
        carpet: {
          select: {
            id: true,
            uniqueCode: true,
            name: true,
            patternCode: true,
            shape: true,
            productType: true,
            price: true,
            images: true,
          },
        },
      },
    });

    const ovalCandidates = ovalCarpets.map((item) => ({
      carpetId: item.carpet.id,
      uniqueCode: item.barcode,
      name: item.carpet.name,
      patternCode: item.carpet.patternCode,
      widthCm: Math.round(item.widthMm / 10),
      lengthCm: Math.round(item.lengthMm / 10),
      shape: item.carpet.shape,
      productType: item.carpet.productType,
      price: Number(item.pricePerM2 || item.carpet.price),
      stock: 1,
      images: item.carpet.images || [],
    }));

    return this.rankCandidates(widthCm, lengthCm, ovalCandidates, maxDistanceCm);
  }

  /**
   * Executes the strict fallback search workflow:
   *   1. Search Metraj category first.
   *   2. If no suitable metraj carpet exists, search closest suitable Ready-made carpets.
   *   3. If no suitable ready-made carpet exists, search Oval carpets.
   *   4. If no suitable oval carpet exists, STOP search with "Ushbu o‘lchamga mos gilam topilmadi."
   *   CRITICAL: Never automatically suggest 5-meter metraj carpets!
   */
  async executeFallbackSearch(
    widthCm: number,
    lengthCm: number,
    displayMeters: string,
  ): Promise<CarpetSearchResultFlow> {
    // --- STAGE 1: METRAJ SEARCH ---
    const metrajMatches = await this.searchMetrajRolls(widthCm, lengthCm);
    if (metrajMatches.length > 0) {
      return {
        stage: 'METRAJ_EXACT',
        queryWidthCm: widthCm,
        queryLengthCm: lengthCm,
        displayMeters,
        results: [],
        metrajResults: metrajMatches,
      };
    }

    // --- STAGE 2: CLOSEST READY-MADE CARPETS ---
    const rankedReady = await this.findClosestReadyCarpets(widthCm, lengthCm);
    if (rankedReady.length > 0) {
      return {
        stage: 'READY_CLOSEST',
        queryWidthCm: widthCm,
        queryLengthCm: lengthCm,
        displayMeters,
        results: rankedReady,
      };
    }

    // --- STAGE 3: CLOSEST OVAL CARPETS ---
    const rankedOval = await this.findClosestOvalCarpets(widthCm, lengthCm);
    if (rankedOval.length > 0) {
      return {
        stage: 'OVAL_CLOSEST',
        queryWidthCm: widthCm,
        queryLengthCm: lengthCm,
        displayMeters,
        results: rankedOval,
      };
    }

    // --- STAGE 4: NOT FOUND (STOP) ---
    // Do NOT substitute 5-meter metraj. Stop here.
    return {
      stage: 'NOT_FOUND',
      queryWidthCm: widthCm,
      queryLengthCm: lengthCm,
      displayMeters,
      results: [],
      message: 'Ushbu o‘lchamga mos gilam topilmadi.',
    };
  }
}
