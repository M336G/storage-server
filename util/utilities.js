const startupTime = Date.now();

const serverHeaders = {
    "Content-Type": "application/json",
    "Accept": "application/json",
};

const contentEncoding = {
    0: null,
    1: "deflate",
    2: "gzip"
};

export {
    startupTime,
    serverHeaders,
    contentEncoding
};