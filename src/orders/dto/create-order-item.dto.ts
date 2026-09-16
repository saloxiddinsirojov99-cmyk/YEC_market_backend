import { IsInt, IsOptional, IsString, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateOrderItemDto {
  @ApiProperty({ example: 'cm9xxxxxx' })
  @IsString()
  carpetId!: string;

  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  quantity!: number;

  @ApiProperty({ example: 150, required: false })
  @IsInt()
  @IsOptional()
  widthCm?: number;

  @ApiProperty({ example: 551, required: false })
  @IsInt()
  @IsOptional()
  lengthCm?: number;
}
