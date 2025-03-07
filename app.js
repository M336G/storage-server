import { join, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { unlink } from "node:fs/promises";
import { PassThrough, pipeline } from "node:stream";
import { deflate, gzip } from "node:zlib";
import { isURL, isBase64, isUUID } from "validator";
import { promisify } from "node:util";

import { log, getHashFromBuffer, getClientIP, checkExpiredFiles, checkInvalidFiles, checkHashes, cleanExpiredIPEntries, checkToken } from "./util/functions.js";
import { contentEncoding } from "./util/utilities.js";
import { DatabaseWrapper } from "./util/database.js";

global.serverToken = process.env.TOKEN;
global.serverPort = Number(process.env.PORT) || 3033;
global.serverHostname = process.env.HOSTNAME || hostname();
global.maxStorageBytes = process.env.MAX_STORAGE_SIZE ? Number(process.env.MAX_STORAGE_SIZE) * 1024 * 1024 * 1024 : null; // Convert from gigabytes to bytes
global.maximumUploadSize = process.env.MAXIMUM_UPLOAD_SIZE ? Number(process.env.MAXIMUM_UPLOAD_SIZE) * 1024 * 1024 * 1024 : undefined;
global.storagePath = process.env.STORAGE_PATH ? (isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : join(process.cwd(), process.env.STORAGE_PATH)) : join(process.cwd(), "data", "storage");
global.unaccessedMillisecondsBeforeDeletion = process.env.UNACCESSED_DAYS_BEFORE_DELETION ? Number(process.env.UNACCESSED_DAYS_BEFORE_DELETION) * 24 * 60 * 60 * 1000 : undefined;

if (!global.serverToken) log.warn("The server is currently running without any token. It is extremely recommended to set one to avoid potential threats");
else if (global.serverToken == "AAAABBBBCCCCDDDD") log.warn("The server is currently running with the example token. It is extremely recommmended to set one secured!")

// Table kept in memory to follow requests
global.requestCounts = new Map();

const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = process.env.RATE_LIMIT; // Maximum amount of requests per minute

Bun.serve({
    port: global.serverPort,
    maxRequestBodySize: global.maximumUploadSize,

    routes: {
        // Ping the server
        "/ping": async () => {
            return Response.json({ success: true, timestamp: Date.now() },
                {
                    headers: {
                        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                        "Pragma": "no-cache",
                        "Expires": "0",
                        "Surrogate-Control": "no-store",
                    }
                }
            )
        },

        "/file/:uuid": {
            // Get info about the file
            HEAD: async (req) => {
                const uuid = req.params.uuid;
        
                // Check if UUID is valid
                if (!uuid || !isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/")) return new Response(null, { status: 400 });
        
                // Check if file exists in the database
                if (!await DatabaseWrapper.checkFileExistenceFromUUID(uuid)) {
                    return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
                }
        
                const filePath = join(global.storagePath, uuid);
        
                // Check if the file exists locally
                if (!await Bun.file(filePath).exists()) {
                    await DatabaseWrapper.deleteFileFromUUID(uuid); // Clean up the database if file is missing
                    return new Response(null, { status: 404 });
                }
        
                const fileMetadata = await DatabaseWrapper.getFileMetadataFromUUID(uuid);
        
                const now = Date.now();
                const expires = fileMetadata.expires ? parseInt(fileMetadata.expires, 10) : null;
                const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

                // If the file is expired, delete it completely instead of returning info about it
                if (expires && maxAge <= 0) {
                    await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
                    await unlink(join(global.storagePath, uuid)); // Delete the file itself
                    log.info(`Deleted expired file (${uuid})`);
                    return new Response(null, { status: 404 });
                }
        
                const headers = {
                    "Cache-Control": `public, max-age=${maxAge / 1000}, immutable`,
                    "Content-Length": (await Bun.file(filePath).bytes()).length,
                };
        
                if (fileMetadata.compressed >= 1) headers["Content-Encoding"] = contentEncoding[fileMetadata.compressed];
        
                return new Response(null, { status: 200, headers });
            },

            // Get a file from the server
            GET: async (req) => {
                if (!await rateLimit(req)) return Response.json({ success: false, cause: `Rate limited` }, { status: 429 });
                
                const uuid = req.params.uuid;
                if (!uuid) return Response.json({ success: false, cause: "You can't just use that on the whole server!" }, { status: 400 });
                if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/")) return Response.json({ success: false, cause: "Invalid UUID" }, { status: 400 });

                if (!await DatabaseWrapper.checkFileExistenceFromUUID(uuid)) return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
                
                // If it doesn't exist locally delete it from the database
                if (!await Bun.file(join(global.storagePath, uuid)).exists()) {
                    await DatabaseWrapper.deleteFileFromUUID(uuid);
                    return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
                }

                const fileMetadata = await DatabaseWrapper.getFileMetadataFromUUID(uuid);

                const now = Date.now();
                const expires = fileMetadata.expires ? parseInt(fileMetadata.expires, 10) : null;
                const maxAge = expires ? (expires > now ? expires - now : -1) : 30 * 24 * 60 * 60 * 1000; // Default to 30 days

                // If the file is expired, delete it completely instead of returning it
                if (expires && maxAge <= 0) {
                    await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
                    await unlink(join(global.storagePath, uuid)); // Delete the file itself
                    log.info(`Deleted expired file (${uuid})`);
                    return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
                }

                DatabaseWrapper.updateLastAccessFromUUID(uuid); // Update the last access time
        
                const fileStream = Bun.file(join(global.storagePath, uuid)).stream();
                const passThrough = new PassThrough();
        
                pipeline(fileStream, passThrough, (error) => {
                    if (error) {
                        throw new Error(error);
                    }
                });
        
                const responseHeaders = { "Cache-Control": `public max-age=${maxAge / 1000}, immutable` };
                if (fileMetadata.compressed >= 1) responseHeaders["Content-Encoding"] = contentEncoding[fileMetadata.compressed];

                return new Response(passThrough, { headers: responseHeaders });
            },

            // Delete a file from the server
            DELETE: async (req) => {
                if (!await rateLimit(req)) return Response.json({ success: false, cause: `Rate limited` }, { status: 429 });
                if (!await checkToken(req.headers.get("Authorization"))) return Response.json({ success: false, cause: "Unauthorized" }, { status: 401 });

                const uuid = req.params.uuid;
                if (!uuid) return Response.json({ success: false, cause: "You can't just use that on the whole server!" }, { status: 400 });
                if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/")) return Response.json({ success: false, cause: "Invalid UUID" }, { status: 400 });

                if (!await DatabaseWrapper.checkFileExistenceFromUUID(uuid)) return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });

                await DatabaseWrapper.deleteFileFromUUID(uuid);
                await unlink(join(global.storagePath, uuid));

                log.info(`Deleted file (${uuid})`);
                return Response.json({ success: true, uuid }, { status: 200 });
            }
        },

        // Get info about the server
        "/info/": async () => {
            return Response.json({
                success: true,
                name: global.serverHostname,
                version: global.serverVersion,
                start: global.startupTime,
                count: await DatabaseWrapper.getTotalAmountOfFiles(),
                size: await DatabaseWrapper.getTotalSize(),
                maxUploadSize: global.maximumUploadSize,
                maxSize: global.maxStorageBytes,
                maxUnaccessedTime: global.unaccessedMillisecondsBeforeDeletion
            });
        },

        // Get info about a specific file
        "/info/:uuid": async (req) => {
            const uuid = req.params.uuid;
            if (!isUUID(uuid, 4) || uuid.includes("..") || uuid.includes("/")) return Response.json({ success: false, cause: "Invalid UUID" }, { status: 400 });
    
            if (!await DatabaseWrapper.checkFileExistenceFromUUID(uuid)) return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
            
            const fileMetadata = await DatabaseWrapper.getFileMetadataFromUUID(uuid);

            const now = Date.now();
            const expires = fileMetadata.expires ? parseInt(fileMetadata.expires, 10) : null;
            const maxAge = expires ? (expires > now ? expires - now : -1) : 30 * 24 * 60 * 60 * 1000; // Default to 30 days

            // If the file is expired, delete it completely instead of returning info about it
            if (expires && maxAge <= 0) {
                await DatabaseWrapper.deleteFileFromUUID(uuid); // Delete the entry from the database
                await unlink(join(global.storagePath, uuid)); // Delete the file itself
                log.info(`Deleted expired file (${uuid})`);
                return Response.json({ success: false, cause: "This file doesn't exist!" }, { status: 404 });
            }

            return Response.json({
                success: true,
                uuid,
                hash: fileMetadata.hash,
                compressedHash: fileMetadata.compressedHash,
                compressionType: contentEncoding[fileMetadata.compressed],
                size: fileMetadata.size,
                expires: fileMetadata.expires,
                accessed: fileMetadata.accessed,
                timestamp: fileMetadata.timestamp,
            });
        },

        // Upload a new file on the server
        "/upload": {
            POST: async (req) => {
                if (!await rateLimit(req)) return Response.json({ success: false, cause: "Rate limited" }, { status: 429 });
                if (!await checkToken(req.headers.get("Authorization"))) return Response.json({ success: false, cause: "Unauthorized" }, { status: 401 });
                if (req.headers.get("Content-Type") != "application/json" || req.headers.get("Accept") != "application/json") return Response.json({ success: false, cause: "Please supply \"application/json\" for your Content-Type and your Accept headers" }, { status: 415 });

                let { file, link, expires } = await req.json().catch(() => ({})) || {}; // yes

                if (!file && !link) return Response.json({ success: false, cause: "Please at least send a file or a link!" }, { status: 400 });

                if (file && !isBase64(file)) return Response.json({ success: false, cause: "Please send a base64 encoded file" }, { status: 422 });
                
                if (link) link = decodeURIComponent(link).replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, "");
                if (link && !isURL(link)) return Response.json({ success: false, cause: "Please send a valid URL" }, { status: 422 });

                if (expires && typeof expires !== "number") return Response.json({ success: false, cause: "Make sure that the expires parameter is an integer" }, { status: 422 });
                if (expires && expires <= Date.now()) return Response.json({ success: false, cause: "Expiry timestamp must be above the current epoch timestamp (in milliseconds)" }, { status: 422 });
        
                if (file) file = Buffer.from(file, "base64");
                if (link) {
                    const response = await fetch(link, { headers: { "User-Agent": `StorageServer/${global.serverVersion}` } });
                    
                    if (!response.ok) throw new Error(`Failed to fetch file from URL with code ${response.status}:`, response.statusText);
                    
                    file = Buffer.from(await response.arrayBuffer());
                }

                const hash = await getHashFromBuffer(file);

                if (await DatabaseWrapper.checkFileExistenceFromHash(hash)) {
                    const fileMetadata = await DatabaseWrapper.getFileMetadataFromHash(hash);
                    return Response.json({ success: true, uuid: fileMetadata.ID, hash, compressedHash: fileMetadata.compressedHash, message: "This file already exists!" });
                }

                // Compression stuff
                const compressed = Number(process.env.COMPRESSION_ALGORITHM) >= 1 && Number(process.env.COMPRESSION_ALGORITHM) <= 2 ? Number(process.env.COMPRESSION_ALGORITHM) >= 1 && Number(process.env.COMPRESSION_ALGORITHM) : 0;

                if (compressed >= 1) {
                    const compressionLevel = Number(process.env.COMPRESSION_LEVEL) ? Number(process.env.COMPRESSION_LEVEL) : null;

                    switch (compressed) {
                        case 1:
                            file = await promisify(deflate)(file, { level: compressionLevel >= 1 && compressionLevel <= 9 ? compressionLevel : undefined });
                            break;
                        case 2:
                            file = await promisify(gzip)(file, { level: compressionLevel >= 1 && compressionLevel <= 9 ? compressionLevel : undefined });
                            break;
                        default:
                            throw new Error("Unsupported compression algorithm");
                    }
                }

                if (!file || !file.length) throw new Error("File buffer is null or zero bytes");

                if (global.maxStorageBytes && file.length > global.maxStorageBytes) return Response.json({ success: false, cause: "File too large" }, { status: 413 });

                const uuid = crypto.randomUUID();
                const compressedHash = compressed >= 1 ? await getHashFromBuffer(file) : null;

                await Bun.write(join(global.storagePath, uuid), file);
                await DatabaseWrapper.addFile(uuid, hash, compressedHash, file.length, expires, compressed);

                log.info(`New file added (${uuid})`);
                return Response.json({ success: true, uuid, hash, compressedHash }, { status: 201 });
            }
        },

        // If the endpoint is not found
        "/*": Response.json({ success: false, cause: "Not Found" }, { status: 404 })
    },
    
    error(error) {
        log.error(`${error.stack}`);
        return Response.json({ success: false, cause: "Internal Server Error" }, { status: 500 });
    }
});

