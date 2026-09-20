#!/usr/bin/env bun
// Every test under tests/, on this machine alone. gates/test.ts needs the
// mini cluster: a bastion, an SSH key and a slot of 48 nodes. Nobody
// outside that network can run it, and no node of it runs Windows.
//
//   bun gates/local.ts [--filter <text>] [--jobs <n>] [--limit <n>]
//                      [--no-js] [--no-c] [--verbose] [--gate]
//
// This runner changes nothing about what a test means. It reads, parses
// and judges through gates/test.ts itself, so the two gates cannot drift.
// It replaces only the three things a single box cannot do: ssh and tar
// become a local copy, `perl alarm` becomes a spawn timeout, and
// `xargs -P` becomes a job pool.
//
// The C lane needs clang, which every host here has.

import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as lib from "./_lib";

// The gate's own reader, splitter, parser and judge. Importing them keeps
// one definition of what a test means, so the two runners cannot drift.
// test.ts guards its cluster path behind `import.meta.main`, so nothing of
// it runs here.
import { MARK, shard_parse, shard_split, test_judge, test_path, test_read,
  test_runs, tidy } from "./test.ts";

import type { Fail, Test } from "./test.ts";

// Constants
// =========

const ROOT = lib.ROOT;

const TESTS = path.join(ROOT, "tests");

// Only the local runner selects platform fixtures. The cluster gate keeps
// reading the canonical tests, regardless of the machine launching it.
export function test_fixture(dir: string, file: string,
  platform: NodeJS.Platform = process.platform): string {
  const variant = path.join(ROOT, "gates", "windows", dir, file);
  return platform === "win32" && fs.existsSync(variant)
    ? variant : path.join(TESTS, dir, file);
}

// The bun running this file, not the cluster's /usr/local/bun.
const BUN = process.execPath;

const MAIN = path.join(ROOT, "bend2", "main.ts");

const WIN = process.platform === "win32";

// A Windows process starts far more slowly than a mini's, so the alarms
// are longer than the cluster's 5 s. The warm-up alarm stays at 60 s.
const CHECK_MS = 600000;

const BUILD_MS = 300000;

const RUN_MS = WIN ? 30000 : 10000;

const WARM_MS = 60000;

const ENV = { ...process.env, BEND_NO_TELEMETRY: "1",
  BUN_JSC_maxPerThreadStackUsage: "33554432" };

// Options
// =======

type Opts = {
  filter: string | null;
  jobs: number;
  limit: number;
  js: boolean;
  c: boolean;
  verbose: boolean;
  report: string | null;
};

export function opts_read(argv: string[]): Opts {
  const o: Opts = {
    filter: null,
    jobs: Math.max(1, Math.min(4, os.availableParallelism() - 1)),
    limit: 0,
    js: true,
    c: true,
    verbose: false,
    report: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--filter") {
      o.filter = argv[i += 1];
      if (!o.filter || o.filter.startsWith("--")) throw new Error("--filter needs text");
    } else if (argv[i] === "--report") {
      o.report = argv[i += 1];
      if (!o.report || o.report.startsWith("--")) throw new Error("--report needs a file");
    } else if (argv[i] === "--jobs") {
      o.jobs = Number(argv[i += 1]);
    } else if (argv[i] === "--limit") {
      o.limit = Number(argv[i += 1]);
    } else if (argv[i] === "--no-js") {
      o.js = false;
    } else if (argv[i] === "--no-c") {
      o.c = false;
    } else if (argv[i] === "--verbose") {
      o.verbose = true;
    } else if (argv[i] !== "--gate") {
      throw new Error("unknown option: " + argv[i]);
    }
  }
  if (!Number.isSafeInteger(o.jobs) || o.jobs < 1) {
    throw new Error("--jobs must be a positive integer");
  }
  if (!Number.isSafeInteger(o.limit) || o.limit < 0) {
    throw new Error("--limit must be a nonnegative integer");
  }
  return o;
}

