import { join } from "node:path";
import { appendFile, unlink } from "node:fs/promises";
import { DatabaseWrapper } from "./database.js";

const logFilePath = process.env.WRITE_LOGS ? process.env.WRITE_LOGS : false;

const logLevels = {
    "trace": 0,
    "debug": 1,
    "info": 2,
    "warn": 3,
    "error": 4,
    "fatal": 5,
    "nothing": 6
};

const logLevelString = process.env.LOG_LEVEL ? process.env.LOG_LEVEL.toLowerCase() : "info";
const logLevel = logLevels[logLevelString] !== undefined ? logLevels[logLevelString] : 2;

// Simplified logging functions
const log = {
    // Log a fatal error
    fatal: async (message, fatal) => {
        if (process.argv.includes('dev')) return console.error(message, fatal)
        const logMessage = `[FATAL] ${message}${fatal ? ` ${fatal}` : ""}`;
        try {
            if (logLevel <= 5) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.error(logMessage);
            }
        } catch (error) {
            console.error("Failed to write fatal error log:", error);
        }
    },

    // Log an error
    error: async (message, error) => {
        if (process.argv.includes('dev')) return console.error(message, error)
        const logMessage = `[ERROR] ${message}${error ? ` ${error}` : ""}`;
        try {
            if (logLevel <= 4) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.error(logMessage);
            }
        } catch (error) {
            console.error("Failed to write error log:", error);
        }
    },

    // Log a warning
    warn: async (message, warn) => {
        const logMessage = `[WARN] ${message}${warn ? ` ${warn}` : ""}`;
        try {
            if (logLevel <= 3) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.warn(logMessage);
            }
        } catch (error) {
            console.error("Failed to write warn log:", error);
        }
    },

    // Log an info
    info: async (message, info) => {
        const logMessage = `[INFO] ${message}${info ? ` ${info}` : ""}`;
        try {
            if (logLevel <= 2) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.info(logMessage);
            }
        } catch (error) {
            console.error("Failed to write info log:", error);
        }
    },

    // Log a debug info
    debug: async (message, debug) => {
        const logMessage = `[DEBUG] ${message}${debug ? ` ${debug}` : ""}`;
        try {
            if (logLevel <= 1) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.debug(logMessage);
            }
        } catch (error) {
            console.error("Failed to write debug log:", error);
        }
    },

    // Log a trace info
    trace: async (message, trace) => {
        const logMessage = `[TRACE] ${message}${trace ? ` ${trace}` : ""}`;
        try {
            if (logLevel <= 0) {
                if (logFilePath) await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
                console.debug(logMessage);
            }
        } catch (error) {
            console.error("Failed to write trace log:", error);
        }
    }
};

// Asynchronous function to get the SHA-256 hash of a file from a buffer
async function getHashFromBuffer(buffer) {
    const hasher = new Bun.CryptoHasher("sha256");

    return hasher.update(buffer).digest("hex");
}
/**
 * 
 * @param { Request } request 
 * @returns 
 */
async function getClientIP(request) {
    const headers = request.headers

    // Start by checking if Cloudflare forwarded the IP
    let cfConnectingIP = headers.get("cf-connecting-ip");
    if (cfConnectingIP) return cfConnectingIP;

    // Check if NGINX X-Real-IP is supplied if not
    let xRealIP = headers.get("x-real-ip");
    if (xRealIP) return xRealIP;

    // If not then also check if NGINX has supplied X-Forwarded-For, and return the first IP of the list
    let xForwardedFor = headers.get("x-forwarded-for");
    if (xForwardedFor) return xForwardedFor.split(",")[0].trim();

    // If none of them are supplied, just supply the original address in the request
    return request.remoteAddr;
}

async function checkToken(token) {
    try {
        if (global.serverToken) {
            if (!token || token != `Bearer ${global.serverToken}`) return false;
        }
        return true;
    } catch (error) {
        log.error("Error while verifying token:", error.stack);
        return false;
    }
}

