import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateCategoryDto {
  @ApiPropertyOptional({ example: 'Yangi kategoriya nomi' })
  @IsOptional()
  @IsString()
  @MinLength(2, {
    message: "Kategoriya nomi kamida 2 ta belgidan iborat bo'lsin.",
  })
  @MaxLength(100, {
    message: 'Kategoriya nomi 100 ta belgidan oshmasligi kerak.',
  })
  name?: string;

  @ApiPropertyOptional({ example: '/uploads/category-image.jpg' })
  @IsOptional()
  @IsString()
  image?: string;
}
