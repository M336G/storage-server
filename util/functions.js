const fs = require("fs").promises;
const path = require("path");

// Simplified async functions that are related to console logging.
const log = {
    // Log an error in the console.
    error: async (message, error) => {
        const logMessage = !error ? `[ERROR] ${message}` : `[ERROR] ${message} ${error}`;
        try {
            await fs.appendFile(path.join(__dirname, "..", "logs.txt"), `${logMessage}\n`, 'utf8');
            return console.error(logMessage);
        } catch (error) {
            console.error("Failed to write error log:", error);
        }
    },

    // Log a warning in the console.
    warn: async (message, warn) => {
        const logMessage = !warn ? `[WARN] ${message}` : `[WARN] ${message} ${warn}`;
        try {
            await fs.appendFile(path.join(__dirname, "..", "logs.txt"), `${logMessage}\n`, 'utf8');
            return console.warn(logMessage);
        } catch (error) {
            console.error("Failed to write warn log:", error);
        }
    },

    // Log an info in the console.
    info: async (message, info) => {
        const logMessage = !info ? `[INFO] ${message}` : `[INFO] ${message} ${info}`;
        try {
            await fs.appendFile(path.join(__dirname, "..", "logs.txt"), `${logMessage}\n`, 'utf8');
            return console.info(logMessage);
        } catch (error) {
            console.error("Failed to write info log:", error);
        }
    },

    // Log a debug in the console.
    debug: async (message, debug) => {
        const logMessage = !debug ? `[DEBUG] ${message}` : `[DEBUG] ${message} ${debug}`;
        try {
            await fs.appendFile(path.join(__dirname, "..", "logs.txt"), `${logMessage}\n`, 'utf8');
            return console.info(logMessage);
        } catch (error) {
            console.error("Failed to write debug log:", error);
        }
    },

    // Log a request in the console.
    request: async (request, logToConsole) => {
        if (!request) return;
        const logMessage = `[REQUEST] ${request}`;
        try {
            await fs.appendFile(path.join(__dirname, "..", "logs.txt"), `${logMessage}\n`, 'utf8');
            if (logToConsole) console.log(logMessage);
            return;
        } catch (error) {
            console.error("Failed to write request log:", error);
        }
    }
};

module.exports = {
    log
};