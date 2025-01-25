import { join, isAbsolute } from "node:path";
import { deflate, gzip } from "node:zlib";
import { unlink } from "node:fs/promises";
import { hostname } from "node:os";
import { PassThrough, pipeline } from "node:stream";
import { isURL, isBase64, isUUID } from "validator";
import { promisify } from "node:util";

import { log, getHashFromBuffer, generateAES128Key, encryptAES128, decryptAES128 } from "./functions.js";
import { startupTime, serverHeaders, contentEncoding } from "./utilities.js";
import { db } from "./database.js";
import { version } from "../package.json";

const storagePath = process.env.STORAGE_PATH ? (isAbsolute(process.env.STORAGE_PATH) ? process.env.STORAGE_PATH : join(process.cwd(), process.env.STORAGE_PATH)) : join(process.cwd(), "data", "storage");

const maxStorageBytes = process.env.MAX_STORAGE_SIZE ? Number(process.env.MAX_STORAGE_SIZE) * 1024 * 1024 * 1024 : null; // Convert from gigabytes to bytes

async function handlePing(req, url) {
    if (url.pathname != "/ping") return new Response(JSON.stringify({ success: false, cause: "No path found or invalid method" }), { headers: serverHeaders, status: 404 });
    if (req.method != "GET") return new Response(JSON.stringify({ success: false, cause: "Unallowed method!" }), { headers: serverHeaders, status: 400 });

    try {
        return new Response(JSON.stringify({ success: true, timestamp: Date.now() }),
            {
                headers: {
                    ...serverHeaders,
                    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
                    "Pragma": "no-cache",
                    "Expires": "0",
                    "Surrogate-Control": "no-store",
                }, 
                status: 200
            }
        );
    } catch (error) {
        log.error("Error while trying to ping:", error);
        return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
    }
};

async function handleFile(req, url) {
    if (!url.pathname.startsWith("/file/")) return new Response(JSON.stringify({ success: false, cause: "No path found or invalid method" }), { headers: serverHeaders, status: 404 });

    let uuid = url.pathname.substring("/file/".length);
    let key = url.searchParams.get("key");

    if (uuid) uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");
    if (!uuid) return new Response(JSON.stringify({ success: false, cause: "You can't just use that on the whole server!" }), { headers: serverHeaders, status: 400 });
    if (!isUUID(uuid, 4)) return new Response(JSON.stringify({ success: false, cause: "Invalid UUID" }), { headers: serverHeaders, status: 400 });

    if (req.method == "GET") {
        try {
            
            const fileData = db.prepare("SELECT 1 as 'exists', expires, compressed, key FROM storage WHERE ID = ?").get(uuid);
            if (!fileData) return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });
            
            if (fileData.key && (!key || fileData.key != key)) return new Response(JSON.stringify({ success: false, cause: "Incorrect decryption key!" }), { headers: serverHeaders, status: 401 });

            if (!await Bun.file(join(storagePath, uuid)).exists()) {
                db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
                return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });
            }
    
            const now = Date.now();
            const expires = fileData.expires ? parseInt(fileData.expires, 10) : null;
            const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days
    
            if (expires && maxAge <= 0) {
                db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
                await unlink(join(storagePath, uuid));
                log.info(`Deleted expired file (${uuid})`);
                return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });
            }
    
            db.prepare("UPDATE storage SET accessed = ? WHERE ID = ?").run(Date.now(), uuid);
    
            const fileStream = Bun.file(join(storagePath, uuid)).stream();
    
            const passThrough = new PassThrough();
    
            pipeline(
                fileStream,
                passThrough,
                (passthroughError) => {
                    if (passthroughError) {
                        log.error("Error in file pipeline:", passthroughError);
                        passThrough.destroy();
                        return new Response(JSON.stringify({ success: false, cause: "Error streaming the file" }), { headers: serverHeaders, status: 500 });
                    }
                }
            );
    
            const responseHeaders = {
                "Cache-Control": `public, max-age=${maxAge / 1000}, immutable`
            };
            
            if (fileData.compressed >= 1) {
                responseHeaders["Content-Encoding"] = contentEncoding[fileData.compressed];
            }

            return new Response(passThrough, { headers: responseHeaders });
        } catch (error) {
            log.error("Error while trying to return file:", error);
            return new Response(JSON.stringify({ success: false, cause: "Error returning the file" }), { headers: serverHeaders, status: 500 });
        }
    } else if (req.method == "DELETE") {
        try {
            const fileExist = db.prepare("SELECT 1 FROM storage WHERE ID = ?").get(uuid);
            if (!fileExist) return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });
    
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await unlink(join(storagePath, uuid));
            log.info(`Deleted file (${uuid})`);
    
            return new Response(JSON.stringify({ success: true, uuid }), { headers: serverHeaders, status: 200 });
        } catch (error) {
            log.error("Error while trying to delete file:", error);
            return new Response(JSON.stringify({ success: false, cause: "Error deleting the file" }), { headers: serverHeaders, status: 500 });
        }
    } else {
        return new Response(JSON.stringify({ success: false, cause: "Unallowed method!" }), { headers: serverHeaders, status: 400 });
    }
};

