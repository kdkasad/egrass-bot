export function flatten(
	obj: Record<string, unknown>,
	prefix = "",
): Record<string, string | number | boolean> {
	const result: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(obj)) {
		const fullKey = prefix ? `${prefix}.${key}` : key;
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			Object.assign(result, flatten(value as Record<string, unknown>, fullKey));
		} else {
			result[fullKey] = value as string | number | boolean;
		}
	}
	return result;
}
