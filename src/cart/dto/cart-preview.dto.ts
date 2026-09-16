import { Transform, Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class CartItemDto {
  @ApiProperty({ example: 'cm9xxxxxx' })
  @IsString()
  carpetId!: string;

  @ApiProperty({ example: 2 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  quantity!: number;
}

export class CartPreviewDto {
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
  @ValidateNested({ each: true })
  @Type(() => CartItemDto)
  items!: CartItemDto[];
}
