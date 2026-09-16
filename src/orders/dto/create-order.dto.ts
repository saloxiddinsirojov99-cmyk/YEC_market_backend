import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsPhoneNumber,
  IsNumber,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateOrderItemDto } from './create-order-item.dto';
import { PaymentMethod } from '@prisma/client';

export class CreateOrderDto {
  @ApiProperty({ example: 'Ali Valiyev' })
  @IsString()
  @MaxLength(100)
  customerName!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsPhoneNumber(undefined)
  phone!: string;

  @ApiPropertyOptional({ example: '+998911112233' })
  @IsOptional()
  @IsPhoneNumber(undefined)
  phone2?: string;

  @ApiProperty({ example: 'Toshkent shahri, Chilonzor tumani' })
  @IsString()
  @MaxLength(255)
  address!: string;

  @ApiProperty({ example: 41.311081 })
  @Type(() => Number)
  @IsNumber()
  locationLat!: number;

  @ApiProperty({ example: 69.279723 })
  @Type(() => Number)
  @IsNumber()
  locationLng!: number;

  @ApiProperty({ example: 'Tashkent, Chilonzor, Uzbekistan' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  locationText!: string;

  @ApiProperty({ enum: PaymentMethod, example: PaymentMethod.CASH })
  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @ApiPropertyOptional({ example: 'Kechki payt yetkazib berilsin' })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  comment?: string;

  @ApiPropertyOptional({ example: 'YEC15' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;

  @ApiProperty({
    example: '[{"carpetId":"cm9xxxxxx","quantity":2}]',
    description:
      "Form-data uchun JSON string yoki array ko'rinishida yuboriladi.",
  })
  @Transform(({ value }) => {
    if (typeof value === 'string') {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];

  @ApiPropertyOptional({
    example: true,
    description: 'Metraj gilam shartlarini tasdiqlash statusi',
  })
  @IsOptional()
  termsAccepted?: boolean;

  @ApiPropertyOptional({
    example: '2026-06-29',
    description: 'Yetkazib berish sanasi',
  })
  @IsOptional()
  @IsString()
  deliveryDateString?: string;
}
