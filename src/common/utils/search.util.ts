/**
 * Qidiruv qiymatlarini frontend va backendda bir xil normalizatsiya qilish uchun util funksiya.
 * O'zbekcha o'g' va g' belgilarni, unicode va double space'larni tozalaydi.
 */
export function normalizeSearchValue(value: string): string {
  if (!value) return '';

  return (
    value
      .normalize('NFKC')
      .toLowerCase()
      // Tag chiziqlar va chiziqchalarni bo'shliqqa almashtiramiz
      .replace(/[_-]/g, ' ')
      // O'zbekcha o' / o‘ / o’ diakritik belgilarini oddiy o harfiga almashtirish
      .replace(/[o‘'’]/g, 'o')
      // O'zbekcha g' / g‘ / g’ diakritik belgilarini oddiy g harfiga almashtirish
      .replace(/[g‘'’]/g, 'g')
      // Boshqa har qanday ' va ’ belgilarini tozalash (agar kerak bo'lsa)
      .replace(/['’‘ʻ]/g, '')
      // Ortiqcha bo'shliqlarni bitta bo'shliqqa keltirish
      .replace(/\s+/g, ' ')
      .trim()
  );
}
