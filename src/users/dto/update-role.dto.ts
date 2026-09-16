import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { UserRole } from '@prisma/client';

export class UpdateRoleDto {
  @ApiProperty({ enum: UserRole, description: 'Yangi rol' })
  @IsEnum(UserRole)
  role: UserRole;
}
