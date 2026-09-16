import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RollAllocationStatus } from '@prisma/client';

@Injectable()
export class RollInventoryService {
  constructor(private readonly prisma: PrismaService) {}

  async reserveRollLength(
    tx: any,
    carpetId: string,
    widthCm: number,
    lengthCm: number,
  ) {
    const roll = await tx.rollInventory.findFirst({
      where: { carpetId, widthCm },
    });

    if (!roll) {
      throw new NotFoundException(
        `Ushbu gilam uchun ${widthCm} sm kenglikdagi roll topilmadi.`,
      );
    }

    const availableLength = roll.currentLengthCm - roll.reservedLengthCm;
    if (availableLength < lengthCm) {
      throw new BadRequestException(
        `Roll variantida yetarli uzunlik yo'q. Mavjud: ${availableLength / 100} m, So'ralgan: ${lengthCm / 100} m`,
      );
    }

    // Increment reserved length
    return tx.rollInventory.update({
      where: { id: roll.id },
      data: {
        reservedLengthCm: { increment: lengthCm },
      },
    });
  }

  async releaseRollReservation(
    tx: any,
    rollInventoryId: string,
    lengthCm: number,
  ) {
    return tx.rollInventory.update({
      where: { id: rollInventoryId },
      data: {
        reservedLengthCm: { decrement: lengthCm },
      },
    });
  }

  async cutRollSegment(tx: any, rollInventoryId: string, lengthCm: number) {
    // Cut is done: decrement reserved, and decrement current length
    return tx.rollInventory.update({
      where: { id: rollInventoryId },
      data: {
        currentLengthCm: { decrement: lengthCm },
        reservedLengthCm: { decrement: lengthCm },
      },
    });
  }

  async restockRollSegment(tx: any, rollInventoryId: string, lengthCm: number) {
    // Add returned segment back to the roll's current length
    return tx.rollInventory.update({
      where: { id: rollInventoryId },
      data: {
        currentLengthCm: { increment: lengthCm },
      },
    });
  }
}
