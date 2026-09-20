import { test, expect } from "bun:test";
import { opts_read, pool, run_process, test_fixture } from "../gates/local.ts";
import { test_read } from "../gates/test.ts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

test("only Windows selects the platform fixtures; cluster expectations stay canonical", () => {
  for (const platform of ["linux", "darwin"] as const) {
    const source = test_fixture("io", "get_env.bend", platform);
    expect(source).toEndWith(path.join("tests", "io", "get_env.bend"));
    expect(test_read("io", "get_env.bend", source).want).toStartWith("HOME=set");
    expect(test_fixture("io", "tcp_send_slow_peer.bend", platform))
      .toEndWith(path.join("tests", "io", "tcp_send_slow_peer.bend"));
  }
  const source = test_fixture("io", "get_env.bend", "win32");
  expect(source).toEndWith(path.join("gates", "windows", "io", "get_env.bend"));
  expect(test_read("io", "get_env.bend", source).want).toStartWith("PATH=set");
  expect(test_read("io", "get_env.bend").want).toStartWith("HOME=set");
  expect(test_fixture("io", "nul_bytes.bend", "win32"))
    .toEndWith(path.join("gates", "windows", "io", "nul_bytes.bend"));
  expect(test_fixture("io", "nul_bytes.bend", "linux"))
    .toEndWith(path.join("tests", "io", "nul_bytes.bend"));
  const nul = test_read("io", "nul_bytes.bend");
  const windowsNul = test_read("io", "nul_bytes.bend", test_fixture("io", "nul_bytes.bend", "win32"));
  expect(windowsNul.want.replace(/\r\n/g, "\n")).toBe(nul.want.replace(/\r\n/g, "\n"));
  expect(test_fixture("io", "file_binary.bend", "win32"))
    .toEndWith(path.join("tests", "io", "file_binary.bend"));
  const tcp = test_read("io", "tcp_send_slow_peer.bend");
  const windows = test_read("io", "tcp_send_slow_peer.bend",
    test_fixture("io", "tcp_send_slow_peer.bend", "win32"));
  expect(windows.want.replace(/\r\n/g, "\n")).toBe(tcp.want.replace(/\r\n/g, "\n"));
});

test("worker counts and limits reject missing, nonnumeric and invalid values", () => {
  for (const n of ["0", "-1", "1.5", "NaN", "Infinity", "abc", "9007199254740992"]) {
    expect(() => opts_read(["--jobs", n])).toThrow();
  }
  expect(() => opts_read(["--jobs"])).toThrow();
  expect(() => opts_read(["--filter"])).toThrow();
  expect(() => opts_read(["--report"])).toThrow();
  for (const n of ["-1", "1.5", "abc"]) expect(() => opts_read(["--limit", n])).toThrow();
  expect(opts_read(["--jobs", "1", "--limit", "0"]).jobs).toBe(1);
});

test("pool bounds live jobs and runs each item once", async () => {
  let active = 0, peak = 0;
  const seen: number[] = [];
  await pool([0, 1, 2, 3, 4, 5], 2, async i => {
    active += 1;
    peak = Math.max(peak, active);
    seen.push(i);
    await new Promise(resolve => setTimeout(resolve, 10));
    active -= 1;
  });
  expect(peak).toBe(2);
  expect(seen.sort()).toEqual([0, 1, 2, 3, 4, 5]);
  expect(active).toBe(0);
  expect(pool([1], 0, async () => {})).rejects.toThrow();
});

test("process runner overlaps real processes, merges output and handles failures", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend process test "));
  try {
    const script = 'console.log(Date.now()); setTimeout(() => console.log(Date.now()), 500)';
    const rows = await Promise.all([0, 1].map(() =>
      run_process(process.execPath, ["-e", script], 5000, dir)));
    const times = rows.map(([out, code]) => {
      expect(code).toBe(0);
      return out.trim().split(/\s+/).map(Number);
    });
    expect(Math.max(times[0][0], times[1][0])).toBeLessThan(Math.min(times[0][1], times[1][1]));
    const mixed = await run_process(process.execPath, ["-e",
      'const f=require("fs"); f.writeSync(1,"out\\n"); f.writeSync(2,"err\\n"); process.exit(7)'], 5000, dir);
    expect(mixed).toEqual(["out\nerr\n", 7]);
    const timeout = await run_process(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100, dir);
    expect(timeout[1]).toBe(142);
    const missing = await run_process(path.join(dir, "absent.exe"), [], 5000, dir);
    expect(missing[1]).not.toBe(0);
    expect(missing[0]).toContain("ENOENT");
    expect(fs.readdirSync(dir)).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
