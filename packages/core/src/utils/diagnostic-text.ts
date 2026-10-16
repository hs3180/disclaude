/** Bound diagnostic text without serializing request/config/header objects. */
export function sanitizeDiagnosticText(value: string, secrets: readonly string[] = []): string {
  let text = value;
  const protectedValues = [...secrets, ...Object.entries(process.env)
    .filter(([name]) => /(?:KEY|TOKEN|SECRET|PASS(?:WORD)?|CREDENTIAL)/i.test(name))
    .map(([, secret]) => secret ?? '')];
  for (const secret of protectedValues.filter(v => v.length >= 4).sort((a, b) => b.length - a.length)) {
    for (const candidate of [secret, encodeURIComponent(secret)]) {text = text.split(candidate).join('[REDACTED]');}
  }
  return text
    .replace(/https?:\/\/[^\s<>"']+/gi, raw => {
      try {const url = new URL(raw); return `${url.origin}${url.pathname}`;} catch {return '[URL]';}
    })
    .replace(/\b(?:Bearer|Basic)\s+[^\s,"';]+/gi, '[REDACTED AUTH]')
    .replace(/(["']?(?:app[_-]?secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|credential|token)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&}]+)/gi, '$1[REDACTED]')
    .replace(/\p{Cc}/gu, ' ').slice(0, 1500);
}
