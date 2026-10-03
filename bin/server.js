#!/usr/bin/env node
/**
 * 启动多住户智能家居裁决后端（品牌无关）。
 *
 * 环境变量：
 *   ARBITRATION_PORT    监听端口（默认 8080）
 *   ARBITRATION_DB      JSON 持久化文件（默认 ./data/arbitration.json）
 *   TZ                  时区（默认 Asia/Shanghai）
 */
import { SmartHomeArbitration } from "../src/domain/app.js";
import { createHttpServer } from "../src/server.js";

const port = Number(process.env.ARBITRATION_PORT || 8080);
const persistPath = process.env.ARBITRATION_DB || new URL("../data/arbitration.json", import.meta.url).pathname;

const app = await SmartHomeArbitration.create({ persistPath });
const server = createHttpServer(app);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`多住户智能家居裁决后端已启动：http://localhost:${port}（持久化：${persistPath}）`);
});

const shutdown = async () => {
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
