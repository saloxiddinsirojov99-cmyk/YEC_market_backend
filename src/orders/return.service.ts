import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  ReturnRequestStatus,
  RollAllocationStatus,
  CarpetInventoryStatus,
} from '@prisma/client';
import { RollInventoryService } from '../inventory/roll-inventory.service';
import { TelegramService } from '../telegram/telegram.service';

@Injectable()
export class ReturnService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rollInventoryService: RollInventoryService,
    private readonly telegramService: TelegramService,
  ) {}

  async createReturnRequest(
    orderId: string,
    userId: string,
    dto: { reason: string; explanation: string; images?: string[] },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { rollAllocation: true } } },
    });

    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.customerId !== userId) {
      throw new BadRequestException('Bu buyurtma sizga tegishli emas.');
    }

    if (order.status !== 'DELIVERED' || !order.deliveryCompletedAt) {
      throw new BadRequestException(
        "Faqat yetkazib berilgan buyurtmalarni qaytarish so'rovi berilishi mumkin.",
      );
    }

    const elapsedMs = Date.now() - order.deliveryCompletedAt.getTime();
    const twentyFourHoursMs = 24 * 60 * 60 * 1000;
    if (elapsedMs > twentyFourHoursMs) {
      throw new BadRequestException('Qaytarish muddati (24 soat) tugagan.');
    }

    // Check if there is already a return request
    const existing = await this.prisma.returnRequest.findUnique({
      where: { orderId },
    });
    if (existing) {
      throw new BadRequestException(
        "Ushbu buyurtma uchun qaytarish so'rovi yuborilgan.",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const req = await tx.returnRequest.create({
        data: {
          orderId,
          reason: dto.reason,
          explanation: dto.explanation,
          images: dto.images || [],
          status: ReturnRequestStatus.RETURN_REQUESTED,
        },
      });

      await tx.order.update({
        where: { id: orderId },
        data: { status: 'RETURN_REQUESTED' },
      });

      const totalAmount = order.items.reduce(
        (sum, item) => sum + Number(item.price) * item.quantity,
        0,
      );
      const depositAmount = Number(order.depositAmount || 0);

      const message =
        `━━━━━━━━━━━━━━━\n` +
        `🔄 <b>QAYTARISH SO'ROVI</b>\n\n` +
        `<b>Buyurtma ID:</b> #${order.id}\n` +
        `<b>Mijoz:</b> ${order.customerName || 'Mijoz'}\n` +
        `<b>Telefon:</b> ${order.phone}\n` +
        `<b>Manzil:</b> ${order.address || "Ko'rsatilmagan"}\n` +
        `<b>Buyurtma summasi:</b> ${totalAmount.toLocaleString('uz-UZ')} so'm\n` +
        `<b>Oldindan to'langan:</b> ${depositAmount.toLocaleString('uz-UZ')} so'm\n` +
        `<b>Qaytarish sababi:</b> ${dto.reason || "Ko'rsatilmadi"}\n` +
        `━━━━━━━━━━━━━━━`;

      const replyMarkup = {
        inline_keyboard: [
          [
            {
              text: '✅ Tasdiqlash',
              callback_data: `admin_return_approve_${order.id}`,
            },
            {
              text: '❌ Rad etish',
              callback_data: `admin_return_reject_${order.id}`,
            },
          ],
        ],
      };

      try {
        await this.telegramService.notifyAdmins(
          message,
          undefined,
          replyMarkup,
        );
      } catch (err) {
        console.error(
          'Failed to send return request telegram alert:',
          err.message,
        );
      }

      return req;
    });
  }

  private async generateUniqueBarcode(tx: any): Promise<string> {
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const num = Math.floor(10000000 + Math.random() * 90000000);
      const barcodeStr = String(num);
      const existing = await tx.carpet.findUnique({
        where: { barcode: barcodeStr },
      });
      if (!existing) {
        return barcodeStr;
      }
    }
    throw new BadRequestException(
      'Barcode generatsiya qilish urinishlari soni oshib ketdi (100 marta).',
    );
  }

  private async generateUniqueSku(
    tx: any,
    designCode: string,
    widthCm: number,
    lengthCm: number,
  ): Promise<string> {
    const cleanDesign = (designCode || 'UNKNOWN')
      .trim()
      .replace(/[^a-zA-Z0-9]/g, '')
      .toUpperCase();
    let counter = 1;
    let attempts = 0;
    while (attempts < 100) {
      attempts++;
      const paddedCounter = String(counter).padStart(4, '0');
      const skuStr = `RET-${cleanDesign}-${widthCm}-${lengthCm}-${paddedCounter}`;
      const existing = await tx.carpet.findUnique({
        where: { sku: skuStr },
      });
      if (!existing) {
        return skuStr;
      }
      counter++;
    }
    throw new BadRequestException(
      'SKU generatsiya qilish urinishlari soni oshib ketdi.',
    );
  }

  async approveRefundTransaction(
    orderId: string,
    deliveryCost: number,
    penaltyAmount = 0,
    penaltyReason = 'Delivery Cost / Penalty',
    actor = 'ADMIN',
  ) {
    const request = await this.prisma.returnRequest.findUnique({
      where: { orderId },
      include: {
        order: {
          include: {
            items: {
              include: {
                rollAllocation: true,
                carpet: true,
              },
            },
          },
        },
      },
    });

    if (!request) {
      throw new NotFoundException("Qaytarish so'rovi topilmadi.");
    }

    if (
      request.status !== ReturnRequestStatus.RETURN_REQUESTED &&
      request.status !== ReturnRequestStatus.RETURN_UNDER_REVIEW
    ) {
      throw new BadRequestException("Bu so'rov allaqachon ko'rib chiqilgan.");
    }

    const paidAmount = Number(request.order.paidAmount);
    if (paidAmount <= 0) {
      throw new BadRequestException(
        "To'lov amalga oshirilmagan buyurtmani qaytarib bo'lmaydi.",
      );
    }

    const refundAmount = Math.max(0, paidAmount - deliveryCost - penaltyAmount);

    return this.prisma.$transaction(async (tx) => {
      // Optimistic concurrency locking (check version)
      const freshOrder = await tx.order.findUnique({
        where: { id: orderId },
      });
      if (!freshOrder || freshOrder.version !== request.order.version) {
        throw new BadRequestException(
          "Buyurtma holati o'zgargan. Iltimos sahifani yangilang.",
        );
      }

      // Check if already processed
      const existingReturnedItem = await tx.inventoryItem.findUnique({
        where: { returnRequestId: request.id },
      });
      if (existingReturnedItem) {
        throw new ConflictException(
          "Bu qaytarish so'rovi uchun inventar yozuvi allaqachon yaratilgan.",
        );
      }

      // 1. Update ReturnRequest status
      await tx.returnRequest.update({
        where: { id: request.id },
        data: {
          status: ReturnRequestStatus.RETURN_APPROVED,
          deliveryCost,
          refundAmount,
          penaltyAmount,
          penaltyReason,
          version: { increment: 1 },
        },
      });

      // 2. Update Order status
      await tx.order.update({
        where: { id: orderId, version: freshOrder.version },
        data: {
          status: 'REFUNDED',
          version: { increment: 1 },
        },
      });

      // 3. Register payment history
      await tx.paymentHistory.create({
        data: {
          orderId,
          paymentType: 'REFUND',
          gateway: request.order.paymentMethod || 'CASH',
          transactionId: `REF_TX_${Date.now()}`,
          amount: refundAmount,
          status: 'SUCCESS',
        },
      });

      // 4. Restore Inventories or Create Returned Standalone Carpet
      for (const item of request.order.items) {
        if (!item.carpetId || !item.carpet) continue;

        if (item.isReturnedInventoryCreated) {
          throw new ConflictException(
            'Ushbu mahsulot uchun qaytarilgan inventar yozuvi allaqachon yaratilgan.',
          );
        }

        const parentCarpet = item.carpet;

        const allocations = await tx.orderItemInventory.findMany({
          where: { orderItemId: item.id },
          include: { inventory: true },
        });
        const isAlreadyReturnedItem =
          allocations.length > 0 && allocations[0].inventory.isReturned;

        if (isAlreadyReturnedItem) {
          const targetItem = allocations[0].inventory;
          await tx.inventoryItem.update({
            where: { id: targetItem.id },
            data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
          });

          // Write Audit Log for simple restock of RETURN_ROLL
          await tx.auditLog.create({
            data: {
              action: 'ROLL_RETURN_CONVERTED',
              who: actor,
              orderId,
              oldValue: JSON.stringify({ status: 'SOLD' }),
              newValue: JSON.stringify({ status: 'ACTIVE' }),
              reason: 'Returned roll carpet restocked back to active inventory',
            },
          });
        } else if (item.rollAllocation) {
          const alloc = item.rollAllocation;

          // Parent is a normal ROLL. We create a standalone RETURN_ROLL inventory item!
          const newBarcode = await this.generateUniqueBarcode(tx);
          const newSku = await this.generateUniqueSku(
            tx,
            parentCarpet.designCode || 'DC',
            alloc.widthCm,
            alloc.lengthCm,
          );
          const calculatedArea = (alloc.widthCm * alloc.lengthCm) / 10000;
          const originalPricePerM2 = Number(
            item.pricePerM2 || parentCarpet.price,
          );
          const calculatedPiecePrice = Math.round(
            originalPricePerM2 * calculatedArea,
          );

          const newInventoryItem = await tx.inventoryItem.create({
            data: {
              carpetId: parentCarpet.id,
              barcode: newBarcode,
              sku: newSku,
              widthMm: alloc.widthCm * 10,
              lengthMm: alloc.lengthCm * 10,
              size: `${alloc.widthCm / 100}x${alloc.lengthCm / 100}`,
              pricePerM2: originalPricePerM2,
              piecePrice: calculatedPiecePrice,
              selectedArea: calculatedArea,
              isReturned: true,
              returnRequestId: request.id,
              returnCreatedAt: new Date(),
              returnGeneration: 1,
              inventorySource: 'RETURN',
              sourceOrderId: orderId,
              sourceOrderItemId: item.id,
              inventoryStatus: CarpetInventoryStatus.ACTIVE,
            },
          });

          // Mark allocation status to RETURNED/RESTOCKED
          await tx.orderItemRoll.update({
            where: { id: alloc.id },
            data: { status: RollAllocationStatus.RESTOCKED },
          });

          // Log allocation history
          await tx.rollAllocationHistory.create({
            data: {
              rollInventoryId: alloc.rollInventoryId,
              orderId,
              lengthCm: alloc.lengthCm,
              action: 'RETURNED',
              actor,
            },
          });

          // Write detailed Audit Log
          const durationMs = Date.now() - request.createdAt.getTime();
          await tx.auditLog.create({
            data: {
              action: 'ROLL_RETURN_CONVERTED',
              who: actor,
              orderId,
              oldValue: JSON.stringify({
                oldPrice: parentCarpet.price,
                oldBarcode: parentCarpet.uniqueCode,
                previousStock: 0,
                previousStatus: 'SOLD',
              }),
              newValue: JSON.stringify({
                newInventoryItemId: newInventoryItem.id,
                newBarcode,
                newSku,
                piecePrice: calculatedPiecePrice,
                pricePerM2: originalPricePerM2,
                area: calculatedArea,
                conversionDurationMs: durationMs,
                newStock: 1,
                newStatus: 'ACTIVE',
                inventorySource: 'RETURN',
              }),
              reason:
                'Returned roll carpet successfully converted into individual standalone inventory item',
            },
          });
        } else {
          // Increase ready carpet stock
          const invIds = allocations.map((a) => a.inventoryId);
          if (invIds.length > 0) {
            await tx.inventoryItem.updateMany({
              where: { id: { in: invIds } },
              data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
            });
          }

          // Log inventory ledger
          await tx.inventoryLedger.create({
            data: {
              carpetId: item.carpetId,
              quantity: item.quantity,
              action: 'REFUND',
              actor,
              reason: `Returned & restocked order #${orderId}`,
            },
          });
        }

        // 5. Update OrderItem status
        await tx.orderItem.update({
          where: { id: item.id },
          data: { isReturnedInventoryCreated: true },
        });
      }

      // 6. Enqueue Notification
      await tx.notificationQueue.create({
        data: {
          channel: 'TELEGRAM',
          recipient: request.order.customerId,
          message: `Sizning #${orderId} raqamli buyurtmangiz bo'yicha pul qaytarildi. Qaytarilgan summa: ${refundAmount.toLocaleString('uz-UZ')} so'm.`,
          status: 'PENDING',
        },
      });
    });
  }

  async reviewReturnRequest(
    orderId: string,
    status: ReturnRequestStatus,
    deliveryCost = 0,
    penaltyAmount = 0,
    penaltyReason = 'Admin Approved',
  ) {
    if (status === ReturnRequestStatus.RETURN_APPROVED) {
      return this.approveRefundTransaction(
        orderId,
        deliveryCost,
        penaltyAmount,
        penaltyReason,
        'ADMIN',
      );
    }

    if (status === ReturnRequestStatus.RETURN_REJECTED) {
      return this.prisma.$transaction(async (tx) => {
        const req = await tx.returnRequest.findUnique({ where: { orderId } });
        if (!req) throw new NotFoundException("Qaytarish so'rovi topilmadi.");

        await tx.returnRequest.update({
          where: { id: req.id },
          data: { status: ReturnRequestStatus.RETURN_REJECTED },
        });

        const order = await tx.order.update({
          where: { id: orderId },
          data: { status: 'COMPLETED' },
        });

        // Write Audit Log
        await tx.auditLog.create({
          data: {
            action: 'Return Rejected',
            who: 'ADMIN',
            orderId,
            reason: 'Admin rejected request',
          },
        });

        return order;
      });
    }

    throw new BadRequestException("Noto'g'ri status ko'rsatildi.");
  }

  async processReturnAction(
    orderId: string,
    action: 'RESTOCKED' | 'DISCARDED',
  ) {
    // Legacy action handler (no-op since restocking is wrapped in approveRefundTransaction)
    return { success: true };
  }
}