global.startupTime = Date.now();
log.info(`Server is now running on ${global.serverPort}`);

// Middleware for rate limiting
async function rateLimit(request) {
    if (!MAX_REQUESTS_PER_WINDOW) return true;

    const ip = await getClientIP(request) || 'unkownip'; // C'est possible que l'on puisse pas récupérer les ip avec bun à vérifier
    const now = Date.now();

    if (!global.requestCounts.has(ip)) {
        // New entry for this IP
        global.requestCounts.set(ip, { count: 1, expiry: now + RATE_LIMIT_WINDOW_MS });
        return true;
    }

    let entry = global.requestCounts.get(ip);

    if (now > entry.expiry) {
        // Expired window, reset data
        global.requestCounts.set(ip, { count: 1, expiry: now + RATE_LIMIT_WINDOW_MS });
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

setInterval(cleanExpiredIPEntries, 60_000); // Check for expired IP entries every minute
checkExpiredFiles();
setInterval(checkExpiredFiles, 1_800_000); // Check for expired/(old) unaccessed files every 30 minutes
checkInvalidFiles();
setInterval(checkInvalidFiles, 86_400_000); // Check for invalid files every day

checkHashes(); // Check for files that haven't gotten an hash on startup

process.on("unhandledRejection", async (reason, promise) => {
    await log.fatal(`Unhandled rejection at ${promise}:`, reason);
    await server.stop();
});

process.on("uncaughtException", async (error) => {
    await log.fatal(`Uncaught exception:`, error);
    await server.stop();
});