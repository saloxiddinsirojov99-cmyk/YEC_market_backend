import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { CreateOrderItemDto } from './create-order-item.dto';

export class PreviewPromoDto {
  @ApiPropertyOptional({ example: 'YEC15' })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  promoCode?: string;

  @ApiProperty({
    type: [CreateOrderItemDto],
    example: [{ carpetId: 'cm9xxxxxx', quantity: 2 }],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOrderItemDto)
  items!: CreateOrderItemDto[];
}
