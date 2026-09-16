import {
  Controller,
  Post,
  Patch,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ReturnService } from './return.service';
import { ReturnRequestStatus } from '@prisma/client';

@ApiTags('Returns')
@Controller('orders')
export class ReturnController {
  constructor(private readonly returnService: ReturnService) {}

  @ApiOperation({
    summary: "Mijoz tomonidan mahsulotni qaytarish so'rovi (24 soat ichida)",
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':id/return')
  create(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
    @Body() dto: { reason: string; explanation: string; images?: string[] },
  ) {
    return this.returnService.createReturnRequest(id, user.sub, dto);
  }

  @ApiOperation({
    summary:
      "Admin tomonidan qaytarish so'rovini tasdiqlash/rad etish (admin only)",
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/return-review')
  review(
    @Param('id') id: string,
    @Body() dto: { status: ReturnRequestStatus },
  ) {
    return this.returnService.reviewReturnRequest(id, dto.status);
  }

  @ApiOperation({
    summary:
      'Admin tomonidan qaytarilgan mahsulotni omborga olish/tashlab yuborish (admin only)',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post(':id/return-action')
  action(
    @Param('id') id: string,
    @Body() dto: { action: 'RESTOCKED' | 'DISCARDED' },
  ) {
    return this.returnService.processReturnAction(id, dto.action);
  }
}
