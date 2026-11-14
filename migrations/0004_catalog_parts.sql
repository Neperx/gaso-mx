CREATE TABLE IF NOT EXISTS gaso_catalog_parts (
  name TEXT NOT NULL,
  part INTEGER NOT NULL,
  n INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (name, part)
);
