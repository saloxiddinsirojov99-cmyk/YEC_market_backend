import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';

export class CarpetQueryDto {
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(10000)
  limit?: number = 10;

  @ApiPropertyOptional({ example: 'turkiya' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: 'cm9xxxxxx' })
  @IsOptional()
  @IsString()
  categoryId?: string;

  @ApiPropertyOptional({ example: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  minPrice?: number;

  @ApiPropertyOptional({ example: 500 })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  maxPrice?: number;

  @ApiPropertyOptional({ example: '200x300 sm' })
  @IsOptional()
  @IsString()
  size?: string;

  @ApiPropertyOptional({ example: 'Paxta' })
  @IsOptional()
  @IsString()
  material?: string;

  @ApiPropertyOptional({
    example: 'carpet',
    description:
      'Filter by type: carpet, prayer, oval, roll, returned, returned_roll, returned_ready, normal_roll, normal_ready, normal',
  })
  @IsOptional()
  @IsString()
  @IsIn([
    'carpet',
    'prayer',
    'oval',
    'roll',
    'returned',
    'returned_roll',
    'returned_ready',
    'normal_roll',
    'normal_ready',
    'normal',
  ])
  kind?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Admin use only: show items with 0 stock',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  showAll?: boolean;

  @ApiPropertyOptional({
    example: 'popular',
    description: 'Sort by popular or newest',
  })
  @IsOptional()
  @IsString()
  sortBy?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Bypass grouping and return raw items',
  })
  @IsOptional()
  @Transform(({ value }) => value === 'true' || value === true)
  raw?: boolean;

  @ApiPropertyOptional({
    example: 'antique',
    description: 'Filter by exact collection name',
  })
  @IsOptional()
  @IsString()
  collection?: string;

  @ApiPropertyOptional({
    example: 'cmr7dmmyn000yacu5qiy4qzfz',
    description: 'Carpet ID to exclude from recommendations',
  })
  @IsOptional()
  @IsString()
  excludeId?: string;
}
