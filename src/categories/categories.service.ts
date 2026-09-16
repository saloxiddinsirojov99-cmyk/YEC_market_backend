import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    const existing = await this.prisma.category.findUnique({
      where: { name: dto.name },
    });

    if (existing) {
      throw new ConflictException('Kategoriya allaqachon mavjud.');
    }

    return this.prisma.category.create({ data: dto });
  }

  async findAll() {
    return this.prisma.category.findMany({
      orderBy: [{ soldCount: 'desc' }, { createdAt: 'desc' }],
      include: {
        _count: {
          select: { carpets: true },
        },
      },
    });
  }

  async update(id: string, dto: UpdateCategoryDto) {
    await this.ensureExists(id);
    return this.prisma.category.update({
      where: { id },
      data: dto,
    });
  }

  async remove(id: string) {
    await this.ensureExists(id);

    const linkedCarpets = await this.prisma.carpet.count({
      where: { categoryId: id },
    });

    if (linkedCarpets > 0) {
      throw new ConflictException(
        "Bu kategoriyada gilamlar bor. Avval gilamlarni boshqa kategoriyaga o'tkazing yoki o'chiring.",
      );
    }

    return this.prisma.category.delete({ where: { id } });
  }

  private async ensureExists(id: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id } });
    if (!category) {
      throw new NotFoundException('Kategoriya topilmadi.');
    }
  }
}
