import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'Ali Valiyev' })
  @IsOptional()
  @IsString({ message: "Ism matn bo'lishi kerak." })
  @MinLength(2, { message: "Ism kamida 2 ta belgidan iborat bo'lishi kerak." })
  @MaxLength(100, { message: 'Ism 100 ta belgidan oshmasligi kerak.' })
  name?: string;

  @ApiPropertyOptional({ example: '+998 90-123-45-67' })
  @IsOptional()
  @IsString({ message: "Telefon raqam matn bo'lishi kerak." })
  @Matches(/^(\+?998)?[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}$/, {
    message: "Telefon raqami noto'g'ri kiritildi (masalan: +998 90 123 45 67).",
  })
  phone?: string;

  @ApiPropertyOptional({ example: 'https://example.com/avatar.jpg' })
  @IsOptional()
  @IsString({ message: "Rasm manzili matn bo'lishi kerak." })
  avatar?: string;

  @ApiPropertyOptional({ example: 'Toshkent' })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional()
  @IsOptional()
  lat?: number;

  @ApiPropertyOptional()
  @IsOptional()
  lng?: number;
}
