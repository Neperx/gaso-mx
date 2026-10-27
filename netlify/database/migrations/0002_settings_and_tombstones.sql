-- Ajustes cifrados (⚙️ Configuración) y registro de eliminaciones para la sincronización.
CREATE TABLE IF NOT EXISTS gaso_settings (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS gaso_tombstones (
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  deleted_at BIGINT NOT NULL,
  PRIMARY KEY (kind, key)
);
