const contentEncoding = {
	0: null,
	1: "deflate",
	2: "gzip",
};

const Headers = {
	ping: {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "OPTIONS, GET",

		"Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
		Pragma: "no-cache",
		Expires: "0",
		"Surrogate-Control": "no-store",
	},
	file: {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "OPTIONS, GET, HEAD, DELETE",
	},
	info: {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
	},
	upload: {
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "OPTIONS, POST",
		"Access-Control-Allow-Headers": "Authorization, Content-Type, Accept",
	},
};

export { contentEncoding, Headers };