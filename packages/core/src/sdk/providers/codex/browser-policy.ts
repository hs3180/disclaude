/** Keep browser automation on the shared browser-use/CDP path, scoped to our children. */
export const CODEX_BROWSER_DISABLE_ARGS = [
  '--disable', 'browser_use',
  '--disable', 'browser_use_external',
  '--disable', 'browser_use_full_cdp_access',
];
