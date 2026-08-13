import { createAdminPasswordHash } from "../backend/src/admin/security";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) {
  chunks.push(Buffer.from(chunk));
}
const password = Buffer.concat(chunks).toString("utf8").replace(/[\r\n]+$/, "");
if (!password) {
  throw new Error("Pipe the admin password through stdin; it is never accepted as a command-line argument.");
}
process.stdout.write(`${await createAdminPasswordHash(password)}\n`);
