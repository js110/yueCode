import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [srcDir, destDir, ext] = process.argv.slice(2);
if (!existsSync(srcDir)) process.exit(0);
mkdirSync(destDir, { recursive: true });
const files = readdirSync(srcDir).filter((f) => f.endsWith(ext));
for (const f of files) {
	copyFileSync(join(srcDir, f), join(destDir, f));
}
