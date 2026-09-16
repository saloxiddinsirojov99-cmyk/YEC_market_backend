import { IsEmail, IsString, MinLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class LoginDto {
  @ApiProperty({ example: 'admin@yecmarket.uz' })
  @IsString({ message: "Login noto'g'ri formatda (Email yoki Telefon)." })
  email!: string;

  @ApiProperty({ example: 'Admin123!' })
  @IsString({ message: "Parol matn bo'lishi kerak." })
  @MinLength(6, {
    message: "Parol kamida 6 ta belgidan iborat bo'lishi kerak.",
  })
  password!: string;
}
