import type { AIConfig } from "@rin/api";
import { AI_CONFIG_PREFIX, DEFAULT_AI_CONFIG, MASKED_SECRET_VALUE } from "@rin/config";

type ConfigReader = {
    get(key: string): Promise<unknown>;
};

type ConfigWriter = ConfigReader & {
    set(key: string, value: unknown, save?: boolean): Promise<void>;
    save(): Promise<void>;
};

const AI_CONFIG_FIELDS = ["enabled", "provider", "model", "api_key", "api_url"] as const;

// Fields stored as plain strings. They are trimmed on read and on write: pasting a
// key from a web page often carries a trailing space/newline, and an untrimmed key
// makes every later request fail ("Bearer sk-xxx ") even though the input looked fine.
const AI_STRING_FIELDS = new Set<string>(["provider", "model", "api_key", "api_url"]);

/**
 * Normalize an AI config field to the string it is supposed to be.
 *
 * The config store keeps strings verbatim but runs `JSON.parse` on load, so a string
 * that happens to be valid JSON — a numeric-only key such as "123456" is the common
 * case — comes back as a number. Without this coercion such a key would be dropped on
 * read: the settings page would show it as unset and every later test would fail with
 * "API key not configured", even though it was saved correctly.
 */
function normalizeAIString(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value.trim();
    }

    if (typeof value === "number" || typeof value === "boolean") {
        return String(value);
    }

    return undefined;
}

/** The masking placeholder is never a real secret: it must not be stored or surfaced as one. */
function isMaskedSecret(value: string): boolean {
    return value === MASKED_SECRET_VALUE;
}

export function readAIConfigFromValues(values: Record<string, unknown>): AIConfig {
    const config: AIConfig = { ...DEFAULT_AI_CONFIG };

    const enabled = values[AI_CONFIG_PREFIX + "enabled"];
    if (enabled != null) {
        config.enabled = enabled === true || enabled === "true";
    }

    const provider = normalizeAIString(values[AI_CONFIG_PREFIX + "provider"]);
    if (provider) {
        config.provider = provider;
    }

    const model = normalizeAIString(values[AI_CONFIG_PREFIX + "model"]);
    if (model !== undefined) {
        config.model = model;
    }

    const apiKey = normalizeAIString(values[AI_CONFIG_PREFIX + "api_key"]);
    if (apiKey !== undefined && !isMaskedSecret(apiKey)) {
        config.api_key = apiKey;
    }

    const apiUrl = normalizeAIString(values[AI_CONFIG_PREFIX + "api_url"]);
    if (apiUrl !== undefined) {
        config.api_url = apiUrl;
    }

    return config;
}

export function readAIConfigFromMap(values: Map<string, unknown>): AIConfig {
    return readAIConfigFromValues(Object.fromEntries(values));
}

export async function getAIConfig(config: ConfigReader): Promise<AIConfig> {
    const values = await Promise.all(
        AI_CONFIG_FIELDS.map(async (field) => [field, await config.get(AI_CONFIG_PREFIX + field)] as const),
    );

    return readAIConfigFromValues(
        Object.fromEntries(values.map(([field, value]) => [AI_CONFIG_PREFIX + field, value])),
    );
}

export async function getFrontendAIEnabled(config: ConfigReader): Promise<boolean> {
    const enabled = await config.get(AI_CONFIG_PREFIX + "enabled");
    return enabled == null ? DEFAULT_AI_CONFIG.enabled : enabled === true || enabled === "true";
}

export async function setAIConfig(config: ConfigWriter, updates: Partial<AIConfig>): Promise<void> {
    for (const field of AI_CONFIG_FIELDS) {
        const rawValue = updates[field];
        if (rawValue === undefined) {
            continue;
        }

        const value = AI_STRING_FIELDS.has(field) ? normalizeAIString(rawValue) : rawValue;
        if (value === undefined) {
            continue;
        }

        if (field === "api_key") {
            const apiKey = value as string;

            // An empty value means "keep the stored key"; the masking placeholder
            // means the client sent back what it was shown, not a new key.
            if (apiKey === "" || isMaskedSecret(apiKey)) {
                continue;
            }
        }

        await config.set(AI_CONFIG_PREFIX + field, value, false);
    }

    await config.save();
}

export async function getAIConfigForFrontend(
    config: ConfigReader,
): Promise<AIConfig & { api_key_set: boolean }> {
    const aiConfig = await getAIConfig(config);
    return {
        ...aiConfig,
        api_key: "",
        api_key_set: aiConfig.api_key.length > 0,
    };
}
