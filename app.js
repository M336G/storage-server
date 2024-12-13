import { Elysia } from "elysia";
import { join } from "path";
import { randomUUID } from "crypto";
import { isURL, isBase64, isUUID } from "validator";
import { deflate, createInflate } from "node:zlib";
import { unlink } from "node:fs/promises";
import { hostname } from "node:os";
import axios from "axios";
import { PassThrough, pipeline } from "stream";

import { log, getHashFromBuffer } from "./util/functions.js";
import { db } from "./util/database.js";
import { storagePath, unaccessedDaysBeforeDeletion, maxStorageSize, enableCompression } from "./config.json";
import { version } from "./package.json";

const maxStorageBytes = maxStorageSize ? maxStorageSize * 1024 * 1024 * 1024 : null // Convert from gigabytes to bytes

const PORT = process.env.PORT ? process.env.PORT : 3033;
const TOKEN = process.env.TOKEN;
if (!TOKEN) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats");

const startTimestamp = Date.now();

const app = new Elysia({ serve: { maxRequestBodySize: 2 * 1024 * 1024 * 1024 } }); // 2 GB in bytes, max upload limit

if (process.env.BEHIND_PROXY) app.use(require("elysia-ip").ip({ headersOnly: true }));

// Rate limiting
if (process.env.RATE_LIMIT) {
    app.use(
        require("elysia-rate-limit").rateLimit({
            windowMs: 60 * 1000, // 1 minute
            limit: process.env.RATE_LIMIT,
            message: "Temporarily rate limited, please try again later."
        })
    );
}

