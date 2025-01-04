import { join, isAbsolute } from "node:path";
import { unlink } from "node:fs/promises";

import { handlePing, handleFile, handleInfo, handleUpload } from "./util/web.js";
import { log, getHashFromBuffer, getClientIP } from "./util/functions.js";
import { serverHeaders } from "./util/utilities.js";
import { db } from "./util/database.js";

const TOKEN = process.env.TOKEN;
if (!TOKEN) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats");

const storagePath = process.env.STORAGE_PATH ? (isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : join(process.cwd(), process.env.STORAGE_PATH)) : join(process.cwd(), "data", "storage");

// Table kept in memory to follow requests
const requestCounts = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = process.env.RATE_LIMIT; // Maximum amount of requests per minute

const routes = {
    GET: {
        "/ping": async (req, url) => await handlePing(req, url),
        "/file/": async (req, url) => await handleFile(req, url),
        "/info": async (req, url) => await handleInfo(req, url)
    },
    POST: {
        "/upload": async (req, url) => await handleUpload(req, url),
    },
    DELETE: {
        "/file/": async (req, url) => await handleFile(req, url),
    }
};

const server = Bun.serve({
    port: Number(process.env.PORT) || 3033,
    maxRequestBodySize: process.env.MAXIMUM_UPLOAD_SIZE ? Number(process.env.MAXIMUM_UPLOAD_SIZE) * 1024 * 1024 * 1024 : undefined,

    async fetch(req) {
        const url = new URL(req.url);
        const methodRoutes = routes[req.method];

        if (!url.pathname.startsWith("/ping") && !await rateLimit(req)) return new Response(JSON.stringify({ success: false, cause: `Rate limited` }), { headers: serverHeaders, status: 429 });

        if (methodRoutes && Array.isArray(methodRoutes)) {
            await Promise.all(methodRoutes.map(async (path) => {
                if (url.pathname.startsWith(path)) {
                    // Check for correct headers
                    if (!(req.method == "GET" && url.pathname.startsWith("/file/"))) {
                        for (const [header, value] of Object.entries(serverHeaders)) {
                            if (req.headers.get(header) !== value) {
                                return new Response(JSON.stringify({ success: false, cause: `Please supply "${value}" for your "${header}" header` }), { headers: serverHeaders, status: 400 });
                            }
                        }
                    }

                    // Check for token
                    if (!(req.method == "GET" && url.pathname.startsWith("/file/")) && !url.pathname.startsWith("/ping") && !url.pathname.startsWith("/info")) {
                        if (!await checkToken(req.headers.get("Authorization"))) {
                            return new Response(JSON.stringify({ success: false, cause: "Unauthorized" }), { headers: serverHeaders, status: 401 });
                        }
                    }
        
                    return await methodRoutes[path](req, url);
                }
            }));
        } else {
            return new Response(JSON.stringify({ success: false, cause: "No path found or invalid method" }), { headers: serverHeaders, status: 404 });
        }
    }
});

// Clean up expired IP entries
async function cleanExpiredIPEntries() {
    await Promise.all(requestCounts.forEach((data, ip) => {
        if (data.expiry < Date.now()) {
            requestCounts.delete(ip);
        }
    }));
};

// Middleware for rate limiting
async function rateLimit(request) {
    if (!MAX_REQUESTS_PER_WINDOW) return true;

    const ip = getClientIP(request);
    const now = Date.now();

    if (!requestCounts.has(ip)) {
        // New entry for this IP
        requestCounts.set(ip, { count: 1, expiry: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    let entry = requestCounts.get(ip);

    if (now > entry.expiry) {
        // Expired window, reset data
        requestCounts.set(ip, { count: 1, expiry: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    if (entry.count < MAX_REQUESTS_PER_WINDOW) {
        // Increment the counter for this IP address
        entry.count += 1;
        return true;
    }

    // Limit reached
    return false;
}

log.info(`Server is now running on ${server.port}`);

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
    const unaccessedBeforeDeletion = now - ((process.env.UNACCESSED_DAYS_BEFORE_DELETION ? Number(process.env.UNACCESSED_DAYS_BEFORE_DELETION) : 999999999 /* Just prevent it from working if it's not set lmao */) * 24 * 60 * 60 * 1000); // From days to milliseconds

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

setInterval(cleanExpiredIPEntries, 60000); // Check for expired IP entries every minute

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