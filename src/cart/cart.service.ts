import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CartPreviewDto } from './dto/cart-preview.dto';

@Injectable()
export class CartService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(dto: CartPreviewDto) {
    const carpetIds = [...new Set(dto.items.map((item) => item.carpetId))];

    const carpets = await this.prisma.carpet.findMany({
      where: { id: { in: carpetIds } },
      include: { category: true },
    });

    if (carpets.length !== carpetIds.length) {
      throw new BadRequestException("Ba'zi gilamlar topilmadi.");
    }

    const items = dto.items.map((item) => {
      const carpet = carpets.find((c) => c.id === item.carpetId);
      if (!carpet) {
        throw new BadRequestException(`Gilam topilmadi: ${item.carpetId}`);
      }

      const unitPrice = Number(carpet.price);
      const subtotal = unitPrice * item.quantity;

      return {
        carpet,
        quantity: item.quantity,
        unitPrice,
        subtotal,
      };
    });

    const total = items.reduce((sum, item) => sum + item.subtotal, 0);

    return { items, total };
  }
}
