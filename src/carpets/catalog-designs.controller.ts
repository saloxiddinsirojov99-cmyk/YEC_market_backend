import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CatalogDesignService } from './catalog-design.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { UserRole } from '../common/enums/user-role.enum';

@ApiTags('Catalog Designs')
@Controller('catalog-designs')
export class CatalogDesignsController {
  constructor(private readonly catalogDesignService: CatalogDesignService) {}

  @ApiOperation({ summary: 'Get filtered catalog design codes' })
  @ApiQuery({ name: 'type', required: false, enum: ['READY', 'ROLL'] })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @Get()
  async getCatalogDesigns(
    @Query('type') type?: 'READY' | 'ROLL',
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? parseInt(page, 10) : undefined;
    const limitNum = limit ? parseInt(limit, 10) : undefined;
    return this.catalogDesignService.getCatalogDesigns({
      type,
      search,
      page: pageNum,
      limit: limitNum,
    });
  }

  @ApiOperation({
    summary:
      'Synchronize YEC Catalog with database and downloads missing codes',
  })
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.ADMIN)
  @Post('sync')
  async syncCatalog() {
    return this.catalogDesignService.syncCatalog();
  }
}
