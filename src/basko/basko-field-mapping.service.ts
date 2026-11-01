import { Injectable, Logger } from '@nestjs/common';
import { BaskoRawProduct } from './types/basko.types';

@Injectable()
export class BaskoFieldMappingService {
  private readonly logger = new Logger(BaskoFieldMappingService.name);

  // Configurable aliases mapping canonical internal fields to possible external column names
  private readonly DEFAULT_FIELD_ALIASES: Record<string, string[]> = {
    barcode: [
      'штрихкод',
      'штрих код',
      'штрих-код',
      'barcode',
      'shtrix kod',
      'shtrixkod',
      'shtrix-kod',
      'коди',
      'kodi',
      'kod',
      'code',
      'artikul',
      'артикул',
      'sku',
    ],
    name: [
      'махсулот номи',
      'маҳсулот номи',
      'махсулот',
      'маҳсулот',
      'mahsulot nomi',
      'mahsulot',
      'наименование',
      'product name',
      'nomi',
      'name',
      'название',
      'коллекция',
      'collection',
    ],
    designCode: [
      'дизайн коди',
      'dizayn kodi',
      'design code',
      'дизайн',
      'рисунок',
      'gul kodi',
      'dizayn',
      'pattern',
      'patterncode',
      'дизайнкоди',
    ],
    width: [
      'эни',
      'эni',
      'eni',
      'width',
      'widthmm',
      'kenglik',
      'kengligi',
      'ширина',
      'ширина(м)',
      'ширина(см)',
    ],
    length: [
      'бўйи',
      'буйи',
      'boyi',
      'length',
      'lengthmm',
      'uzunlik',
      'uzunligi',
      'длина',
      'длина(м)',
      'длина(см)',
    ],
    appearance: [
      'appearance',
      'кўриниши',
      'куриниши',
      'turi',
      'korinishi',
      'vid',
      'вид',
      'type',
      'тип',
      'форма',
      'shape',
      'producttype',
    ],
    pricePerM2: [
      'narxi',
      'narx',
      'price',
      'цена',
      'стоимость',
      'priceperm2',
      'кв.м нархи',
      'м2 нархи',
      'цена за м2',
    ],
    piecePrice: [
      'донабай',
      'донабай нархи',
      'pieceprice',
      'dona narxi',
      'цена за штуку',
      'дона',
    ],
    material: [
      'состави',
      'tarkibi',
      'material',
      'состав',
      'сырье',
      'xomashyo',
      'материал',
    ],
    yarnType: [
      'ip turi',
      'yarn',
      'yarntype',
      'обработка',
      'нить',
      'технология',
      'ip',
    ],
    color: [
      'ранги',
      'rangi',
      'color',
      'цвет',
      'оттенок',
      'rang',
    ],
    stock: [
      'қолдиқ',
      'колдик',
      'qoldiq',
      'остаток',
      'stock',
      'soni',
      'кол-во',
      'количество',
      'кол',
    ],
    remainingLengthMeters: [
      'qoldiq metr',
      'остаток метраж',
      'длина рулона',
      'metr',
      'rulon uzunligi',
    ],
    brand: [
      'бренд',
      'brand',
      'ishlab chiqaruvchi',
    ],
    category: [
      'категория',
      'category',
      'turkum',
      'kategoriya',
    ],
  };

  /**
   * Normalizes header string: removes special characters, brackets, lowercases and trims.
   */
  normalizeHeader(h: unknown): string {
    if (h === undefined || h === null) return '';
    return String(h)
      .replace(/[\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff\u200b\u200c\u200d]/g, ' ')
      .trim()
      .toLowerCase()
      .replace(/\s+/g, ' ');
  }

  /**
   * Cleans header for fuzzy matching (removes parentheses content and non-alphanumerics).
   */
  private cleanHeader(h: string): string {
    return h
      .replace(/\(.*\)/g, '')
      .replace(/[^a-z0-9а-яёўқғҳ]/g, '')
      .trim();
  }

  /**
   * Maps an arbitrary raw row object to canonical BaskoRawProduct.
   */
  mapRow(
    row: Record<string, unknown>,
    rowNum: number,
    customAliases?: Record<string, string[]>,
  ): BaskoRawProduct {
    const aliases = { ...this.DEFAULT_FIELD_ALIASES, ...customAliases };
    const rowKeys = Object.keys(row);
    const normalizedKeys = rowKeys.map((k) => ({
      original: k,
      norm: this.normalizeHeader(k),
      clean: this.cleanHeader(this.normalizeHeader(k)),
    }));

    const getValue = (canonicalField: string): unknown => {
      const candidates = aliases[canonicalField] || [];
      const normCandidates = candidates.map((c) => this.normalizeHeader(c));
      const cleanCandidates = candidates.map((c) => this.cleanHeader(this.normalizeHeader(c)));

      // 1. Exact match
      for (const k of normalizedKeys) {
        if (normCandidates.includes(k.norm)) {
          return row[k.original];
        }
      }

      // 2. Clean match
      for (const k of normalizedKeys) {
        if (cleanCandidates.includes(k.clean)) {
          return row[k.original];
        }
      }

      return undefined;
    };

    const barcodeRaw = getValue('barcode');
    const nameRaw = getValue('name');
    const designCodeRaw = getValue('designCode');
    const widthRaw = getValue('width');
    const lengthRaw = getValue('length');
    const appearanceRaw = getValue('appearance');
    const pricePerM2Raw = getValue('pricePerM2');
    const piecePriceRaw = getValue('piecePrice');
    const materialRaw = getValue('material');
    const yarnTypeRaw = getValue('yarnType');
    const colorRaw = getValue('color');
    const stockRaw = getValue('stock');
    const remLengthRaw = getValue('remainingLengthMeters');
    const brandRaw = getValue('brand');
    const categoryRaw = getValue('category');

    return {
      __rowNum__: rowNum,
      barcode: barcodeRaw as any,
      code: barcodeRaw as any,
      name: nameRaw != null ? String(nameRaw).trim() : null,
      designCode: designCodeRaw != null ? String(designCodeRaw).trim() : null,
      width: widthRaw as any,
      length: lengthRaw as any,
      appearance: appearanceRaw != null ? String(appearanceRaw).trim() : null,
      pricePerM2: pricePerM2Raw as any,
      piecePrice: piecePriceRaw as any,
      material: materialRaw != null ? String(materialRaw).trim() : null,
      yarnType: yarnTypeRaw != null ? String(yarnTypeRaw).trim() : null,
      color: colorRaw != null ? String(colorRaw).trim() : null,
      stock: stockRaw as any,
      remainingLengthMeters: remLengthRaw as any,
      brand: brandRaw != null ? String(brandRaw).trim() : null,
      category: categoryRaw != null ? String(categoryRaw).trim() : null,
    };
  }
}
