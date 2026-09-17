export const TELEGRAM_BUTTONS = {
  // Main admin menu
  MAIN_SEARCH: '🔍 Gilam qidirish',
  MAIN_NEW_ORDERS: '📦 Buyurtmalar',
  MAIN_ADD_ADMIN: '👥 Adminlar',
  MAIN_ADD_ADMIN_ALT: '👤 Adminlar',
  MAIN_ADD_SELLER: '🤝 Sotuvchilar',
  MAIN_COURIERS: '🚚 Kuryerlar',

  // Seller management
  SELLERS_ALL: '📋 Barcha sotuvchilar',
  SELLERS_ADD: "➕ Sotuvchi qo'shish",
  SELLERS_BACK: '🔙 Orqaga',

  // Courier management
  COURIERS_ALL: '📋 Barcha kuryerlar',
  COURIERS_ADD: "➕ Kuryer qo'shish",
  COURIERS_BACK: '🔙 Orqaga',

  // Courier personal menu
  COURIER_ORDERS: '📦 Mening buyurtmalarim',

  // Search menu
  SEARCH_IMAGE: '🖼️ Rasm bilan qidirish',
  SEARCH_IMAGE_ALT: '🖼 Rasm orqali qidirish',
  SEARCH_NAME: "🏷️ Nom bo'yicha",
  SEARCH_CODE: '🔢 Gul kodi bilan',
  SEARCH_SIZE: "📏 O'lcham bo'yicha",
  SEARCH_CATEGORY: "📂 Kategoriya bo'yicha",

  // Customer menu
  CUSTOMER_SEARCH: '🔍 Gilam qidirish',
  CUSTOMER_IMAGE_SEARCH: '🖼 Rasm orqali qidirish',
  CUSTOMER_CATEGORIES: '📂 Kategoriyalar',
  CUSTOMER_SIZES: "📏 O'lcham bo'yicha",
  CUSTOMER_PREMIUM: '💎 Premium',
  CUSTOMER_FAVORITES: '❤️ Sevimlilar',
  CUSTOMER_OPERATOR: '📞 Operator',
  CUSTOMER_SETTINGS: '⚙ Sozlamalar',
  CUSTOMER_ORDERS: '📦 Buyurtmalarim',
  CUSTOMER_BRANCHES: '🏢 Filiallar',
  CUSTOMER_CONTACT_ADMIN: "💬 Admin bilan bog'lanish",
  CUSTOMER_SEND_CONTACT: '📞 Telefonni yuborish',
  CUSTOMER_BACK: '🏠 Menyuga qaytish',

  // Common
  BACK: '🔙 Orqaga',
  CONFIRM: '✅ Tasdiqlash',
  CANCEL: '❌ Bekor qilish',
} as const;

/**
 * Normalizes user input by trimming, replacing multi-spaces,
 * and stripping Unicode emoji variation selectors (like U+FE0F).
 */
export function normalizeMenuText(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\uFE0F/g, '');
}

/**
 * Escapes HTML characters for Telegram parse_mode: 'HTML'
 */
export function escapeHtml(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Masks chat ID for privacy in logs (e.g. 7362992250 -> 736***250)
 */
export function maskChatId(chatId: string | number | null | undefined): string {
  if (!chatId) return 'unknown';
  const str = String(chatId);
  if (str.length <= 5) return '***';
  return `${str.slice(0, 3)}***${str.slice(-3)}`;
}
