import { ApiProperty } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class RequestRegisterOtpDto {
  @ApiProperty({ example: 'Ali' })
  @IsString({ message: "Ism matn bo'lishi kerak." })
  @MinLength(2, { message: "Ism kamida 2 ta belgidan iborat bo'lishi kerak." })
  @MaxLength(100, { message: 'Ism 100 ta belgidan oshmasligi kerak.' })
  firstName!: string;

  @ApiProperty({ example: 'Valiyev' })
  @IsString({ message: "Familiya matn bo'lishi kerak." })
  @MinLength(2, {
    message: "Familiya kamida 2 ta belgidan iborat bo'lishi kerak.",
  })
  @MaxLength(100, { message: 'Familiya 100 ta belgidan oshmasligi kerak.' })
  lastName!: string;

  @ApiProperty({ example: 'customer@yecmarket.uz' })
  @IsEmail({}, { message: "Email formati noto'g'ri." })
  email!: string;

  @ApiProperty({ example: '+998901234567' })
  @IsString({ message: "Telefon raqam matn bo'lishi kerak." })
  @Matches(/^\+998\d{9}$/, {
    message: "Telefon raqam +998901234567 formatida bo'lishi kerak.",
  })
  phone!: string;

  @ApiProperty({ example: 'Customer123!' })
  @IsString({ message: "Parol matn bo'lishi kerak." })
  @MinLength(6, {
    message: "Parol kamida 6 ta belgidan iborat bo'lishi kerak.",
  })
  password!: string;
}
