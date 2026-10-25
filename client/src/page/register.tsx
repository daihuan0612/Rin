import { useState } from "react";
import { t } from "i18next";
import { Link, useLocation } from "wouter";
import { ButtonWithLoading } from "../components/button";
import { Input } from "../components/input";
import { client } from "../app/runtime";
import { setAuthToken } from "../utils/auth";

/**
 * 邀请码注册：填用户名、密码、邀请码，注册成功直接登录。
 * 没有"申请 → 审核"这一步 —— 作者把码发给谁，谁就能自己注册完。
 */
export function RegisterPage() {
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [invite, setInvite] = useState('');
    const [signupNote, setSignupNote] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState('');
    const [, setLocation] = useLocation();

    const handleRegister = async () => {
        if (!username || !password || !invite) {
            setError(t('register.error.empty'));
            return;
        }
        if (password !== confirm) {
            setError(t('register.error.mismatch'));
            return;
        }
        if (password.length < 6) {
            setError(t('register.error.short_password'));
            return;
        }

        setIsLoading(true);
        setError('');

        try {
            const { data, error: apiError } = await client.auth.register({
                username,
                password,
                invite,
                signupNote: signupNote.trim() || undefined,
            });

            if (apiError || !data?.success) {
                setError(t('register.error.failed'));
                setIsLoading(false);
                return;
            }

            if (data.token) {
                setAuthToken(data.token);
            }
            setLocation('/');
            window.location.reload();
        } catch (err) {
            setError(t('register.error.network'));
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex items-center justify-center my-8">
            <div className="bg-w w-full max-w-md flex flex-col items-center justify-between p-8 space-y-4 t-primary rounded-2xl shadow-lg">
                <p className="text-2xl font-bold">{t('register.title')}</p>
                <p className="text-xs t-secondary text-center leading-5">{t('register.hint')}</p>

                {error && (
                    <p className="text-sm text-red-500 text-center">{error}</p>
                )}

                <Input
                    value={username}
                    setValue={setUsername}
                    placeholder={t('register.username.placeholder')}
                    disabled={isLoading}
                    autofocus
                />
                <Input
                    value={password}
                    setValue={setPassword}
                    placeholder={t('register.password.placeholder')}
                    type="password"
                    disabled={isLoading}
                />
                <Input
                    value={confirm}
                    setValue={setConfirm}
                    placeholder={t('register.confirm.placeholder')}
                    type="password"
                    disabled={isLoading}
                />
                <Input
                    value={invite}
                    setValue={setInvite}
                    placeholder={t('register.invite.placeholder')}
                    onSubmit={handleRegister}
                    disabled={isLoading}
                />
                <Input
                    value={signupNote}
                    setValue={setSignupNote}
                    placeholder={t('register.signup_note.placeholder')}
                    disabled={isLoading}
                />

                <div className="flex flex-row items-center space-x-4 pt-2">
                    <ButtonWithLoading
                        title={isLoading ? t('register.loading') : t('register.submit')}
                        onClick={handleRegister}
                        loading={isLoading}
                    />
                </div>

                <Link href="/login" className="text-xs t-secondary hover:underline">
                    {t('register.have_account')}
                </Link>
            </div>
        </div>
    );
}
