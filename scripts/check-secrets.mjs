import { execFileSync } from "node:child_process";
const files = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
  encoding: "utf8",
})
  .split("\0")
  .filter(Boolean);
for (const file of files) {
  if (/^(private|data)\/|\.local\.json$|\.env(?:$|\.local)/.test(file))
    throw new Error(`Private file staged: ${file}`);
  const text = execFileSync("git", ["show", `:${file}`], {
    encoding: "utf8",
    maxBuffer: 5000000,
  });
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|AIza[0-9A-Za-z_-]{30,}|sk-(?:proj-)?[A-Za-z0-9_-]{30,}/.test(
      text,
    )
  )
    throw new Error(`Potential credential staged: ${file}`);
}
console.log("Staged secret check passed.");
