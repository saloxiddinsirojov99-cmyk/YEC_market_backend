import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
  Res,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CreateOrderDto } from './dto/create-order.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { PreviewPromoDto } from './dto/preview-promo.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { OrdersService } from './orders.service';

@ApiTags('Orders')
@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @ApiOperation({ summary: 'Buyurtma yaratish (customer)' })
  @ApiBearerAuth()
  @ApiBody({ type: CreateOrderDto })
  @ApiResponse({ status: 201, description: 'Buyurtma yaratildi.' })
  @UseGuards(JwtAuthGuard)
  @Post()
  create(@CurrentUser() user: { sub: string }, @Body() dto: CreateOrderDto) {
    return this.ordersService.create(user.sub, dto);
  }

  @ApiOperation({ summary: 'Buyurtmalar ro`yxati (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get()
  findAll(@Query() query: OrderQueryDto) {
    return this.ordersService.findAll(query);
  }

  @ApiOperation({ summary: 'Mening buyurtmalarim (customer)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('my')
  findMine(
    @CurrentUser() user: { sub: string },
    @Query() query: OrderQueryDto,
  ) {
    return this.ordersService.findMy(user.sub, query);
  }

  @ApiOperation({ summary: 'Promokodni oldindan tekshirish (customer)' })
  @ApiBearerAuth()
  @ApiBody({ type: PreviewPromoDto })
  @UseGuards(JwtAuthGuard)
  @Post('promo-preview')
  previewPromo(
    @CurrentUser() user: { sub: string },
    @Body() dto: PreviewPromoDto,
  ) {
    return this.ordersService.previewPromo(user.sub, dto);
  }

  @ApiOperation({ summary: 'Bitda buyurtmani ko`rish' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get(':id')
  findOne(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string; role: string },
  ) {
    return this.ordersService.findOne(id, user.sub, user.role);
  }

  @ApiOperation({ summary: 'Buyurtma statusini yangilash (admin)' })
  @ApiBearerAuth()
  @ApiBody({ type: UpdateOrderStatusDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateOrderStatusDto,
    @CurrentUser() user: { role: string },
  ) {
    return this.ordersService.updateStatus(id, dto, user.role);
  }

  @ApiOperation({ summary: 'Buyurtmani tahrirlash (admin only)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  updateOrder(
    @Param('id') id: string,
    @Body() dto: any,
    @CurrentUser() user: { role: string },
  ) {
    return this.ordersService.updateOrder(id, dto, user.role);
  }

  @ApiOperation({
    summary: 'Buyurtmani qabul qilib olganlikni tasdiqlash (customer)',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id/confirm-delivery')
  confirmDelivery(
    @Param('id') id: string,
    @CurrentUser() user: { sub: string },
  ) {
    return this.ordersService.confirmDelivery(id, user.sub);
  }

  @ApiOperation({ summary: 'Buyurtmani bekor qilish (customer)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Patch(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: { sub: string }) {
    return this.ordersService.cancelMyOrder(id, user.sub);
  }

  @ApiOperation({
    summary: 'Qolgan pul to`langanligini tasdiqlash (admin only)',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/confirm-remaining-payment')
  confirmRemainingPayment(@Param('id') id: string) {
    return this.ordersService.confirmRemainingPayment(id);
  }

  @ApiOperation({ summary: 'Admin Dashboard Metrics' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('dashboard/metrics')
  getDashboardMetrics() {
    return this.ordersService.getDashboardMetrics();
  }

  @ApiOperation({ summary: 'Export Audit Logs as CSV' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('audit-logs/export')
  async exportAuditLogs(@Res() res: Response) {
    const logs = await this.ordersService.getAuditLogs();

    let csv = 'ID,Action,Who,When,IP,OldValue,NewValue,Reason,OrderID\n';
    for (const log of logs) {
      const row = [
        log.id,
        log.action,
        log.who,
        log.when.toISOString(),
        log.ip || '',
        (log.oldValue || '').replace(/"/g, '""'),
        (log.newValue || '').replace(/"/g, '""'),
        (log.reason || '').replace(/"/g, '""'),
        log.orderId || '',
      ];
      csv += row.map((val) => `"${val}"`).join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=audit-logs.csv');
    return res.send(csv);
  }

  @ApiOperation({
    summary: 'Metraj gilam kesilganligini tasdiqlash (admin only)',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id/item/:itemId/cut')
  markItemAsCut(@Param('id') id: string, @Param('itemId') itemId: string) {
    return this.ordersService.markItemAsCut(id, itemId);
  }

  @ApiOperation({ summary: 'Depozit sozlamalarini olish (admin only)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('settings/deposit')
  getDepositSettings() {
    return this.ordersService.getDepositSettings();
  }

  @ApiOperation({ summary: 'Depozit sozlamalarini yangilash (admin only)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Put('settings/deposit')
  updateDepositSettings(@Body() dto: any) {
    return this.ordersService.updateDepositSettings(dto);
  }
}