const checkExpiredFiles = async () => {
    if (!global.unaccessedMillisecondsBeforeDeletion || global.unaccessedMillisecondsBeforeDeletion == "0") return;

    const now = Date.now();
    const unaccessedBeforeDeletion = now - global.unaccessedMillisecondsBeforeDeletion;

    // Fetch files that need to be deleted
    const files = await DatabaseWrapper.getExpiredFiles(now, unaccessedBeforeDeletion);
        
    if (files.length > 0) {
        // Delete expired files from the database
        await DatabaseWrapper.deleteExpiredFiles(now, unaccessedBeforeDeletion).catch((error) => { log.error(error.stack) });

        let deletedCount = 0;

        // Prepare deletion promises for the files
        const fsDeletionPromises = files.map(row => {
            const uuid = row.ID;
                
            return unlink(join(global.storagePath, uuid))
                .then(() => {
                    deletedCount++;
                })
                .catch(() => {
                    log.error(`Failed to delete file "${uuid}" from storage`);
                });
        });

        await Promise.all(fsDeletionPromises);
        log.info(`Deleted ${deletedCount}/${files.length} expired/unaccessed file(s) from the storage`);
    }
};

const checkInvalidFiles = async () => {
    const files = await DatabaseWrapper.getAllFileIDs();

    if (files.length > 0) {
        let invalidFileCount = 0;
        let deletedCount = 0;
    
        const deletionPromises = files.map(async (row) => {
            const uuid = row.ID;
            const filePath = join(global.storagePath, uuid);
    
            if (!await Bun.file(filePath).exists()) {
                invalidFileCount++;
                return DatabaseWrapper.deleteFileFromUUID(uuid)
                .then(() => {
                    deletedCount++;
                })
                .catch((error) => {
                    log.error(error.stack);
                });
            }
        });
    
        // Wait for all deletions to complete
        await Promise.all(deletionPromises);
        if (invalidFileCount > 0) {
            log.info(`Deleted ${deletedCount}/${invalidFileCount} invalid file(s) from the database`);
        }
    }
};


const checkHashes = async () => {
    const files = await DatabaseWrapper.getFileIDsWithoutHash();

    if (files.length > 0) {
        let storedCount = 0;

        for (const file of files) {
            const filePath = join(global.storagePath, file.ID);
            const hash = await getHashFromBuffer(await Bun.file(filePath).arrayBuffer());

            await DatabaseWrapper.updateHashFromUUID(hash, file.ID)
            .then(() => {
                storedCount++;
            })
            .catch((error) => {
                log.error(error.stack);
            });
        }
        log.info(`Stored the hash of ${storedCount}/${files.length} file(s)`);
    }
};

// Clean up expired IP entries
async function cleanExpiredIPEntries() {
    global.requestCounts.forEach(async (data, ip) => {
        if (data?.expiry < Date.now()) {
            global.requestCounts.delete(ip);
        }
    });
};

// Middleware for rate limiting
async function rateLimit(request) {
    if (!global.maxRequestsPerWindow || global.maxRequestsPerWindow == "0") return true;

    const ip = await getClientIP(request) || 'unknownip'; // C'est possible que l'on puisse pas récupérer les ip avec bun à vérifier
    const now = Date.now();

    if (!global.requestCounts.has(ip)) {
        // New entry for this IP
        global.requestCounts.set(ip, { count: 1, expiry: now + global.rateLimitWindowMs });
        return true;
    }

    let entry = global.requestCounts.get(ip);

    if (now > entry.expiry) {
        // Expired window, reset data
        global.requestCounts.set(ip, { count: 1, expiry: now + global.rateLimitWindowMs });
        return true;
    }

    if (entry.count < global.maxRequestsPerWindow) {
        // Increment the counter for this IP address
        entry.count += 1;
        return true;
    }

    // Limit reached
    return false;
}

export { log, getHashFromBuffer, getClientIP, checkToken, checkExpiredFiles, checkInvalidFiles, checkHashes, cleanExpiredIPEntries, rateLimit };