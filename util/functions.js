import { appendFile } from "node:fs/promises";

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

async function generateAES128Key() {
    const key = await crypto.subtle.generateKey(
        { name: "AES-GCM", length: 128 },
        true,
        ["encrypt", "decrypt"]
    );
    const rawKey = await crypto.subtle.exportKey("raw", key);

    return Buffer.from(rawKey).toString("hex");
}

async function encryptAES128(file, keyHex) {
    const keyBuffer = Buffer.from(keyHex, "hex");
    const key = await crypto.subtle.importKey(
        "raw",
        keyBuffer,
        { name: "AES-GCM" },
        false,
        ["encrypt"]
    );
  
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        file
    );
  
    return Buffer.concat([iv, Buffer.from(encrypted)]).toString("hex");
}

async function decryptAES128(encryptedHex, keyHex) {
    const encryptedBuffer = Buffer.from(encryptedHex, "hex");
    const iv = encryptedBuffer.slice(0, 12); // TODO: replace this with something not deprecated
    const data = encryptedBuffer.slice(12); // TODO: replace this with something not deprecated
  
    const keyBuffer = Buffer.from(keyHex, "hex");
    const key = await crypto.subtle.importKey(
        "raw",
        keyBuffer,
        { name: "AES-GCM" },
        false,
        ["decrypt"]
    );
  
    const decrypted = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv },
        key,
        data
    );
  
    return Buffer.from(decrypted);
}

export { log, getHashFromBuffer, getClientIP, generateAES128Key, encryptAES128, decryptAES128 };