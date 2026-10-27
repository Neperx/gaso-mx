CREATE TABLE IF NOT EXISTS gaso_catalog_parts (
  name TEXT NOT NULL,
  part INT NOT NULL,
  n INT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (name, part)
);
