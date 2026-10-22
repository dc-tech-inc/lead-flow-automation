CREATE TABLE IF NOT EXISTS leads (
  id           uuid PRIMARY KEY,
  external_id  text NOT NULL UNIQUE,
  source       text NOT NULL,
  email        text NOT NULL,
  name         text NOT NULL,
  company      text,
  received_at  timestamptz NOT NULL,
  responded_at timestamptz,
  converted_at timestamptz,
  crm_id       text,
  crm_status   text NOT NULL DEFAULT 'pending' CHECK (crm_status IN ('pending', 'synced', 'failed')),
  synthetic    boolean NOT NULL DEFAULT false,
  CHECK (responded_at IS NULL OR responded_at >= received_at)
);

-- The dashboard filters by received_at over a rolling window.
CREATE INDEX IF NOT EXISTS leads_received_at_idx ON leads (received_at);