async function handleInfo(req, url) {
    if (!url.pathname.startsWith("/info")) return new Response(JSON.stringify({ success: false, cause: "No path found or invalid method" }), { headers: serverHeaders, status: 404 });
    if (req.method != "GET") return new Response(JSON.stringify({ success: false, cause: "Unallowed method!" }), { headers: serverHeaders, status: 400 });

    try {
        let uuid = url.pathname.length > 6 ? url.pathname.substring("/info/".length) : null;
        let key = url.searchParams.get("key");

        if (uuid) uuid = uuid.replace(/[^0-9a-fA-F-]/g, "");

        // Display information about the server instead if there is no UUID
        if (!uuid) {
            const info = db.prepare("SELECT COUNT(ID) as count, SUM(size) as size FROM storage").get();
            return new Response(JSON.stringify({
                success: true,
                name: process.env.HOSTNAME || hostname(),
                version,
                start: startupTime,
                count: info.count,
                size: info.size,
                maxUploadSize: process.env.MAXIMUM_UPLOAD_SIZE ? Number(process.env.MAXIMUM_UPLOAD_SIZE) * 1024 * 1024 * 1024 : null,
                maxSize: maxStorageBytes
            }), {
                headers: serverHeaders,
                status: 200
            });
        }

        if (!isUUID(uuid, 4)) return new Response(JSON.stringify({ success: false, cause: "Invalid UUID" }), { headers: serverHeaders, status: 400 });
        const file = db.prepare("SELECT hash, size, expires, key, accessed, timestamp FROM storage WHERE ID = ?").get(uuid);
        if (!file) return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });

        if (file.key && (!key || file.key != key)) return new Response(JSON.stringify({ success: false, cause: "Incorrect decryption key!" }), { headers: serverHeaders, status: 401 });

        const now = Date.now();
        const expires = file.expires ? parseInt(file.expires, 10) : null;
        const maxAge = expires ? (expires > now ? expires - now : -1) : 2592000000; // Default to 30 days

        if (file.expires && maxAge <= 0) {
            db.prepare("DELETE FROM storage WHERE ID = ?").run(uuid);
            await unlink(join(storagePath, uuid));
            log.info(`Deleted expired file (${uuid})`);
            return new Response(JSON.stringify({ success: false, cause: "This file doesn't exist!" }), { headers: serverHeaders, status: 404 });
        }

        return new Response(JSON.stringify({
            success: true,
            uuid,
            hash: file.hash,
            compressedHash: file.compressedHash,
            compression: contentEncoding[file.compressed],
            size: file.size,
            expires: file.expires,
            accessed: file.accessed,
            timestamp: file.timestamp,
        }), {
            headers: serverHeaders,
            status: 400
        });
    } catch (error) {
        log.error("Error while trying to return file info:", error);
        return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
    }
};

