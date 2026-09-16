import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';

export class RequestForgotPasswordDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail({}, { message: "Noto'g'ri email formati." })
  @IsNotEmpty({ message: 'Email bo`sh bo`lmasligi kerak.' })
  email!: string;
}
