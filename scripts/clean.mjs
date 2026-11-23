// Delete everything installed or built locally: node_modules folders, the in-repo pnpm
// store and Foundry build output. Source files and git history are not touched.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const targets = ["node_modules", ".pnpm-store", "contracts/out", "contracts/cache"];

for (const group of ["packages", "apps"]) {
  if (!existsSync(group)) continue;
  for (const name of readdirSync(group)) {
    targets.push(join(group, name, "node_modules"), join(group, name, "dist"));
  }
}

for (const target of targets) {
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
    console.log(`removed ${target}`);
  }
}
