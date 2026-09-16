DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'carpets_price_non_negative_chk'
  ) THEN
    ALTER TABLE "carpets"
    ADD CONSTRAINT "carpets_price_non_negative_chk"
    CHECK ("price" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'carpets_stock_non_negative_chk'
  ) THEN
    ALTER TABLE "carpets"
    ADD CONSTRAINT "carpets_stock_non_negative_chk"
    CHECK ("stock" >= 0);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'order_items_price_non_negative_chk'
  ) THEN
    ALTER TABLE "order_items"
    ADD CONSTRAINT "order_items_price_non_negative_chk"
    CHECK ("price" >= 0);
  END IF;
END
$$;
