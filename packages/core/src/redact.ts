// Secret redaction for anything that may leave the machine or be kept on disk.
// The summary sent to a decision model and the session notes pass through
// redact() first. Every pattern has bounded repeats, so long input cannot make
// it slow; callers also cut text to a few kilobytes before calling it.
// Part of twosystems, created by Shashikant.

export const REDACTED = "[redacted]";

interface Rule {
  name: string;
  pattern: RegExp;
  /** Keep the first capture group (a label such as "password=") and redact the rest. */
  keepLabel?: boolean;
}

// Values after a secret's name that are clearly code, not the secret itself.
const CODE_VALUE =
  "(?:process\\.env|os\\.environ|import\\.meta\\.env|this|self|config|settings|env|options|opts)\\s{0,2}[.\\[]|[A-Za-z_$][A-Za-z_$]{0,80}\\s{0,2}\\(";

// Flag names that carry a secret.
const SECRET_FLAG =
  "(?:password|passwd|pass|pwd|secret|secret-key|token|api-key|apikey|access-key|secret-access-key|private-key|client-secret|auth-token)";

// Words that name a secret in "name = value" pairs and query strings.
const SECRET_NAME =
  "(?:pass(?:word|wd|phrase)?|pwd?|secret|token(?!s)|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth(?:orization)?)";

// Order matters: whole blocks first, then well-known token shapes, then
// generic "name = value" pairs, then anything that still looks random.
const RULES: Rule[] = [
  { name: "private_key", pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g },
  { name: "url_credentials", pattern: /(\b[a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/:@]{0,200}:[^\s/@]{1,200}(?=@)/gi, keepLabel: true },
  { name: "provider_key", pattern: /\bsk-(?:ant-|or-|proj-|svcacct-|live-)?[A-Za-z0-9_-]{16,}/g },
  { name: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g },
  { name: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { name: "aws_access_key", pattern: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{16}\b/g },
  { name: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: "stripe_key", pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{30,}/g },
  { name: "pypi_token", pattern: /\bpypi-[A-Za-z0-9_-]{50,}/g },
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { name: "bearer", pattern: /(\b(?:bearer|basic|token)\s{1,10})[A-Za-z0-9._~+/=-]{12,}/gi, keepLabel: true },
  {
    // Keys inside connection strings. A plain "password = x" is left to the assignment rule below.
    name: "connection_string",
    pattern: /(\b(?:AccountKey|SharedAccessKey|SharedAccessSignature)\s{0,10}=\s{0,10}|;\s{0,10}(?:Password|Pwd)\s{0,10}=\s{0,10})[^;"'\s]+/gi,
    keepLabel: true,
  },
  {
    name: "query_parameter",
    pattern: new RegExp(`([?&](?:sig|signature|key|code|access_token|${SECRET_NAME})=)[^&\\s#"']+`, "gi"),
    keepLabel: true,
  },
  {
    // A secret-looking name, then ":" or "=", then a value. Only values that are
    // clearly code are left alone: a read from a known settings object
    // (process.env.KEY, os.environ["KEY"], config.token) or a plain call with no
    // digits in its name (getToken(user)). Anything else is treated as a secret.
    name: "assignment",
    pattern: new RegExp(
      `(\\b[A-Za-z0-9_.-]{0,40}?${SECRET_NAME}(?:[_.-][A-Za-z0-9_.-]{0,40})?["']?\\s{0,10}[:=]\\s{0,10})` +
        `(?!(?:bearer|basic|token)\\b|\\[redacted\\]|${CODE_VALUE})` +
        `("[^"\\n]{0,500}"|'[^'\\n]{0,500}'|[^\\s,;]+)`,
      "gi",
    ),
    keepLabel: true,
  },
  {
    // Command-line flags: --password X, --secret-key=X, -p X is too vague to catch.
    name: "flag",
    pattern: new RegExp(`(--${SECRET_FLAG}(?:=|\\s{1,3}))(?!-)("[^"\\n]{0,500}"|'[^'\\n]{0,500}'|\\S+)`, "gi"),
    keepLabel: true,
  },
  {
    // curl -u name:password and --user name:password.
    name: "user_password",
    pattern: /((?:^|\s)(?:-u|--user)(?:=|\s{1,3}))[^\s:]{1,200}:\S+/g,
    keepLabel: true,
  },
  { name: "email", pattern: /\b[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g },
];

// Long runs of letters and digits: keys we do not know by shape, if they look random.
const LONG_TOKEN = /[A-Za-z0-9+/_=-]{32,}/g;

function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** True for strings that look like a key: long hex, or letters mixed with digits and high entropy. */
export function looksRandom(token: string): boolean {
  if (token.length < 32) return false;
  if (/^[a-f0-9]+$/i.test(token)) return true;
  return /[A-Za-z]/.test(token) && /[0-9]/.test(token) && entropy(token) >= 4;
}

// Looks like a file path: starts at a root or the home folder, ends in a file
// extension, or has many parts. Base64 keys with slashes rarely do any of these.
function looksLikePath(token: string): boolean {
  const parts = token.split("/");
  return /^(?:\/|~\/|\.\.?\/)/.test(token) || /\.[A-Za-z0-9]{1,8}$/.test(parts.at(-1) ?? "") || parts.length >= 5;
}

// A path is judged one part at a time, so src/components/CheckoutButtonContainer.tsx
// survives and a long random part does not. Anything else is judged whole, so a key
// such as wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY is caught.
function redactLongToken(token: string): string {
  if (!token.includes("/") || !looksLikePath(token)) return looksRandom(token) ? REDACTED : token;
  return token
    .split("/")
    .map((part) => (looksRandom(part) ? REDACTED : part))
    .join("/");
}

/** Replace secrets with [redacted]. Labels such as "password=" are kept so the text still reads. */
export function redact(text: string): string {
  let out = wellFormed(text);
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (_match: string, label?: unknown) =>
      rule.keepLabel && typeof label === "string" ? `${label}${REDACTED}` : REDACTED,
    );
  }
  return out.replace(LONG_TOKEN, redactLongToken);
}

/**
 * Redact, then cut to at most max characters. Only the start of the text is
 * read (four times max), so even a huge input stays fast, and a secret is never
 * cut short before it can be recognised.
 */
export function redactAndClip(text: string, max: number): string {
  const clean = redact(clip(text, max * 4)).replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clip(clean, max - 3)}...`;
}

/**
 * The first `max` UTF-16 units of the text, or one fewer when the cut would
 * split an emoji or another character outside the Basic Multilingual Plane, so
 * a cut never leaves half a character.
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Every half character (an unpaired UTF-16 surrogate) replaced by U+FFFD, so the text is valid Unicode everywhere. */
export function wellFormed(text: string): string {
  return text.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g, (unit) => (unit.length === 2 ? unit : "\uFFFD"));
}
