ALTER TABLE "TonhubScanCursor"
  ADD COLUMN "scannedThroughAt" TIMESTAMP(3);

CREATE OR REPLACE FUNCTION tonhub_guard_scan_cursor_horizon()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."scannedThroughAt" IS NOT NULL AND (
    NEW."scannedThroughAt" IS NULL OR
    NEW."scannedThroughAt" < OLD."scannedThroughAt"
  ) THEN
    RAISE EXCEPTION 'TonhubScanCursor scannedThroughAt cannot move backwards';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "TonhubScanCursor_scannedThroughAt_monotonic"
BEFORE UPDATE OF "scannedThroughAt" ON "TonhubScanCursor"
FOR EACH ROW EXECUTE FUNCTION tonhub_guard_scan_cursor_horizon();
