// Run with: bun test tools/windows-paths.test.ts
import { test, expect } from "bun:test";
import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bend2", "main.ts");

function run(args: string[], cwd = root) {
  return child.spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: "utf8", timeout: 30000,
    env: { ...process.env, BEND_NO_TELEMETRY: "1" },
  });
}

test("Base's foreign effects load through host paths", () => {
  const result = run([path.join(root, "demos", "io_hello_world", "main.bend")]);
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(result.stdout.trim()).toBe("Hello, world!");
});

test("relative imports, bare filenames, spaces and emitted JavaScript", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend path test "));
  try {
    fs.mkdirSync(path.join(dir, "nested"));
    fs.writeFileSync(path.join(dir, "value.bend"),
      "import Base\n\ndef value() -> U32:\n  42\n");
    fs.writeFileSync(path.join(dir, "nested", "main.bend"),
      "import Base\nimport ../value.bend as V\n\ndef main() -> U32:\n  V.value()\n");
    for (const [file, cwd] of [
      [path.join(dir, "nested", "main.bend"), root],
      [path.join("nested", "main.bend"), dir],
      ["main.bend", path.join(dir, "nested")],
    ]) {
      const result = run([file], cwd);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("42");
    }
    const output = path.join(dir, "result.js");
    const build = run([path.join(dir, "nested", "main.bend"), "-o", output]);
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);
    const result = child.spawnSync(process.execPath, [output], {
      encoding: "utf8", timeout: 30000,
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("42");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("absolute module imports use host path semantics", () => {
  // Bend import syntax has no quoted paths; keep this fixture space-free.
  const parent = path.join(root, ".tmp");
  fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, "imports-"));
  try {
    const value = path.join(dir, "value.bend").replaceAll("\\", "/");
    if (/\s/.test(value)) return;
    fs.writeFileSync(value, "import Base\n\ndef value() -> U32:\n  7\n");
    const main = path.join(dir, "main.bend");
    fs.writeFileSync(main,
      `import Base\nimport ${value} as V\n\ndef main() -> U32:\n  V.value()\n`);
    const result = run([main]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("7");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
