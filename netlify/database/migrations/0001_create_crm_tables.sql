-- Tablas compartidas de CRM: clientes, notas (cotizaciones) y contador de folios.
CREATE TABLE IF NOT EXISTS gaso_clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gaso_quotes (
  number TEXT PRIMARY KEY,
  client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',
  quote_date TEXT NOT NULL DEFAULT '',
  total NUMERIC NOT NULL DEFAULT 0,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_gaso_quotes_client ON gaso_quotes (client_name);

CREATE TABLE IF NOT EXISTS gaso_folio_seq (
  year INT PRIMARY KEY,
  seq INT NOT NULL DEFAULT 0
);
