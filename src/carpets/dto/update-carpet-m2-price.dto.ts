import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsArray,
  IsNumber,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class UpdateCarpetM2PriceDto {
  @ApiProperty({ example: ['Etalon'], isArray: true })
  @IsArray()
  @ArrayMinSize(1, { message: 'Kamida bitta gilam nomini tanlang.' })
  @IsString({ each: true })
  names!: string[];

  @ApiProperty({ example: 99100, minimum: 1, maximum: 99999999 })
  @Type(() => Number)
  @IsNumber(
    { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 2 },
    { message: "m2 narxi noto'g'ri kiritildi." },
  )
  @Min(1, { message: "m2 narxi 1 dan kichik bo'lmasligi kerak." })
  @Max(99999999, { message: 'm2 narxi juda katta.' })
  m2Price!: number;
}
