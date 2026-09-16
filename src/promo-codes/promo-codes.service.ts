import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PromoCodeType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePromoCodeDto } from './dto/create-promo-code.dto';
import { UpdatePromoCodeDto } from './dto/update-promo-code.dto';

@Injectable()
export class PromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreatePromoCodeDto) {
    const code = this.normalizeCode(dto.code);
    this.ensureValidCode(code);

    const promoType = dto.promoType ?? PromoCodeType.DISCOUNT;
    const startsAt = this.parseDateOrNull(
      dto.startsAt,
      "Promokod boshlanish sanasi noto'g'ri.",
    );
    const expiresAt = this.parseDateOrNull(
      dto.expiresAt,
      "Promokod tugash sanasi noto'g'ri.",
    );

    if (startsAt && expiresAt && startsAt.getTime() > expiresAt.getTime()) {
      throw new BadRequestException(
        "Boshlanish sanasi tugash sanasidan keyin bo'la olmaydi.",
      );
    }

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException(
        "Promokod tugash sanasi kelajakda bo'lishi kerak.",
      );
    }

    const minOrderAmount = this.normalizeMinOrderAmount(dto.minOrderAmount);

    const existing = await this.prisma.promoCode.findUnique({
      where: { code },
    });
    if (existing) {
      throw new ConflictException('Bu promokod allaqachon mavjud.');
    }

    if (promoType === PromoCodeType.DISCOUNT) {
      const percent = Number(dto.discountPercent);
      if (!Number.isFinite(percent)) {
        throw new BadRequestException('Skidka foizini kiriting.');
      }
      if (percent < 1 || percent > 99) {
        throw new BadRequestException(
          "Skidka foizi 1 dan 99 gacha bo'lishi kerak.",
        );
      }
    } else {
      if (!dto.giftImage?.trim()) {
        throw new BadRequestException('Gilamcha rasmi majburiy.');
      }
      const giftPrice = Number(dto.giftPrice);
      if (!Number.isFinite(giftPrice) || giftPrice < 0) {
        throw new BadRequestException("Gilamcha narxi noto'g'ri kiritildi.");
      }
    }

    return this.prisma.promoCode.create({
      data: {
        code,
        type: promoType,
        discountPercent:
          promoType === PromoCodeType.DISCOUNT
            ? Math.round(Number(dto.discountPercent))
            : 0,
        minOrderAmount,
        startsAt,
        expiresAt,
        giftName:
          promoType === PromoCodeType.GIFT
            ? dto.giftName?.trim() || 'Gilamcha'
            : null,
        giftImage:
          promoType === PromoCodeType.GIFT ? dto.giftImage?.trim() : null,
        giftPrice:
          promoType === PromoCodeType.GIFT
            ? Math.round(Number(dto.giftPrice ?? 0))
            : null,
      },
    });
  }

  async findAll() {
    return this.prisma.promoCode.findMany({
      orderBy: [{ createdAt: 'desc' }],
      include: {
        _count: {
          select: { usages: true },
        },
      },
    });
  }

  async update(id: string, dto: UpdatePromoCodeDto) {
    const existing = await this.ensureExists(id);

    const data: any = {};
    if (dto.isActive !== undefined) {
      data.isActive = dto.isActive;
    }
    if (dto.discountPercent !== undefined) {
      data.discountPercent = dto.discountPercent;
    }
    if (dto.minOrderAmount !== undefined) {
      data.minOrderAmount = this.normalizeMinOrderAmount(dto.minOrderAmount);
    }
    if (dto.startsAt !== undefined) {
      data.startsAt = this.parseDateOrNull(
        dto.startsAt,
        "Promokod boshlanish sanasi noto'g'ri.",
      );
    }
    if (dto.expiresAt !== undefined) {
      data.expiresAt = this.parseDateOrNull(
        dto.expiresAt,
        "Promokod tugash sanasi noto'g'ri.",
      );
    }
    if (dto.giftName !== undefined) {
      const trimmed = dto.giftName?.trim();
      data.giftName = trimmed ? trimmed : null;
    }
    if (dto.giftImage !== undefined) {
      const trimmed = dto.giftImage?.trim();
      data.giftImage = trimmed ? trimmed : null;
    }
    if (dto.giftPrice !== undefined) {
      const giftPrice = Number(dto.giftPrice);
      if (!Number.isFinite(giftPrice) || giftPrice < 0) {
        throw new BadRequestException("Gilamcha narxi noto'g'ri kiritildi.");
      }
      data.giftPrice = Math.round(giftPrice);
    }

    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        'Yangilash uchun kamida bitta maydon yuboring.',
      );
    }

    const nextStartsAt =
      data.startsAt !== undefined ? data.startsAt : existing.startsAt;
    const nextExpiresAt =
      data.expiresAt !== undefined ? data.expiresAt : existing.expiresAt;

    if (
      nextStartsAt &&
      nextExpiresAt &&
      nextStartsAt.getTime() > nextExpiresAt.getTime()
    ) {
      throw new BadRequestException(
        "Boshlanish sanasi tugash sanasidan keyin bo'la olmaydi.",
      );
    }

    return this.prisma.promoCode.update({
      where: { id },
      data,
      include: {
        _count: {
          select: { usages: true },
        },
      },
    });
  }

  private async ensureExists(id: string) {
    const found = await this.prisma.promoCode.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException('Promokod topilmadi.');
    }
    return found;
  }

  private normalizeCode(rawCode: string) {
    return String(rawCode ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private ensureValidCode(code: string) {
    if (!code) {
      throw new BadRequestException('Promokod kiriting.');
    }
    if (!/^[A-Z0-9_-]{3,30}$/.test(code)) {
      throw new BadRequestException(
        "Promokod faqat harf, raqam, '-' yoki '_' dan iborat bo'lsin (3-30 belgi).",
      );
    }
  }

  private parseDateOrNull(
    value: string | undefined,
    errorMessage: string,
  ): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(errorMessage);
    }
    return parsed;
  }

  private normalizeMinOrderAmount(value: unknown): number {
    const raw = Number(value ?? 0);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new BadRequestException("Minimal summa noto'g'ri kiritildi.");
    }
    return Math.round(raw);
  }
}
