require("dotenv").config();
import { Elysia } from "elysia";
import { Database } from "bun:sqlite";
import { join } from "path";
import { randomUUID } from "crypto";
import { isURL, isBase64, isUUID } from "validator";
import { deflate, createInflate } from "node:zlib";
import { unlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import axios from "axios";

import { log } from "./util/functions.js";
import { storagePath, unaccessedDaysBeforeDeletion, maxStorageSize, enableCompression } from "./config.json";
import { version } from "./package.json";

const PORT = process.env.PORT ? process.env.PORT : 3033;
const TOKEN = process.env.TOKEN;
if (!TOKEN) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats");

let db;
try {
    db = new Database(join(__dirname, "data", "database.db"));
    const initScript = await Bun.file(join(__dirname, "data", "database.sql")).text();
    db.exec(initScript);
    db.exec("PRAGMA journal_mode = WAL;");
    log.info("Connected to SQLite and initialized tables if they didn't exist");
} catch (catchError) {
    log.error("Error initializing SQLite database:", catchError.message);
    process.exit(1);
}

const app = new Elysia();

if (process.env.TRUST_PROXY) app.set("trust proxy", process.env.TRUST_PROXY); // Number of proxies between user and server

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

app.get("/file/:uuid", async ({ set, params: { uuid }, error }) => {
    try {
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

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

        const fileStream = createReadStream(join(storagePath, uuid));

        set.headers["Cache-Control"] = `public, max-age=${maxAge / 1000}, immutable`;

        // Handle file compression
        if (fileData.compressed === 1) {
            return fileStream.pipe(createInflate());
        } else {
            return fileStream;
        }
    } catch (catchError) {
        log.error("Error while trying to return file:", catchError);
        return error(500, { success: false, cause: "Internal Server Error" });
    }
});

app.get("/info/:uuid", async ({ params: { uuid }, error }) => {
    try {
        uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        if (!uuid) return error(400, { success: false, cause: "You can't just fetch the server!" });

        if (!isUUID(uuid, 4)) return error(400, { success: false, cause: "Invalid UUID" });

        const file = db.prepare("SELECT size, expires, accessed, timestamp FROM storage WHERE ID = ?").get(uuid);
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
        if (link) link = decodeURIComponent(link, "base64url").replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, "");
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
            if (!file) { if (!res.headersSent) return res.status(500).send({ success: false, cause: "Internal Server Error" }); else return }
        }

        if (maxStorageSize && file.length > maxStorageSize) return error(413, { success: false, cause: "File too large" });

        const uuid = randomUUID();
        const filename = join(storagePath, uuid);
        await Bun.write(filename, file);
        const compressed = enableCompression ? 1 : 0;

        db.prepare("INSERT INTO storage (ID, timestamp, size, expires, compressed) VALUES (?, ?, ?, ?, ?)").run(uuid, Date.now(), file.length, expires, compressed);

        log.info(`New file added (${uuid})`);
        return { success: true, uuid };
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

setInterval(checkExpiredFiles, 1800000); // Check for expired/(old) unaccessed files every 30 minutes
setInterval(checkInvalidFiles, 86400000); // Check for invalid files every day

process.on("unhandledRejection", (reason, promise) => {
    log.error(`Unhandled rejection at ${promise}:`, reason);
});

process.on("uncaughtException", (error) => {
    log.error(`Uncaught exception:`, error);
});