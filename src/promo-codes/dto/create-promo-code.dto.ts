import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PromoCodeType } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
  MaxLength,
} from 'class-validator';

export class CreatePromoCodeDto {
  @ApiProperty({ example: 'YEC15' })
  @IsString()
  @Length(3, 30)
  code!: string;

  @ApiPropertyOptional({ enum: PromoCodeType, example: PromoCodeType.DISCOUNT })
  @IsOptional()
  @IsEnum(PromoCodeType)
  promoType?: PromoCodeType;

  @ApiPropertyOptional({ example: 15, minimum: 1, maximum: 99 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  discountPercent?: number;

  @ApiPropertyOptional({ example: 5000000, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minOrderAmount?: number;

  @ApiPropertyOptional({
    example: '2026-06-20T00:00:00.000Z',
    description: 'Promokod boshlanish vaqti (ixtiyoriy)',
  })
  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @ApiPropertyOptional({
    example: '2026-12-31T23:59:59.000Z',
    description: 'Promokod tugash vaqti (ixtiyoriy)',
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @ApiPropertyOptional({ example: 'Gilamcha' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  giftName?: string;

  @ApiPropertyOptional({ example: '/uploads/1710000000000-gift.webp' })
  @IsOptional()
  @IsString()
  giftImage?: string;

  @ApiPropertyOptional({ example: 120000, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  giftPrice?: number;
}
