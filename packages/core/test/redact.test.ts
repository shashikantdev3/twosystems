// Tests for secret redaction. Fake secrets are assembled at run time so the
// source never contains a string that looks like a real key.
// Part of twosystems, created by Shashikant.
import { test } from "node:test";
import assert from "node:assert/strict";
import { REDACTED, redact } from "../src/redact.js";

const join = (...parts: string[]) => parts.join("");
const run = (n: number, alphabet = "aB3dE5gH7jK9mN1pQ") =>
  Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join("");

const SECRETS: Record<string, string> = {
  openrouter: join("sk-", "or-v1-", run(64, "0123456789abcdef")),
  anthropic: join("sk-", "ant-api03-", run(80)),
  openai: join("sk-", "proj-", run(48)),
  github: join("gh", "p_", run(36)),
  githubPat: join("github", "_pat_", run(60)),
  gitlab: join("glp", "at-", run(20)),
  aws: join("AK", "IA", "Q3EGRQ5Y7ZT2NB4W"),
  google: join("AI", "za", run(35)),
  slack: join("xo", "xb-", "1234567890-", run(24)),
  stripe: join("sk", "_live_", run(24)),
  npm: join("np", "m_", run(36)),
  pypi: join("py", "pi-", run(60)),
  jwt: join("ey", "JhbGciOiJIUzI1NiJ9", ".", "eyJzdWIiOiIxMjM0NTY3ODkwIn0", ".", run(43)),
};

for (const [name, secret] of Object.entries(SECRETS)) {
  test(`redacts a ${name} key wherever it appears`, () => {
    for (const text of [secret, `export KEY=${secret}`, `curl -H "x-key: ${secret}" https://x`, `"${secret}"`]) {
      const out = redact(text);
      assert.ok(!out.includes(secret), `${name} leaked in: ${out}`);
      assert.ok(out.includes(REDACTED));
    }
  });
}

test("redacts private key blocks, even unfinished ones", () => {
  const block = join("-----BEGIN ", "RSA PRIVATE KEY-----\n", run(64), "\n", run(64), "\n-----END RSA PRIVATE KEY-----");
  assert.equal(redact(`key:\n${block}\nend`), `key:\n${REDACTED}\nend`);
  const cut = join("-----BEGIN ", "OPENSSH PRIVATE KEY-----\n", run(40));
  assert.equal(redact(cut), REDACTED);
});

test("keeps the label of name=value secrets so the text still reads", () => {
  assert.equal(redact("DB_PASSWORD=hunter2"), `DB_PASSWORD=${REDACTED}`);
  assert.equal(redact("GITHUB_TOKEN=abc"), `GITHUB_TOKEN=${REDACTED}`);
  assert.equal(redact("client_secret: s3cr3t"), `client_secret: ${REDACTED}`);
  assert.equal(redact('{"api_key": "abc123"}'), `{"api_key": ${REDACTED}}`);
  assert.equal(redact("Authorization: Bearer abcdefghijklmnop1234"), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redact("Server=x;Password=p@ss;User=u"), `Server=x;Password=${REDACTED};User=u`);
  assert.equal(redact("git clone https://user:pa55word@github.com/a/b"), `git clone https://${REDACTED}@github.com/a/b`);
});

test("redacts email addresses and long random tokens", () => {
  assert.equal(redact("mail dev@example.com now"), `mail ${REDACTED} now`);
  const token = run(40, "Zq8Lr3Vt6Xw1Yb4Nc7Md0Kf2Hg5Js9");
  assert.equal(redact(`token ${token}`), `token ${REDACTED}`);
});

test("leaves ordinary code and errors alone", () => {
  const plain = [
    "npm test -- --watch=false",
    "TypeError: Cannot read properties of undefined (reading 'map') at src/app.ts:12:5",
    "git commit -m 'fix: handle empty basket'",
    "const total = items.reduce((sum, item) => sum + item.price, 0);",
    "src/components/CheckoutButton/CheckoutButtonContainer.tsx",
    "max_tokens=1000",
    "author: Shashikant",
    "if (isAuthorized) { secretsLoaded = true }",
  ];
  for (const text of plain) assert.equal(redact(text), text);
});

test("redaction is idempotent", () => {
  const text = `KEY=${SECRETS["github"] ?? ""} and dev@example.com`;
  assert.equal(redact(redact(text)), redact(text));
});

test("redacts secrets in query strings, short passwords, and URLs without a user name", () => {
  const sas = "https://acct.blob.core.windows.net/c/f?sv=2024-11-04&se=2026-12-01&sig=AbC%2Bdef%2Fghi123%3D";
  assert.equal(redact(sas), `https://acct.blob.core.windows.net/c/f?sv=2024-11-04&se=2026-12-01&sig=${REDACTED}`);
  assert.equal(redact("GET /api?key=abc123&page=2"), `GET /api?key=${REDACTED}&page=2`);
  assert.equal(redact("DB_PW=s3cret!"), `DB_PW=${REDACTED}`);
  assert.equal(redact("redis://:hunter2@cache:6379"), `redis://${REDACTED}@cache:6379`);
  const hexKey = run(32, "0123456789abcdef");
  assert.equal(redact(`key ${hexKey}`), `key ${REDACTED}`);
});

test("leaves paths, code and long identifiers readable", () => {
  const keep = [
    "/home/dev/projects/shop/src/components/checkout/CheckoutButtonContainer.tsx",
    "C:/Users/dev/source/repos/Contoso.Payments.Service/Controllers/OrdersController.cs",
    "const token = getToken(user);",
    "password: process.env.DB_PASSWORD",
    "password = config.db.password",
    "AbstractSingletonProxyFactoryBeanConfigurationProvider",
  ];
  for (const text of keep) assert.equal(redact(text), text);
});

test("long hostile input stays fast", () => {
  for (const text of ["a.".repeat(20_000), "a@".repeat(20_000), "x".repeat(50_000), `${"token=".repeat(5000)}x`]) {
    const started = performance.now();
    redact(text);
    assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
  }
});

test("values that only look a little like code are still treated as secrets", () => {
  for (const [text, label] of [
    ["DB_PASSWORD=Spring2024.Secure", "DB_PASSWORD="],
    ["client_secret=Kx8.Qp2-Lm9_Zr4", "client_secret="],
    ["token=abcDEF123.ghiJKL456.mnoPQR789", "token="],
    ["password: hunter2(prod)", "password: "],
    ["secret=Winter[2026]", "secret="],
  ] as const) {
    assert.equal(redact(text), `${label}${REDACTED}`, text);
  }
});

test("redacts flag values, curl credentials and unlabelled keys with slashes", () => {
  assert.equal(redact("mysql --password hunter2 -h db"), `mysql --password ${REDACTED} -h db`);
  assert.equal(redact("tool --secret-key=abc123"), `tool --secret-key=${REDACTED}`);
  assert.equal(redact("curl -u admin:pa55 https://x"), `curl -u ${REDACTED} https://x`);
  const awsLike = ["wJalrXUtnFEMI", "K7MDENG", "bPxRfiCYEXAMPLEKEY"].join("/");
  assert.ok(!redact(`aws configure set aws_secret_access_key ${awsLike}`).includes("K7MDENG"));
  assert.equal(redact(awsLike), REDACTED);
});
