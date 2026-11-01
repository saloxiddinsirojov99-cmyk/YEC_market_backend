import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import * as XLSX from 'xlsx';
import { BaskoFieldMappingService } from './basko-field-mapping.service';
import { BaskoRawProduct } from './types/basko.types';

@Injectable()
export class BaskoExcelImportService {
  private readonly logger = new Logger(BaskoExcelImportService.name);

  constructor(private readonly fieldMappingService: BaskoFieldMappingService) {}

  /**
   * Reads an Excel file (from file path or Buffer) and extracts normalized raw products.
   * Strictly preserves formatted text for barcodes so leading zeros are not lost.
   */
  parseWorkbook(
    input: string | Buffer,
    options?: {
      sheetName?: string;
      customAliases?: Record<string, string[]>;
    },
  ): {
    sheetName: string;
    totalRows: number;
    rawProducts: BaskoRawProduct[];
  } {
    let workbook: XLSX.WorkBook;

    try {
      if (typeof input === 'string') {
        workbook = XLSX.readFile(input, {
          cellDates: false,
          raw: false, // Ensures formatted string text (preserves leading zeros!)
        });
      } else {
        workbook = XLSX.read(input, {
          type: 'buffer',
          cellDates: false,
          raw: false,
        });
      }
    } catch (err: any) {
      this.logger.error(`Excel faylini o'qishda xatolik: ${err.message}`);
      throw new BadRequestException(`Excel fayli shikastlangan yoki o'qib bo'lmadi: ${err.message}`);
    }

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      throw new BadRequestException("Excel faylida biron bir varaq (sheet) topilmadi.");
    }

    const targetSheetName = options?.sheetName || workbook.SheetNames[0];
    const worksheet = workbook.Sheets[targetSheetName];

    if (!worksheet) {
      throw new BadRequestException(`"${targetSheetName}" nomli varaq topilmadi.`);
    }

    // Convert sheet to JSON array of objects with raw strings
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(worksheet, {
      defval: '',
      raw: false, // Preserves string representation like "00123456"
    });

    if (rows.length === 0) {
      throw new BadRequestException("Excel faylida ma'lumotlar qatori topilmadi.");
    }

    this.logger.log(
      `📖 Excel fayl ochildi: Varaq "${targetSheetName}", Jami qatorlar: ${rows.length}`,
    );

    const rawProducts: BaskoRawProduct[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rowNum = i + 2; // Row 1 is usually header in Excel
      const mapped = this.fieldMappingService.mapRow(
        rows[i],
        rowNum,
        options?.customAliases,
      );
      rawProducts.push(mapped);
    }

    return {
      sheetName: targetSheetName,
      totalRows: rows.length,
      rawProducts,
    };
  }
}
