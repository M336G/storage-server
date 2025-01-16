ALTER TABLE storage ADD COLUMN compressed_int INTEGER NOT NULL DEFAULT 0;
UPDATE storage SET compressed_int = CASE compressed WHEN 1 THEN 1 ELSE 0 END;
CREATE TABLE storage_new (
    ID VARCHAR(36) NOT NULL UNIQUE,
    hash VARCHAR DEFAULT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    compressed INTEGER NOT NULL DEFAULT 0,
    expires INTEGER DEFAULT null,
    accessed INTEGER DEFAULT null,
    timestamp INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(ID)
);
INSERT INTO storage_new (ID, hash, size, compressed, expires, accessed, timestamp)
SELECT ID, hash, size, compressed_int, expires, accessed, timestamp FROM storage;
DROP TABLE storage;
ALTER TABLE storage_new RENAME TO storage;