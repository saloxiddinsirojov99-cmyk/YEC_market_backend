import {
  BadRequestException,
  ConflictException,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { DeliveryScheduleStatus } from '@prisma/client';

@Injectable()
export class DeliveryService implements OnModuleInit {
  private defaultCapacity = 8;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit() {
    const capacityEnv = this.configService.get<string>(
      'DELIVERY_DAILY_CAPACITY',
    );
    if (capacityEnv) {
      const parsed = parseInt(capacityEnv, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.defaultCapacity = parsed;
      }
    }
    void this.syncExistingSchedulesCapacity();
  }

  private async syncExistingSchedulesCapacity() {
    try {
      const schedules = await this.prisma.deliverySchedule.findMany({
        where: { capacity: 30 },
      });
      for (const s of schedules) {
        const available = Math.max(0, this.defaultCapacity - s.reservedOrders);
        const status =
          available <= 0
            ? DeliveryScheduleStatus.FULL
            : s.status === DeliveryScheduleStatus.CLOSED
              ? DeliveryScheduleStatus.CLOSED
              : DeliveryScheduleStatus.AVAILABLE;
        await this.prisma.deliverySchedule.update({
          where: { id: s.id },
          data: {
            capacity: this.defaultCapacity,
            availableSlots: available,
            status,
          },
        });
      }
    } catch (err) {
      // Ignore if database is initializing
    }
  }

  // Get current time in Tashkent timezone (+5)
  getTashkentTime(): Date {
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60 * 1000;
    return new Date(utc + 5 * 60 * 60 * 1000);
  }

  formatDateString(date: Date): string {
    const yyyy = date.getFullYear();
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  }

  getUzbekLabel(dateStr: string): string {
    const todayStr = this.formatDateString(this.getTashkentTime());

    const tomorrow = this.getTashkentTime();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const tomorrowStr = this.formatDateString(tomorrow);

    if (dateStr === todayStr) {
      return '🟣 Bugun';
    }
    if (dateStr === tomorrowStr) {
      return '🟣 Ertaga';
    }

    const date = new Date(dateStr);
    const day = date.getDate();

    const months = [
      'yanvar',
      'fevral',
      'mart',
      'aprel',
      'may',
      'iyun',
      'iyul',
      'avgust',
      'sentabr',
      'oktabr',
      'noyabr',
      'dekabr',
    ];
    const days = [
      'Yakshanba',
      'Dushanba',
      'Seshanba',
      'Chorshanba',
      'Payshanba',
      'Juma',
      'Shanba',
    ];

    const monthName = months[date.getMonth()];
    const dayName = days[date.getDay()];

    return `📅 ${day}-${monthName}, ${dayName}`;
  }

  async getAvailability() {
    const tashTime = this.getTashkentTime();
    const hours = tashTime.getHours();

    // Baseline calculation starts today if time is <= 21:00, otherwise tomorrow
    const baseDate = new Date(tashTime);
    if (hours >= 21) {
      baseDate.setDate(baseDate.getDate() + 1);
    }

    // Scan the next 30 days to find the first available delivery slot
    for (let i = 0; i < 30; i++) {
      const scanDate = new Date(baseDate);
      scanDate.setDate(baseDate.getDate() + i);
      const dateStr = this.formatDateString(scanDate);

      const schedule = await this.prisma.deliverySchedule.findUnique({
        where: { dateString: dateStr },
      });

      if (schedule) {
        if (
          schedule.status === DeliveryScheduleStatus.CLOSED ||
          schedule.status === DeliveryScheduleStatus.FULL ||
          schedule.reservedOrders >= schedule.capacity
        ) {
          continue;
        }
        return {
          dateString: dateStr,
          label: this.getUzbekLabel(dateStr),
          capacity: schedule.capacity,
          reserved: schedule.reservedOrders,
          available: schedule.availableSlots,
        };
      } else {
        // Assume default availability
        return {
          dateString: dateStr,
          label: this.getUzbekLabel(dateStr),
          capacity: this.defaultCapacity,
          reserved: 0,
          available: this.defaultCapacity,
        };
      }
    }

    throw new BadRequestException(
      "Yaqin kunlar ichida bo'sh yetkazib berish slotlari topilmadi.",
    );
  }

  async reserveSlot(dateStr: string) {
    const schedule = await this.prisma.deliverySchedule.findUnique({
      where: { dateString: dateStr },
    });

    const capacity = schedule ? schedule.capacity : this.defaultCapacity;
    const reserved = schedule ? schedule.reservedOrders : 0;

    if (
      reserved >= capacity ||
      (schedule && schedule.status === DeliveryScheduleStatus.CLOSED)
    ) {
      throw new BadRequestException(
        `Tanlangan kun (${dateStr}) uchun yetkazib berish limitlari to'lgan.`,
      );
    }

    const nextReserved = reserved + 1;
    const available = Math.max(0, capacity - nextReserved);
    const status =
      available <= 0
        ? DeliveryScheduleStatus.FULL
        : DeliveryScheduleStatus.AVAILABLE;

    return this.prisma.deliverySchedule.upsert({
      where: { dateString: dateStr },
      create: {
        dateString: dateStr,
        capacity,
        reservedOrders: nextReserved,
        availableSlots: available,
        status,
      },
      update: {
        reservedOrders: nextReserved,
        availableSlots: available,
        status,
      },
    });
  }

  async validateAndReserveSlot(requestedDateString?: string): Promise<string> {
    const availability = await this.getAvailability();

    if (!requestedDateString) {
      await this.reserveSlot(availability.dateString);
      return availability.dateString;
    }

    const schedule = await this.prisma.deliverySchedule.findUnique({
      where: { dateString: requestedDateString },
    });

    const capacity = schedule ? schedule.capacity : this.defaultCapacity;
    const reserved = schedule ? schedule.reservedOrders : 0;

    if (
      reserved >= capacity ||
      (schedule && schedule.status === DeliveryScheduleStatus.CLOSED)
    ) {
      throw new ConflictException({
        message: `Tanlangan yetkazib berish kuni (${requestedDateString}) band bo'ldi.`,
        nextAvailableDate: availability.dateString,
        nextAvailableLabel: availability.label,
      });
    }

    await this.reserveSlot(requestedDateString);
    return requestedDateString;
  }

  async releaseSlot(dateStr: string) {
    const schedule = await this.prisma.deliverySchedule.findUnique({
      where: { dateString: dateStr },
    });
    if (!schedule) return;

    const nextReserved = Math.max(0, schedule.reservedOrders - 1);
    const available = Math.max(0, schedule.capacity - nextReserved);
    const status =
      available <= 0
        ? DeliveryScheduleStatus.FULL
        : DeliveryScheduleStatus.AVAILABLE;

    return this.prisma.deliverySchedule.update({
      where: { dateString: dateStr },
      data: {
        reservedOrders: nextReserved,
        availableSlots: available,
        status,
      },
    });
  }

  async getAdminSchedule(daysCount = 14) {
    const tashTime = this.getTashkentTime();
    const baseDate = new Date(tashTime);

    const result: any[] = [];
    for (let i = 0; i < daysCount; i++) {
      const scanDate = new Date(baseDate);
      scanDate.setDate(baseDate.getDate() + i);
      const dateStr = this.formatDateString(scanDate);

      const schedule = await this.prisma.deliverySchedule.findUnique({
        where: { dateString: dateStr },
      });

      if (schedule) {
        result.push(schedule);
      } else {
        result.push({
          id: `temp-${dateStr}`,
          dateString: dateStr,
          capacity: this.defaultCapacity,
          reservedOrders: 0,
          availableSlots: this.defaultCapacity,
          status: 'AVAILABLE',
        });
      }
    }
    return result;
  }

  async updateCapacity(
    dateStr: string,
    capacity: number,
    status?: DeliveryScheduleStatus,
  ) {
    const schedule = await this.prisma.deliverySchedule.findUnique({
      where: { dateString: dateStr },
    });

    const reserved = schedule ? schedule.reservedOrders : 0;
    const nextCapacity = capacity;
    const available = Math.max(0, nextCapacity - reserved);
    const nextStatus =
      status ||
      (available <= 0
        ? DeliveryScheduleStatus.FULL
        : DeliveryScheduleStatus.AVAILABLE);

    return this.prisma.deliverySchedule.upsert({
      where: { dateString: dateStr },
      create: {
        dateString: dateStr,
        capacity: nextCapacity,
        reservedOrders: reserved,
        availableSlots: available,
        status: nextStatus,
      },
      update: {
        capacity: nextCapacity,
        availableSlots: available,
        status: nextStatus,
      },
    });
  }
}
