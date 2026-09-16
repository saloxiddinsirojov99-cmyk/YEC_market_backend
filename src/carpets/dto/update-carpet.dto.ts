import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  IsInt,
  IsEnum,
} from 'class-validator';
import { CarpetType } from '@prisma/client';

export class UpdateCarpetDto {
  @ApiPropertyOptional({ example: 'Updated Carpet Name' })
  @IsOptional()
  @IsString()
  @MinLength(2, { message: "Nomi kamida 2 ta belgidan iborat bo'lishi kerak." })
  @MaxLength(150, { message: 'Nomi 150 ta belgidan oshmasligi kerak.' })
  name?: string;

  @ApiPropertyOptional({ example: 399.99 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: "Narx son ko'rinishida bo'lishi shart." },
  )
  price?: number;

  @ApiPropertyOptional({ example: '160x230 sm' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "O'lcham bo'sh bo'lmasligi kerak." })
  size?: string;

  @ApiPropertyOptional({ example: 'Paxta' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "Material bo'sh bo'lmasligi kerak." })
  material?: string;

  @ApiPropertyOptional({ example: 'Yangilangan tavsif' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ example: 'pattern001' })
  @IsOptional()
  @IsString()
  patternCode?: string;

  @ApiPropertyOptional({ example: 'DC-001' })
  @IsOptional()
  @IsString()
  designCode?: string;

  @ApiPropertyOptional({ example: ['/uploads/new-file.webp'], isArray: true })
  @IsOptional()
  @IsString({ each: true })
  images?: string[];

  @ApiPropertyOptional({ example: 15 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({}, { message: "Miqdor son bo'lishi kerak." })
  stock?: number;

  @ApiPropertyOptional({ example: 'cm9xxxxxx' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ example: 2405427104 })
  @IsOptional()
  qo_shimchaKod?: any;

  @ApiPropertyOptional({ example: 'YEC Market' })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({ example: '12345678' })
  @IsOptional()
  @IsString()
  barcode?: string;

  @ApiPropertyOptional({ enum: CarpetType, example: 'READY' })
  @IsOptional()
  @IsEnum(CarpetType, { message: "Tur faqat READY yoki ROLL bo'lishi mumkin." })
  type?: CarpetType;

  @ApiPropertyOptional({
    example: 300,
    description: 'Kenglik sm da (faqat ROLL)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "Kenglik butun son bo'lishi kerak." })
  @IsPositive({ message: "Kenglik 0 dan katta bo'lishi kerak." })
  widthCm?: number;

  @ApiPropertyOptional({
    example: 5000,
    description: 'Uzunlik sm da (faqat ROLL)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "Uzunlik butun son bo'lishi kerak." })
  @IsPositive({ message: "Uzunlik 0 dan katta bo'lishi kerak." })
  originalLengthCm?: number;

  @ApiPropertyOptional({
    example: 120000,
    description: '1 m² narxi (faqat ROLL)',
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: "m² narxi son bo'lishi kerak." },
  )
  @IsPositive({ message: "m² narxi 0 dan katta bo'lishi kerak." })
  pricePerM2?: number;

  @ApiPropertyOptional({ example: 2.5 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    {},
    { message: "Vazn o'lchami o'nlik son bo'lishi kerak (masalan, 2.5)." },
  )
  @IsPositive({ message: "Vazn 0 dan katta bo'lishi kerak." })
  weightKg?: number;

  @ApiPropertyOptional({ example: 12 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "Tuk balandligi butun son bo'lishi kerak." })
  @IsPositive({ message: "Tuk balandligi 0 dan katta bo'lishi kerak." })
  pileHeight?: number;
}
