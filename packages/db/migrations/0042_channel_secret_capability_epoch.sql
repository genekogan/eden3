ALTER TABLE "channel_connections" ADD COLUMN "capability_epoch" integer DEFAULT 1 NOT NULL;
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_capability_epoch_chk" CHECK ("capability_epoch" BETWEEN 1 AND 999999);

CREATE OR REPLACE FUNCTION public.channel_secret_capability_epoch_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, public, pg_temp
AS $$
DECLARE
  credential_changed boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.capability_epoch <> 1 THEN
      RAISE EXCEPTION 'new channel credential must start at capability epoch one';
    END IF;
    RETURN NEW;
  END IF;

  credential_changed :=
    NEW.token_ciphertext IS DISTINCT FROM OLD.token_ciphertext OR
    NEW.token_iv IS DISTINCT FROM OLD.token_iv OR
    NEW.token_auth_tag IS DISTINCT FROM OLD.token_auth_tag OR
    NEW.token_sha256 IS DISTINCT FROM OLD.token_sha256 OR
    NEW.key_version IS DISTINCT FROM OLD.key_version;

  IF credential_changed THEN
    IF OLD.capability_epoch >= 999999 THEN
      RAISE EXCEPTION 'channel capability epoch exhausted';
    END IF;
    IF NEW.capability_epoch<>OLD.capability_epoch+1 THEN
      RAISE EXCEPTION 'credential rotation must advance capability epoch exactly once';
    END IF;
  ELSIF NEW.capability_epoch<>OLD.capability_epoch THEN
    RAISE EXCEPTION 'capability epoch cannot change without credential rotation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER channel_secret_capability_epoch_guard
BEFORE INSERT OR UPDATE OF token_ciphertext, token_iv, token_auth_tag, token_sha256, key_version, capability_epoch
ON public.channel_connections
FOR EACH ROW EXECUTE FUNCTION public.channel_secret_capability_epoch_guard();
