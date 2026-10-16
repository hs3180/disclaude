/** Ensure Readline receives UTF-8 input in the owned DSH runtime. */
export function dshProcessEnv(env, platform = process.platform) {
    const result = { ...env };
    // The Windows profile uses PowerShell, which owns its encoding setup.
    if (platform === 'win32') {
        return result;
    }
    const locales = [env.LC_ALL, env.LC_CTYPE, env.LANG];
    const active = locales.find((locale) => locale?.trim());
    const isUtf8 = (locale) => locale !== undefined && /^(?:[a-z0-9_-]+\.)?utf-?8(?:@[a-z0-9_-]+)?$/i.test(locale);
    if (isUtf8(active)) {
        return result;
    }
    // LC_ALL wins over LC_CTYPE and LANG. Replace a C/POSIX override too:
    // otherwise interactive Bash converts UTF-8 bytes into Meta shortcuts.
    result.LC_ALL = locales.find(isUtf8) ?? (platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8');
    return result;
}
