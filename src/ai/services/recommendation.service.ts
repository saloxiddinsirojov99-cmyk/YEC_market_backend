import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Carpet, CatalogDesign } from '@prisma/client';

export interface SizeRecommendation {
  sizeLabel: string;
  widthM: number;
  lengthM: number;
  score: number;
  reason: string;
}

export interface CarpetRecommendationResult {
  carpet: Carpet & { catalogDesign?: CatalogDesign | null };
  matchPercent: number;
  explanations: string[];
  wmsDetails?: {
    designCode: string;
    collectionName: string;
    warehouse: string;
    shelf: string;
    stock: number;
    fifoAgeDays: number;
    createdAt: Date;
  };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const shorthandRegex = /^#?([a-f\d])([a-f\d])([a-f\d])$/i;
  const fullHex = hex.replace(
    shorthandRegex,
    (m, r, g, b) => r + r + g + g + b + b,
  );
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(fullHex);
  return result
    ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16),
      }
    : null;
}

function parseDimensionsFromLabel(label: string): { w: number; l: number } {
  const clean = label
    .replace(' sm', '')
    .replace(' cm', '')
    .replace(' m', '')
    .replace(' см', '');
  const parts = clean.split('x');
  if (parts.length === 2) {
    const w = parseFloat(parts[0]);
    const l = parseFloat(parts[1]);
    if (!isNaN(w) && !isNaN(l)) {
      return { w, l };
    }
  }
  return { w: 0, l: 0 };
}

