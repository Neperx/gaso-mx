-- Copia del catálogo de Tecnosinergia descargada en segundo plano (la API lo entrega completo y tarda).
CREATE TABLE IF NOT EXISTS gaso_tecno_meta (
  id INT PRIMARY KEY,
  status TEXT NOT NULL,
  total INT NOT NULL DEFAULT 0,
  chunks INT NOT NULL DEFAULT 0,
  message TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS gaso_tecno_chunks (
  idx INT PRIMARY KEY,
  data TEXT NOT NULL
);
