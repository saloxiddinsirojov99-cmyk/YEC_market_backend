import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { InventoryService } from './inventory.service';
import { RollInventoryService } from './roll-inventory.service';
import { InventoryController } from './inventory.controller';

@Module({
  imports: [PrismaModule],
  controllers: [InventoryController],
  providers: [InventoryService, RollInventoryService],
  exports: [InventoryService, RollInventoryService],
})
export class InventoryModule {}
