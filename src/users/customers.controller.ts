import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CustomersService } from './customers.service';

@ApiTags('Customers & Loyalty')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.ADMIN, UserRole.SUPERADMIN, UserRole.OPERATOR)
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @ApiOperation({ summary: 'Mijozlar ro`yxatini olish' })
  @Get()
  findAll(
    @Query('search') search?: string,
    @Query('loyaltyStatus') loyaltyStatus?: string,
    @Query('registrationType') registrationType?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.customersService.findAll({
      search,
      loyaltyStatus,
      registrationType,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @ApiOperation({ summary: 'Telefon raqam bo`yicha mijozni qidirish' })
  @Get('lookup')
  lookupByPhone(@Query('phone') phone: string) {
    return this.customersService.lookupByPhone(phone);
  }

  @ApiOperation({ summary: 'Mijoz ma`lumotlarini olish' })
  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.customersService.findOne(id);
  }

  @ApiOperation({ summary: 'Mijozni ro`yxatga olish (Tezkor / To`liq)' })
  @Post('register')
  register(
    @Body()
    dto: {
      name: string;
      phone: string;
      email?: string;
      address?: string;
      notes?: string;
      birthDate?: string;
      telegramUsername?: string;
    },
  ) {
    return this.customersService.register(dto);
  }

  @ApiOperation({ summary: 'Offline mijoz qo`shish' })
  @Post('offline')
  createOffline(
    @Body()
    dto: {
      name: string;
      phone: string;
      email?: string;
      address?: string;
      notes?: string;
      birthDate?: string;
      telegramUsername?: string;
    },
  ) {
    return this.customersService.createOffline(dto);
  }

  @ApiOperation({ summary: 'Mijoz ma`lumotlarini yangilash' })
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body()
    dto: {
      name?: string;
      phone?: string;
      email?: string;
      address?: string;
      notes?: string;
      birthDate?: string;
      telegramUsername?: string;
      loyaltyPoints?: number;
      loyaltyStatus?: string;
    },
  ) {
    return this.customersService.update(id, dto);
  }

  @ApiOperation({ summary: 'Marketing yoki individual SMS yuborish' })
  @Post('sms')
  sendMarketingSms(
    @Body()
    dto: {
      target: 'ALL' | 'BRONZE' | 'SILVER' | 'GOLD' | 'SPECIFIC';
      phoneNumbers?: string[];
      message: string;
    },
  ) {
    return this.customersService.sendMarketingSms(dto);
  }

  @ApiOperation({
    summary: 'Mijozga SMS tasdiqlash kodini yuborish (Operator/Admin)',
  })
  @Post('send-code')
  sendSmsCode(
    @Body()
    dto: {
      phone: string;
      code?: string;
      customNote?: string;
    },
  ) {
    return this.customersService.sendSmsCode(dto);
  }
}
