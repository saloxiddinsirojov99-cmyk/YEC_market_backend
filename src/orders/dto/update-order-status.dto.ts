import { OrderStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateOrderStatusDto {
  @ApiPropertyOptional({ enum: OrderStatus, example: OrderStatus.ACCEPTED })
  @IsOptional()
  @IsEnum(OrderStatus)
  status?: OrderStatus;

  @ApiPropertyOptional({ example: "Mijoz bilan bog'lanib bo'lmadi" })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  cancelReason?: string;

  @ApiPropertyOptional({ example: '2024-03-20' })
  @IsOptional()
  @IsString()
  deliveryDate?: string;

  @ApiPropertyOptional({ example: 'Ulov buzilgani sababli kelyapmiz' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  explanation?: string;

  @ApiPropertyOptional({ example: 'courier-uuid-here' })
  @IsOptional()
  @IsString()
  courierId?: string;

  @ApiPropertyOptional({ example: 'SIGNATURE' })
  @IsOptional()
  @IsString()
  courierProofType?: string;

  @ApiPropertyOptional({ example: 'OTP_1234' })
  @IsOptional()
  @IsString()
  courierProofData?: string;

  @ApiPropertyOptional({ example: 'base64-drawing-data' })
  @IsOptional()
  @IsString()
  courierProofSignature?: string;
}