async function handleUpload(req, url) {
    let { file, link, expires, encrypt } = await req.json();

    if (url.pathname != "/upload") return new Response(JSON.stringify({ success: false, cause: "No path found or invalid method" }), { headers: serverHeaders, status: 404 });
    if (req.method != "POST") return new Response(JSON.stringify({ success: false, cause: "Unallowed method!" }), { headers: serverHeaders, status: 400 });

    try {
        if (link) link = decodeURIComponent(link).replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, "");
        if (!file && !link) return new Response(JSON.stringify({ success: false, cause: "Please at least send a file or a link!" }), { headers: serverHeaders, status: 400 });
        if (expires && typeof expires !== "number") return new Response(JSON.stringify({ success: false, cause: "Make sure that the expires parameter is an integer" }), { headers: serverHeaders, status: 422 });
        if (expires && expires <= Date.now()) return new Response(JSON.stringify({ success: false, cause: "Expiry timestamp must be above the current epoch timestamp" }), { headers: serverHeaders, status: 422 });

        if (file && !isBase64(file)) return new Response(JSON.stringify({ success: false, cause: "Please send a base64 encoded file" }), { headers: serverHeaders, status: 422 });
        if (link && !isURL(link)) return new Response(JSON.stringify({ success: false, cause: "Please send a valid URL" }), { headers: serverHeaders, status: 422 });
        if (file) file = Buffer.from(file, "base64");

        if (link) {
            const response = await fetch(link, 
                {
                    headers: {
                        "User-Agent": `StorageServer/${version}`
                    }
                }
            );
            
            if (!response.ok) {
                log.error(`Failed to fetch file from URL with code ${response.status}:`, response.statusText);
                return new Response(JSON.stringify({ success: false, cause: "Error fetching file from URL" }), { headers: serverHeaders, status: 500 });
            }

            file = Buffer.from(await response.arrayBuffer());
        }

        const hash = await getHashFromBuffer(file);
        const fileExists = db.prepare("SELECT ID, compressedHash FROM storage WHERE hash = ? ORDER BY timestamp DESC LIMIT 1").get(hash);
        if (fileExists) return new Response(JSON.stringify({ success: true, uuid: fileExists.ID, hash, compressedHash: fileExists.compressedHash, message: "This file already exists!" }), { headers: serverHeaders, status: 200 });

        // Compression stuff
        const compressed = Number(process.env.COMPRESSION_ALGORITHM) >= 1 && Number(process.env.COMPRESSION_ALGORITHM) <= 2 ? Number(process.env.COMPRESSION_ALGORITHM) >= 1 && Number(process.env.COMPRESSION_ALGORITHM) : 0;

        if (compressed >= 1) {
            try {
                const compressionLevel = Number(process.env.COMPRESSION_LEVEL) ? Number(process.env.COMPRESSION_LEVEL) : null;

                switch (compressed) {
                    case 1:
                        file = await promisify(deflate)(file, { level: compressionLevel >= 1 && compressionLevel <= 9 ? compressionLevel : undefined });
                        break;
                    case 2:
                        file = await promisify(gzip)(file, { level: compressionLevel >= 1 && compressionLevel <= 9 ? compressionLevel : undefined });
                        break;
                    default:
                        log.error("Unsupported compression algorithm");
                        return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
                }
                if (!file) return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
            }
            catch (error) {
                log.error("Error compressing file:", error);
                return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
            }
        }

        const key = encrypt ? await generateAES128Key() : null;

        if (encrypt && key) {
            file = await encryptAES128(file, key);
            if (!file) return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
        }

        if (maxStorageBytes && file.length > maxStorageBytes) return new Response(JSON.stringify({ success: false, cause: "File too large" }), { headers: serverHeaders, status: 413 });

        if (!file || !file.length) {
            log.error("File buffer is null or zero bytes");
            return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
        }

        const uuid = crypto.randomUUID();
        const compressedHash = compressed >= 1 ? await getHashFromBuffer(file) : null;
        const filename = join(storagePath, uuid);
        await Bun.write(filename, file);

        db.prepare("INSERT INTO storage (ID, hash, compressedHash, timestamp, size, expires, compressed, key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(uuid, hash, compressedHash, Date.now(), file.length, expires, compressed, key);

        log.info(`New file added (${uuid})`);
        return new Response(JSON.stringify({ success: true, uuid, hash, key }), { headers: serverHeaders, status: 200 });
    } catch (catchError) {
        log.error("Error uploading file:", catchError);
        return new Response(JSON.stringify({ success: false, cause: "Internal Server Error" }), { headers: serverHeaders, status: 500 });
    }
};

export {
    handlePing,
    handleFile,
    handleInfo,
    handleUpload
};