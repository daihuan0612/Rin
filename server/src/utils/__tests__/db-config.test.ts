import { describe, expect, it, afterEach } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Database } from "bun:sqlite";
import { AI_CONFIG_PREFIX, MASKED_SECRET_VALUE } from "@rin/config";
import type { AIConfig } from "@rin/api";
import { CacheImpl } from "../cache";
import * as schema from "../../db/schema";
import { getAIConfig, readAIConfigFromMap, readAIConfigFromValues, setAIConfig } from "../db-config";

function createMemoryConfig(initial: Record<string, unknown> = {}) {
    const values = new Map<string, unknown>(Object.entries(initial));
    return {
        values,
        saves: 0,
        async get(key: string) {
            return values.get(key);
        },
        async set(key: string, value: unknown) {
            values.set(key, value);
        },
        async save() {
            this.saves += 1;
        },
    };
}

function createTestDB() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });

    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            type TEXT DEFAULT 'cache' NOT NULL,
            created_at INTEGER DEFAULT (unixepoch()),
            updated_at INTEGER DEFAULT (unixepoch()),
            UNIQUE(key, type)
        );
    `);

    return { db, sqlite };
}

describe("setAIConfig", () => {
    it("should trim surrounding whitespace before storing values", async () => {
        const config = createMemoryConfig();

        await setAIConfig(config, {
            provider: " openai ",
            model: " gpt-4o-mini\n",
            api_url: " https://api.openai.com/v1 ",
            api_key: " sk-test-123 \n",
        });

        expect(config.values.get(AI_CONFIG_PREFIX + "provider")).toBe("openai");
        expect(config.values.get(AI_CONFIG_PREFIX + "model")).toBe("gpt-4o-mini");
        expect(config.values.get(AI_CONFIG_PREFIX + "api_url")).toBe("https://api.openai.com/v1");
        expect(config.values.get(AI_CONFIG_PREFIX + "api_key")).toBe("sk-test-123");
        expect(config.saves).toBe(1);
    });

    it("should store a pasted key without trailing whitespace so it stays usable", async () => {
        const config = createMemoryConfig({ [AI_CONFIG_PREFIX + "api_key"]: "sk-old" });
        const updates: Partial<AIConfig> = { api_key: "sk-new-123 " };

        await setAIConfig(config, updates);

        expect((await getAIConfig(config)).api_key).toBe("sk-new-123");
    });

    it("should keep the stored key when an empty value is submitted", async () => {
        const config = createMemoryConfig({ [AI_CONFIG_PREFIX + "api_key"]: "sk-stored" });

        await setAIConfig(config, { api_key: "   " });
        await setAIConfig(config, { api_key: "" });

        expect((await getAIConfig(config)).api_key).toBe("sk-stored");
    });

    it("should not overwrite the stored key with the masking placeholder", async () => {
        const config = createMemoryConfig({ [AI_CONFIG_PREFIX + "api_key"]: "sk-stored" });

        await setAIConfig(config, { api_key: MASKED_SECRET_VALUE });

        expect((await getAIConfig(config)).api_key).toBe("sk-stored");
    });

    it("should ignore non-scalar values for string fields", async () => {
        const config = createMemoryConfig();

        await setAIConfig(config, { api_key: { nested: true } as unknown as string, model: undefined });

        expect(config.values.has(AI_CONFIG_PREFIX + "api_key")).toBe(false);
        expect(config.values.has(AI_CONFIG_PREFIX + "model")).toBe(false);
        expect(config.saves).toBe(1);
    });

    it("should store a numeric key as a string", async () => {
        const config = createMemoryConfig();

        await setAIConfig(config, { api_key: 123456 as unknown as string });

        expect(config.values.get(AI_CONFIG_PREFIX + "api_key")).toBe("123456");
    });

    it("should still persist non-string fields as-is", async () => {
        const config = createMemoryConfig();

        await setAIConfig(config, { enabled: true });

        expect(config.values.get(AI_CONFIG_PREFIX + "enabled")).toBe(true);
    });
});

describe("readAIConfigFromValues", () => {
    it("should trim stored values on read", () => {
        const config = readAIConfigFromValues({
            [AI_CONFIG_PREFIX + "provider"]: " openai ",
            [AI_CONFIG_PREFIX + "model"]: " gpt-4o-mini ",
            [AI_CONFIG_PREFIX + "api_url"]: " https://api.openai.com/v1 ",
            [AI_CONFIG_PREFIX + "api_key"]: " sk-legacy \n",
        });

        expect(config.provider).toBe("openai");
        expect(config.model).toBe("gpt-4o-mini");
        expect(config.api_url).toBe("https://api.openai.com/v1");
        expect(config.api_key).toBe("sk-legacy");
    });

    it("should fall back to defaults for blank values", () => {
        const config = readAIConfigFromValues({
            [AI_CONFIG_PREFIX + "provider"]: "   ",
            [AI_CONFIG_PREFIX + "api_key"]: "",
        });

        expect(config.provider).toBe("openai");
        expect(config.api_key).toBe("");
    });

    it("should treat a stored masking placeholder as an unset key", () => {
        const config = readAIConfigFromValues({
            [AI_CONFIG_PREFIX + "api_key"]: MASKED_SECRET_VALUE,
        });

        expect(config.api_key).toBe("");
    });

    it("should read a boolean enabled flag", () => {
        expect(readAIConfigFromValues({ [AI_CONFIG_PREFIX + "enabled"]: true }).enabled).toBe(true);
        expect(readAIConfigFromValues({ [AI_CONFIG_PREFIX + "enabled"]: "true" }).enabled).toBe(true);
        expect(readAIConfigFromValues({ [AI_CONFIG_PREFIX + "enabled"]: "false" }).enabled).toBe(false);
    });

    it("should coerce values the store parsed back into a JSON scalar", () => {
        // The config store keeps strings verbatim but JSON.parses on load, so "123456"
        // comes back as the number 123456 and a bare "true" as a boolean.
        const config = readAIConfigFromValues({
            [AI_CONFIG_PREFIX + "api_key"]: 123456,
            [AI_CONFIG_PREFIX + "model"]: 456,
            [AI_CONFIG_PREFIX + "api_url"]: 789,
            [AI_CONFIG_PREFIX + "provider"]: true,
        });

        expect(config.api_key).toBe("123456");
        expect(config.model).toBe("456");
        expect(config.api_url).toBe("789");
        expect(config.provider).toBe("true");
    });
});

describe("getAIConfig - config store round trip", () => {
    const databases: Array<{ close: () => void }> = [];

    afterEach(() => {
        while (databases.length > 0) {
            databases.pop()?.close();
        }
    });

    function openStore() {
        const { db, sqlite } = createTestDB();
        databases.push(sqlite);
        const env = { DB: {}, CACHE_STORAGE_MODE: "database" } as unknown as Env;
        return {
            db,
            env,
            fresh: () => new CacheImpl(db as any, env, "server.config", "database"),
        };
    }

    it("should keep a numeric-only API key usable after saving and reloading", async () => {
        const store = openStore();

        const writer = store.fresh();
        await setAIConfig(writer, { api_key: "123456" });

        // A new request gets a new store instance, which reads the row back from the DB.
        const reader = store.fresh();
        expect((await getAIConfig(reader)).api_key).toBe("123456");

        // The settings page reads through `all()` (buildServerConfigResponse), which must
        // still see a stored key instead of reporting it as unset.
        expect(readAIConfigFromMap(await reader.all() as Map<string, unknown>).api_key).toBe("123456");
    });

    it("should keep other JSON-scalar-like keys usable too", async () => {
        const store = openStore();

        // "1e5" and a 20-digit value only survive because the store quotes strings that
        // JSON.parse would not return unchanged.
        for (const key of ["123456", "012345", "1e5", "000000", "12345678901234567890", "true"]) {
            const writer = store.fresh();
            await setAIConfig(writer, { api_key: key });

            expect((await getAIConfig(store.fresh())).api_key).toBe(key);
        }
    });
});
