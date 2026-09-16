import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, Length } from 'class-validator';

export class VerifyRegisterOtpDto {
  @ApiProperty({ example: 'customer@yecmarket.uz' })
  @IsEmail({}, { message: "Email formati noto'g'ri." })
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString({ message: 'Tasdiqlash kodi matn bo`lishi kerak.' })
  @Length(6, 6, {
    message: "Tasdiqlash kodi 6 ta raqamdan iborat bo'lishi kerak.",
  })
  otp!: string;
}
