import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ProductType, Shape, CarpetType } from '@prisma/client';
import { Type } from 'class-transformer';

export class CreateCarpetDto {
  @ApiPropertyOptional({ example: 'barcode12345' })
  @IsString()
  @IsOptional()
  barcode?: string;

  @ApiProperty({ example: 'Iran Soft' })
  @IsString()
  @IsNotEmpty({ message: 'Nomi bo‘sh bo‘lmasligi kerak.' })
  @MinLength(2, { message: "Nomi kamida 2 ta belgidan iborat bo'lishi kerak." })
  @MaxLength(150, { message: 'Nomi 150 ta belgidan oshmasligi kerak.' })
  name!: string;

  @ApiPropertyOptional({ example: 'pattern001' })
  @IsString()
  @IsOptional()
  patternCode?: string;

  @ApiProperty({ enum: ['METRAJ', 'RUNNER', 'READY'], example: 'READY' })
  @IsEnum(ProductType, {
    message: 'Mahsulot turi faqat METRAJ, RUNNER yoki READY bo‘lishi mumkin.',
  })
  productType!: ProductType;

  @ApiProperty({ enum: ['RECTANGLE', 'OVAL', 'CIRCLE'], example: 'RECTANGLE' })
  @IsEnum(Shape, {
    message: 'Shakli faqat RECTANGLE, OVAL yoki CIRCLE bo‘lishi mumkin.',
  })
  shape!: Shape;

  @ApiProperty({ example: 3000, description: 'Eni (millimetrda)' })
  @Type(() => Number)
  @IsInt({ message: "Eni butun son bo'lishi kerak (mm da)." })
  @IsPositive({ message: "Eni 0 dan katta bo'lishi kerak." })
  widthMm!: number;

  @ApiProperty({ example: 4000, description: 'Bo‘yi (millimetrda)' })
  @Type(() => Number)
  @IsInt({ message: "Bo‘yi butun son bo'lishi kerak (mm da)." })
  @IsPositive({ message: "Bo‘yi 0 dan katta bo'lishi kerak." })
  lengthMm!: number;

  @ApiPropertyOptional({ example: 399.99 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber(
    { maxDecimalPlaces: 2 },
    { message: "Narx son ko'rinishida bo'lishi shart." },
  )
  @IsPositive({ message: "Narx 0 dan katta bo'lishi shart." })
  price?: number;

  @ApiPropertyOptional({ example: '160x230 sm' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: "O'lcham bo'sh bo'lmasligi kerak." })
  size?: string;

  @ApiPropertyOptional({ example: 'Paxta' })
  @IsOptional()
  @IsString()
  @IsNotEmpty({ message: 'Material bo`sh bo`lmasligi kerak.' })
  material?: string;

  @ApiPropertyOptional({ example: 'Yangilangan tavsif' })
  @IsOptional()
  @IsString()
  description?: string;

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
  @IsPositive({ message: "Miqdor 0 dan katta bo'lishi kerak." })
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

  @ApiPropertyOptional({ enum: CarpetType, example: 'READY' })
  @IsOptional()
  @IsEnum(CarpetType)
  type?: CarpetType;

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
