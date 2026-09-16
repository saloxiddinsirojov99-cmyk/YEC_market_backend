-- Product -> Carpet nomini data saqlagan holda ko'chirish
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'Product'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'Carpet'
  ) THEN
    ALTER TABLE "Product" RENAME TO "Carpet";
  END IF;
END
$$;

-- OrderItem.productId -> carpetId
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'OrderItem'
      AND column_name = 'productId'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'OrderItem'
      AND column_name = 'carpetId'
  ) THEN
    ALTER TABLE "OrderItem" RENAME COLUMN "productId" TO "carpetId";
  END IF;
END
$$;

-- Order jadvaliga customerId qo'shish
ALTER TABLE "Order"
ADD COLUMN IF NOT EXISTS "customerId" TEXT;

-- Avvaldan mavjud orderlar uchun customerId ni fallback user bilan to'ldirish
DO $$
DECLARE
  fallback_user_id TEXT;
BEGIN
  SELECT id INTO fallback_user_id
  FROM "User"
  ORDER BY "createdAt" ASC
  LIMIT 1;

  IF fallback_user_id IS NULL THEN
    fallback_user_id := 'migration_customer_1';

    INSERT INTO "User" ("id", "email", "password", "role", "createdAt", "updatedAt")
    VALUES (
      fallback_user_id,
      'migration.customer@yecmarket.uz',
      '$2b$10$CwTycUXWue0Thq9StjUM0uJ8k8R8fVQxA3NwJd6Y5wP2N5wM0k5aG',
      'CUSTOMER',
      NOW(),
      NOW()
    )
    ON CONFLICT ("email") DO NOTHING;

    SELECT id INTO fallback_user_id
    FROM "User"
    WHERE "email" = 'migration.customer@yecmarket.uz'
    LIMIT 1;
  END IF;

  UPDATE "Order"
  SET "customerId" = fallback_user_id
  WHERE "customerId" IS NULL;
END
$$;

ALTER TABLE "Order"
ALTER COLUMN "customerId" SET NOT NULL;

-- Eski FK larni tozalash
ALTER TABLE "OrderItem"
DROP CONSTRAINT IF EXISTS "OrderItem_productId_fkey";

-- Yangi FK lar
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'OrderItem_carpetId_fkey'
  ) THEN
    ALTER TABLE "OrderItem"
    ADD CONSTRAINT "OrderItem_carpetId_fkey"
    FOREIGN KEY ("carpetId") REFERENCES "Carpet"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'Order_customerId_fkey'
  ) THEN
    ALTER TABLE "Order"
    ADD CONSTRAINT "Order_customerId_fkey"
    FOREIGN KEY ("customerId") REFERENCES "User"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;

-- Indexlar
DROP INDEX IF EXISTS "Product_categoryId_idx";
CREATE INDEX IF NOT EXISTS "Carpet_categoryId_idx" ON "Carpet"("categoryId");

DROP INDEX IF EXISTS "Product_createdAt_idx";
CREATE INDEX IF NOT EXISTS "Carpet_createdAt_idx" ON "Carpet"("createdAt");

DROP INDEX IF EXISTS "OrderItem_productId_idx";
CREATE INDEX IF NOT EXISTS "OrderItem_carpetId_idx" ON "OrderItem"("carpetId");

CREATE INDEX IF NOT EXISTS "Order_customerId_idx" ON "Order"("customerId");

-- Tasdiqlash kodi registratsiya uchun jadval
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'OtpPurpose') THEN
    CREATE TYPE "OtpPurpose" AS ENUM ('REGISTER');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "OtpCode" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "purpose" "OtpPurpose" NOT NULL,
  "pendingPassword" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OtpCode_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OtpCode_email_purpose_createdAt_idx"
ON "OtpCode"("email", "purpose", "createdAt");
