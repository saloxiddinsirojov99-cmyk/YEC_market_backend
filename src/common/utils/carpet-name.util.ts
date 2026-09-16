/**
 * Normalizes a carpet collection name by removing trailing weight/vessel parameters
 * like _1100Gr, _2800Gr, _20mm, _16mm, etc.
 *
 * Examples:
 *   GOLD_1100Gr          -> GOLD
 *   STEFFANO_2800Gr_20mm -> STEFFANO
 *   TOUCH_2200gr_12mm    -> TOUCH
 */
export function normalizeCarpetName(name: string): string {
  if (!name) return '';
  // Match any underscore/dash/space followed by numbers and gr/mm case-insensitively
  const cleaned = name.replace(/[_\s-]+[0-9]+(?:[gG][rR]|[mM][mM])\b/gi, '');
  return cleaned.trim();
}
