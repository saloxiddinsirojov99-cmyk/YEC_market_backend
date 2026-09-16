import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CarpetInventoryStatus, InventoryStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async releaseExpiredReservations(): Promise<void> {
    const now = new Date();
    const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const expired = await this.prisma.inventoryItem.findMany({
      where: {
        inventoryStatus: CarpetInventoryStatus.RESERVED,
        allocations: {
          some: {
            orderItem: {
              order: {
                status: 'PENDING',
                createdAt: { lt: twentyFourHoursAgo },
              },
            },
          },
        },
      },
      include: {
        allocations: {
          include: {
            orderItem: true,
          },
        },
      },
    });

    if (expired.length === 0) return;
    this.logger.log(
      `Muddati otgan rezervlar: ${expired.length} ta qaytarilmoqda...`,
    );
    await this.prisma.$transaction(async (tx) => {
      for (const item of expired) {
        const orderId = item.allocations[0]?.orderItem.orderId;
        await tx.inventoryItem.update({
          where: { id: item.id },
          data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
        });
        await tx.inventoryHistory.create({
          data: {
            inventoryId: item.id,
            oldStatus: InventoryStatus.RESERVED,
            newStatus: InventoryStatus.AVAILABLE,
            reason: 'Reservation timeout (24h)',
            orderId,
          },
        });
      }
    });
    this.logger.log(`${expired.length} ta rezerv ACTIVE ga qaytarildi.`);
  }

  async allocateFIFO(
    tx: Prisma.TransactionClient,
    carpetId: string,
    quantity: number,
    orderId: string,
  ): Promise<{ id: string; barcode: string }[]> {
    const inventories = await tx.$queryRaw<any[]>`
      SELECT id, "barcode" as barcode
      FROM inventory_items
      WHERE "carpetId" = ${carpetId}
        AND "inventoryStatus" = 'ACTIVE'
      ORDER BY "createdAt" ASC
      LIMIT ${quantity}
      FOR UPDATE SKIP LOCKED
    `;
    if (inventories.length < quantity) {
      const carpet = await tx.carpet.findUnique({
        where: { id: carpetId },
        select: { name: true },
      });
      throw new BadRequestException(
        `"${carpet?.name ?? carpetId}" gilamidan omborda yetarli emas. Soralgan: ${quantity}, mavjud: ${inventories.length}`,
      );
    }
    const ids = inventories.map((i) => i.id);
    await tx.inventoryItem.updateMany({
      where: { id: { in: ids } },
      data: { inventoryStatus: CarpetInventoryStatus.RESERVED },
    });
    for (const inv of inventories) {
      await tx.inventoryHistory.create({
        data: {
          inventoryId: inv.id,
          oldStatus: InventoryStatus.AVAILABLE,
          newStatus: InventoryStatus.RESERVED,
          reason: 'Order created',
          orderId,
        },
      });
    }
    return inventories.map((i) => ({ id: i.id, barcode: i.barcode }));
  }

  async markInventorySold(
    tx: Prisma.TransactionClient,
    orderItemIds: string[],
    orderId: string,
  ): Promise<void> {
    const allocations = await tx.orderItemInventory.findMany({
      where: { orderItemId: { in: orderItemIds } },
      select: { inventoryId: true },
    });
    const inventoryIds = allocations.map((a) => a.inventoryId);
    if (inventoryIds.length === 0) return;
    await tx.inventoryItem.updateMany({
      where: {
        id: { in: inventoryIds },
        inventoryStatus: CarpetInventoryStatus.RESERVED,
      },
      data: { inventoryStatus: CarpetInventoryStatus.SOLD },
    });
    for (const invId of inventoryIds) {
      await tx.inventoryHistory.create({
        data: {
          inventoryId: invId,
          oldStatus: InventoryStatus.RESERVED,
          newStatus: InventoryStatus.SOLD,
          reason: 'Order delivered',
          orderId,
        },
      });
    }
  }

  async releaseInventory(
    tx: Prisma.TransactionClient,
    orderItemIds: string[],
    orderId: string,
  ): Promise<{ carpetId: string; quantity: number }[]> {
    const allocations = await tx.orderItemInventory.findMany({
      where: { orderItemId: { in: orderItemIds } },
      include: {
        inventory: {
          select: { id: true, carpetId: true, inventoryStatus: true },
        },
      },
    });
    if (allocations.length === 0) return [];
    const inventoryIds = allocations.map((a) => a.inventoryId);
    await tx.inventoryItem.updateMany({
      where: {
        id: { in: inventoryIds },
        inventoryStatus: {
          in: [CarpetInventoryStatus.RESERVED, CarpetInventoryStatus.SOLD],
        },
      },
      data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
    });
    for (const alloc of allocations) {
      if (
        alloc.inventory.inventoryStatus === CarpetInventoryStatus.RESERVED ||
        alloc.inventory.inventoryStatus === CarpetInventoryStatus.SOLD
      ) {
        await tx.inventoryHistory.create({
          data: {
            inventoryId: alloc.inventoryId,
            oldStatus:
              alloc.inventory.inventoryStatus === CarpetInventoryStatus.RESERVED
                ? InventoryStatus.RESERVED
                : InventoryStatus.SOLD,
            newStatus: InventoryStatus.AVAILABLE,
            reason: 'Order cancelled',
            orderId,
          },
        });
      }
    }
    const grouped = new Map<string, number>();
    for (const alloc of allocations) {
      const carpetId = alloc.inventory.carpetId;
      grouped.set(carpetId, (grouped.get(carpetId) ?? 0) + 1);
    }
    return Array.from(grouped.entries()).map(([carpetId, quantity]) => ({
      carpetId,
      quantity,
    }));
  }

  async checkStockSync(carpetId: string): Promise<void> {
    const availableCount = await this.prisma.inventoryItem.count({
      where: { carpetId, inventoryStatus: CarpetInventoryStatus.ACTIVE },
    });
    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
      select: { name: true },
    });
    if (!carpet) return;
    this.logger.log(
      `Stock check for "${carpet.name}": ACTIVE count=${availableCount}`,
    );
  }

  async createInventoryEntry(carpetId: string, barcode: string) {
    const existing = await this.prisma.inventoryItem.findUnique({
      where: { barcode },
    });
    if (existing)
      throw new ConflictException(
        `Shtrix kodi "${barcode}" allaqachon mavjud.`,
      );
    const carpet = await this.prisma.carpet.findUnique({
      where: { id: carpetId },
    });
    if (!carpet) throw new BadRequestException('Gilam topilmadi.');

    const entry = await this.prisma.$transaction(async (tx) => {
      const e = await tx.inventoryItem.create({
        data: {
          carpetId,
          barcode,
          sku: `SKU-${barcode}`,
          widthMm: 2000, // Default fallbacks
          lengthMm: 3000,
          size: '2x3',
          inventoryStatus: CarpetInventoryStatus.ACTIVE,
        },
      });
      await tx.inventoryHistory.create({
        data: {
          inventoryId: e.id,
          oldStatus: InventoryStatus.AVAILABLE,
          newStatus: InventoryStatus.AVAILABLE,
          reason: 'Initial creation',
        },
      });
      return e;
    });
    return {
      id: entry.id,
      barcode: entry.barcode,
      status: entry.inventoryStatus,
    };
  }

  async findInventories(query: {
    status?: string;
    code?: string;
    carpetName?: string;
    page?: number;
    limit?: number;
  }) {
    const { status, code, carpetName, page = 1, limit = 50 } = query;
    const skip = (page - 1) * limit;
    const where: Prisma.InventoryItemWhereInput = {};
    if (
      status &&
      Object.values(CarpetInventoryStatus).includes(
        status as CarpetInventoryStatus,
      )
    ) {
      where.inventoryStatus = status as CarpetInventoryStatus;
    }
    if (code) where.barcode = { contains: code, mode: 'insensitive' };
    if (carpetName)
      where.carpet = { name: { contains: carpetName, mode: 'insensitive' } };
    const [items, total] = await Promise.all([
      this.prisma.inventoryItem.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          carpet: { select: { id: true, name: true, material: true } },
        },
      }),
      this.prisma.inventoryItem.count({ where }),
    ]);
    return {
      items,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }
}
