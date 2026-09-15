import { z } from "zod";
import {
  readFileSync,
  mkdirSync,
  existsSync,
  copyFileSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
export const profileSchema = z.object({
  personal: z.object({
    firstName: z.string(),
    middleName: z.string().optional(),
    lastName: z.string(),
    preferredName: z.string().optional(),
    email: z.email(),
    phone: z.string(),
    address: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    zip: z.string().optional(),
    country: z.string().optional(),
  }),
  links: z
    .object({
      linkedin: z.url().optional(),
      github: z.url().optional(),
      portfolio: z.url().optional(),
    })
    .default({}),
  education: z
    .array(
      z.object({
        school: z.string(),
        degree: z.string(),
        major: z.string(),
        minor: z.string().optional(),
        startDate: z.string().optional(),
        graduationDate: z.string().optional(),
        gpa: z.number().optional(),
        completed: z.boolean().optional(),
      }),
    )
    .default([]),
  employment: z
    .array(
      z.object({
        employer: z.string(),
        title: z.string(),
        location: z.string().optional(),
        startDate: z.string(),
        endDate: z.string().optional(),
        current: z.boolean().optional(),
        description: z.string().optional(),
      }),
    )
    .default([]),
  authorization: z
    .object({
      citizenship: z.union([z.string(), z.array(z.string())]).optional(),
      authorizedToWorkUS: z.boolean().optional(),
      sponsorshipRequiredNow: z.boolean().optional(),
      sponsorshipRequiredFuture: z.boolean().optional(),
    })
    .default({}),
  demographics: z
    .object({
      gender: z.string().optional(),
      race: z.union([z.string(), z.array(z.string())]).optional(),
      ethnicity: z.string().optional(),
      veteranStatus: z.string().optional(),
      disabilityStatus: z.string().optional(),
    })
    .default({}),
  preferences: z
    .object({
      willingToRelocate: z.boolean().optional(),
      salaryExpectation: z.string().optional(),
      desiredLocations: z.array(z.string()).optional(),
    })
    .default({}),
  approvedFacts: z.record(z.string(), z.unknown()).default({}),
  answerBank: z
    .array(
      z.object({
        question: z.string(),
        answer: z.union([z.string(), z.boolean(), z.number()]),
        scope: z.string().default("global"),
      }),
    )
    .default([]),
  resume: z.object({
    path: z.string(),
    verifiedTextPath: z.string().optional(),
  }),
  ai: z
    .object({
      enabled: z.boolean().default(false),
      baseUrl: z.url(),
      model: z.string(),
      structuredOutput: z.boolean().default(false),
    })
    .optional(),
  gmail: z
    .object({
      enabled: z.boolean().default(false),
      clientPath: z.string(),
      trustedOrigins: z.record(z.string(), z.array(z.url())).default({}),
    })
    .optional(),
  browser: z
    .object({ reviewTabLimit: z.number().int().min(1).max(10).default(10) })
    .default({ reviewTabLimit: 10 }),
});
export type Profile = z.infer<typeof profileSchema>;
export const root = resolve(process.env.JOB_AGENT_ROOT ?? process.cwd());
export const paths = {
  root,
  private: join(root, "private"),
  data: join(root, "data"),
  db: join(root, "data/agent.sqlite"),
  profile: join(root, "private/profile.local.json"),
  browser: join(root, "data/browser"),
  artifacts: join(root, "data/artifacts"),
};
export function directories() {
  for (const p of [paths.private, paths.data, paths.artifacts])
    mkdirSync(p, { recursive: true, mode: 0o700 });
}
export function setupProfile() {
  directories();
  if (!existsSync(paths.profile))
    copyFileSync(join(root, "profile.example.json"), paths.profile);
}
export function loadProfile(live = false): Profile {
  const p = profileSchema.parse(
    JSON.parse(readFileSync(paths.profile, "utf8")),
  );
  if (live) {
    if (
      /example\.(com|org)|YOUR_|DUMMY|Example/i.test(
        JSON.stringify(p.personal),
      ) ||
      !p.personal.phone.trim()
    )
      throw new Error(
        "Configure real private/profile.local.json identity before live preparation.",
      );
    const resume = resolve(root, p.resume.path);
    if (!existsSync(resume) || !statSync(resume).isFile())
      throw new Error("Configure an existing authorized resume path.");
  }
  return p;
}
