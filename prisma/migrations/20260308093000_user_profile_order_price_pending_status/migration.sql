-- User profile fields
ALTER TABLE "User"
ADD COLUMN "name" TEXT,
ADD COLUMN "phone" TEXT;

UPDATE "User"
SET "name" = COALESCE(NULLIF(SPLIT_PART("email", '@', 1), ''), 'Foydalanuvchi')
WHERE "name" IS NULL;

UPDATE "User"
SET "phone" = CONCAT('NOMA''LUM-', SUBSTRING("id", 1, 6))
WHERE "phone" IS NULL;

ALTER TABLE "User"
ALTER COLUMN "name" SET NOT NULL,
ALTER COLUMN "phone" SET NOT NULL;

-- Tasdiqlash kodi pending profile fields
ALTER TABLE "OtpCode"
ADD COLUMN "pendingName" TEXT,
ADD COLUMN "pendingPhone" TEXT;

-- Order status value rename: NEW -> PENDING
ALTER TYPE "OrderStatus" RENAME VALUE 'NEW' TO 'PENDING';

ALTER TABLE "Order"
ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Snapshot price per ordered carpet
ALTER TABLE "OrderItem"
ADD COLUMN "price" DECIMAL(10, 2);

UPDATE "OrderItem" AS oi
SET "price" = c."price"
FROM "Carpet" AS c
WHERE oi."carpetId" = c."id"
  AND oi."price" IS NULL;

ALTER TABLE "OrderItem"
ALTER COLUMN "price" SET NOT NULL;
