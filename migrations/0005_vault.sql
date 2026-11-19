-- Migración 0005: Caja Fuerte / Vault de Contraseñas & Fichas de Activos de Clientes
CREATE TABLE IF NOT EXISTS gaso_vault (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',
  client_id TEXT NOT NULL DEFAULT '',
  client_name TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  password_encrypted TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  port TEXT NOT NULL DEFAULT '',
  p2p TEXT NOT NULL DEFAULT '',
  notes_encrypted TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_gaso_vault_category ON gaso_vault (category);
CREATE INDEX IF NOT EXISTS idx_gaso_vault_client ON gaso_vault (client_id);
