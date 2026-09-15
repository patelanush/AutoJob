import { google } from "googleapis";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import type { CredentialStore } from "../security/keychain.js";
import type { Profile } from "../config/profile.js";
import { root } from "../config/profile.js";
import { safeUrl } from "../security/privacy.js";
export interface VerificationTrigger {
  tenant: string;
  email: string;
  company: string;
  ats: string;
  triggeredAt: number;
  trustedOrigins: string[];
  expectedSenders: string[];
}
export function chooseVerification(
  body: string,
  trigger: VerificationTrigger,
): { link?: string; code?: string } | null {
  if (
    /password reset|reset your password|account recovery|security alert/i.test(
      body,
    )
  )
    return null;
  const links = [...body.matchAll(/https:\/\/[^\s<>"']+/g)].map((m) =>
    m[0].replace(/&amp;/g, "&"),
  );
  const candidates = [
    ...new Set(
      links.filter((link) => {
        try {
          const u = new URL(safeUrl(link));
          return (
            trigger.trustedOrigins.includes(u.origin) &&
            /verify|confirm|activate/i.test(u.pathname) &&
            !/reset|recover/i.test(u.pathname)
          );
        } catch {
          return false;
        }
      }),
    ),
  ];
  if (
    candidates.length === 1 &&
    !links.some(
      (l) => /verify|confirm|activate/i.test(l) && !candidates.includes(l),
    )
  )
    return { link: candidates[0] };
  if (candidates.length) return null;
  const codes = [
    ...body.matchAll(
      /(?:verification|confirmation) code\s*[:-]?\s*(\d{4,8})\b/gi,
    ),
  ].map((m) => m[1]);
  return new Set(codes).size === 1 ? { code: codes[0] } : null;
}
export class GmailVerification {
  constructor(
    private profile: Profile,
    private credentials: CredentialStore,
  ) {}
  private client(redirect?: string) {
    const config = this.profile.gmail;
    if (!config) throw new Error("Configure optional Gmail integration");
    const json = JSON.parse(
      readFileSync(resolve(root, config.clientPath), "utf8"),
    );
    const c = json.installed;
    if (!c?.client_id || !c.client_secret)
      throw new Error("Use a Google OAuth Desktop client JSON");
    return new google.auth.OAuth2(c.client_id, c.client_secret, redirect);
  }
  async authorize(open: (url: string) => Promise<void>) {
    const state = randomBytes(24).toString("hex");
    const server = createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    if (!addr || typeof addr === "string")
      throw new Error("OAuth callback unavailable");
    const redirect = `http://127.0.0.1:${addr.port}/oauth`,
      client = this.client(redirect);
    const verifier = await client.generateCodeVerifierAsync();
    try {
      const code = await new Promise<string>((ok, no) => {
        const timer = setTimeout(() => {
          server.close();
          no(new Error("OAuth timed out"));
        }, 180000);
        server.on("request", (req, res) => {
          const u = new URL(req.url ?? "/", redirect);
          if (
            u.pathname !== "/oauth" ||
            u.searchParams.get("state") !== state
          ) {
            res.writeHead(400).end("Invalid callback");
            return;
          }
          const code = u.searchParams.get("code");
          if (!code) {
            clearTimeout(timer);
            res.end("Authorization declined");
            no(new Error("OAuth declined"));
            return;
          }
          clearTimeout(timer);
          res.end("Authorized. Return to your terminal.");
          ok(code);
        });
        void open(
          client.generateAuthUrl({
            access_type: "offline",
            prompt: "consent",
            scope: ["https://www.googleapis.com/auth/gmail.readonly"],
            state,
            code_challenge: verifier.codeChallenge,
            code_challenge_method: "S256" as never,
          }),
        ).catch(no);
      });
      const { tokens } = await client.getToken({
        code,
        codeVerifier: verifier.codeVerifier,
        redirect_uri: redirect,
      });
      await this.credentials.set("gmail-oauth-token", JSON.stringify(tokens));
    } finally {
      server.close();
    }
  }
  async find(trigger: VerificationTrigger) {
    if (
      !this.profile.gmail?.enabled ||
      !trigger.expectedSenders.length ||
      !trigger.trustedOrigins.length
    )
      return null;
    const client = this.client();
    client.setCredentials(
      JSON.parse(await this.credentials.get("gmail-oauth-token")),
    );
    client.on(
      "tokens",
      (tokens) =>
        void this.credentials
          .get("gmail-oauth-token")
          .then((previous) =>
            this.credentials.set(
              "gmail-oauth-token",
              JSON.stringify({ ...JSON.parse(previous), ...tokens }),
            ),
          )
          .catch(() => undefined),
    );
    const gmail = google.gmail({ version: "v1", auth: client });
    const sender = trigger.expectedSenders.map((s) => `from:${s}`).join(" ");
    const after = Math.floor((trigger.triggeredAt - 60000) / 1000);
    const q = `to:${trigger.email} after:${after} {${sender}} {subject:verify subject:confirm subject:verification}`;
    for (let poll = 0; poll < 4; poll++) {
      const result = await gmail.users.messages.list({
        userId: "me",
        q,
        maxResults: 5,
      });
      const found = [];
      for (const m of result.data.messages ?? []) {
        const message = await gmail.users.messages.get({
          userId: "me",
          id: m.id!,
          format: "full",
        });
        if (Number(message.data.internalDate) < trigger.triggeredAt - 60000)
          continue;
        const headers = message.data.payload?.headers ?? [];
        const from =
          headers.find((h) => h.name?.toLowerCase() === "from")?.value ?? "";
        const sender = from
          .match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+)/i)?.[1]
          ?.toLowerCase();
        if (
          !sender ||
          !trigger.expectedSenders.some(
            (s) => sender === s || sender.endsWith("." + s),
          )
        )
          continue;
        const subject =
          headers.find((h) => h.name?.toLowerCase() === "subject")?.value ?? "";
        const parts: string[] = [];
        const collect = (p: typeof message.data.payload) => {
          if (p?.body?.data)
            parts.push(Buffer.from(p.body.data, "base64url").toString());
          for (const x of p?.parts ?? []) collect(x);
        };
        collect(message.data.payload);
        const candidate = chooseVerification(parts.join("\n"), trigger);
        if (
          candidate?.code &&
          !(
            (subject + " " + parts.join(" "))
              .toLowerCase()
              .includes(trigger.company.toLowerCase()) ||
            (subject + " " + parts.join(" "))
              .toLowerCase()
              .includes(trigger.tenant.split(":")[0])
          )
        )
          continue;
        if (candidate) found.push(candidate);
      }
      if (found.length === 1) return found[0];
      if (found.length > 1) return null;
      if (poll < 3) await new Promise((r) => setTimeout(r, 5000));
    }
    return null;
  }
}
