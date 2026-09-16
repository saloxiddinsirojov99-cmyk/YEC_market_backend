import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateCarpetDiscountDto {
  @ApiProperty({ example: ['Steffano'], isArray: true })
  @IsArray()
  @ArrayMinSize(1, { message: 'Kamida bitta gilam nomini tanlang.' })
  @IsString({ each: true })
  names!: string[];

  @ApiProperty({ example: 15, minimum: 0, maximum: 99 })
  @Type(() => Number)
  @IsInt({ message: "Skidka foizi butun son bo'lishi kerak." })
  @Min(0, { message: "Skidka foizi 0 dan kichik bo'lmasligi kerak." })
  @Max(99, { message: "Skidka foizi 99 dan katta bo'lmasligi kerak." })
  discountPercent!: number;
}
