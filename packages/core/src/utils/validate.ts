// =============================================================================
// PLUGIN OPTIONS VALIDATION
// =============================================================================
// Lightweight runtime validator for plugin options. No external dependencies.

export interface OptionSchema {
	[key: string]: {
		type: "string" | "number" | "boolean";
		required?: boolean;
		default?: unknown;
	};
}

/**
 * Validate and apply defaults to plugin options.
 * Throws on invalid options with a clear error message.
 *
 * @example
 * ```ts
 * const opts = validatePluginOptions<OutboxOptions>("outbox", rawOptions, {
 *   batchSize: { type: "number", default: 100 },
 *   pollInterval: { type: "string", required: true },
 * });
 * ```
 */
export function validatePluginOptions<T>(
	pluginId: string,
	options: unknown,
	schema: OptionSchema,
): T {
	const opts = (options ?? {}) as Record<string, unknown>;
	const result: Record<string, unknown> = {};

	for (const [key, def] of Object.entries(schema)) {
		const value = opts[key];

		if (value === undefined || value === null) {
			if (def.required) {
				throw new Error(`Plugin "${pluginId}": option "${key}" is required`);
			}
			if (def.default !== undefined) {
				result[key] = def.default;
			}
			continue;
		}

		const actualType = typeof value;
		if (actualType !== def.type) {
			throw new Error(
				`Plugin "${pluginId}": option "${key}" expected ${def.type}, got ${actualType}`,
			);
		}

		result[key] = value;
	}

	// Pass through any extra keys not in schema
	for (const [key, value] of Object.entries(opts)) {
		if (!(key in schema)) {
			result[key] = value;
		}
	}

	return result as T;
}