// Run
// ===

let seq = 0;

// One merged pipe, the way the cluster's `2>&1` merges: both streams
// write to the same file, so their order survives. Two pipes read in
// parallel would not keep it.
export async function run_process(bin: string, args: string[], ms: number,
  cwd: string, env: NodeJS.ProcessEnv = ENV): Promise<[string, number]> {
  const log = path.join(cwd, "out-" + process.pid + "-" + String(seq += 1) + ".txt");
  const fd = fs.openSync(log, "w");
  try {
    return await new Promise<[string, number]>((resolve, reject) => {
      let failure = "";
      let late = false;
      let killing: Promise<void> = Promise.resolve();
      const kid = child.spawn(bin, args, { cwd, env, detached: !WIN,
        stdio: ["ignore", fd, fd], windowsHide: true });
      const timer = setTimeout(() => {
        late = true;
        if (!kid.pid) return;
        if (WIN) {
          // Compilers can have children: kill the process tree, not just Bun.
          killing = new Promise<void>(done => {
            const killer = child.spawn("taskkill", ["/PID", String(kid.pid), "/T", "/F"],
              { stdio: "ignore", windowsHide: true });
            killer.on("error", () => { kid.kill("SIGKILL"); done(); });
            killer.on("close", () => { kid.kill("SIGKILL"); done(); });
          });
        } else {
          try { process.kill(-kid.pid, "SIGKILL"); } catch { kid.kill("SIGKILL"); }
        }
      }, ms);
      kid.on("error", e => { failure = String(e); });
      kid.on("close", async code => {
        clearTimeout(timer);
        await killing;
        try {
          const text = fs.readFileSync(log, "utf8");
          resolve([text + (failure ? "\n" + failure + "\n" : ""),
            late ? 142 : code ?? 1]);
        } catch (e) { reject(e); }
      });
    });
  } finally {
    fs.closeSync(fd);
    fs.rmSync(log, { force: true });
  }
}

function run(args: string[], ms: number, cwd: string,
  env: NodeJS.ProcessEnv): Promise<[string, number]> {
  return run_process(BUN, args, ms, cwd, env);
}

function exec(bin: string, args: string[], ms: number,
  env: NodeJS.ProcessEnv): Promise<[string, number]> {
  return run_process(bin, args, ms, WORK, env);
}

// Work
// ====

// tests/ is copied once. Every batch writes its aggregator beside that one
// copy, so a test that imports another still resolves, and --checkup still
// names its sections "./tests/<ns>/<name>.bend", which shard_parse reads.
let WORK = "";

// One temporary directory per batch, not one per run: batches run at the
// same time, and two fixtures that pick the same file name would otherwise
// meet inside it. IO.temp_dir reads TMPDIR on Unix and TEMP on Windows, so
// all three names are set.
function work_env(tag: number): NodeJS.ProcessEnv {
  const temp = path.join(WORK, "temp", String(tag));
  fs.mkdirSync(temp, { recursive: true });
  return { ...ENV, TMPDIR: temp, TMP: temp, TEMP: temp };
}

function work_open(tests: Test[]): void {
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), "bend-local-"));
  fs.mkdirSync(path.join(WORK, "temp"));
  fs.cpSync(TESTS, path.join(WORK, "tests"), { recursive: true });
  for (const t of tests) {
    const rel = test_path(t);
    const source = test_fixture(path.dirname(rel), path.basename(rel));
    if (source !== path.join(TESTS, rel)) {
      fs.copyFileSync(source, path.join(WORK, "tests", rel));
    }
  }
}

function work_shut(): void {
  if (!WORK) return;
  fs.rmSync(WORK, { recursive: true, force: true });
}

function test_src(t: Test): string {
  return path.join(WORK, "tests", test_path(t));
}

// Batch
// =====

