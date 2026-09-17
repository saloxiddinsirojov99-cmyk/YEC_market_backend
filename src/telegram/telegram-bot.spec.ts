import {
  normalizeMenuText,
  escapeHtml,
  maskChatId,
  TELEGRAM_BUTTONS,
} from './telegram.constants';

describe('Telegram Constants and Helpers', () => {
  it('should escape HTML special characters properly', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml('Gilam 3x2 & Premium <Silk>')).toBe(
      'Gilam 3x2 &amp; Premium &lt;Silk&gt;',
    );
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  it('should mask Telegram chat IDs safely', () => {
    expect(maskChatId('7362992250')).toBe('736***250');
    expect(maskChatId(123456789)).toBe('123***789');
    expect(maskChatId('123')).toBe('***');
    expect(maskChatId(null)).toBe('unknown');
  });

  it('should normalize menu buttons with unicode variation selectors and spaces', () => {
    // With U+FE0F vs without
    const withSelector = '🖼️ Rasm bilan qidirish';
    const withoutSelector = '🖼 Rasm bilan qidirish';
    expect(normalizeMenuText(withSelector)).toBe(
      normalizeMenuText(withoutSelector),
    );

    // Multi-spaces and trailing spaces
    expect(normalizeMenuText('  🚚   Kuryerlar   ')).toBe('🚚 Kuryerlar');
    expect(normalizeMenuText('🤝  Sotuvchilar ')).toBe('🤝 Sotuvchilar');
    expect(normalizeMenuText('👥  Adminlar ')).toBe('👥 Adminlar');
    expect(normalizeMenuText('📦  Buyurtmalar ')).toBe('📦 Buyurtmalar');
  });

  it('should have all required central button definitions', () => {
    expect(TELEGRAM_BUTTONS.MAIN_COURIERS).toBe('🚚 Kuryerlar');
    expect(TELEGRAM_BUTTONS.MAIN_ADD_SELLER).toBe('🤝 Sotuvchilar');
    expect(TELEGRAM_BUTTONS.MAIN_ADD_ADMIN).toBe('👥 Adminlar');
    expect(TELEGRAM_BUTTONS.MAIN_NEW_ORDERS).toBe('📦 Buyurtmalar');
    expect(TELEGRAM_BUTTONS.MAIN_SEARCH).toBe('🔍 Gilam qidirish');
  });
});

describe('Search Text Queries Handling', () => {
  const testQueries = [
    'stef',
    '3x2',
    'l102b',
    'нео класика',
    'nonexistentxyz123',
    '🚚 Kuryerlar',
    '🤝 Sotuvchilar',
  ];

  it('should identify search queries vs menu actions', () => {
    for (const q of testQueries) {
      const normalized = normalizeMenuText(q);
      const isAction =
        normalized === normalizeMenuText(TELEGRAM_BUTTONS.MAIN_COURIERS) ||
        normalized === normalizeMenuText(TELEGRAM_BUTTONS.MAIN_ADD_SELLER);

      if (q === '🚚 Kuryerlar' || q === '🤝 Sotuvchilar') {
        expect(isAction).toBe(true);
      } else {
        expect(isAction).toBe(false);
      }
    }
  });
});
