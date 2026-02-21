// =============================================================================
// MODEL RESOLVER — Custom model and field name mapping
// =============================================================================
// Allows users to remap internal table and column names to match their
// existing database schemas. Zero runtime cost — resolved once at init.

export interface ModelNameMapping {
	[internalName: string]: string;
}

export interface FieldNameMapping {
	[modelName: string]: {
		[internalField: string]: string;
	};
}

export interface ModelResolverOptions {
	/** Map internal model names to custom table names. */
	modelNames?: ModelNameMapping;
	/** Map internal field names to custom column names, per model. */
	fieldNames?: FieldNameMapping;
}

export interface ModelResolver {
	/** Resolve an internal model name to the actual table name. */
	getModelName(internal: string): string;
	/** Resolve an internal field name to the actual column name for a given model. */
	getFieldName(model: string, internal: string): string;
}

/**
 * Create a ModelResolver from mapping options.
 * If no mappings are provided, returns an identity resolver (no-op).
 */
export function createModelResolver(options?: ModelResolverOptions): ModelResolver {
	const modelMap = options?.modelNames ?? {};
	const fieldMap = options?.fieldNames ?? {};

	return {
		getModelName(internal: string): string {
			return modelMap[internal] ?? internal;
		},
		getFieldName(model: string, internal: string): string {
			return fieldMap[model]?.[internal] ?? internal;
		},
	};
}
