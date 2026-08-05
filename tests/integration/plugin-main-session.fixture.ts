import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** sdk-showcase 源码目录（node-process 插件，worker 提供 echo 真实实现） */
export const SHOWCASE_SOURCE_DIR = path.resolve(__dirname, "../../examples/plugins/sdk-showcase");