app.get("/file/:uuid?", async ({ set, params: { uuid }, error }) => {
    try {
        if (uuid) uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) return error(400, { success: false, cause: "You can't just download the server!" });

        if (!isUUID(uuid, 4)) return error(400, { success: false, cause: "Invalid UUID" });

        const fileData = db.prepare("SELECT 1 as 'exists', expires, compressed FROM storage WHERE ID = ?").get(uuid);
        if (!fileData) return error(404, { success: false, cause: "This file doesn't exist!" });

        if (!await Bun.file(join(storagePath, uuid)).exists()) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            return error(404, { success: false, cause: "This file doesn't exist!" });
        }

        const now = Date.now();
        const expires = fileData.expires ? parseInt(fileData.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        if (expires && maxAge <= 0) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await unlink(join(storagePath, uuid));
            log.info(`Deleted expired file (${uuid})`);
            return error(404, { success: false, cause: "This file doesn't exist!" });
        }

        db.prepare("UPDATE storage SET accessed = ? WHERE ID = ?").run(Date.now(), uuid);

        const fileStream = Bun.file(join(storagePath, uuid)).stream();

        set.headers["Cache-Control"] = `public, max-age=${maxAge / 1000}, immutable`;

        const passThrough = new PassThrough();

        pipeline(
            fileStream,
            fileData.compressed === 1 ? createInflate() : new PassThrough(),
            passThrough,
            (passthroughError) => {
                if (passthroughError) {
                    log.error("Error in file pipeline:", passthroughError);
                    passThrough.destroy();
                    return error(500, { success: false, cause: "Internal Server Error" });
                }
            }
        );

        return passThrough;
    } catch (catchError) {
        log.error("Error while trying to return file:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});

app.get("/info/:uuid?", async ({ params: { uuid }, error }) => {
    try {
        if (uuid) uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        // Display information about the server instead if there is no UUID
        if (!uuid) {
            const info = db.prepare("SELECT COUNT(ID) as count, SUM(size) as size FROM storage").get();
            return {
                success: true,
                name: process.env.HOSTNAME ? process.env.HOSTNAME : hostname(),
                version,
                start: startTimestamp,
                count: info.count,
                size: info.size,
                maxSize: maxStorageBytes
            }
        }

        if (!isUUID(uuid, 4)) return error(400, { success: false, cause: "Invalid UUID" });

        const file = db.prepare("SELECT hash, size, expires, accessed, timestamp FROM storage WHERE ID = ?").get(uuid);
        if (!file) return error(404, { success: false, cause: "This file doesn't exist!" });

        const now = Date.now();
        const expires = file.expires ? parseInt(file.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        if (file.expires && maxAge <= 0) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await unlink(join(storagePath, uuid));
            log.info(`Deleted expired file (${uuid})`);
            return error(404, { success: false, cause: "This file doesn't exist!" });
        }

        return {
            success: true,
            uuid,
            hash: file.hash,
            size: file.size,
            expires: file.expires,
            accessed: file.accessed,
            timestamp: file.timestamp,
        };
    } catch (catchError) {
        log.error("Error while trying to return file info:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});

app.delete("/file/:uuid", async ({ headers, params: { uuid }, error }) => {
    if (!await checkToken(headers.authorization)) return error(401, { success: false, cause: "Unauthorized" });
    try {
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) return error(400, { success: false, cause: "You can't just delete the server!" });

        if (!isUUID(uuid, 4)) return error(400, { success: false, cause: "Invalid UUID" });

        const fileExist = db.prepare("SELECT 1 FROM storage WHERE ID = ?").get(uuid);
        if (!fileExist) return { success: false, cause: "This file doesn't exist!" };

        db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
        await unlink(join(storagePath, uuid));
        log.info(`Deleted file (${uuid})`);

        return { success: true, uuid };
    } catch (catchError) {
        log.error("Error while trying to delete file:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});

app.get("/ping", async ({ error }) => {
    try {
        return { timestamp: Date.now() };
    } catch (catchError) {
        log.error("Error while trying to ping:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});

app.post("/upload", async ({ headers, body: { file, link, expires }, error }) => {
    if (!await checkToken(headers.authorization)) return error(401, { success: false, cause: "Unauthorized" });
    
    try {
        if (link) link = decodeURIComponent(link).replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, "");
        if (!file && !link) return error(400, { success: false, cause: "Please at least send a file or a link!" });
        if (expires && typeof expires !== "number") return error(422, { success: false, cause: "Make sure that the expires parameter is an integer" });
        if (expires && expires <= Date.now()) return error(422, { success: false, cause: "Expiry timestamp must be above the current epoch timestamp" });

        if (file && !isBase64(file)) return error(422, { success: false, cause: "Please send a base64 encoded file" });
        if (link && !isURL(link)) return error(422, { success: false, cause: "Please send a valid URL" });
        if (file) file = Buffer.from(file, "base64");

        if (link) {
            try {
                const fileData = await axios.get(link, { responseType: "arraybuffer", headers: { "User-Agent": `StorageServer/${version}` } });
                file = fileData.data;
            } catch (axiosError) {
                log.error("Failed to fetch file from URL:", axiosError);
                return error(500, { success: false, cause: "Error fetching file from URL" });
            }
        }

        const hash = await getHashFromBuffer(file);
        const fileExists = db.prepare("SELECT ID FROM storage WHERE hash = ? ORDER BY timestamp DESC LIMIT 1").get(hash);
        if (fileExists) return { success: true, uuid: fileExists.ID, hash, message: "This file already exists!" };

        if (enableCompression) {
            file = await new Promise((resolve, reject) => {
                deflate(file, (error, buffer) => {
                    if (error) {
                        log.error("Error while trying to compress a file:", error);
                        resolve(null);
                    }
                    resolve(buffer);
                });
            });
            if (!file) return error(500, { success: false, cause: "Internal Server Error" });
        }

        if (maxStorageBytes && file.length > maxStorageBytes) return error(413, { success: false, cause: "File too large" });

        const uuid = randomUUID();
        const filename = join(storagePath, uuid);
        await Bun.write(filename, file);
        const compressed = enableCompression ? 1 : 0;

        db.prepare("INSERT INTO storage (ID, hash, timestamp, size, expires, compressed) VALUES (?, ?, ?, ?, ?, ?)").run(uuid, hash, Date.now(), file.length, expires, compressed);

        log.info(`New file added (${uuid})`);
        return { success: true, uuid, hash };
    } catch (catchError) {
        log.error("Error uploading file:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});


app.listen(PORT, async () => { log.info(`Server is now running on ${PORT}`) });

async function checkToken(token) {
    try {
        if (TOKEN) {
            if (!token || token != `Bearer ${TOKEN}`) return false;
        }
        return true;
    } catch (error) {
        log.error("Error while verifying token:", error);
        return false;
    }
}

const checkExpiredFiles = async () => {
    const now = Date.now();
    const unaccessedBeforeDeletion = now - ((unaccessedDaysBeforeDeletion ? unaccessedDaysBeforeDeletion : 999999999 /* Just prevent it from working if it's not set lmao */) * 24 * 60 * 60 * 1000); // From days to milliseconds

    // Fetch files that need to be deleted
    const files = db.prepare("SELECT ID FROM storage WHERE (expires IS NOT NULL AND expires < ?) OR (accessed IS NOT NULL AND accessed < ?) OR (accessed IS NULL AND timestamp < ?)").all(now, unaccessedBeforeDeletion, unaccessedBeforeDeletion);

    if (files.length > 0) {
        // Delete expired files from the database
        db.prepare("DELETE FROM storage WHERE (expires IS NOT NULL AND expires < ?) OR (accessed IS NOT NULL AND accessed < ?) OR (accessed IS NULL AND timestamp < ?)").run(now, unaccessedBeforeDeletion, unaccessedBeforeDeletion);

        // Prepare deletion promises for the files
        const fsDeletionPromises = files.map(row => {
            const uuid = row.ID;
            return unlink(join(storagePath, uuid));
        });

        // Wait for all deletions to complete
        try {
            await Promise.all(fsDeletionPromises);
            log.info(`Deleted expired/(old) unaccessed files (${files.length} files)`);
        } catch (error) {
            log.error("Error deleting files from storage:", error);
        }
    }
};

const checkInvalidFiles = async () => {
    const files = db.prepare("SELECT ID FROM storage").all();
    
    if (files.length == 0) return;

    const deletionPromises = [];

    for (const row of files) {
        const uuid = row.ID;
        const filePath = join(storagePath, uuid);

        if (!await Bun.file(filePath).exists()) {
            deletionPromises.push(
                db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid)
            );
        }
    }

    // Wait for all deletions to complete
    try {
        await Promise.all(deletionPromises);
        if (deletionPromises.length > 0) log.info(`Deleted invalid files (${deletionPromises.length} files)`);
    } catch (error) {
        log.error("Error deleting invalid files from the database:", error);
    }
};

const checkHashes = async () => {
    const files = db.prepare("SELECT ID FROM storage WHERE hash IS null").all();

    if (files.length > 0) {
        for (const file of files) {
            const filePath = join(storagePath, file.ID);
            const hash = await getHashFromBuffer(await Bun.file(filePath).arrayBuffer());
            db.prepare("UPDATE storage SET hash = ? WHERE ID = ?").run(hash, file.ID);
        }

        try {
            log.info(`Stored the hash of ${files.length} files`);
        } catch (error) {
            log.error("Error storing file hashes in storage:", error);
        }
    }
};

checkExpiredFiles();
setInterval(checkExpiredFiles, 1800000); // Check for expired/(old) unaccessed files every 30 minutes
checkInvalidFiles();
setInterval(checkInvalidFiles, 86400000); // Check for invalid files every day
checkHashes();
setInterval(checkHashes, 86400000); // Check for files that haven't gotten an hash every day

process.on("unhandledRejection", (reason, promise) => {
    log.fatal(`Unhandled rejection at ${promise}:`, reason);
    process.exit(1);
});

process.on("uncaughtException", (error) => {
    log.fatal(`Uncaught exception:`, error);
    process.exit(1);
});