// The same framing the node's script writes, so shard_parse reads this
// exactly as it reads a real shard.
async function batch_run(batch: Test[], tag: number, o: Opts): Promise<string> {
  const env = work_env(tag);
  const main = path.join(WORK, "main" + String(tag) + ".bend");
  fs.writeFileSync(main, batch.map((t) =>
    "import ./tests/" + test_path(t) + " as " + t.name).join("\n")
    + "\n");
  const out: string[] = [];
  const [check, code] = await run([MAIN, main, "--checkup"], CHECK_MS, WORK,
    env);
  if (code !== 0 && code !== 1) {
    throw new Error("checkup process failed: " + (code === 142 ? "timeout" : code));
  }
  out.push(MARK + " checkup\n" + check);
  for (const t of test_runs(batch)) {
    out.push(await batch_one(t, o, env));
  }
  fs.rmSync(main, { force: true });
  return out.join("");
}

async function batch_one(t: Test, o: Opts,
  env: NodeJS.ProcessEnv): Promise<string> {
  const lanes = t.lanes.filter((l) => l === "js" ? o.js : o.c);
  const base = path.join(WORK, t.name);
  // Windows runs a binary by its .exe name; the JS lane keeps the base.
  const bin = base + (WIN ? ".exe" : "");
  const built: string[] = [];
  for (const lane of lanes) {
    if (o.verbose) console.log("build " + t.name + " [" + lane + "]");
    const to = lane === "js" ? base + ".js" : bin;
    const [say, code] = await run([MAIN, test_src(t), "-o", to], BUILD_MS,
      WORK, env);
    // A build that fails leaves its message in `left`: both lanes then
    // read it as their answer, as they do on a node.
    if (code !== 0 || !fs.existsSync(to)) {
      return MARK + " left " + t.name + "\n"
        + (say === "" ? "(build failed: exit " + code + ")\n" : say);
    }
    built.push(lane);
  }
  // A `!` program compiles its GPU shader on its first launch, which the
  // host then caches by source. That launch is untimed, as on a node.
  if (built.includes("c") && /!\(/.test(t.src)) {
    const [say, code] = await exec(bin, [], WARM_MS, env);
    if (code !== 0) return MARK + " left " + t.name + "\n"
      + say + "\nGPU warm-up failed: exit " + code + "\n";
  }
  const out: string[] = [];
  for (const lane of built) {
    if (o.verbose) console.log("run " + t.name + " [" + lane + "]");
    const [say, code] = lane === "js"
      ? await run([base + ".js"], RUN_MS, WORK, env)
      : await exec(bin, [], RUN_MS, env);
    out.push(MARK + " " + lane + " " + t.name + "\n" + say
      + (say.endsWith("\n") || say === "" ? "" : "\n")
      + MARK + " exit " + String(code) + "\n");
  }
  return out.join("");
}

// Pool
// ====

export async function pool<T>(items: T[], jobs: number,
  each: (item: T, at: number) => Promise<void>): Promise<void> {
  if (!Number.isSafeInteger(jobs) || jobs < 1) throw new Error("invalid worker count");
  let next = 0;
  const work = async (): Promise<void> => {
    for (;;) {
      const at = next += 1;
      if (at > items.length) {
        return;
      }
      await each(items[at - 1], at - 1);
    }
  };
  const results = await Promise.allSettled(Array.from({ length: Math.min(jobs, items.length) }, work));
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

// Main
// ====

async function main(): Promise<void> {
  const started = Date.now();
  const o = opts_read(process.argv.slice(2));
  let tests = fs.readdirSync(TESTS).sort().flatMap((dir) =>
    fs.readdirSync(path.join(TESTS, dir)).filter((f) => f.endsWith(".bend"))
      .sort().map((f) => test_read(dir, f, test_fixture(dir, f))));
  // Git checks the repository out with CRLF endings under the default
  // core.autocrlf on Windows. test_read splits the source on "\n", so
  // every wanted line then ends in a stray "\r" that tidy does not strip,
  // and nothing matches. A program's own output has no "\r", so dropping
  // it here gives exactly what an LF checkout would have read.
  for (const t of tests) {
    t.want = tidy(t.want.replace(/\r/g, ""));
    t.src = t.src.replace(/\r/g, "");
  }
  if (o.filter !== null) {
    const f = o.filter;
    tests = tests.filter((t) => t.name.includes(f));
  }
  if (o.limit > 0) {
    tests = tests.slice(0, o.limit);
  }
  if (tests.length === 0) throw new Error("no tests selected");
  const skipped = test_runs(tests).flatMap(t => t.lanes.filter(l => l === "js" ? !o.js : !o.c)
    .map(lane => ({ name: t.name, lane, reason: lane === "c" && WIN
      ? "the C lane is off" : "disabled by option" })));
  // A lane this host cannot build is dropped before the probes are counted,
  // so it is never judged and never silently passed.
  for (const t of tests) {
    t.lanes = t.lanes.filter((l) => l === "js" ? o.js : o.c);
  }
  // One aggregator holds about as many tests as a shard does on a node.
  // A batch is one Bun process for its whole check lane, so a larger one
  // starts Bun less often but holds more books in memory at once.
  const batches = shard_split(tests,
    Math.max(o.jobs, Math.ceil(tests.length / 28)));
  if (!lib.GATE) {
    console.log("bend local gate: " + String(tests.length) + " tests, "
      + String(batches.length) + " batches, lanes: check, interp"
      + (o.js ? ", js" : "") + (o.c ? ", c" : ""));
  }
  const variants = tests.flatMap(t => {
    const rel = test_path(t);
    const source = test_fixture(path.dirname(rel), path.basename(rel));
    return source === path.join(TESTS, rel) ? []
      : [{ name: t.name, source: path.relative(ROOT, source).replaceAll("\\", "/") }];
  });
  if (!lib.GATE) for (const v of variants) console.log("Windows fixture: " + v.source);
  work_open(tests);
  const fails: Fail[] = [];
  const completed = new Set<string>();
  let done = 0;
  await pool(batches, o.jobs, async (batch, tag) => {
    let gots;
    try {
      gots = shard_parse(batch, await batch_run(batch, tag, o));
    } catch (e) {
      for (const t of batch) fails.push({ name: t.name, probe: "runner",
        want: "completed batch", got: String(e) });
      return;
    }
    for (const t of batch) {
      if (gots.get(t.name)?.check !== undefined) completed.add(t.name);
      fails.push(...test_judge(t, gots.get(t.name) ?? {}));
    }
    done += batch.length;
    if (!lib.GATE) {
      console.log("     " + String(done).padStart(5) + "/"
        + String(tests.length) + " done");
    }
  });
  for (const t of tests) {
    if (!completed.has(t.name)) fails.push({ name: t.name, probe: "runner",
      want: "test executed", got: "no check result received" });
  }
  work_shut();
  fails.sort((a, b) => a.name < b.name ? -1 : 1);
  if (!lib.GATE) {
    for (const f of fails) {
      console.log("FAIL " + f.name + " [" + f.probe + "]");
      console.log("  expected: " + f.want.replace(/\n/g, "\\n"));
      console.log("  observed: " + f.got.replace(/\n/g, "\\n"));
    }
  }
  const bad = new Set(fails.map((f) => f.name));
  console.log("Executed: " + completed.size + "/" + tests.length
    + "; skipped lanes: " + skipped.length
  );
  if (o.report !== null) fs.writeFileSync(o.report, JSON.stringify({
    platform: process.platform, jobs: o.jobs, selected: tests.length,
    executed: completed.size, passed: tests.length - bad.size,
    durationMs: Date.now() - started, variants, skipped, failures: fails,
  }, null, 2) + "\n");
  lib.verdict(tests.length - bad.size, tests.length);
}

if (import.meta.main) {
  process.on("exit", work_shut);
  try { await main(); } catch (e) {
    console.error(String(e));
    process.exitCode = 1;
  }
}
