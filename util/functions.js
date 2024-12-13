import { appendFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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
    return createHash("sha256").update(buffer).digest("hex");
}

export { log, getHashFromBuffer };