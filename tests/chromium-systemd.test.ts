import { describe, it, expect } from 'vitest';
import { renderLinuxBrowserUnit, resolveLinuxBrowser, systemdQuote } from '../scripts/chromium-systemd.mjs';

describe('native Linux browser configuration', () => {
  it('escapes systemd expansion and quoting in executable arguments', () => {
    expect(systemdQuote('/tmp/a b/$HOME/%h/"quoted"', true)).toBe('"/tmp/a b/$$HOME/%%h/\\"quoted\\""');
    expect(() => systemdQuote('a\nExecStart=other')).toThrow();
  });
  it('rejects invalid ports and a missing desktop before rendering a service', () => {
    expect(() => resolveLinuxBrowser({ CHROMIUM_CDP_BINARY: process.execPath, CHROMIUM_CDP_PORT: '0' })).toThrow('between 1 and 65535');
    expect(() => resolveLinuxBrowser({ CHROMIUM_CDP_BINARY: process.execPath })).toThrow('desktop display');
    expect(() => resolveLinuxBrowser({ CHROMIUM_CDP_BINARY: 'node' })).toThrow('absolute path');
  });
  it('runs the selected browser directly with its persistent profile and process-group cleanup', () => {
    const unit = renderLinuxBrowserUnit({ binary: '/opt/browser/app', profile: '/state/profile', port: 9444, address: '127.0.0.1', headed: '0' }, {});
    expect(unit).toContain('Type=exec');
    expect(unit).toContain('ExecStart="/opt/browser/app" "--user-data-dir=/state/profile"');
    expect(unit).toContain('"--headless=new"');
    expect(unit).toContain('KillMode=control-group');
    expect(unit).toContain('WantedBy=default.target');
  });
});
