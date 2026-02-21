// =============================================================================
// I18N PLUGIN — Multi-locale error message translation
// =============================================================================
// Translates error messages in API responses based on the client's locale.
// Inspired by better-auth's i18n plugin.

import type { PluginApiRequest, PluginApiResponse, SummaPlugin } from "@summa/core";
import { BASE_ERROR_CODES } from "@summa/core";

// =============================================================================
// TYPES
// =============================================================================

export type TranslationMap = Record<string, Record<string, string>>;

export type LocaleDetectionStrategy = "header" | "cookie" | "callback";

export interface I18nOptions {
	/** Default locale when detection fails. Default: "en" */
	defaultLocale?: string;

	/**
	 * Translations keyed by locale, then by error code.
	 *
	 * @example
	 * ```ts
	 * {
	 *   en: { INSUFFICIENT_BALANCE: "Insufficient balance" },
	 *   hi: { INSUFFICIENT_BALANCE: "अपर्याप्त शेष राशि" },
	 * }
	 * ```
	 */
	translations: TranslationMap;

	/** How to detect the client's locale. Default: "header" */
	detection?: LocaleDetectionStrategy;

	/** Cookie name when using detection: "cookie". Default: "locale" */
	cookieName?: string;

	/** Custom detection function when using detection: "callback". */
	detectLocale?: (req: PluginApiRequest) => string | undefined;
}

// =============================================================================
// LOCALE DETECTION
// =============================================================================

/**
 * Parse Accept-Language header and return best matching locale.
 * e.g. "hi-IN,hi;q=0.9,en-US;q=0.8,en;q=0.7" → ["hi", "en"]
 */
function parseAcceptLanguage(header: string): string[] {
	return header
		.split(",")
		.map((part) => {
			const [lang, ...rest] = part.trim().split(";");
			const q = rest.find((r) => r.trim().startsWith("q="));
			return {
				lang: lang?.trim().split("-")[0]?.toLowerCase() ?? "",
				quality: q ? Number.parseFloat(q.trim().slice(2)) : 1.0,
			};
		})
		.filter((p) => p.lang.length > 0)
		.sort((a, b) => b.quality - a.quality)
		.map((p) => p.lang);
}

function parseCookieValue(cookieHeader: string, name: string): string | undefined {
	const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
	return match?.[1]?.trim();
}

function detectRequestLocale(
	req: PluginApiRequest,
	options: Required<Pick<I18nOptions, "detection" | "cookieName" | "defaultLocale">> & {
		detectLocale?: (req: PluginApiRequest) => string | undefined;
	},
	availableLocales: Set<string>,
): string {
	let candidates: string[] = [];

	switch (options.detection) {
		case "header": {
			const header = req.headers?.["accept-language"] ?? req.headers?.["Accept-Language"] ?? "";
			candidates = parseAcceptLanguage(header);
			break;
		}
		case "cookie": {
			const cookieHeader = req.headers?.cookie ?? req.headers?.Cookie ?? "";
			const value = parseCookieValue(cookieHeader, options.cookieName);
			if (value) candidates = [value.toLowerCase()];
			break;
		}
		case "callback": {
			const value = options.detectLocale?.(req);
			if (value) candidates = [value.toLowerCase()];
			break;
		}
	}

	for (const locale of candidates) {
		if (availableLocales.has(locale)) return locale;
	}

	return options.defaultLocale;
}

// =============================================================================
// PLUGIN FACTORY
// =============================================================================

export function i18n(options: I18nOptions): SummaPlugin {
	const defaultLocale = options.defaultLocale ?? "en";
	const detection = options.detection ?? "header";
	const cookieName = options.cookieName ?? "locale";
	const translations = options.translations;
	const availableLocales = new Set(Object.keys(translations));

	// Ensure default locale exists
	if (!availableLocales.has(defaultLocale)) {
		availableLocales.add(defaultLocale);
		translations[defaultLocale] = {};
	}

	// Merge base error code messages as English fallback
	if (!translations.en) {
		translations.en = {};
	}
	for (const [code, { message }] of Object.entries(BASE_ERROR_CODES)) {
		if (!translations.en[code]) {
			translations.en[code] = message;
		}
	}

	return {
		id: "i18n",

		onResponse(req: PluginApiRequest, res: PluginApiResponse): PluginApiResponse {
			// Only translate error responses
			if (res.status < 400) return res;

			const body = res.body as Record<string, unknown> | null;
			const error = body?.error as Record<string, unknown> | undefined;
			if (!error?.code || typeof error.code !== "string") return res;

			const locale = detectRequestLocale(
				req,
				{ detection, cookieName, defaultLocale, detectLocale: options.detectLocale },
				availableLocales,
			);

			const translated =
				translations[locale]?.[error.code] ??
				translations[defaultLocale]?.[error.code] ??
				(error.message as string);

			return {
				...res,
				body: {
					...body,
					error: { ...error, message: translated },
				},
			};
		},
	};
}

// =============================================================================
// HELPER
// =============================================================================

/**
 * Type-safe helper to define translation maps.
 *
 * @example
 * ```ts
 * const hi = defineTranslations({
 *   INSUFFICIENT_BALANCE: "अपर्याप्त शेष राशि",
 *   ACCOUNT_FROZEN: "खाता फ़्रीज़ है",
 * });
 * ```
 */
export function defineTranslations<T extends Record<string, string>>(translations: T): T {
	return translations;
}
