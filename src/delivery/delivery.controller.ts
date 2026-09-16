import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { DeliveryService } from './delivery.service';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { DeliveryScheduleStatus } from '@prisma/client';

@ApiTags('Delivery')
@Controller('delivery')
export class DeliveryController {
  constructor(private readonly deliveryService: DeliveryService) {}

  @ApiOperation({
    summary: 'Mijoz uchun eng yaqin yetkazib berish sanasini olish',
  })
  @Public()
  @Get('availability')
  getAvailability() {
    return this.deliveryService.getAvailability();
  }

  @ApiOperation({
    summary:
      'Admin uchun yetkazib berish kunlik slotlari va bandligini ko`rish',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('admin/schedule')
  getAdminSchedule(@Query('days') days?: string) {
    const limit = days ? parseInt(days, 10) : 14;
    return this.deliveryService.getAdminSchedule(limit);
  }

  @ApiOperation({ summary: 'Admin uchun kunlik slot sig`imini o`zgartirish' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('admin/schedule/:dateString')
  updateCapacity(
    @Param('dateString') dateString: string,
    @Body() dto: { capacity: number; status?: DeliveryScheduleStatus },
  ) {
    return this.deliveryService.updateCapacity(
      dateString,
      dto.capacity,
      dto.status,
    );
  }
}
