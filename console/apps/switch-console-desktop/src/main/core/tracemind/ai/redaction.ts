/** Defense-in-depth for common credential formats; this is not a guarantee that arbitrary source text is secret-free. */
export function redactOutboundText(value: string): string {
  return value
    .replace(
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]{8,}={0,2}/gi, 'Bearer [REDACTED]')
    .replace(/\b(Authorization|Proxy-Authorization)\b\s*:\s*(?:Basic|Digest)\s+[^\r\n]*/gi, '$1=[REDACTED]')
    .replace(
      /\b(token|credential|connection[_-]?string|api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret|private[_-]?key|access[_-]?key)\b\s*[:=]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi,
      '$1=[REDACTED]'
    )
    .replace(/\bsk-(?:proj-|svcacct-|live-)?[A-Za-z0-9_-]{20,}\b/gi, '[REDACTED PROVIDER KEY]')
    .replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/gi, '[REDACTED PROVIDER KEY]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, '[REDACTED PROVIDER KEY]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED AWS KEY]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED JWT]')
    .replace(/(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@');
}