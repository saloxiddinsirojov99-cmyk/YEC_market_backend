CREATE TABLE IF NOT EXISTS "promo_codes" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "discountPercent" INTEGER NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_codes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "promo_codes_code_key" ON "promo_codes"("code");
CREATE INDEX IF NOT EXISTS "promo_codes_isActive_idx" ON "promo_codes"("isActive");
CREATE INDEX IF NOT EXISTS "promo_codes_code_idx" ON "promo_codes"("code");

CREATE TABLE IF NOT EXISTS "promo_code_usages" (
  "id" TEXT NOT NULL,
  "promoCodeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "promo_code_usages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "promo_code_usages_promoCodeId_fkey" FOREIGN KEY ("promoCodeId") REFERENCES "promo_codes"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promo_code_usages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "promo_code_usages_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_usages_orderId_key" ON "promo_code_usages"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "promo_code_usages_promoCodeId_userId_key" ON "promo_code_usages"("promoCodeId", "userId");
CREATE INDEX IF NOT EXISTS "promo_code_usages_promoCodeId_idx" ON "promo_code_usages"("promoCodeId");
CREATE INDEX IF NOT EXISTS "promo_code_usages_userId_idx" ON "promo_code_usages"("userId");

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'orders'
  ) THEN
    ALTER TABLE "orders"
    ADD COLUMN IF NOT EXISTS "appliedPromoCode" TEXT,
    ADD COLUMN IF NOT EXISTS "appliedPromoPercent" INTEGER NOT NULL DEFAULT 0;
  ELSIF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'Order'
  ) THEN
    ALTER TABLE "Order"
    ADD COLUMN IF NOT EXISTS "appliedPromoCode" TEXT,
    ADD COLUMN IF NOT EXISTS "appliedPromoPercent" INTEGER NOT NULL DEFAULT 0;
  END IF;
END
$$;
