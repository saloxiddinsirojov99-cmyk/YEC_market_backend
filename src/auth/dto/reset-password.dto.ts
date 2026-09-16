import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: "Noto'g'ri email formati." })
  @IsNotEmpty({ message: 'Email bo`sh bo`lmasligi kerak.' })
  email!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @IsNotEmpty({ message: 'OTP kod bo`sh bo`lmasligi kerak.' })
  otp!: string;

  @ApiProperty({ example: 'newpassword123' })
  @IsString()
  @MinLength(6, {
    message: "Parol kamida 6 ta belgidan iborat bo'lishi kerak.",
  })
  newPassword!: string;
}
