// 单元测试:注意力优化面 —— 短路径副本机制与注入语义守卫。
// node --test test/

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugins", "zcode-tps-monitor");

// --- 沙箱 HOME:重定向 os.homedir() 的环境来源,避免触碰真实 ~/.zcode ---
function sandboxHome(name) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `tps-attn-${name}-`));
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  return home;
}

test("ensureRateShortcut:首次创建、内容变化即刷新、读取失败返回 null", async () => {
  const home = sandboxHome("lib");
  const { ensureRateShortcut } = await import(pathToFile(path.join(PLUGIN, "hooks", "lib.mjs")));
  const src = path.join(home, "fake-rate.mjs");
  fs.writeFileSync(src, "export const v = 1;\n");

  const dest = ensureRateShortcut(src);
  assert.equal(dest, path.join(home, ".zcode", "token-rate.mjs"));
  assert.equal(fs.readFileSync(dest, "utf8"), "export const v = 1;\n");

  // 源变化(插件升级) → 副本刷新
  fs.writeFileSync(src, "export const v = 2;\n");
  ensureRateShortcut(src);
  assert.equal(fs.readFileSync(dest, "utf8"), "export const v = 2;\n");

  // 源不可读 → null(调用方回退完整路径),不抛错
  assert.equal(ensureRateShortcut(path.join(home, "nope.mjs")), null);
});

function pathToFile(p) {
  return "file://" + p.replace(/\\/g, "/");
}

function runPromptSubmit(home) {
  return spawnSync(process.execPath, [path.join(PLUGIN, "hooks", "prompt-submit.mjs")], {
    encoding: "utf8",
    env: {
      ...process.env,
      USERPROFILE: home,
      HOME: home,
      ZCODE_SESSION_ID: "sess_attn_test",
      TPS_MONITOR_STATE_FILE: path.join(home, "state.json"),
    },
  });
}

test("prompt-submit:注入走短路径副本,五要素守卫齐全,副本内容与源一致", () => {
  const home = sandboxHome("hook");
  const r = runPromptSubmit(home);
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;

  assert.match(ctx, /ZCODE_SESSION_ID="sess_attn_test" node ~\/\.zcode\/token-rate\.mjs --turn --current/, "命令应为短路径形式");
  assert.match(ctx, /调用过工具/, "缺少①调用过工具条件");
  assert.match(ctx, /输出总结前/, "缺少②收尾时机");
  assert.match(ctx, /引用块/, "缺少④引用块要求");
  assert.match(ctx, /不改写/, "缺少④不改写要求");
  assert.match(ctx, /不显示任何统计行/, "缺少⑤空输出守卫");
  assert.match(ctx, /不为此调用工具/, "缺少⑤不额外调用守卫");

  // 副本在沙箱内创建且与插件脚本逐字节一致
  const shortcut = path.join(home, ".zcode", "token-rate.mjs");
  assert.ok(fs.existsSync(shortcut), "短路径副本未创建");
  assert.ok(fs.readFileSync(shortcut).equals(fs.readFileSync(path.join(PLUGIN, "scripts", "token-rate.mjs"))), "副本内容与源不一致");
  // 状态文件仍写入(守卫时序契约)
  assert.ok(fs.existsSync(path.join(home, "state.json")));
});

test("prompt-submit:配置关闭时注入空串(行为不变),且不创建副本", () => {
  const home = sandboxHome("off");
  fs.mkdirSync(path.join(home, ".zcode"), { recursive: true });
  fs.writeFileSync(path.join(home, ".zcode", "tps-monitor.config.json"), JSON.stringify({ tokenRateLine: false }));
  const r = runPromptSubmit(home);
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(ctx, "");
  assert.ok(!fs.existsSync(path.join(home, ".zcode", "token-rate.mjs")), "关闭注入时不应创建副本");
});