@Injectable()
export class RecommendationService {
  private readonly logger = new Logger(RecommendationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recommends ideal carpet sizes based on room width and length (in meters).
   */
  recommendSizes(roomWidth: number, roomLength: number): SizeRecommendation[] {
    const roomArea = roomWidth * roomLength;
    const minIdealArea = roomArea * 0.4;
    const maxIdealArea = roomArea * 0.75;

    // Standard metric sizes
    const standardSizes = [
      {
        label: '1.6x2.3 sm',
        w: 1.6,
        l: 2.3,
        desc: 'Kichik yotoqxona va bolalar xonasi uchun mos',
      },
      {
        label: '2x3 sm',
        w: 2.0,
        l: 3.0,
        desc: "O'rtacha yashash xonasi yoki yotoqxona uchun ideal",
      },
      {
        label: '2.5x3.5 sm',
        w: 2.5,
        l: 3.5,
        desc: "Katta mehmonxona va zal uchun eng yaxshi o'lcham",
      },
      {
        label: '3x4 sm',
        w: 3.0,
        l: 4.0,
        desc: 'Katta zallar va keng xonalar uchun juda mos',
      },
      {
        label: '4x5 sm',
        w: 4.0,
        l: 5.0,
        desc: 'Juda keng marosim zallari uchun mukammal',
      },
    ];

    const recommendations: SizeRecommendation[] = [];

    for (const size of standardSizes) {
      // Check if size fits in room geometry
      const fitsNormal = size.w <= roomWidth && size.l <= roomLength;
      const fitsRotated = size.w <= roomLength && size.l <= roomWidth;

      if (!fitsNormal && !fitsRotated) continue;

      const carpetArea = size.w * size.l;
      let score = 50; // base score

      // 1. Area matching score (ideal coverage: 50% - 70%)
      if (carpetArea >= minIdealArea && carpetArea <= maxIdealArea) {
        score += 25;
      } else {
        const diff = Math.min(
          Math.abs(carpetArea - minIdealArea),
          Math.abs(carpetArea - maxIdealArea),
        );
        score += Math.max(0, 25 - diff * 8);
      }

      // 2. Margins (walking space) score (ideal: 45cm - 90cm on sides)
      const wMargin = Math.abs(roomWidth - size.w) / 2;
      const lMargin = Math.abs(roomLength - size.l) / 2;

      if (wMargin >= 0.45 && wMargin <= 0.9) score += 12;
      if (lMargin >= 0.45 && lMargin <= 0.9) score += 13;

      // Ensure final score is mapped and capped nicely below 100%
      const finalScore = Math.min(Math.max(Math.floor(score), 40), 99);

      let reason = "Xona o'rtacha nisbatlariga mos";
      if (finalScore >= 95) {
        reason = 'Mukammal qoplama va ideal yurish maydoni';
      } else if (finalScore >= 85) {
        reason = 'Balanslashgan yurish maydoni va mebellar joylashishi';
      } else if (carpetArea < minIdealArea) {
        reason = "Xona uchun biroz kichikroq bo'lishi mumkin";
      } else if (carpetArea > maxIdealArea) {
        reason = "Xona maydonini deyarli to'liq qoplaydi";
      }

      recommendations.push({
        sizeLabel: size.label,
        widthM: size.w,
        lengthM: size.l,
        score: finalScore,
        reason,
      });
    }

    // Sort by score descending
    return recommendations.sort((a, b) => b.score - a.score);
  }

  /**
   * Ranks and filters active carpets based on size, preferences, colors, popularity, and FIFO.
   */
  async recommendCarpets(
    roomWidth: number,
    roomLength: number,
    selectedSizeLabel: string,
    userId?: string,
    isSeller = false,
    roomStyle?: string,
    roomColors?: string[],
  ): Promise<CarpetRecommendationResult[]> {
    const parsedWidth = roomWidth;
    const parsedLength = roomLength;

    // 1. Fetch dynamic weights from settings
    let settings = await this.prisma.recommendationSettings.findUnique({
      where: { id: 'singleton' },
    });
    if (!settings) {
      settings = await this.prisma.recommendationSettings.create({
        data: {
          id: 'singleton',
          roomWeight: 0.35,
          clearanceWeight: 0.25,
          colorWeight: 0.15,
          styleWeight: 0.1,
          fifoWeight: 0.1,
          popularityWeight: 0.05,
        },
      });
    }

    // 2. Get size recommendations
    const sizeRecommendations = this.recommendSizes(parsedWidth, parsedLength);
    const sizeRec = sizeRecommendations.find(
      (r) => r.sizeLabel === selectedSizeLabel,
    );
    const sizeScore = sizeRec ? sizeRec.score : 60; // Room size fit base

    // 3. Get user preferences
    let prefColors: string[] = [];
    let prefStyles: string[] = [];
    if (userId) {
      const pref = await this.prisma.userPreference.findUnique({
        where: { userId },
      });
      if (pref) {
        prefColors = pref.preferredColors;
        prefStyles = pref.preferredStyles;
      }
    }

    // 4. Find matching carpets in the YEC database
    const carpets = await this.prisma.carpet.findMany({
      where: {
        isArchived: false,
        inventoryItems: {
          some: {
            inventoryStatus: 'ACTIVE',
            size: {
              contains: selectedSizeLabel
                .replace(' sm', '')
                .replace(' cm', '')
                .replace(' см', ''),
              mode: 'insensitive',
            },
          },
        },
      },
      include: {
        category: true,
        catalogDesign: true,
      },
    });

    const recommendations: CarpetRecommendationResult[] = [];

    // Parse carpet dimensions
    const { w: carpetW, l: carpetL } =
      parseDimensionsFromLabel(selectedSizeLabel);

    for (const carpet of carpets) {
      if (Number(carpet.price) <= 0) continue;

      // A. Room Size compatibility
      const factorRoomSize = sizeScore;

      // B. Furniture Clearance compatibility (ideal: 45cm to 90cm on sides)
      const marginW = Math.max(0, (roomWidth - carpetW) / 2);
      const marginL = Math.max(0, (roomLength - carpetL) / 2);
      let factorClearance = 50; // base score
      if (marginW >= 0.45 && marginW <= 0.9) factorClearance += 25;
      else factorClearance += Math.max(0, 25 - Math.abs(marginW - 0.675) * 50);
      if (marginL >= 0.45 && marginL <= 0.9) factorClearance += 25;
      else factorClearance += Math.max(0, 25 - Math.abs(marginL - 0.675) * 50);
      factorClearance = Math.min(Math.max(factorClearance, 40), 99);

      // C. Color Harmony compatibility (Euclidean RGB delta)
      let factorColor = 80; // default average match
      if (roomColors && roomColors.length > 0) {
        let carpetColors: { r: number; g: number; b: number }[] = [];
        const design = carpet.catalogDesign;
        if (design && design.histogram && Array.isArray(design.histogram)) {
          const hist = design.histogram as number[];
          const indexed = hist.map((val, idx) => ({ val, idx }));
          indexed.sort((a, b) => b.val - a.val);

          carpetColors = indexed.slice(0, 3).map((item) => {
            const idx = item.idx;
            const binR = Math.floor(idx / 16);
            const binG = Math.floor((idx % 16) / 4);
            const binB = idx % 4;
            const r = Math.min(255, binR * 64 + 32);
            const g = Math.min(255, binG * 64 + 32);
            const b = Math.min(255, binB * 64 + 32);
            return { r, g, b };
          });
        }

        if (carpetColors.length > 0) {
          let totalColorScore = 0;
          let colorMatchCount = 0;
          for (const rc of roomColors) {
            const rcRgb = hexToRgb(rc);
            if (!rcRgb) continue;
            let minDistance = Infinity;
            for (const cc of carpetColors) {
              const dist = Math.sqrt(
                (rcRgb.r - cc.r) ** 2 +
                  (rcRgb.g - cc.g) ** 2 +
                  (rcRgb.b - cc.b) ** 2,
              );
              if (dist < minDistance) minDistance = dist;
            }
            if (minDistance !== Infinity) {
              const score = Math.max(0, 99 - (minDistance / 441.67) * 99);
              totalColorScore += score;
              colorMatchCount++;
            }
          }
          if (colorMatchCount > 0) {
            factorColor = Math.round(totalColorScore / colorMatchCount);
          }
        }
      } else if (carpet.catalogDesign?.metadata) {
        const meta = carpet.catalogDesign.metadata as any;
        const colors = Array.isArray(meta.colors) ? meta.colors : [];
        const hasMatchingColor = colors.some((col: string) =>
          prefColors.some((pCol) =>
            col.toLowerCase().includes(pCol.toLowerCase()),
          ),
        );
        if (hasMatchingColor) factorColor = 98;
      }

      // D. Style template alignment
      let factorStyle = 70; // base style match
      const carpetStyle =
        carpet.style || (carpet.catalogDesign?.metadata as any)?.style || '';
      let styleMatch = false;
      if (roomStyle && carpetStyle) {
        if (
          carpetStyle.toLowerCase().includes(roomStyle.toLowerCase()) ||
          roomStyle.toLowerCase().includes(carpetStyle.toLowerCase())
        ) {
          styleMatch = true;
        }
      }
      if (!styleMatch && prefStyles.length > 0) {
        styleMatch = prefStyles.some((pStyle) =>
          carpetStyle.toLowerCase().includes(pStyle.toLowerCase()),
        );
      }
      if (styleMatch) factorStyle = 98;

      // E. FIFO Inventory Priority score
      const fifoAgeDays = Math.max(
        0,
        Math.floor(
          (Date.now() - new Date(carpet.createdAt).getTime()) /
            (1000 * 60 * 60 * 24),
        ),
      );
      const factorFifo = Math.min(60 + Math.floor(fifoAgeDays * 0.5), 98);

      // F. Popularity score
      const clickCount = (carpet as any).clickCount || 0;
      const viewCount = (carpet as any).viewCount || 0;
      const purchaseCount = (carpet as any).purchaseCount || 0;
      const popularityScore = Math.min(
        50 + purchaseCount * 5 + clickCount * 0.1,
        98,
      );

      // Multi-factor dynamic formula
      const finalScore = Math.min(
        Math.floor(
          factorRoomSize * settings.roomWeight +
            factorClearance * settings.clearanceWeight +
            factorColor * settings.colorWeight +
            factorStyle * settings.styleWeight +
            factorFifo * settings.fifoWeight +
            popularityScore * settings.popularityWeight,
        ),
        99,
      );

      // explanations
      const explanations: string[] = [];
      explanations.push("Xona o'lchamiga va nisbatiga mos");
      if (factorClearance >= 90) {
        explanations.push(
          "Mebellarni chetlab o'tish va joylashtirish uchun ideal",
        );
      }
      if (factorColor >= 90) {
        explanations.push("Xona ranglari uyg'unligiga juda mos");
      }
      if (factorStyle >= 90) {
        explanations.push('Xonaning dizayn uslubiga mukammal mos keladi');
      }
      if (popularityScore >= 80) {
        explanations.push('Mijozlar tomonidan yuqori baholangan');
      }

      const activeItems = await this.prisma.inventoryItem.count({
        where: { carpetId: carpet.id, inventoryStatus: 'ACTIVE' },
      });
      if (activeItems > 0) {
        explanations.push('Hozirda omborda tayyor holatda mavjud');
      }

      // WMS detail for Seller Mode
      let wmsDetails: any = undefined;
      if (isSeller) {
        const position = await this.prisma.inventoryItem.findFirst({
          where: { carpetId: carpet.id, inventoryStatus: 'ACTIVE' },
        });

        const reservedCount = await this.prisma.inventoryItem.count({
          where: { carpetId: carpet.id, inventoryStatus: 'RESERVED' },
        });

        const rolls = await this.prisma.rollInventory.findMany({
          where: { carpetId: carpet.id },
          select: { currentLengthCm: true },
        });
        const totalRollLength = rolls.reduce(
          (sum, r) => sum + r.currentLengthCm,
          0,
        );

        const marginValue = Math.round(Number(carpet.price) * 0.35);
        const supplierName = carpet.brand || 'Samarkand Carpet Factory';

        wmsDetails = {
          designCode: carpet.designCode || 'MAVJUD_EMAS',
          collectionName: carpet.name,
          warehouse: 'Asosiy Ombor',
          shelf: 'A-01-B-01',
          stock: activeItems,
          fifoAgeDays,
          createdAt: carpet.createdAt,
          margin: marginValue,
          purchaseDate: carpet.createdAt,
          reserved: reservedCount,
          rollLength: totalRollLength,
          supplier: supplierName,
        };
      }

      recommendations.push({
        carpet,
        matchPercent: finalScore,
        explanations: explanations.slice(0, 5),
        wmsDetails,
      });
    }

    // Save to AiRecommendationLog asynchronously
    this.prisma.aiRecommendationLog
      .create({
        data: {
          userId: userId || null,
          roomWidth,
          roomLength,
          selectedSize: selectedSizeLabel,
          detectedStyle: roomStyle || null,
          detectedColors: roomColors || [],
        },
      })
      .catch(() => {});

    return recommendations.sort((a, b) => {
      if (b.matchPercent !== a.matchPercent) {
        return b.matchPercent - a.matchPercent;
      }
      return (
        new Date(a.carpet.createdAt).getTime() -
        new Date(b.carpet.createdAt).getTime()
      );
    });
  }

  /**
   * Tracks customer purchase/click to record anonymous user preference metrics.
   */
  async trackUserPreference(
    userId: string,
    color?: string,
    size?: string,
    style?: string,
  ): Promise<void> {
    const existing = await this.prisma.userPreference.findUnique({
      where: { userId },
    });

    const colors = existing?.preferredColors || [];
    const sizes = existing?.preferredSizes || [];
    const styles = existing?.preferredStyles || [];

    if (color && !colors.includes(color)) colors.push(color);
    if (size && !sizes.includes(size)) sizes.push(size);
    if (style && !styles.includes(style)) styles.push(style);

    await this.prisma.userPreference.upsert({
      where: { userId },
      create: {
        userId,
        preferredColors: colors.slice(-5), // Keep last 5 preferences
        preferredSizes: sizes.slice(-5),
        preferredStyles: styles.slice(-5),
      },
      update: {
        preferredColors: colors.slice(-5),
        preferredSizes: sizes.slice(-5),
        preferredStyles: styles.slice(-5),
      },
    });
  }
}
