import { IsString, MaxLength, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCategoryDto {
  @ApiProperty({ example: 'Klassik gilamlar' })
  @IsString()
  @MinLength(2, {
    message: "Kategoriya nomi kamida 2 ta belgidan iborat bo'lsin.",
  })
  @MaxLength(100, {
    message: 'Kategoriya nomi 100 ta belgidan oshmasligi kerak.',
  })
  name!: string;
}
