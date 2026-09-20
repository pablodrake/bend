// Run with Bun. Unmodified fixtures use a private temporary directory.
import { test, expect } from "bun:test";
import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { test_fixture } from "../gates/local.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const cli = path.join(root, "bend2", "main.ts");

test.skipIf(process.platform !== "win32")("launcher forwards arguments, cwd and exit status", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend launcher test "));
  try {
    fs.writeFileSync(path.join(dir, "args.bend"), `import Base

def show(xs: List<String>) -> IO(Unit):
  match xs:
    case Nil{}: IO.pure(Unit, Unit{})
    case h <> t:
      do IO<Unit>:
        IO.print(h)
        show(t)

def main() -> IO(Unit):
  do IO<Unit>:
    xs : List<String> <- IO.args()
    show(xs)
`);
    const invoke = (args: string[]) => child.spawnSync("cmd.exe",
      ["/d", "/s", "/c", '""' + path.join(root, "bend.cmd") + '" ' + args.join(" ") + '"'], {
        cwd: dir, encoding: "utf8", timeout: 15000, windowsVerbatimArguments: true,
        env: { ...process.env, BEND_BUN: process.execPath, BEND_NO_TELEMETRY: "1" },
      });
    const version = invoke(["version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toMatch(/^bend 2\./);
    const direct = run([cli, "args.bend", "one", "two words"], dir);
    const launched = invoke(["args.bend", "one", '"two words"']);
    expect(launched.status).toBe(0);
    expect(launched.stderr).toBe("");
    expect(launched.stdout).toBe(direct.stdout);
    expect(launched.stdout).toContain("two words");
    const invalid = invoke(["--not-an-option"]);
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("unknown option");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
const names = [
  "get_env",
  "file_roundtrip", "file_binary", "file_open_mode", "fail_keeps_handle",
  "path_utf8", "read_bytes", "read_leading_bom", "write_nul_bytes", "nul_bytes",
  "now", "sleep_timer", "sleep_order", "spawn_sleep", "spawn_outlives_main",
  "tcp_listen_close", "tcp_loopback", "tcp_short_recv", "tcp_spawn",
  "tcp_connect_black_hole", "tcp_send_slow_peer", "udp_loopback", "udp_poll",
  "udp_recv_park", "udp_send_recv", "udp_truncate", "udp_bad_address", "port_bound",
];

function run(args: string[], cwd: string) {
  return child.spawnSync(process.execPath, args, {
    cwd, encoding: "utf8", timeout: 15000,
    env: { ...process.env, BEND_NO_TELEMETRY: "1", TMPDIR: cwd, TMP: cwd, TEMP: cwd },
  });
}

test.skipIf(process.platform !== "win32")("refused TCP connect wakes and reports a Winsock error", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend refused test "));
  try {
    const file = path.join(dir, "main.bend");
    fs.writeFileSync(file, `import Base

def report(r: Result<&1, &1, U32 & String, Socket>) -> IO(Unit):
  match r:
    case Done{s}:
      do IO<Unit>:
        Socket.close(s)
        IO.die(Unit, 1, "unexpected connection")
    case Fail{(code, message)}:
      do IO<Unit>:
        IO.print(U32.show(code))
        IO.print(message)

def main() -> IO(Unit):
  do IO<Unit>:
    r : Result<&1, &1, U32 & String, Socket> <- TCP.connect("127.0.0.1", ${port})
    report(r)
`);
    const output = path.join(dir, "main.js");
    expect(run([cli, file, "-o", output], dir).status).toBe(0);
    for (const args of [[cli, file], [output]]) {
      const result = run(args, dir);
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(0);
      expect(result.stderr.trim()).toBe("");
      expect(result.stdout.trim()).toMatch(/^10061\r?\n.+/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 40000);

for (const name of names) {
  test(name + " interpreted and emitted JS", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend io test "));
    try {
      const source = fs.readFileSync(test_fixture("io", name + ".bend"), "utf8");
      const want = source.split(/\r?\n/).filter(l => l.startsWith("#|"))
        .map(l => l.slice(2)).join("\n").trim();
      const file = path.join(dir, "main.bend");
      fs.writeFileSync(file, source);
      const direct = run([cli, file], dir);
      expect(direct.error).toBeUndefined();
      expect(direct.stderr.trim()).toBe("");
      expect(direct.status).toBe(0);
      expect(direct.stdout.trim()).toBe(want);
      const output = path.join(dir, "main.js");
      const build = run([cli, file, "-o", output], dir);
      expect(build.status).toBe(0);
      expect(build.stderr.trim()).toBe("");
      const emitted = run([output], dir);
      expect(emitted.error).toBeUndefined();
      expect(emitted.stderr.trim()).toBe("");
      expect(emitted.status).toBe(0);
      expect(emitted.stdout.trim()).toBe(want);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 40000);
}
