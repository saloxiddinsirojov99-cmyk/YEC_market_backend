import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { BaskoFieldMappingService } from './basko-field-mapping.service';
import { BaskoExcelImportService } from './basko-excel-import.service';
import { BaskoProductNormalizer } from './basko-product.normalizer';
import { BaskoSyncService } from './basko-sync.service';
import { BaskoSyncLogService } from './basko-sync-log.service';
import { BaskoIntegrationService } from './basko-integration.service';

@Module({
  imports: [PrismaModule],
  providers: [
    BaskoFieldMappingService,
    BaskoExcelImportService,
    BaskoProductNormalizer,
    BaskoSyncService,
    BaskoSyncLogService,
    BaskoIntegrationService,
  ],
  exports: [
    BaskoIntegrationService,
    BaskoExcelImportService,
    BaskoProductNormalizer,
    BaskoFieldMappingService,
    BaskoSyncService,
    BaskoSyncLogService,
  ],
})
export class BaskoModule {}
