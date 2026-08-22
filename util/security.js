export const RegexCheck = {
	// Only checks if the string is a valid URL format, not if it actually exists
	URL: async (url) => {
		return /^(https?:\/\/)?([a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)$/.test(url);
	},
};