import { Hono } from "hono";
import { desc, eq, inArray, isNull } from "drizzle-orm";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { inviteCodes, users } from "../db/schema";
import { BadRequestError, ForbiddenError, NotFoundError } from "../errors";

/**
 * 邀请码（一次一码）
 *
 * 为什么用邀请码而不是"申请 → 审核"：用户要的是"我发给谁，他自己注册就行"。
 * 一枚码只用一次，码上带一句备注（给谁的）；注册成功后这句备注自动写进那个用户的 `note`，
 * 于是"码 → 人 → 用户名"能对上 —— 不管他起什么网名，作者都知道这是谁。
 */

/** 去掉了容易看错的 0/O/1/I/L */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUP = 4;
const CODE_GROUPS = 2;

/** 生成形如 `K7QP-3MZ9` 的码：可读、可念、难猜 */
function generateCode(): string {
    const bytes = new Uint8Array(CODE_GROUP * CODE_GROUPS);
    crypto.getRandomValues(bytes);
    const chars = Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]);
    const groups: string[] = [];
    for (let i = 0; i < CODE_GROUPS; i++) {
        groups.push(chars.slice(i * CODE_GROUP, (i + 1) * CODE_GROUP).join(""));
    }
    return groups.join("-");
}

/** 用户输入容错：忽略大小写、空格、横杠 */
export function normalizeInviteCode(input: string): string {
    return (input || "").replace(/[\s-]/g, "").toUpperCase();
}

export function InviteService(): Hono {
    const app = new Hono();

    // GET /invite?status=unused|used|all —— 邀请码列表（默认未用在前、新的在前）
    app.get("/", async (c: AppContext) => {
        if (!c.get("admin")) {
            throw new ForbiddenError("Permission denied");
        }
        const db = c.get("db");
        const status = c.req.query("status") || "all";

        const rows = await profileAsync(c, "invite_list", () =>
            db.query.inviteCodes.findMany({
                orderBy: [desc(inviteCodes.id)],
                limit: 200,
            })
        );

        // 用掉的那枚码要能看出"给谁注册走了"
        const usedIds = rows
            .map((r: any) => r.used_by)
            .filter((v: any): v is number => typeof v === "number" && v > 0);
        const usedUsers = usedIds.length
            ? await profileAsync(c, "invite_used_users", () =>
                db.select({ id: users.id, username: users.username, note: users.note })
                    .from(users)
                    .where(inArray(users.id, usedIds))
            )
            : [];
        const userMap = new Map(usedUsers.map((u: any) => [u.id, u]));

        const all = rows.map((r: any) => ({
            id: r.id,
            code: r.code,
            note: r.note,
            revoked: !!r.revoked,
            usedBy: r.used_by || null,
            usedByName: r.used_by ? (userMap.get(r.used_by)?.username ?? "") : "",
            usedAt: r.used_at || null,
            createdAt: r.createdAt,
        }));

        const list =
            status === "unused"
                ? all.filter((r) => !r.usedBy && !r.revoked)
                : status === "used"
                    ? all.filter((r) => !!r.usedBy)
                    : all;

        return c.json({
            list,
            summary: {
                total: all.length,
                unused: all.filter((r) => !r.usedBy && !r.revoked).length,
                used: all.filter((r) => !!r.usedBy).length,
            },
        });
    });

    // POST /invite —— 生成邀请码（可批量），每枚码带一句备注
    app.post("/", async (c: AppContext) => {
        if (!c.get("admin")) {
            throw new ForbiddenError("Permission denied");
        }
        const db = c.get("db");

        const body = await c.req.json().catch(() => ({} as any));
        const countRaw = Number(body?.count ?? 1);
        const count = Number.isFinite(countRaw) ? Math.min(Math.max(Math.trunc(countRaw), 1), 20) : 1;
        const note = String(body?.note ?? "").trim().slice(0, 80);

        const created: string[] = [];
        for (let i = 0; i < count; i++) {
            for (let attempt = 0; attempt < 5; attempt++) {
                const code = generateCode();
                const exists = await profileAsync(c, "invite_code_check", () =>
                    db.query.inviteCodes.findFirst({ where: eq(inviteCodes.code, code) })
                );
                if (exists) continue;
                await profileAsync(c, "invite_code_insert", () =>
                    db.insert(inviteCodes).values({ code, note })
                );
                created.push(code);
                break;
            }
        }

        if (created.length === 0) {
            throw new BadRequestError("Failed to generate invite codes");
        }

        return c.json({ created });
    });

    // POST /invite/:id/revoke —— 作废（只有没用过的能作废）
    app.post("/:id/revoke", async (c: AppContext) => {
        if (!c.get("admin")) {
            throw new ForbiddenError("Permission denied");
        }
        const db = c.get("db");

        const id = Number(c.req.param("id"));
        if (!Number.isFinite(id)) {
            throw new BadRequestError("Invalid id");
        }

        const row = await profileAsync(c, "invite_revoke_lookup", () =>
            db.query.inviteCodes.findFirst({ where: eq(inviteCodes.id, id) })
        );
        if (!row) {
            throw new NotFoundError("Invite code");
        }
        if (row.used_by) {
            throw new BadRequestError("Invite code already used");
        }

        await profileAsync(c, "invite_revoke", () =>
            db.update(inviteCodes).set({ revoked: 1 }).where(eq(inviteCodes.id, id))
        );
        return c.json({ success: true });
    });

    // DELETE /invite/:id —— 删掉没用过的码
    app.delete("/:id", async (c: AppContext) => {
        if (!c.get("admin")) {
            throw new ForbiddenError("Permission denied");
        }
        const db = c.get("db");

        const id = Number(c.req.param("id"));
        const row = await profileAsync(c, "invite_delete_lookup", () =>
            db.query.inviteCodes.findFirst({ where: eq(inviteCodes.id, id) })
        );
        if (!row) {
            throw new NotFoundError("Invite code");
        }
        if (row.used_by) {
            throw new BadRequestError("Invite code already used");
        }

        await profileAsync(c, "invite_delete", () => db.delete(inviteCodes).where(eq(inviteCodes.id, id)));
        return c.json({ success: true });
    });

    return app;
}
