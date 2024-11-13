import { appendFile } from "node:fs/promises";
import { join } from "path";

const logFilePath = join(__dirname, "..", "logs.txt");

// Simplified logging functions
const log = {
    // Log an error
    error: async (message, error) => {
        const logMessage = `[ERROR] ${message}${error ? ` ${error}` : ""}`;
        try {
            await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
            console.error(logMessage);
        } catch (error) {
            console.error("Failed to write error log:", error);
        }
    },

    // Log a warning
    warn: async (message, warn) => {
        const logMessage = `[WARN] ${message}${warn ? ` ${warn}` : ""}`;
        try {
            await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
            console.warn(logMessage);
        } catch (error) {
            console.error("Failed to write warn log:", error);
        }
    },

    // Log an info
    info: async (message, info) => {
        const logMessage = `[INFO] ${message}${info ? ` ${info}` : ""}`;
        try {
            await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
            console.info(logMessage);
        } catch (error) {
            console.error("Failed to write info log:", error);
        }
    },

    // Log a debug
    debug: async (message, debug) => {
        const logMessage = `[DEBUG] ${message}${debug ? ` ${debug}` : ""}`;
        try {
            await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
            console.debug(logMessage);
        } catch (error) {
            console.error("Failed to write debug log:", error);
        }
    },

    // Log a request
    request: async (request, logToConsole = false) => {
        if (!request) return;
        const logMessage = `[REQUEST] ${request}`;
        try {
            await appendFile(logFilePath, `${logMessage}\n`, { encoding: "utf8" });
            if (logToConsole) console.log(logMessage);
        } catch (error) {
        console.error("Failed to write request log:", error);
        }
    }
};

export { log };