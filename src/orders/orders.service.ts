import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  OrderStatus,
  Prisma,
  UserRole,
  CarpetInventoryStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { CreateOrderItemDto } from './dto/create-order-item.dto';
import { OrderQueryDto } from './dto/order-query.dto';
import { PreviewPromoDto } from './dto/preview-promo.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { MailService } from '../mail/mail.service';
import { TelegramService } from '../telegram/telegram.service';
import { ConfigService } from '@nestjs/config';
import { PushNotificationService } from '../notifications/push-notification.service';
import { formatOrderNumber } from '../common/utils/order-number';
import { InventoryService } from '../inventory/inventory.service';
import { RollInventoryService } from '../inventory/roll-inventory.service';
import { SmsService } from '../notifications/sms.service';
import { DeliveryService } from '../delivery/delivery.service';
import { AuditService } from './audit.service';

type ResolvedPromoCode = {
  id: string;
  code: string;
  discountPercent: number;
  isActive: boolean;
  startsAt: Date | null;
  expiresAt: Date | null;
  minOrderAmount: number;
  type: 'DISCOUNT' | 'GIFT';
  giftName: string | null;
  giftImage: string | null;
  giftPrice: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type CarpetSnapshot = {
  id: string;
  price: unknown;
  discountPercent: number;
  stock: number;
  name: string;
  categoryId: string | null;
  type: string;
  images?: string[];
  barcode?: string;
};

type OrderPricingItem = {
  carpetId: string;
  carpetName: string;
  quantity: number;
  originalUnitPrice: number;
  carpetDiscountPercent: number;
  unitPriceAfterCarpetDiscount: number;
  promoDiscountPercent: number;
  unitPriceAfterPromo: number;
  lineOriginalTotal: number;
  lineAfterCarpetDiscountTotal: number;
  lineTotal: number;
  lineProductDiscountAmount: number;
  linePromoDiscountAmount: number;
  lineTotalDiscountAmount: number;
};

type OrderPricingSummary = {
  items: OrderPricingItem[];
  totalOriginalAmount: number;
  subtotalAfterCarpetDiscount: number;
  totalAfterPromo: number;
  productDiscountAmount: number;
  promoDiscountAmount: number;
  totalDiscountAmount: number;
  totalDiscountPercent: number;
};

@Injectable()
export class OrdersService implements OnModuleInit {
  private readonly orderTransitionMap: Record<OrderStatus, OrderStatus[]> = {
    PENDING: [OrderStatus.ACCEPTED, OrderStatus.CANCELLED],
    ACCEPTED: [
      OrderStatus.CUTTING,
      OrderStatus.READY_FOR_DELIVERY,
      OrderStatus.CANCELLED,
      OrderStatus.CANCEL_REQUESTED,
    ],
    CUTTING: [
      OrderStatus.READY_FOR_DELIVERY,
      OrderStatus.CANCELLED,
      OrderStatus.CANCEL_REQUESTED,
    ],
    READY_FOR_DELIVERY: [
      OrderStatus.ON_WAY,
      OrderStatus.CANCELLED,
      OrderStatus.CANCEL_REQUESTED,
    ],
    ON_WAY: [OrderStatus.DELIVERED],
    DELIVERED: [OrderStatus.COMPLETED, OrderStatus.RETURN_REQUESTED],
    CANCEL_REQUESTED: [
      OrderStatus.CANCELLED,
      OrderStatus.ACCEPTED,
      OrderStatus.CUTTING,
      OrderStatus.READY_FOR_DELIVERY,
    ],
    RETURN_REQUESTED: [
      OrderStatus.RETURN_APPROVED,
      OrderStatus.RETURN_REJECTED,
    ],
    RETURN_APPROVED: [OrderStatus.REFUNDED],
    RETURN_REJECTED: [OrderStatus.COMPLETED],
    COMPLETED: [],
    CANCELLED: [],
    REFUNDED: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailService: MailService,
    private readonly telegramService: TelegramService,
    private readonly configService: ConfigService,
    private readonly pushNotificationService: PushNotificationService,
    private readonly inventoryService: InventoryService,
    private readonly rollInventoryService: RollInventoryService,
    private readonly smsService: SmsService,
    private readonly deliveryService: DeliveryService,
    private readonly auditService: AuditService,
  ) {}

  async onModuleInit() {
    setImmediate(async () => {
      try {
        // 1. Repair legacy ROLL items that don't have new dimensions/prices persisted
        const legacyItems = await this.prisma.orderItem.findMany({
          where: {
            carpet: { type: 'ROLL' },
            rollAllocation: { isNot: null },
            pricePerM2: null,
          },
          include: {
            rollAllocation: true,
            carpet: true,
          },
        });

        if (legacyItems.length > 0) {
          console.log(
            `Found ${legacyItems.length} legacy ROLL order items. Starting migration...`,
          );
          for (const item of legacyItems) {
            if (item.rollAllocation) {
              const widthCm = item.rollAllocation.widthCm;
              const lengthCm = item.rollAllocation.lengthCm;
              const area = (widthCm * lengthCm) / 10000;

              // Historical price was stored as price per m2, so finalPrice is basePrice * area
              const pricePerM2 = Number(item.price);
              const finalPrice = Math.round(pricePerM2 * area);

              await this.prisma.orderItem.update({
                where: { id: item.id },
                data: {
                  pricePerM2: pricePerM2,
                  selectedArea: area,
                  selectedWidthCm: widthCm,
                  selectedLengthCm: lengthCm,
                  price: finalPrice,
                  carpetName: item.carpet?.name || null,
                  carpetImage: item.carpet?.images?.[0] || null,
                  carpetBarcode: item.carpet?.uniqueCode || null,
                },
              });
            }
          }
          console.log(
            `Successfully migrated ${legacyItems.length} legacy ROLL order items to new schema.`,
          );
        }

        // 2. Also populate snapshot fields (carpetName, carpetImage, carpetBarcode) for any READY/Prayer items where they are null
        const unpopulatedItems = await this.prisma.orderItem.findMany({
          where: {
            carpetName: null,
            carpetId: { not: null },
          },
          include: {
            carpet: true,
          },
        });

        if (unpopulatedItems.length > 0) {
          console.log(
            `Found ${unpopulatedItems.length} unpopulated historical snapshot order items. Populating...`,
          );
          for (const item of unpopulatedItems) {
            const carpet = (item as any).carpet;
            if (carpet) {
              const firstItem = await this.prisma.inventoryItem.findFirst({
                where: { carpetId: carpet.id },
              });
              await this.prisma.orderItem.update({
                where: { id: item.id },
                data: {
                  carpetName: carpet.name,
                  carpetImage: carpet.images?.[0] || null,
                  carpetBarcode: firstItem?.barcode || carpet.uniqueCode,
                },
              });
            }
          }
          console.log(
            `Successfully populated ${unpopulatedItems.length} unpopulated snapshot order items.`,
          );
        }
      } catch (err) {
        console.error('Error in legacy order items migration:', err);
      }
    });
  }

  async calculateDepositDetails(
    customerId: string,
    totalAmount: number,
    tx?: any,
  ): Promise<{ depositPercent: number; depositAmount: number }> {
    const client = tx || this.prisma;

    // 1. Fetch settings and tiers
    const settings = await client.recommendationSettings.findUnique({
      where: { id: 'singleton' },
    });
    const minDeposit = settings ? Number(settings.minDeposit) : 100000;
    const maxDeposit = settings ? Number(settings.maxDeposit) : 2000000;
    const loyalCountTier1 = settings ? settings.loyalCountTier1 : 3;
    const loyalCountTier2 = settings ? settings.loyalCountTier2 : 10;
    const loyalDiscountTier1 = settings ? settings.loyalDiscountTier1 : 5.0;
    const loyalDiscountTier2 = settings ? settings.loyalDiscountTier2 : 5.0;

    const tiers = await client.depositTier.findMany({
      orderBy: { minAmount: 'asc' },
    });

    // 2. Determine base percentage from tiers
    let basePercent = 30; // default fallback
    for (const tier of tiers) {
      if (
        totalAmount >= Number(tier.minAmount) &&
        totalAmount <= Number(tier.maxAmount)
      ) {
        basePercent = tier.percent;
        break;
      }
    }

    // 3. Check customer history
    const completedOrdersCount = await client.order.count({
      where: {
        customerId,
        status: 'COMPLETED',
      },
    });

    let discount = 0;
    if (completedOrdersCount >= loyalCountTier2) {
      discount = loyalDiscountTier1 + loyalDiscountTier2; // default -10% total
    } else if (completedOrdersCount >= loyalCountTier1) {
      discount = loyalDiscountTier1; // default -5%
    }

    const finalPercent = Math.max(0, basePercent - discount);

    // 4. Calculate initial deposit amount
    let depositAmount = Math.round((totalAmount * finalPercent) / 100);

    // 5. Enforce min/max constraints
    if (depositAmount < minDeposit) {
      depositAmount = minDeposit;
    }
    if (depositAmount > maxDeposit) {
      depositAmount = maxDeposit;
    }

    // Must not exceed total amount
    if (depositAmount > totalAmount) {
      depositAmount = totalAmount;
    }

    const finalPercentRecalculated =
      totalAmount > 0 ? Math.round((depositAmount * 100) / totalAmount) : 0;

    return {
      depositPercent: finalPercentRecalculated,
      depositAmount,
    };
  }

  async create(customerId: string, dto: CreateOrderDto) {
    const normalizedPromoCode = this.normalizePromoCode(dto.promoCode);

    const finalDeliveryDateString =
      await this.deliveryService.validateAndReserveSlot(dto.deliveryDateString);

    try {
      return await this.prisma.$transaction(async (tx) => {
        const currentUser = await tx.user.findUnique({
          where: { id: customerId },
          select: { id: true, telegramChatId: true },
        });

        if (!currentUser) {
          throw new BadRequestException('Foydalanuvchi topilmadi.');
        }

        if (
          !this.isInsideUzbekistan(
            Number(dto.locationLat),
            Number(dto.locationLng),
          )
        ) {
          throw new BadRequestException(
            "Tanlangan manzil O'zbekiston hududidan tashqarida. Buyurtma berib bo'lmaydi.",
          );
        }

        const carpetMap = await this.loadCarpetMap(tx, dto.items);

        // metraj (ROLL) gilamlarni aniqlash va shartlarni tekshirish
        const rollItems = dto.items.filter(
          (item) => carpetMap.get(item.carpetId)?.type === 'ROLL',
        );
        if (rollItems.length > 0 && !dto.termsAccepted) {
          throw new BadRequestException(
            'Metraj gilam shartlariga rozilik bildirishingiz shart.',
          );
        }

        const rollMap = new Map<string, any>();
        for (const item of dto.items) {
          const carpet = carpetMap.get(item.carpetId);
          if (
            carpet?.type === 'RETURN_ROLL' ||
            carpet?.type === 'RETURN_READY'
          ) {
            if (item.widthCm || item.lengthCm) {
              throw new BadRequestException(
                "Qaytarilgan gilam uchun o'lchamlar tanlanishi mumkin emas (kesilmaydi).",
              );
            }
            if (item.quantity > 1) {
              throw new BadRequestException(
                'Qaytarilgan gilamdan faqat 1 dona xarid qilish mumkin.',
              );
            }
          }
          if (carpet?.type === 'ROLL') {
            if (!item.widthCm || !item.lengthCm) {
              throw new BadRequestException(
                "Metraj gilam uchun kenglik va uzunlik ko'rsatilishi shart.",
              );
            }
            const rollInv = await tx.rollInventory.findUnique({
              where: {
                carpetId_widthCm: {
                  carpetId: item.carpetId,
                  widthCm: item.widthCm,
                },
              },
            });
            if (!rollInv) {
              throw new BadRequestException(
                `"${carpet.name}" gilamining ${item.widthCm} sm kenglikdagi varianti topilmadi.`,
              );
            }
            rollMap.set(`${item.carpetId}_${item.widthCm}`, rollInv);
          }
        }

        const promoCode = await this.resolvePromoCode(
          tx,
          customerId,
          normalizedPromoCode,
        );

        const pricing = this.buildPricingSummary(
          dto.items,
          carpetMap,
          promoCode,
          rollMap,
        );

        if (
          promoCode &&
          promoCode.minOrderAmount > 0 &&
          pricing.subtotalAfterCarpetDiscount < promoCode.minOrderAmount
        ) {
          throw new BadRequestException(
            `Bu promokod ${this.formatCurrency(promoCode.minOrderAmount)}dan oshgan buyurtmalar uchun.`,
          );
        }

        await this.reserveStockAndIncrementSales(tx, dto.items, carpetMap);

        // --- Oldindan to'lov hisob-kitoblari ---
        const totalAmount = pricing.totalAfterPromo;
        const hasRollItems = pricing.items.some(
          (item) => carpetMap.get(item.carpetId)?.type === 'ROLL',
        );
        const depositRequired =
          dto.paymentMethod === 'CLICK' ||
          dto.paymentMethod === 'PAYME' ||
          hasRollItems;

        const { depositPercent, depositAmount } =
          await this.calculateDepositDetails(customerId, totalAmount, tx);

        const paidAmount = 0;
        const remainingAmount = totalAmount;
        let paymentStatus:
          | 'UNPAID'
          | 'DEPOSIT_REQUIRED'
          | 'PAYMENT_PENDING'
          | 'PARTIALLY_PAID'
          | 'FULLY_PAID'
          | 'PAID'
          | 'FAILED'
          | 'REFUNDED' = 'UNPAID';

        if (depositRequired) {
          paymentStatus = 'DEPOSIT_REQUIRED';
        }

        const order = await tx.order.create({
          data: {
            customerId,
            customerName: dto.customerName,
            phone: dto.phone,
            phone2: dto.phone2,
            address: dto.address,
            locationLat: dto.locationLat,
            locationLng: dto.locationLng,
            locationText: dto.locationText,
            paymentMethod: dto.paymentMethod,
            status: 'PENDING',
            deliveryDate: new Date(finalDeliveryDateString),
            comment: dto.comment,
            appliedPromoCode: promoCode?.code ?? null,
            appliedPromoPercent:
              promoCode && promoCode.type === 'DISCOUNT'
                ? promoCode.discountPercent
                : 0,
            appliedPromoType: promoCode?.type ?? null,
            appliedPromoGiftName:
              promoCode?.type === 'GIFT'
                ? (promoCode.giftName ?? 'Gilamcha')
                : null,
            appliedPromoGiftImage:
              promoCode?.type === 'GIFT' ? promoCode.giftImage : null,
            appliedPromoGiftPrice:
              promoCode?.type === 'GIFT' ? promoCode.giftPrice : null,
            depositPercent: depositRequired ? depositPercent : 0,
            depositAmount: depositRequired ? depositAmount : 0,
            depositPaidAt: null,
            depositPaymentMethod: depositRequired ? dto.paymentMethod : null,
            depositTransactionId: null,
            paidAmount,
            remainingAmount,
            paymentStatus,
            paymentPaidAt: null,
            termsAccepted: dto.termsAccepted ?? false,
            termsAcceptedAt: dto.termsAccepted ? new Date() : null,
            items: {
              create: pricing.items.map((item) => {
                const carpet = carpetMap.get(item.carpetId);
                const originalItem = dto.items.find(
                  (i) => i.carpetId === item.carpetId,
                );

                let pricePerM2: number | null = null;
                let selectedArea: number | null = null;
                let selectedWidthCm: number | null = null;
                let selectedLengthCm: number | null = null;
                let finalPrice = item.unitPriceAfterPromo;

                if (carpet?.type === 'ROLL') {
                  const rollInv = rollMap.get(
                    `${item.carpetId}_${originalItem?.widthCm}`,
                  );
                  const basePrice = rollInv
                    ? Math.round(Number(rollInv.pricePerM2))
                    : Math.round(Number(carpet.price));

                  pricePerM2 = basePrice;
                  if (originalItem?.widthCm && originalItem?.lengthCm) {
                    const area =
                      (originalItem.widthCm * originalItem.lengthCm) / 10000;
                    selectedWidthCm = originalItem.widthCm;
                    selectedLengthCm = originalItem.lengthCm;
                    selectedArea = area;
                    finalPrice = Math.round(basePrice * area);
                  }
                }

                const primaryImage = carpet
                  ? carpet.images && carpet.images.length > 0
                    ? carpet.images[0]
                    : null
                  : null;

                return {
                  carpetId: item.carpetId,
                  quantity: item.quantity,
                  price: finalPrice,
                  pricePerM2,
                  selectedArea,
                  selectedWidthCm,
                  selectedLengthCm,
                  carpetName: carpet?.name || null,
                  carpetImage: primaryImage,
                  carpetBarcode: carpet?.barcode || null,
                };
              }),
            },
          },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                role: true,
              },
            },
            items: {
              include: {
                carpet: {
                  include: { category: true },
                },
                rollAllocation: true,
              },
            },
          },
        });

        // allocation
        for (const dbItem of order.items) {
          if (!dbItem.carpetId) continue;
          const carpet = carpetMap.get(dbItem.carpetId);
          if (!carpet) continue;

          if (carpet.type === 'ROLL') {
            const originalItem = dto.items.find(
              (i) => i.carpetId === dbItem.carpetId,
            );
            if (originalItem && originalItem.widthCm && originalItem.lengthCm) {
              const rollInv = rollMap.get(
                `${dbItem.carpetId}_${originalItem.widthCm}`,
              );
              if (rollInv) {
                // Lock the rollInventory row to prevent concurrent updates
                await tx.$executeRawUnsafe(
                  'SELECT * FROM roll_inventories WHERE id = $1 FOR UPDATE',
                  rollInv.id,
                );

                // Stock validation inside transaction
                const rollInvDb = await tx.rollInventory.findUnique({
                  where: { id: rollInv.id },
                });
                if (
                  !rollInvDb ||
                  rollInvDb.currentLengthCm - rollInvDb.reservedLengthCm <
                    originalItem.lengthCm
                ) {
                  throw new BadRequestException(
                    `${carpet.name} (eni ${originalItem.widthCm} sm) uchun metraj zaxirasi yetarli emas. Qolgan: ${rollInvDb ? rollInvDb.currentLengthCm - rollInvDb.reservedLengthCm : 0} sm`,
                  );
                }

                await this.rollInventoryService.reserveRollLength(
                  tx,
                  dbItem.carpetId,
                  originalItem.widthCm,
                  originalItem.lengthCm,
                );
                await tx.orderItemRoll.create({
                  data: {
                    orderItemId: dbItem.id,
                    rollInventoryId: rollInv.id,
                    lengthCm: originalItem.lengthCm,
                    widthCm: originalItem.widthCm,
                    status: 'RESERVED',
                  },
                });
              }
            }
          } else {
            // Lock ready carpet row to prevent parallel checkout race conditions
            await tx.$executeRawUnsafe(
              'SELECT * FROM carpets WHERE id = $1 FOR UPDATE',
              dbItem.carpetId,
            );

            // Stock validation inside transaction for READY carpets
            const carpetDb = await tx.carpet.findUnique({
              where: { id: dbItem.carpetId },
            });
            const activeCount = await tx.inventoryItem.count({
              where: {
                carpetId: dbItem.carpetId,
                inventoryStatus: CarpetInventoryStatus.ACTIVE,
              },
            });
            if (!carpetDb || activeCount < dbItem.quantity) {
              throw new BadRequestException(
                `${carpetDb?.name || 'Mahsulot'} uchun zaxira yetarli emas. Qolgan: ${activeCount}`,
              );
            }

            try {
              const allocated = await this.inventoryService.allocateFIFO(
                tx,
                dbItem.carpetId,
                dbItem.quantity,
                order.id,
              );
              if (allocated.length > 0) {
                await tx.orderItemInventory.createMany({
                  data: allocated.map((inv) => ({
                    orderItemId: dbItem.id,
                    inventoryId: inv.id,
                  })),
                });
              }
            } catch (fifoErr) {
              if (fifoErr instanceof BadRequestException) {
                throw fifoErr;
              }
              console.warn(
                `FIFO allocation for carpet ${dbItem.carpetId}:`,
                (fifoErr as Error).message,
              );
            }
          }
        }

        if (promoCode) {
          await tx.promoCodeUsage.create({
            data: {
              promoCodeId: promoCode.id,
              userId: customerId,
              orderId: order.id,
            },
          });
        }

        // Register inventory ledgers
        for (const item of order.items) {
          if (!item.carpetId) continue;
          await tx.inventoryLedger.create({
            data: {
              carpetId: item.carpetId,
              quantity: -item.quantity,
              action: 'ORDER_CREATED',
              actor: customerId,
              reason: `Checkout creation of order #${order.id}`,
            },
          });
        }

        // Register payment transaction if deposit is required
        let checkoutSession: any = null;
        if (
          depositRequired &&
          (dto.paymentMethod === 'CLICK' || dto.paymentMethod === 'PAYME')
        ) {
          const transactionId = `TX_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry

          const provider = dto.paymentMethod === 'PAYME' ? 'PAYME' : 'CLICK';
          const checkoutUrl = `/checkout/payment?orderId=${order.id}&transactionId=${transactionId}`;

          const pt = await tx.paymentTransaction.create({
            data: {
              orderId: order.id,
              provider,
              transactionId,
              amount: depositAmount,
              status: 'PENDING',
              paymentType: 'DEPOSIT',
              currency: 'UZS',
              requestPayload: {
                orderId: order.id,
                customerId,
                amount: depositAmount,
              },
            },
          });

          checkoutSession = {
            id: pt.id,
            expiresAt,
            provider,
            amount: depositAmount,
            checkoutUrl,
          };
        }

        // Write Audit Log
        await tx.auditLog.create({
          data: {
            action: 'Order Created',
            who: customerId,
            orderId: order.id,
            newValue: JSON.stringify({
              status: order.status,
              total: totalAmount,
            }),
            reason: 'Checkout creation',
          },
        });

        // Send notifications (async, don't block)
        const adminEmail = this.configService.get<string>('SMTP_USER') || '';
        if (adminEmail) {
          void this.mailService.sendNewOrderNotification(
            adminEmail,
            order,
            pricing,
          );
        }

        const tgMessage = this.buildTelegramOrderMessage(order, pricing);
        const isSpecialDelivery =
          !this.isInsideTashkent(
            Number(order.locationLat),
            Number(order.locationLng),
          ) || pricing.totalAfterPromo < 5000000;
        void this.telegramService.notifyAdmins(
          tgMessage,
          order.locationLat && order.locationLng
            ? { lat: Number(order.locationLat), lng: Number(order.locationLng) }
            : undefined,
          isSpecialDelivery
            ? {
                inline_keyboard: [
                  [
                    {
                      text: '💰 Yetkazib berish narxini yuborish',
                      callback_data: `set_delivery_price_${order.id}`,
                    },
                  ],
                ],
              }
            : undefined,
        );

        void this.pushNotificationService.notifyAdmins(
          'Yangi Buyurtma!',
          `${order.customerName} tomonidan yangi buyurtma qabul qilindi.`,
          `/admin/orders/${order.id}`,
        );

        const orderNumber = formatOrderNumber(order.id, order.createdAt);
        const welcomeMessage = `YEC Market: Sizning #${orderNumber} buyurtmangiz qabul qilindi. Tez orada operatorlarimiz siz bilan bog'lanishadi. Rahmat!`;
        void this.sendStatusSmsToCustomer(order, welcomeMessage);

        return { order, checkoutSession };
      });
    } catch (error) {
      // Release slot if order creation failed
      await this.deliveryService.releaseSlot(finalDeliveryDateString);

      if (this.isPromoCodeReuseError(error)) {
        throw new BadRequestException(
          'Siz bu promokoddan allaqachon foydalangansiz.',
        );
      }
      throw error;
    }
  }

  async previewPromo(customerId: string, dto: PreviewPromoDto) {
    const normalizedPromoCode = this.normalizePromoCode(dto.promoCode);
    const carpetMap = await this.loadCarpetMap(this.prisma, dto.items);
    const pricingWithoutPromo = this.buildPricingSummary(
      dto.items,
      carpetMap,
      null,
    );

    if (!normalizedPromoCode) {
      return {
        state: 'empty',
        message: 'Promokod kiritilmagan.',
        promo: null,
        pricing: pricingWithoutPromo,
      };
    }

    try {
      const promoCode = await this.resolvePromoCode(
        this.prisma,
        customerId,
        normalizedPromoCode,
      );
      const pricing = this.buildPricingSummary(dto.items, carpetMap, promoCode);

      if (
        promoCode &&
        promoCode.minOrderAmount > 0 &&
        pricing.subtotalAfterCarpetDiscount < promoCode.minOrderAmount
      ) {
        throw new BadRequestException(
          `Bu promokod ${this.formatCurrency(promoCode.minOrderAmount)}dan oshgan buyurtmalar uchun.`,
        );
      }

      return {
        state: 'valid',
        message:
          promoCode?.type === 'GIFT'
            ? `Promokod qabul qilindi. Sovg'a: ${promoCode.giftName ?? 'Gilamcha'}.`
            : `Promokod qabul qilindi. Qo'shimcha skidka: -${promoCode?.discountPercent ?? 0}%.`,
        promo: promoCode
          ? {
              code: promoCode.code,
              type: promoCode.type,
              discountPercent: promoCode.discountPercent,
              minOrderAmount: promoCode.minOrderAmount,
              giftName: promoCode.giftName,
              giftImage: promoCode.giftImage,
              giftPrice: promoCode.giftPrice,
            }
          : null,
        pricing,
      };
    } catch (error) {
      const message =
        error instanceof BadRequestException
          ? this.extractBadRequestMessage(error)
          : "Promokodni tekshirib bo'lmadi.";

      return {
        state: 'invalid',
        message,
        promo: {
          code: normalizedPromoCode,
        },
        pricing: pricingWithoutPromo,
      };
    }
  }

  async findMy(customerId: string, query: OrderQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = {
      customerId,
      status: query.status,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              role: true,
            },
          },
          courier: {
            select: {
              id: true,
              name: true,
              phone: true,
              telegramChatId: true,
            },
          },
          items: {
            include: {
              carpet: {
                include: { category: true },
              },
              rollAllocation: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  private formatPhoneNumber(value: string): string {
    const digits = (value || '').replace(/\D/g, '');
    let localDigits = '';
    if (digits.startsWith('998')) {
      localDigits = digits.slice(3, 12);
    } else {
      localDigits = digits.slice(0, 9);
    }

    const compact = localDigits.padEnd(9, '');
    return `+998${compact}`;
  }

  private async sendStatusTelegramToCustomer(
    order: any,
    message: string,
  ): Promise<void> {
    const directChatId = order.customer?.telegramChatId;
    if (directChatId) {
      await this.telegramService.sendRaw(directChatId, message);
      return;
    }

    const targetPhone = this.formatPhoneNumber(order.phone);
    const tgUser = await this.prisma.user.findFirst({
      where: { phone: targetPhone, telegramChatId: { not: null } },
      select: { telegramChatId: true },
    });
    if (tgUser?.telegramChatId) {
      await this.telegramService.sendRaw(tgUser.telegramChatId, message);
    }
  }

  private async sendStatusSmsToCustomer(
    order: any,
    message: string,
  ): Promise<void> {
    if (order.phone) {
      void this.smsService.sendSms(order.phone, message);
    }
  }

  private async sendOrderToCourier(order: any): Promise<void> {
    const courierChatId = order.courier?.telegramChatId;
    if (!courierChatId) return;

    const itemsText = this.formatTelegramItemsList(order.items ?? []);
    const orderNumber = formatOrderNumber(order.id, order.createdAt);

    const message =
      `<b>Yangi yetkazib berish buyurtmasi</b>\n` +
      `<b>Buyurtma:</b> #${orderNumber}\n` +
      `<b>Mijoz:</b> ${order.customerName}\n` +
      `<b>Tel 1:</b> ${this.formatPhoneNumber(order.phone)}\n` +
      `${order.phone2 ? `<b>Tel 2:</b> ${this.formatPhoneNumber(order.phone2)}\n` : ''}` +
      `<b>Manzil:</b> ${order.address}\n` +
      `${order.locationText ? `<b>Lokatsiya:</b> ${order.locationText}\n` : ''}` +
      `\n📦 <b>Mahsulotlar:</b>\n${itemsText}`;

    await this.telegramService.sendRaw(courierChatId, message, {
      inline_keyboard: [
        [
          {
            text: 'Yetkazildi',
            callback_data: `courier_delivered_${order.id}`,
          },
        ],
      ],
    });

    if (order.locationLat && order.locationLng) {
      await this.telegramService.sendLocation(
        courierChatId,
        Number(order.locationLat),
        Number(order.locationLng),
      );
    }
  }

  async findAll(query: OrderQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 10;
    const skip = (page - 1) * limit;

    const where = { status: query.status };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.order.findMany({
        where,
        include: {
          paymentTransactions: {
            orderBy: { createdAt: 'desc' },
          },
          customer: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
              role: true,
            },
          },
          courier: {
            select: {
              id: true,
              name: true,
              phone: true,
              telegramChatId: true,
            },
          },
          items: {
            include: {
              carpet: {
                include: { category: true },
              },
              rollAllocation: true,
              inventoryAllocations: {
                include: {
                  inventory: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.order.count({ where }),
    ]);

    return {
      items,
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async findOne(id: string, userId: string, role: string) {
    const isAdmin = role === 'ADMIN' || role === 'SUPERADMIN';
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        returnRequest: true,
        paymentTransactions: {
          orderBy: { createdAt: 'desc' },
        },
        paymentHistories: {
          where: { deletedAt: null },
          orderBy: { createdAt: 'desc' },
        },
        customer: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            role: true,
          },
        },
        courier: {
          select: {
            id: true,
            name: true,
            phone: true,
            telegramChatId: true,
          },
        },
        items: {
          include: {
            carpet: { include: { category: true } },
            rollAllocation: true,
            inventoryAllocations: isAdmin
              ? {
                  include: {
                    inventory: true,
                  },
                }
              : (false as any), // Only select for admin
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (
      role !== 'ADMIN' &&
      role !== 'SUPERADMIN' &&
      order.customerId !== userId
    ) {
      throw new BadRequestException(
        "Siz faqatgina o'zingizning buyurtmangizni ko'ra olasiz.",
      );
    }

    // Customer should not see sensitive fields
    if (!isAdmin) {
      delete (order as any).cancelledBy;
    }

    const auditLogs = await this.prisma.auditLog.findMany({
      where: { orderId: id, deletedAt: null },
      orderBy: { when: 'asc' },
    });

    return {
      ...order,
      auditLogs,
    };
  }

  async updateStatus(id: string, dto: UpdateOrderStatusDto, role: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            name: true,
            phone: true,
            telegramChatId: true,
          },
        },
        courier: {
          select: {
            id: true,
            name: true,
            phone: true,
            telegramChatId: true,
          },
        },
        items: {
          include: {
            carpet: {
              include: { category: true },
            },
            rollAllocation: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.status === 'ON_WAY' && dto.status !== 'DELIVERED') {
      throw new BadRequestException(
        "Yo'ldagi buyurtmani o'zgartirib bo'lmaydi.",
      );
    }

    if (order.status === 'DELIVERED' || order.status === 'CANCELLED') {
      throw new BadRequestException(
        "Yakunlangan buyurtma holatini o'zgartirib bo'lmaydi.",
      );
    }

    if (dto.status === OrderStatus.PENDING) {
      throw new BadRequestException(
        "Buyurtma holatini 'Kutilmoqda' (PENDING) ga qaytarib bo'lmaydi.",
      );
    }

    const nextStatus = dto.status ?? order.status;
    if (
      dto.status &&
      dto.status !== order.status &&
      !this.canTransition(order.status, dto.status)
    ) {
      throw new BadRequestException(
        `Holatni ${order.status} dan ${dto.status} ga o'tkazib bo'lmaydi.`,
      );
    }

    if (nextStatus === OrderStatus.DELIVERED) {
      const hasProof =
        dto.courierProofType ||
        dto.courierProofData ||
        dto.courierProofSignature;
      if (!hasProof) {
        throw new BadRequestException(
          "Buyurtmani 'Yetkazib berildi' (DELIVERED) qilish uchun kuryer tasdig'i (imzo, foto yoki OTP) taqdim etilishi shart.",
        );
      }
    }

    if (role === 'ADMIN' && nextStatus === 'DELIVERED') {
      throw new BadRequestException(
        "Admin buyurtmani to'g'ridan-to'g'ri 'Yetkazib berildi' (DELIVERED) qila olmaydi. Faqat 'ON_WAY' (Yetkazib berilmoqda) qilish mumkin.",
      );
    }

    if (nextStatus === 'CANCELLED' && !dto.cancelReason?.trim()) {
      throw new BadRequestException("Bekor qilish sababi ko'rsatilishi kerak.");
    }

    let selectedCourier: {
      id: string;
      name: string;
      phone: string;
      telegramChatId: string | null;
    } | null = null;

    if (nextStatus === OrderStatus.ON_WAY) {
      const courierId = String(dto.courierId ?? order.courierId ?? '').trim();
      if (courierId) {
        selectedCourier = await this.prisma.user.findFirst({
          where: {
            id: courierId,
            role: UserRole.COURIER,
          },
          select: {
            id: true,
            name: true,
            phone: true,
            telegramChatId: true,
          },
        });

        if (!selectedCourier) {
          throw new BadRequestException('Tanlangan kuryer topilmadi.');
        }

        if (!selectedCourier.telegramChatId) {
          throw new BadRequestException(
            "Kuryerning Telegram akkaunti bog'lanmagan. Avval botga /start qilib bog'lang.",
          );
        }
      }
    }

    const parsedDeliveryDate =
      dto.deliveryDate !== undefined && dto.deliveryDate !== ''
        ? new Date(dto.deliveryDate)
        : undefined;
    if (parsedDeliveryDate && Number.isNaN(parsedDeliveryDate.getTime())) {
      throw new BadRequestException("Yetkazib berish sanasi noto'g'ri.");
    }

    let updatedOrder;
    try {
      const now = new Date();
      updatedOrder = await this.prisma.$transaction(async (tx) => {
        const orderDb = await tx.order.update({
          where: { id, version: order.version },
          data: {
            status: nextStatus,
            version: { increment: 1 },
            courierProofType: dto.courierProofType ?? order.courierProofType,
            courierProofData: dto.courierProofData ?? order.courierProofData,
            courierProofSignature:
              dto.courierProofSignature ?? order.courierProofSignature,
            courierId:
              selectedCourier?.id ??
              (nextStatus === OrderStatus.ON_WAY
                ? (order.courierId ?? null)
                : undefined),
            courierName:
              selectedCourier?.name ??
              (nextStatus === OrderStatus.ON_WAY
                ? (order.courierName ?? null)
                : undefined),
            courierPhone: selectedCourier?.phone
              ? this.formatPhoneNumber(selectedCourier.phone)
              : nextStatus === OrderStatus.ON_WAY
                ? (order.courierPhone ?? null)
                : undefined,
            cancelReason:
              nextStatus === 'CANCELLED'
                ? dto.cancelReason?.trim()
                : order.cancelReason,
            cancelledAt: nextStatus === 'CANCELLED' ? now : order.cancelledAt,
            cancelledBy:
              nextStatus === 'CANCELLED' ? 'ADMIN' : order.cancelledBy,
            deliveryDate:
              parsedDeliveryDate !== undefined
                ? parsedDeliveryDate
                : order.deliveryDate,
            deliveryCompletedAt:
              nextStatus === OrderStatus.DELIVERED
                ? now
                : order.deliveryCompletedAt,
            returnDeadline:
              nextStatus === OrderStatus.DELIVERED
                ? new Date(now.getTime() + 24 * 60 * 60 * 1000)
                : order.returnDeadline,
          },
          include: {
            customer: {
              select: {
                id: true,
                name: true,
                phone: true,
                telegramChatId: true,
              },
            },
            courier: {
              select: {
                id: true,
                name: true,
                phone: true,
                telegramChatId: true,
              },
            },
            items: {
              include: {
                carpet: {
                  include: { category: true },
                },
                rollAllocation: true,
              },
            },
          },
        });

        // Write Audit Log
        await tx.auditLog.create({
          data: {
            action: `Order Status -> ${nextStatus}`,
            who: role,
            orderId: id,
            oldValue: JSON.stringify({ status: order.status }),
            newValue: JSON.stringify({ status: nextStatus }),
            reason:
              dto.cancelReason || dto.explanation || "Status o'zgartirildi",
          },
        });

        const orderItemIds = orderDb.items.map((i) => i.id);

        if (nextStatus === OrderStatus.ACCEPTED) {
          await tx.orderItemRoll.updateMany({
            where: { orderItemId: { in: orderItemIds }, status: 'RESERVED' },
            data: { status: 'CUTTING' },
          });
        } else if (
          (
            [
              OrderStatus.READY_FOR_DELIVERY,
              OrderStatus.ON_WAY,
              OrderStatus.DELIVERED,
            ] as OrderStatus[]
          ).includes(nextStatus)
        ) {
          // --- CUT LOGIC ---
          for (const item of orderDb.items) {
            if (
              item.carpet?.type === 'ROLL' &&
              item.rollAllocation &&
              item.rollAllocation.status !== 'CUT'
            ) {
              const rollAlloc = item.rollAllocation;

              // Decrease roll inventory currentLength and reservedLength
              await this.rollInventoryService.cutRollSegment(
                tx,
                rollAlloc.rollInventoryId,
                rollAlloc.lengthCm,
              );

              // Update roll allocation status to CUT
              await tx.orderItemRoll.update({
                where: { id: rollAlloc.id },
                data: { status: 'CUT' },
              });

              // Generate unique barcode for this piece
              const originalBarcode =
                item.carpet.uniqueCode || `ROLL-${item.carpet.id}`;
              const count = await tx.inventoryItem.count({
                where: { barcode: { startsWith: `${originalBarcode}-P` } },
              });
              const nextSeq = count + 1;
              const cutBarcode = `${originalBarcode}-P${nextSeq}`;

              const statsSize = `${item.selectedWidthCm} sm x ${item.selectedLengthCm} sm`;
              const cutInventory = await tx.inventoryItem.create({
                data: {
                  carpetId: item.carpetId!,
                  barcode: cutBarcode,
                  sku: `${cutBarcode}-SKU`,
                  widthMm: (item.selectedWidthCm || 0) * 10,
                  lengthMm: (item.selectedLengthCm || 0) * 10,
                  size: statsSize,
                  pricePerM2: item.pricePerM2,
                  piecePrice: item.price,
                  selectedArea: item.selectedArea,
                  isReturned: false,
                  inventorySource: 'MANUAL',
                  sourceOrderId: id,
                  sourceOrderItemId: item.id,
                  inventoryStatus:
                    nextStatus === OrderStatus.DELIVERED
                      ? CarpetInventoryStatus.SOLD
                      : CarpetInventoryStatus.RESERVED,
                },
              });

              // Link order item to this cut piece
              await tx.orderItemInventory.create({
                data: {
                  orderItemId: item.id,
                  inventoryId: cutInventory.id,
                },
              });

              await tx.inventoryHistory.create({
                data: {
                  inventoryId: cutInventory.id,
                  oldStatus: 'AVAILABLE',
                  newStatus:
                    nextStatus === OrderStatus.DELIVERED ? 'SOLD' : 'RESERVED',
                  reason: `Segment cut from roll for order status ${nextStatus}`,
                  orderId: id,
                },
              });
            }
          }

          if (nextStatus === OrderStatus.DELIVERED) {
            // METRAJ sold (ready stock items)
            await this.inventoryService.markInventorySold(tx, orderItemIds, id);
            // Metraj allocations -> DELIVERED
            await tx.orderItemRoll.updateMany({
              where: {
                orderItemId: { in: orderItemIds },
                status: { in: ['RESERVED', 'CUTTING', 'CUT'] },
              },
              data: { status: 'DELIVERED' },
            });
          }
        } else if (nextStatus === OrderStatus.CANCELLED) {
          if (orderDb.deliveryDate) {
            const dateStr = this.deliveryService.formatDateString(
              orderDb.deliveryDate,
            );
            void this.deliveryService.releaseSlot(dateStr);
          }

          // Release ready stock items
          await this.inventoryService.releaseInventory(tx, orderItemIds, id);

          // For each ROLL item:
          for (const item of orderDb.items) {
            if (item.carpet?.type === 'ROLL' && item.rollAllocation) {
              const rollAlloc = item.rollAllocation;

              if (rollAlloc.status === 'CUT') {
                // Find the cut InventoryItem
                const link = await tx.orderItemInventory.findFirst({
                  where: { orderItemId: item.id },
                  select: { inventoryId: true },
                });
                if (link) {
                  // Make it AVAILABLE (ACTIVE) sellable separately!
                  await tx.inventoryItem.update({
                    where: { id: link.inventoryId },
                    data: { inventoryStatus: CarpetInventoryStatus.ACTIVE },
                  });
                  await tx.inventoryHistory.create({
                    data: {
                      inventoryId: link.inventoryId,
                      oldStatus: 'RESERVED',
                      newStatus: 'AVAILABLE',
                      reason:
                        'Order cancelled post-cutting, piece made available separately',
                      orderId: id,
                    },
                  });
                }
              } else {
                // Release reservation if uncut
                await this.rollInventoryService.releaseRollReservation(
                  tx,
                  rollAlloc.rollInventoryId,
                  rollAlloc.lengthCm,
                );
              }

              await tx.orderItemRoll.update({
                where: { id: rollAlloc.id },
                data: { status: 'AVAILABLE' },
              });
            }
          }
        }

        return orderDb;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new BadRequestException(
          'Buyurtma boshqa foydalanuvchi/admin tomonidan tahrirlangan. Sahifani yangilang.',
        );
      }
      throw err;
    }

    const currentStatus = nextStatus;
    let statusText = '';
    switch (currentStatus) {
      case 'ACCEPTED':
        statusText = 'qabul qilindi';
        break;
      case 'ON_WAY':
        statusText = "yo'lga chiqdi";
        break;
      case 'DELIVERED':
        statusText = 'yetkazib berildi';
        break;
      case 'CANCELLED':
        statusText = 'bekor qilindi';
        break;
    }

    if (statusText || dto.explanation || nextStatus === OrderStatus.ON_WAY) {
      const defaultStatusMessage = `Sizning #${formatOrderNumber(updatedOrder.id, updatedOrder.createdAt)} buyurtmangiz ${statusText}.${dto.deliveryDate ? ` Taxminiy kunda: ${dto.deliveryDate}` : ''}`;
      const customerCourierMessage =
        nextStatus === OrderStatus.ON_WAY && updatedOrder.courier
          ? `Sizning #${formatOrderNumber(updatedOrder.id, updatedOrder.createdAt)} buyurtmangiz yo'lga chiqdi.\nKuryer: ${updatedOrder.courier.name}\nTelefon: ${this.formatPhoneNumber(updatedOrder.courier.phone)}\nBog'lanish uchun kuryerga qo'ng'iroq qilishingiz mumkin.`
          : defaultStatusMessage;
      const msg = dto.explanation ? dto.explanation : customerCourierMessage;

      void this.pushNotificationService.sendNotification(
        updatedOrder.customerId,
        dto.explanation ? 'Yangi xabar' : "Buyurtma holati o'zgardi",
        msg,
        `/orders/${updatedOrder.id}`,
      );

      void this.sendStatusTelegramToCustomer(updatedOrder, msg);
      void this.sendStatusSmsToCustomer(updatedOrder, msg);

      if (nextStatus === OrderStatus.ON_WAY && updatedOrder.courier) {
        void this.sendOrderToCourier(updatedOrder);
      }
    }

    if (nextStatus === OrderStatus.CANCELLED) {
      const orderNum = formatOrderNumber(
        updatedOrder.id,
        updatedOrder.createdAt,
      );
      const customerName = updatedOrder.customer?.name || "Noma'lum";
      const customerPhone = updatedOrder.customer?.phone || '';
      const totalSum =
        Number(updatedOrder.paidAmount) + Number(updatedOrder.remainingAmount);

      const adminMsg =
        `❌ <b>BUYURTMA BEKOR QILINDI!</b>\n\n` +
        `📦 Buyurtma kodi: <code>#${orderNum}</code>\n` +
        `👤 Mijoz: <b>${customerName}</b>\n` +
        `📞 Telefon: <b>${this.formatPhoneNumber(customerPhone)}</b>\n` +
        `💬 Sabab: <i>${updatedOrder.cancelReason || 'Admin/Sotuvchi tomonidan bekor qilindi'}</i>\n` +
        `💰 Summa: ${totalSum.toLocaleString()} so'm`;

      void this.telegramService.notifyAdmins(adminMsg);
      void this.pushNotificationService.notifyAdmins(
        `Buyurtma bekor qilindi (#${orderNum})`,
        `Buyurtma #${orderNum} bekor qilindi. Sabab: ${updatedOrder.cancelReason || "Ko'rsatilmadi"}`,
        `/admin/orders`,
      );
    }

    if (nextStatus === OrderStatus.DELIVERED) {
      const totalAmount =
        Number(updatedOrder.paidAmount) + Number(updatedOrder.remainingAmount);
      void this.updateLoyaltyStats(updatedOrder.customerId, totalAmount);
    }

    return updatedOrder;
  }

  async updateOrder(id: string, dto: any, role: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: { include: { rollAllocation: true } } },
    });
    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    const isAfterDelivery = [
      'READY_FOR_DELIVERY',
      'ON_WAY',
      'DELIVERED',
      'COMPLETED',
    ].includes(order.status);
    if (isAfterDelivery) {
      throw new BadRequestException(
        "Yetkazib berilgan yoki yetkazib berish jarayonidagi buyurtmani tahrirlab bo'lmaydi.",
      );
    }

    return this.prisma.$transaction(async (tx) => {
      if (dto.items) {
        const oldItemIds = order.items.map((i) => i.id);

        await this.inventoryService.releaseInventory(tx, oldItemIds, id);

        for (const item of order.items) {
          if (item.rollAllocation) {
            await this.rollInventoryService.releaseRollReservation(
              tx,
              item.rollAllocation.rollInventoryId,
              item.rollAllocation.lengthCm,
            );
          }
        }

        await tx.orderItem.deleteMany({
          where: { orderId: id },
        });

        const carpetMap = await this.loadCarpetMap(tx, dto.items);
        const rollMap = new Map<string, any>();
        for (const item of dto.items) {
          const carpet = carpetMap.get(item.carpetId);
          if (carpet?.type === 'ROLL') {
            const rollInv = await tx.rollInventory.findUnique({
              where: {
                carpetId_widthCm: {
                  carpetId: item.carpetId,
                  widthCm: item.widthCm,
                },
              },
            });
            if (!rollInv) {
              throw new BadRequestException(
                `"${carpet.name}" gilamining ${item.widthCm} sm kenglikdagi varianti topilmadi.`,
              );
            }
            rollMap.set(`${item.carpetId}_${item.widthCm}`, rollInv);
          }
        }

        const promoCode = order.appliedPromoCode
          ? await tx.promoCode.findUnique({
              where: { code: order.appliedPromoCode },
            })
          : null;

        const resolvedPromo: ResolvedPromoCode | null = promoCode
          ? {
              id: promoCode.id,
              code: promoCode.code,
              discountPercent: promoCode.discountPercent,
              type: promoCode.type,
              minOrderAmount: promoCode.minOrderAmount,
              giftName: promoCode.giftName,
              giftImage: promoCode.giftImage,
              giftPrice: promoCode.giftPrice,
              isActive: promoCode.isActive,
              startsAt: promoCode.startsAt,
              expiresAt: promoCode.expiresAt,
              createdAt: promoCode.createdAt,
              updatedAt: promoCode.updatedAt,
            }
          : null;

        const pricing = this.buildPricingSummary(
          dto.items,
          carpetMap,
          resolvedPromo,
          rollMap,
        );

        await this.reserveStockAndIncrementSales(tx, dto.items, carpetMap);

        for (let idx = 0; idx < pricing.items.length; idx++) {
          const item = pricing.items[idx];
          const carpet = carpetMap.get(item.carpetId);
          const originalItem = dto.items[idx];

          let pricePerM2: number | null = null;
          let selectedArea: number | null = null;
          let selectedWidthCm: number | null = null;
          let selectedLengthCm: number | null = null;
          let finalPrice = item.unitPriceAfterPromo;

          if (carpet?.type === 'ROLL') {
            const rollInv = rollMap.get(
              `${item.carpetId}_${originalItem?.widthCm}`,
            );
            const basePrice = rollInv
              ? Math.round(Number(rollInv.pricePerM2))
              : Math.round(Number(carpet.price));

            pricePerM2 = basePrice;
            if (originalItem?.widthCm && originalItem?.lengthCm) {
              const area =
                (originalItem.widthCm * originalItem.lengthCm) / 10000;
              selectedWidthCm = originalItem.widthCm;
              selectedLengthCm = originalItem.lengthCm;
              selectedArea = area;
              finalPrice = Math.round(basePrice * area);
            }
          }

          const primaryImage = carpet
            ? carpet.images && carpet.images.length > 0
              ? carpet.images[0]
              : null
            : null;

          const createdItem = await tx.orderItem.create({
            data: {
              orderId: id,
              carpetId: item.carpetId,
              quantity: item.quantity,
              price: finalPrice,
              pricePerM2,
              selectedArea,
              selectedWidthCm,
              selectedLengthCm,
              carpetName: carpet?.name || null,
              carpetImage: primaryImage,
              carpetBarcode: carpet?.barcode || null,
            },
          });

          if (
            carpet?.type === 'ROLL' &&
            originalItem?.widthCm &&
            originalItem?.lengthCm
          ) {
            const rollInv = rollMap.get(
              `${item.carpetId}_${originalItem.widthCm}`,
            );
            if (rollInv) {
              await tx.$executeRawUnsafe(
                'SELECT * FROM roll_inventories WHERE id = $1 FOR UPDATE',
                rollInv.id,
              );

              const rollInvDb = await tx.rollInventory.findUnique({
                where: { id: rollInv.id },
              });
              if (
                !rollInvDb ||
                rollInvDb.currentLengthCm - rollInvDb.reservedLengthCm <
                  originalItem.lengthCm
              ) {
                throw new BadRequestException(
                  `${carpet.name} (eni ${originalItem.widthCm} sm) uchun metraj zaxirasi yetarli emas.`,
                );
              }

              await this.rollInventoryService.reserveRollLength(
                tx,
                createdItem.carpetId!,
                originalItem.widthCm,
                originalItem.lengthCm,
              );

              await tx.orderItemRoll.create({
                data: {
                  orderItemId: createdItem.id,
                  rollInventoryId: rollInv.id,
                  lengthCm: originalItem.lengthCm,
                  widthCm: originalItem.widthCm,
                  status: 'RESERVED',
                },
              });
            }
          } else if (carpet && carpet.type !== 'ROLL') {
            const allocated = await this.inventoryService.allocateFIFO(
              tx,
              createdItem.carpetId!,
              createdItem.quantity,
              id,
            );
            if (allocated.length > 0) {
              await tx.orderItemInventory.createMany({
                data: allocated.map((inv) => ({
                  orderItemId: createdItem.id,
                  inventoryId: inv.id,
                })),
              });
            }
          }
        }

        const totalAmount = pricing.totalAfterPromo;
        await tx.order.update({
          where: { id },
          data: {
            paidAmount: 0,
            remainingAmount: totalAmount,
          },
        });
      }

      return tx.order.update({
        where: { id },
        data: {
          customerName: dto.customerName ?? undefined,
          phone: dto.phone ?? undefined,
          phone2: dto.phone2 ?? undefined,
          address: dto.address ?? undefined,
          comment: dto.comment ?? undefined,
          deliveryDate: dto.deliveryDate
            ? new Date(dto.deliveryDate)
            : undefined,
        },
        include: {
          items: {
            include: {
              carpet: true,
              rollAllocation: true,
            },
          },
        },
      });
    });
  }

  async confirmDelivery(id: string, customerId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.customerId !== customerId) {
      throw new BadRequestException('Bu buyurtma sizga tegishli emas.');
    }

    if (order.status !== OrderStatus.ON_WAY) {
      throw new BadRequestException(
        "Faqatgina 'Yetkazib berilmoqda' (ON_WAY) holatidagi buyurtmalarni qabul qilishingiz mumkin.",
      );
    }

    const orderItemIds = order.items.map((i) => i.id);

    // Releasing / marking sold
    void this.inventoryService.markInventorySold(
      this.prisma as any,
      orderItemIds,
      id,
    );

    // Metraj allocations -> DELIVERED
    await this.prisma.orderItemRoll.updateMany({
      where: {
        orderItemId: { in: orderItemIds },
        status: { in: ['RESERVED', 'CUTTING', 'CUT'] },
      },
      data: { status: 'DELIVERED' },
    });

    const updated = await this.prisma.order.update({
      where: { id },
      data: {
        status: OrderStatus.DELIVERED,
        deliveryCompletedAt: new Date(),
      },
    });

    const totalAmount =
      Number(updated.paidAmount) + Number(updated.remainingAmount);
    void this.updateLoyaltyStats(updated.customerId, totalAmount);

    return updated;
  }

  async cancelMyOrder(id: string, customerId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.customerId !== customerId) {
      throw new BadRequestException('Bu buyurtma sizga tegishli emas.');
    }

    if (order.status === 'ON_WAY') {
      throw new BadRequestException(
        'Order cannot be cancelled because delivery has started.',
      );
    }

    if (
      order.status === 'DELIVERED' ||
      order.status === 'COMPLETED' ||
      order.status === 'RETURN_REQUESTED' ||
      order.status === 'RETURN_APPROVED' ||
      order.status === 'RETURN_REJECTED' ||
      order.status === 'REFUNDED' ||
      order.status === 'CANCELLED' ||
      order.status === 'CANCEL_REQUESTED'
    ) {
      throw new BadRequestException("Ushbu buyurtmani bekor qilib bo'lmaydi.");
    }

    // If PENDING, cancel immediately
    if (order.status === 'PENDING') {
      const cancelledOrder = await this.prisma.$transaction(async (tx) => {
        // 1. Release physical inventories (RESERVED/SOLD -> AVAILABLE)
        const orderItemIds = order.items.map((i) => i.id);
        await this.inventoryService.releaseInventory(tx, orderItemIds, id);

        // 2. Return general stock and decrement soldCount
        for (const item of order.items) {
          if (!item.carpetId) {
            continue;
          }

          // Decrement soldCount
          const carpet = await tx.carpet.findUnique({
            where: { id: item.carpetId },
          });
          if (carpet && carpet.categoryId) {
            await tx.category.update({
              where: { id: carpet.categoryId },
              data: { soldCount: { decrement: item.quantity } },
            });
          }
        }

        // 3. Update order status and write cancellation audit fields
        return tx.order.update({
          where: { id },
          data: {
            status: OrderStatus.CANCELLED,
            cancelReason: 'Mijoz tomonidan bekor qilindi',
            cancelledAt: new Date(),
            cancelledBy: 'CUSTOMER',
          },
          include: { customer: true },
        });
      });

      const orderNum = formatOrderNumber(
        cancelledOrder.id,
        cancelledOrder.createdAt,
      );
      const customerName = cancelledOrder.customer?.name || "Noma'lum";
      const customerPhone = cancelledOrder.customer?.phone || '';
      const totalSum =
        Number(cancelledOrder.paidAmount) +
        Number(cancelledOrder.remainingAmount);

      const adminMsg =
        `❌ <b>BUYURTMA BEKOR QILINDI!</b>\n\n` +
        `📦 Buyurtma kodi: <code>#${orderNum}</code>\n` +
        `👤 Mijoz: <b>${customerName}</b>\n` +
        `📞 Telefon: <b>${this.formatPhoneNumber(customerPhone)}</b>\n` +
        `💬 Sabab: <i>Mijoz tomonidan bekor qilindi</i>\n` +
        `💰 Summa: ${totalSum.toLocaleString()} so'm`;

      void this.telegramService.notifyAdmins(adminMsg);
      void this.pushNotificationService.notifyAdmins(
        `Buyurtma bekor qilindi! (#${orderNum})`,
        `Mijoz #${orderNum} buyurtmani bekor qildi.`,
        `/admin/orders`,
      );

      return cancelledOrder;
    }

    // If ACCEPTED, CUTTING, or READY_FOR_DELIVERY, change status to CANCEL_REQUESTED
    const requestedOrder = await this.prisma.order.update({
      where: { id },
      data: {
        status: OrderStatus.CANCEL_REQUESTED,
        cancelReason:
          "Mijoz bekor qilish so'rovi yubordi (Admin tasdiqlashi kutilmoqda)",
      },
      include: { customer: true },
    });

    const orderNum = formatOrderNumber(
      requestedOrder.id,
      requestedOrder.createdAt,
    );
    const customerName = requestedOrder.customer?.name || "Noma'lum";
    const customerPhone = requestedOrder.customer?.phone || '';

    const adminMsg =
      `⚠️ <b>BUYURTMANI BEKOR QILISH SO'ROVI!</b>\n\n` +
      `📦 Buyurtma kodi: <code>#${orderNum}</code>\n` +
      `👤 Mijoz: <b>${customerName}</b>\n` +
      `📞 Telefon: <b>${this.formatPhoneNumber(customerPhone)}</b>\n` +
      `💬 Sabab: <i>Mijoz bekor qilish so'rovi yubordi</i>\n\n` +
      `<i>Adminlar ko'rib chiqishi kutilmoqda.</i>`;

    void this.telegramService.notifyAdmins(adminMsg);
    void this.pushNotificationService.notifyAdmins(
      `Bekor qilish so'rovi! (#${orderNum})`,
      `Mijoz #${orderNum} buyurtmani bekor qilish so'rovini yubordi.`,
      `/admin/orders`,
    );

    return requestedOrder;
  }

  async confirmRemainingPayment(id: string) {
    const order = await this.prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Buyurtma topilmadi.');
    }

    if (order.paymentStatus === 'FULLY_PAID') {
      throw new BadRequestException("Bu buyurtma allaqachon to'liq to'langan.");
    }

    const totalAmount = order.items.reduce(
      (sum, item) => sum + Number(item.price) * item.quantity,
      0,
    );

    return this.prisma.order.update({
      where: { id },
      data: {
        paymentStatus: 'FULLY_PAID',
        paidAmount: totalAmount,
        remainingAmount: 0,
        paymentPaidAt: new Date(),
      },
    });
  }

  private canTransition(from: OrderStatus, to: OrderStatus): boolean {
    const allowed = this.orderTransitionMap[from] ?? [];
    return allowed.includes(to);
  }

  private async loadCarpetMap(
    db: Prisma.TransactionClient | PrismaService,
    items: CreateOrderItemDto[],
  ): Promise<Map<string, CarpetSnapshot>> {
    const carpetIds = [...new Set(items.map((item) => item.carpetId))];
    const carpets = await db.carpet.findMany({
      where: { id: { in: carpetIds } },
      select: {
        id: true,
        price: true,
        discountPercent: true,
        name: true,
        categoryId: true,
        type: true,
        images: true,
        inventoryItems: {
          select: { barcode: true },
          take: 1,
        },
      },
    });

    if (carpets.length !== carpetIds.length) {
      throw new BadRequestException("Ba'zi gilamlar topilmadi.");
    }

    const mapped = carpets.map((c) => ({
      ...c,
      barcode: c.inventoryItems[0]?.barcode || null,
      stock: 9999, // dummy fallback to satisfy validation map checks
    }));

    return new Map(mapped.map((carpet) => [carpet.id, carpet as any]));
  }

  private async resolvePromoCode(
    db: Prisma.TransactionClient | PrismaService,
    customerId: string,
    normalizedPromoCode: string,
  ): Promise<ResolvedPromoCode | null> {
    if (!normalizedPromoCode) return null;

    const promoCode = await db.promoCode.findUnique({
      where: { code: normalizedPromoCode },
      select: {
        id: true,
        code: true,
        discountPercent: true,
        isActive: true,
        startsAt: true,
        expiresAt: true,
        minOrderAmount: true,
        type: true,
        giftName: true,
        giftImage: true,
        giftPrice: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!promoCode) {
      throw new BadRequestException('Promokod topilmadi.');
    }

    if (!promoCode.isActive) {
      throw new BadRequestException('Bu promokod hozir faol emas.');
    }

    if (promoCode.startsAt && promoCode.startsAt.getTime() > Date.now()) {
      throw new BadRequestException('Bu promokod hali boshlanmagan.');
    }

    if (promoCode.expiresAt && promoCode.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Bu promokod vaqti tugagan.');
    }

    const existingUsage = await db.promoCodeUsage.findUnique({
      where: {
        promoCodeId_userId: {
          promoCodeId: promoCode.id,
          userId: customerId,
        },
      },
    });

    if (existingUsage) {
      throw new BadRequestException(
        'Siz bu promokoddan allaqachon foydalangansiz.',
      );
    }

    return promoCode;
  }

  private buildPricingSummary(
    items: CreateOrderItemDto[],
    carpetMap: Map<string, CarpetSnapshot>,
    promoCode: ResolvedPromoCode | null,
    rollMap?: Map<string, any>,
  ): OrderPricingSummary {
    let totalOriginalAmount = 0;
    let subtotalAfterCarpetDiscount = 0;
    let totalAfterPromo = 0;
    const pricingItems: OrderPricingItem[] = [];

    for (const item of items) {
      const carpet = carpetMap.get(item.carpetId);
      if (!carpet) continue;

      const isRoll = carpet.type === 'ROLL';
      let basePrice = Math.round(Number(carpet.price));
      let multiplier = item.quantity;

      if (isRoll && rollMap) {
        const rollInv = rollMap.get(`${item.carpetId}_${item.widthCm}`);
        if (rollInv) {
          basePrice = Math.round(Number(rollInv.pricePerM2));
        }
        const area = ((item.widthCm ?? 0) * (item.lengthCm ?? 0)) / 10000;
        multiplier = area * item.quantity;
      }

      const originalUnitPrice = basePrice;
      const unitPriceAfterCarpetDiscount = this.getDiscountedPrice(
        basePrice,
        carpet.discountPercent,
      );
      const promoDiscountPercent =
        promoCode?.type === 'DISCOUNT' ? promoCode.discountPercent : 0;
      const unitPriceAfterPromo =
        promoCode?.type === 'DISCOUNT'
          ? this.applyPromoDiscount(
              unitPriceAfterCarpetDiscount,
              promoCode.discountPercent,
            )
          : unitPriceAfterCarpetDiscount;

      const lineOriginalTotal = Math.round(originalUnitPrice * multiplier);
      const lineAfterCarpetDiscountTotal = Math.round(
        unitPriceAfterCarpetDiscount * multiplier,
      );
      const lineTotal = Math.round(unitPriceAfterPromo * multiplier);
      const lineProductDiscountAmount =
        lineOriginalTotal - lineAfterCarpetDiscountTotal;
      const linePromoDiscountAmount = lineAfterCarpetDiscountTotal - lineTotal;
      const lineTotalDiscountAmount = lineOriginalTotal - lineTotal;

      totalOriginalAmount += lineOriginalTotal;
      subtotalAfterCarpetDiscount += lineAfterCarpetDiscountTotal;
      totalAfterPromo += lineTotal;

      pricingItems.push({
        carpetId: item.carpetId,
        carpetName: carpet.name,
        quantity: item.quantity,
        originalUnitPrice,
        carpetDiscountPercent: Math.round(Number(carpet.discountPercent ?? 0)),
        unitPriceAfterCarpetDiscount,
        promoDiscountPercent,
        unitPriceAfterPromo,
        lineOriginalTotal,
        lineAfterCarpetDiscountTotal,
        lineTotal,
        lineProductDiscountAmount,
        linePromoDiscountAmount,
        lineTotalDiscountAmount,
      });
    }

    const productDiscountAmount =
      totalOriginalAmount - subtotalAfterCarpetDiscount;
    const promoDiscountAmount = subtotalAfterCarpetDiscount - totalAfterPromo;
    const totalDiscountAmount = totalOriginalAmount - totalAfterPromo;
    const totalDiscountPercent =
      totalOriginalAmount > 0
        ? Math.round((totalDiscountAmount / totalOriginalAmount) * 10000) / 100
        : 0;

    return {
      items: pricingItems,
      totalOriginalAmount,
      subtotalAfterCarpetDiscount,
      totalAfterPromo,
      productDiscountAmount,
      promoDiscountAmount,
      totalDiscountAmount,
      totalDiscountPercent,
    };
  }

  private async reserveStockAndIncrementSales(
    tx: Prisma.TransactionClient,
    items: CreateOrderItemDto[],
    carpetMap: Map<string, CarpetSnapshot>,
  ): Promise<void> {
    const requiredByCarpet = new Map<string, number>();
    for (const item of items) {
      const carpet = carpetMap.get(item.carpetId);
      if (carpet && carpet.type !== 'ROLL') {
        requiredByCarpet.set(
          item.carpetId,
          (requiredByCarpet.get(item.carpetId) ?? 0) + item.quantity,
        );
      }
    }

    for (const [carpetId, requiredQty] of requiredByCarpet.entries()) {
      const carpet = carpetMap.get(carpetId);
      if (!carpet) continue;

      const activeCount = await tx.inventoryItem.count({
        where: { carpetId, inventoryStatus: CarpetInventoryStatus.ACTIVE },
      });

      if (activeCount < requiredQty) {
        throw new BadRequestException(
          `Kechirasiz, "${carpet.name}" gilamidan omborda yetarli emas. Qoldiq: ${activeCount}`,
        );
      }
    }

    for (const [carpetId, requiredQty] of requiredByCarpet.entries()) {
      const carpet = carpetMap.get(carpetId);
      if (!carpet) continue;

      if (carpet.categoryId) {
        await tx.category.update({
          where: { id: carpet.categoryId },
          data: { soldCount: { increment: requiredQty } },
        });
      }
    }
  }

  private formatTelegramItemsList(items: any[]): string {
    return items
      .map((item: any, index: number) => {
        const carpet = item.carpet;
        const carpetName = carpet?.name ?? "Noma'lum gilam";
        const designCode = carpet?.designCode ? ` ${carpet.designCode}` : '';
        const barcode = carpet?.barcode ?? '-';

        let detailsText = '';
        const isRoll = carpet?.type === 'ROLL' || !!item.selectedWidthCm;
        const widthCm = item.selectedWidthCm ?? item.rollAllocation?.widthCm;
        const lengthCm = item.selectedLengthCm ?? item.rollAllocation?.lengthCm;
        const pricePerM2 = item.pricePerM2
          ? Number(item.pricePerM2)
          : carpet?.price
            ? Number(carpet.price)
            : 0;

        if (isRoll && widthCm && lengthCm) {
          const wM = widthCm / 100;
          const lM = lengthCm / 100;
          const area = (widthCm * lengthCm) / 10000;
          detailsText =
            `<b>Kenglik:</b> ${wM} m\n` +
            `<b>Uzunlik:</b> ${lM} m\n` +
            `<b>Kvadratura (m²):</b> ${area.toFixed(2)} m²\n` +
            `<b>Narxi / m²:</b> ${this.formatCurrency(pricePerM2)}\n`;
        }

        const finalUnitPrice = Number(item.price);
        const finalTotalPrice = finalUnitPrice * item.quantity;

        return (
          `<b>${index + 1}. ${carpetName}${designCode}</b>\n` +
          `<b>Shtrixkod:</b> ${barcode}\n` +
          detailsText +
          `<b>Soni:</b> ${item.quantity} ta\n` +
          `<b>Dona narxi:</b> ${this.formatCurrency(finalUnitPrice)}\n` +
          `<b>Jami narxi:</b> ${this.formatCurrency(finalTotalPrice)}\n`
        );
      })
      .join('\n');
  }

  private buildTelegramOrderMessage(
    order: any,
    pricing: OrderPricingSummary,
  ): string {
    const orderNumber = formatOrderNumber(order.id, order.createdAt);
    const promoLabel = order.appliedPromoCode
      ? order.appliedPromoType === 'GIFT'
        ? `${order.appliedPromoCode} (Sovg'a)`
        : `${order.appliedPromoCode} (-${order.appliedPromoPercent || 0}%)`
      : '-';

    const itemsText = this.formatTelegramItemsList(order.items ?? []);

    return (
      `📦 <b>Yangi Buyurtma!</b>\n` +
      `<b>Buyurtma:</b> #${orderNumber}\n` +
      `<b>Mijoz:</b> ${order.customerName}\n` +
      `<b>Tel 1:</b> ${this.formatPhoneNumber(order.phone)}\n` +
      (order.phone2
        ? `<b>Tel 2:</b> ${this.formatPhoneNumber(order.phone2)}\n`
        : '') +
      `<b>Manzil:</b> ${order.address}\n\n` +
      `📦 <b>Mahsulotlar:</b>\n${itemsText}\n` +
      `<b>Promokod:</b> ${promoLabel}\n` +
      `<b>Skidka:</b> ${this.formatCurrency(pricing.totalDiscountAmount)} (${pricing.totalDiscountPercent}%)\n` +
      `<b>Jami to'lov:</b> ${this.formatCurrency(pricing.totalAfterPromo)}`
    ).trim();
  }

  private extractBadRequestMessage(error: BadRequestException): string {
    const response = error.getResponse() as
      | string
      | { message?: string | string[] };
    if (typeof response === 'string') return response;

    if (Array.isArray(response?.message)) {
      return String(response.message[0] ?? "So'rovda xatolik.");
    }

    if (typeof response?.message === 'string') {
      return response.message;
    }

    return "So'rovda xatolik yuz berdi.";
  }

  private isInsideTashkent(lat: number, lng: number): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

    const minLat = 41.1;
    const maxLat = 41.45;
    const minLng = 69.1;
    const maxLng = 69.45;

    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  }

  private isInsideUzbekistan(lat: number, lng: number): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;

    const minLat = 37.17;
    const maxLat = 45.59;
    const minLng = 55.99;
    const maxLng = 73.15;

    return lat >= minLat && lat <= maxLat && lng >= minLng && lng <= maxLng;
  }

  private getDiscountedPrice(price: unknown, discountPercent: unknown): number {
    const basePrice = Number(price);
    if (!Number.isFinite(basePrice)) return 0;

    const percentRaw = Math.round(Number(discountPercent ?? 0));
    const percent = Number.isFinite(percentRaw)
      ? Math.min(99, Math.max(0, percentRaw))
      : 0;

    if (percent <= 0) return Math.round(basePrice);
    return Math.round((basePrice * (100 - percent)) / 100);
  }

  private applyPromoDiscount(price: number, promoPercent: unknown): number {
    const basePrice = Number(price);
    if (!Number.isFinite(basePrice)) return 0;

    const rawPercent = Math.round(Number(promoPercent ?? 0));
    const percent = Number.isFinite(rawPercent)
      ? Math.min(99, Math.max(0, rawPercent))
      : 0;

    if (percent <= 0) return Math.round(basePrice);
    return Math.round((basePrice * (100 - percent)) / 100);
  }

  private normalizePromoCode(rawCode?: string | null): string {
    return String(rawCode ?? '')
      .trim()
      .toUpperCase()
      .replace(/\s+/g, '');
  }

  private isPromoCodeReuseError(error: unknown): boolean {
    return (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      Array.isArray(error.meta?.target) &&
      (error.meta?.target as string[]).includes('promoCodeId') &&
      (error.meta?.target as string[]).includes('userId')
    );
  }

  private formatCurrency(value: number): string {
    const rounded = Math.round(Number(value));
    if (!Number.isFinite(rounded)) return "0 so'm";
    const sign = rounded < 0 ? '-' : '';
    const abs = Math.abs(rounded).toString();
    const formatted = abs.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${sign}${formatted} so'm`;
  }

  async markItemAsCut(orderId: string, orderItemId: string) {
    const allocation = await this.prisma.orderItemRoll.findFirst({
      where: { orderItemId },
    });

    if (!allocation) {
      throw new NotFoundException('Metraj gilam buyurtma elementi topilmadi.');
    }

    if (allocation.status === 'CUT') {
      throw new BadRequestException('Ushbu element allaqachon kesilgan.');
    }

    return this.prisma.$transaction(async (tx) => {
      await this.rollInventoryService.cutRollSegment(
        tx,
        allocation.rollInventoryId,
        allocation.lengthCm,
      );

      return tx.orderItemRoll.update({
        where: { id: allocation.id },
        data: { status: 'CUT' },
      });
    });
  }

  private async updateLoyaltyStats(userId: string, orderAmount: number) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
      });
      if (!user) return;

      const firstPurchaseDate = user.firstPurchaseDate || new Date();
      const lastPurchaseDate = new Date();
      const newTotalAmount = Number(user.totalPurchaseAmount) + orderAmount;
      const newPoints = user.loyaltyPoints + Math.floor(orderAmount / 10000);

      let loyaltyStatus = user.loyaltyStatus;
      if (newTotalAmount >= 30000000) {
        loyaltyStatus = 'GOLD';
      } else if (newTotalAmount >= 10000000) {
        loyaltyStatus = 'SILVER';
      } else {
        loyaltyStatus = 'BRONZE';
      }

      await this.prisma.user.update({
        where: { id: userId },
        data: {
          firstPurchaseDate,
          lastPurchaseDate,
          totalPurchaseAmount: newTotalAmount,
          loyaltyPoints: newPoints,
          loyaltyStatus,
        },
      });
    } catch (err) {
      console.error('Loyalty stats update error:', err);
    }
  }

  async getDashboardMetrics() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      ordersToday,
      totalDepositToday,
      totalRefundToday,
      totalCancelledToday,
      totalRevenueToday,
      pendingReturnsCount,
      pendingCouriersCount,
    ] = await Promise.all([
      this.prisma.order.count({
        where: { createdAt: { gte: today } },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: today }, depositAmount: { not: null } },
        _sum: { depositAmount: true },
      }),
      this.prisma.paymentHistory.aggregate({
        where: { createdAt: { gte: today }, paymentType: 'REFUND' },
        _sum: { amount: true },
      }),
      this.prisma.order.count({
        where: { createdAt: { gte: today }, status: 'CANCELLED' },
      }),
      this.prisma.order.aggregate({
        where: { createdAt: { gte: today } },
        _sum: { paidAmount: true },
      }),
      this.prisma.returnRequest.count({
        where: { status: 'RETURN_REQUESTED' },
      }),
      this.prisma.order.count({
        where: { status: 'ON_WAY' },
      }),
    ]);

    // Returned Inventory Metrics
    // Returned Inventory Metrics
    const [
      returnedInventoryCount,
      returnedInventoryValAgg,
      returnedInventorySold,
      returnedInventoryRemaining,
      returnedRevenueAgg,
      totalReturnRequests,
      approvedReturnRequestsCount,
    ] = await Promise.all([
      this.prisma.inventoryItem.count({ where: { isReturned: true } }),
      this.prisma.inventoryItem.aggregate({
        where: {
          isReturned: true,
          inventoryStatus: CarpetInventoryStatus.ACTIVE,
        },
        _sum: { piecePrice: true },
      }),
      this.prisma.inventoryItem.count({
        where: {
          isReturned: true,
          inventoryStatus: CarpetInventoryStatus.SOLD,
        },
      }),
      this.prisma.inventoryItem.count({
        where: {
          isReturned: true,
          inventoryStatus: CarpetInventoryStatus.ACTIVE,
        },
      }),
      this.prisma.inventoryItem.aggregate({
        where: {
          isReturned: true,
          inventoryStatus: CarpetInventoryStatus.SOLD,
        },
        _sum: { piecePrice: true },
      }),
      this.prisma.returnRequest.count(),
      this.prisma.returnRequest.count({ where: { status: 'RETURN_APPROVED' } }),
    ]);

    // Average Return Time (requested -> approved)
    const approvedRequests = await this.prisma.returnRequest.findMany({
      where: { status: 'RETURN_APPROVED' },
      select: { createdAt: true, updatedAt: true },
    });
    let totalReturnTimeMs = 0;
    approvedRequests.forEach((r) => {
      totalReturnTimeMs += r.updatedAt.getTime() - r.createdAt.getTime();
    });
    const averageReturnTimeHrs =
      approvedRequests.length > 0
        ? Math.round(
            totalReturnTimeMs / approvedRequests.length / (1000 * 60 * 60),
          )
        : 0;

    // Average Resale Time
    const soldReturnedItems = await this.prisma.inventoryItem.findMany({
      where: {
        isReturned: true,
        inventoryStatus: CarpetInventoryStatus.SOLD,
        NOT: { returnCreatedAt: null },
      },
      include: {
        allocations: {
          include: { orderItem: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });
    let totalResaleTimeMs = 0;
    let resaleCalculationsCount = 0;
    soldReturnedItems.forEach((c) => {
      if (c.allocations && c.allocations.length > 0) {
        totalResaleTimeMs +=
          c.allocations[0].orderItem.createdAt.getTime() -
          c.returnCreatedAt!.getTime();
        resaleCalculationsCount++;
      }
    });
    const averageResaleTimeDays =
      resaleCalculationsCount > 0
        ? Math.round(
            totalResaleTimeMs / resaleCalculationsCount / (1000 * 60 * 60 * 24),
          )
        : 0;

    // Most Returned Design & Collection
    const returnedGrouped = await this.prisma.inventoryItem.groupBy({
      by: ['carpetId'],
      where: { isReturned: true },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 1,
    });
    let mostReturnedDesign = 'N/A';
    let mostReturnedCollection = 'N/A';
    if (returnedGrouped.length > 0) {
      const topCarpet = await this.prisma.carpet.findUnique({
        where: { id: returnedGrouped[0].carpetId },
      });
      mostReturnedDesign = topCarpet?.designCode || 'N/A';
      mostReturnedCollection = topCarpet?.name || 'N/A';
    }

    const returnConversionRate =
      totalReturnRequests > 0
        ? Math.round((approvedReturnRequestsCount / totalReturnRequests) * 100)
        : 0;

    const returnedInventoryValue = Number(
      returnedInventoryValAgg._sum.piecePrice || 0,
    );
    const returnedRevenue = Number(returnedRevenueAgg._sum.piecePrice || 0);

    return {
      ordersToday,
      depositToday: Number(totalDepositToday._sum.depositAmount || 0),
      refundToday: Number(totalRefundToday._sum.amount || 0),
      cancelledToday: totalCancelledToday,
      revenueToday: Number(totalRevenueToday._sum.paidAmount || 0),
      pendingReturns: pendingReturnsCount,
      pendingCouriers: pendingCouriersCount,
      returnedInventoryCount,
      returnedInventoryValue,
      returnedInventorySold,
      returnedInventoryRemaining,
      averageReturnTimeHrs,
      averageResaleTimeDays,
      mostReturnedDesign,
      mostReturnedCollection,
      returnedRevenue,
      recoveredRevenue: returnedRevenue, // Resold returned inventory revenue is recovered revenue
      returnConversionRate,
    };
  }

  async getAuditLogs() {
    return this.prisma.auditLog.findMany({
      orderBy: { when: 'desc' },
      where: { deletedAt: null },
    });
  }

  async getDepositSettings() {
    const settings = await this.prisma.recommendationSettings.findUnique({
      where: { id: 'singleton' },
    });
    const tiers = await this.prisma.depositTier.findMany({
      orderBy: { minAmount: 'asc' },
    });
    return {
      minDeposit: settings ? Number(settings.minDeposit) : 100000,
      maxDeposit: settings ? Number(settings.maxDeposit) : 2000000,
      loyalDiscountTier1: settings ? settings.loyalDiscountTier1 : 5.0,
      loyalDiscountTier2: settings ? settings.loyalDiscountTier2 : 5.0,
      loyalCountTier1: settings ? settings.loyalCountTier1 : 3,
      loyalCountTier2: settings ? settings.loyalCountTier2 : 10,
      tiers: tiers.map((t) => ({
        id: t.id,
        minAmount: Number(t.minAmount),
        maxAmount: Number(t.maxAmount),
        percent: t.percent,
      })),
    };
  }

  async updateDepositSettings(dto: any) {
    await this.prisma.recommendationSettings.upsert({
      where: { id: 'singleton' },
      create: {
        id: 'singleton',
        minDeposit: dto.minDeposit,
        maxDeposit: dto.maxDeposit,
        loyalDiscountTier1: dto.loyalDiscountTier1,
        loyalDiscountTier2: dto.loyalDiscountTier2,
        loyalCountTier1: dto.loyalCountTier1,
        loyalCountTier2: dto.loyalCountTier2,
      },
      update: {
        minDeposit: dto.minDeposit,
        maxDeposit: dto.maxDeposit,
        loyalDiscountTier1: dto.loyalDiscountTier1,
        loyalDiscountTier2: dto.loyalDiscountTier2,
        loyalCountTier1: dto.loyalCountTier1,
        loyalCountTier2: dto.loyalCountTier2,
      },
    });

    if (dto.tiers && Array.isArray(dto.tiers)) {
      await this.prisma.depositTier.deleteMany({});
      for (const tier of dto.tiers) {
        await this.prisma.depositTier.create({
          data: {
            minAmount: tier.minAmount,
            maxAmount: tier.maxAmount,
            percent: tier.percent,
          },
        });
      }
    }
    return this.getDepositSettings();
  }
}
