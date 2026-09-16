import { Module } from '@nestjs/common';
import { CarpetsController } from './carpets.controller';
import { CarpetsService } from './carpets.service';
import { CarpetsRepository } from './carpets.repository';
import { CacheService } from '../common/cache.service';
import { CatalogDesignService } from './catalog-design.service';
import { CatalogDesignsController } from './catalog-designs.controller';
import { SearchService } from './search.service';

@Module({
  controllers: [CarpetsController, CatalogDesignsController],
  providers: [
    CarpetsService,
    CarpetsRepository,
    CacheService,
    CatalogDesignService,
    SearchService,
  ],
  exports: [
    CarpetsService,
    CarpetsRepository,
    CacheService,
    CatalogDesignService,
    SearchService,
  ],
})
export class CarpetsModule {}
