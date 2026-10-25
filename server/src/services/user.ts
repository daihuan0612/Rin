import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { deleteCookie } from "hono/cookie";
import type { AppContext } from "../core/hono-types";
import { profileAsync } from "../core/server-timing";
import { inviteCodes, users } from "../db/schema";
import {
    BadRequestError,
    ForbiddenError,
    NotFoundError
} from "../errors";

export function UserService(): Hono {
    const app = new Hono();

    // 注意：原先的两条 GitHub OAuth 路由（/user/github、/user/github/callback）已经整块删掉。
    // 现在只剩「密码登录（作者）+ 邀请码注册（读者）」两种进站方式，见 auth.ts。

    // GET /user/profile - Get user profile
    app.get('/profile', async (c: AppContext) => {
        const uid = c.get('uid');
        const db = c.get('db');

        if (!uid) {
            throw new ForbiddenError('Authentication required');
        }

        const user = await profileAsync(c, 'user_profile_lookup', () => db.query.users.findFirst({ where: eq(users.id, uid) }));
        if (!user) {
            throw new NotFoundError('User');
        }

        return c.json({
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            permission: user.permission === 1,
            createdAt: user.createdAt,
            updatedAt: user.updatedAt,
        });
    });

    // POST /user/logout - Logout user
    app.post('/logout', async (c: AppContext) => {
        deleteCookie(c, 'token', {
            path: '/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax',
        });
        deleteCookie(c, 'auth_token', {
            path: '/',
            sameSite: 'Lax',
        });
        return c.json({ success: true });
    });

    // PUT /user/profile - Update user profile
    app.put('/profile', async (c: AppContext) => {
        const uid = c.get('uid');
        const db = c.get('db');
        const body = await profileAsync(c, 'user_profile_parse', () => c.req.json());

        if (!uid) {
            throw new ForbiddenError('Authentication required');
        }

        const { username, avatar } = body as { username?: string; avatar?: string };

        if (!username && !avatar) {
            throw new BadRequestError('At least one field (username or avatar) is required');
        }

        const updateData: { username?: string; avatar?: string } = {};
        if (username) updateData.username = username;
        if (avatar) updateData.avatar = avatar;

        await profileAsync(c, 'user_profile_update', () => db.update(users).set(updateData).where(eq(users.id, uid)));

        return c.json({ success: true });
    });

    // GET /user/admin/list —— 用户管理（只有作者能看）：备注、注册自述、注册 IP、用了哪枚邀请码
    app.get('/admin/list', async (c: AppContext) => {
        const admin = c.get('admin');
        const db = c.get('db');
        if (!admin) {
            throw new ForbiddenError('Permission denied');
        }

        const rows = await profileAsync(c, 'user_admin_list', () =>
            db.query.users.findMany({
                orderBy: [desc(users.id)],
                limit: 200,
            })
        );

        const inviteRows = await profileAsync(c, 'user_admin_invites', () =>
            db.select({
                used_by: inviteCodes.used_by,
                code: inviteCodes.code,
                note: inviteCodes.note,
                used_at: inviteCodes.used_at,
            }).from(inviteCodes)
        );
        const inviteMap = new Map(
            inviteRows
                .filter((r: any) => typeof r.used_by === 'number' && r.used_by > 0)
                .map((r: any) => [r.used_by as number, r])
        );

        return c.json(rows.map((u: any) => {
            const invite: any = inviteMap.get(u.id);
            return {
                id: u.id,
                username: u.username,
                avatar: u.avatar || '',
                permission: u.permission === 1,
                note: u.note || '',
                signupNote: u.signup_note || '',
                signupIp: u.signup_ip || '',
                disabled: u.disabled === 1,
                inviteCode: invite?.code || '',
                inviteNote: invite?.note || '',
                createdAt: u.createdAt,
            };
        }));
    });

    // PUT /user/admin/:id —— 改备注 / 停用（改不了权限，也别把自己停掉）
    app.put('/admin/:id', async (c: AppContext) => {
        const admin = c.get('admin');
        const db = c.get('db');
        const selfUid = c.get('uid');
        if (!admin) {
            throw new ForbiddenError('Permission denied');
        }

        const id = Number(c.req.param('id'));
        if (!Number.isFinite(id)) {
            throw new BadRequestError('Invalid id');
        }

        const body = await profileAsync(c, 'user_admin_update_parse', () => c.req.json()) as {
            note?: string;
            disabled?: boolean;
        };

        const target = await profileAsync(c, 'user_admin_update_lookup', () =>
            db.query.users.findFirst({ where: eq(users.id, id) })
        );
        if (!target) {
            throw new NotFoundError('User');
        }

        const patch: Record<string, any> = {};
        if (typeof body.note === 'string') {
            patch.note = body.note.trim().slice(0, 80);
        }
        if (typeof body.disabled === 'boolean') {
            if (body.disabled && (target.permission === 1 || target.id === selfUid)) {
                throw new BadRequestError('Cannot disable an admin account');
            }
            patch.disabled = body.disabled ? 1 : 0;
        }
        if (Object.keys(patch).length === 0) {
            throw new BadRequestError('Nothing to update');
        }

        await profileAsync(c, 'user_admin_update', () => db.update(users).set(patch).where(eq(users.id, id)));
        return c.json({ success: true });
    });

    return app;
}
