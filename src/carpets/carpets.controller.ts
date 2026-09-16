import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../common/decorators/public.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import {
  CurrentUser,
  CurrentUserPayload,
} from '../common/decorators/current-user.decorator';
import { UserRole } from '../common/enums/user-role.enum';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { OptionalJwtAuthGuard } from '../common/guards/optional-jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CarpetsService } from './carpets.service';
import { CreateCarpetDto } from './dto/create-carpet.dto';
import { CarpetQueryDto } from './dto/carpet-query.dto';
import { UpdateCarpetDto } from './dto/update-carpet.dto';
import { UpdateCarpetDiscountDto } from './dto/update-carpet-discount.dto';
import { UpdateCarpetM2PriceDto } from './dto/update-carpet-m2-price.dto';

@ApiTags('Carpets')
@Controller('carpets')
export class CarpetsController {
  constructor(private readonly carpetsService: CarpetsService) {}

  @ApiOperation({ summary: 'Gilamlar ro`yxati' })
  @ApiResponse({ status: 200, description: "Gilamlar ro'yxati." })
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get()
  findAll(@Query() query: CarpetQueryDto, @Req() req: any) {
    return this.carpetsService.findAll(query, req.user?.sub);
  }

  @ApiOperation({ summary: 'Foydalanuvchi yoqtirgan gilamlar' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Get('liked')
  getLikedCarpets(@Req() req: any) {
    return this.carpetsService.findLikedCarpets(req.user.sub);
  }

  @ApiOperation({ summary: 'Gilam kolleksiya nomlari ro`yxati (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('names')
  getDistinctNames(@Query('kind') kind?: string) {
    return this.carpetsService.getDistinctNames(kind);
  }

  @ApiOperation({ summary: 'Faol skidkalar ro`yxati (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('discounts')
  getDiscountGroups() {
    return this.carpetsService.getDiscountGroups();
  }

  @ApiOperation({ summary: 'Nom bo`yicha m2 narxini topish (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('m2-price')
  getCollectionM2Price(@Query('name') name: string) {
    return this.carpetsService.getCollectionM2Price(name);
  }

  @Get('material')
  getMaterial(@Query('name') name: string) {
    return this.carpetsService.getMaterialByName(name);
  }

  @ApiOperation({ summary: 'Kolleksiya bo`yicha skidka qo`shish (admin)' })
  @ApiBearerAuth()
  @ApiBody({ type: UpdateCarpetDiscountDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('discount')
  updateDiscount(@Body() dto: UpdateCarpetDiscountDto) {
    return this.carpetsService.updateDiscountByNames(dto);
  }

  @ApiOperation({ summary: 'Kolleksiya bo`yicha m2 narxini yangilash (admin)' })
  @ApiBearerAuth()
  @ApiBody({ type: UpdateCarpetM2PriceDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('m2-price')
  updateM2Price(@Body() dto: UpdateCarpetM2PriceDto) {
    return this.carpetsService.updateM2PriceByNames(dto);
  }

  @ApiOperation({ summary: 'Predefined carpet names list' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('predefined-names')
  async getPredefinedNames() {
    return this.carpetsService.getPredefinedNames();
  }

  @ApiOperation({ summary: 'Create predefined carpet name/design' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('predefined-names')
  async createPredefinedName(
    @Body()
    dto: {
      name: string;
      designCode: string;
      images: string[];
      categoryId?: string;
      material?: string;
      brand?: string;
      pricePerM2?: number;
    },
  ) {
    return this.carpetsService.createPredefinedName(dto);
  }

  @ApiOperation({ summary: 'Update predefined carpet name/design' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch('predefined-names/:id')
  async updatePredefinedName(
    @Param('id') id: string,
    @Body()
    dto: {
      name?: string;
      designCode?: string;
      images?: string[];
      categoryId?: string;
      material?: string;
      brand?: string;
      pricePerM2?: number;
    },
  ) {
    return this.carpetsService.updatePredefinedName(id, dto);
  }

  @ApiOperation({ summary: 'Delete predefined carpet name/design' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete('predefined-names/:id')
  async deletePredefinedName(@Param('id') id: string) {
    return this.carpetsService.deletePredefinedName(id);
  }

  @ApiOperation({ summary: 'Bitta gilamni olish' })
  @ApiResponse({ status: 200, description: "Gilam ma'lumoti." })
  @Public()
  @UseGuards(OptionalJwtAuthGuard)
  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: any) {
    return this.carpetsService.findOne(id, req.user?.sub);
  }

  @ApiOperation({ summary: 'Gilamga like bosish yoki olib tashlash' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @Post(':id/like')
  toggleLike(@Param('id') id: string, @Req() req: any) {
    return this.carpetsService.toggleLike(id, req.user.sub);
  }

  @ApiOperation({ summary: 'Gilam qo`shish (admin)' })
  @ApiBearerAuth()
  @ApiBody({ type: CreateCarpetDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post()
  create(
    @Body() dto: CreateCarpetDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.carpetsService.create(dto, user.sub);
  }

  @ApiOperation({ summary: 'Shtrix-kod mavjudligini tekshirish (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Get('check-barcode/:barcode')
  async checkBarcode(@Param('barcode') barcode: string) {
    const exists = await this.carpetsService.checkBarcodeExists(barcode);
    return { exists };
  }

  @ApiOperation({ summary: 'Gilamni tahrirlash (admin)' })
  @ApiBearerAuth()
  @ApiBody({ type: UpdateCarpetDto })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateCarpetDto,
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.carpetsService.update(id, dto, user.role, user.sub);
  }

  @ApiOperation({ summary: "Gilamni o'chirish (admin)" })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.carpetsService.remove(id);
  }

  @ApiOperation({ summary: 'Excel import batch endpoint (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('import-batch')
  importBatch(
    @Body() dto: { type: string; items: any[] },
    @CurrentUser() user: CurrentUserPayload,
  ) {
    return this.carpetsService.importBatch(dto, user.sub);
  }

  @ApiOperation({ summary: 'Excel import audit log endpoint (admin)' })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('import-log')
  async saveImportLog(@Body() dto: any, @Req() req: any) {
    const user = req.user;
    const dbUser = await this.carpetsService.getUserById(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      (user.sub as string) || (user.id as string),
    );
    const userName = dbUser?.name || 'Admin';
    const userEmail = dbUser?.email || 'admin@yecmarket.uz';

    // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
    return this.carpetsService.saveImportLog({
      ...dto,
      userName,
      userEmail,
    });
  }

  @ApiOperation({ summary: 'Filter uchun faol gilam nomlarini olish' })
  @Public()
  @Get('filter/names')
  async getFilterNames(@Query('kind') kind?: string) {
    const data = await this.carpetsService.getFilterNames(kind);
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Filter uchun faol materiallarni olish' })
  @Public()
  @Get('filter/materials')
  async getFilterMaterials(@Query('kind') kind?: string) {
    const data = await this.carpetsService.getFilterMaterials(kind);
    return { success: true, data };
  }

  @ApiOperation({ summary: 'Filter uchun faol o`lchamlarni olish' })
  @Public()
  @Get('filter/sizes')
  async getFilterSizes(@Query('kind') kind?: string) {
    const data = await this.carpetsService.getFilterSizes(kind);
    return { success: true, data };
  }
}
