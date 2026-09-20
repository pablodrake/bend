import { test, expect } from "bun:test";
import * as child from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Compile the actual effect against a small host shim: this tests the Win32
// path handling without claiming the entire native runtime is ported.
test.skipIf(process.platform !== "win32")("C temp directory preserves Unicode and drive roots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bend temp test "));
  try {
    const source = path.join(dir, "temp.c");
    fs.writeFileSync(source, `
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
typedef char* Term;
typedef int Env;
typedef int IoWork;
typedef uint64_t u64;
#define CID_IO_TEMP_DIR 0
static void err_fail(const char* text) { fprintf(stderr, "%s", text); exit(1); }
static void* io_mem(void* p) { if (!p) err_fail("allocation"); return p; }
static Term io_str(Env e, const char* s, u64 n) {
  char* out = io_mem(malloc(n + 1)); memcpy(out, s, n); out[n] = 0; return out;
}
static void io_eff(int id, Term (*run)(Env, Term*, IoWork*), int flags) {}
#include ${JSON.stringify(path.join(root, "bend2", "effs", "temp_dir.c").replaceAll("\\", "/"))}
int main(void) { char* out = io_temp_dir_run(0, NULL, NULL); puts(out); free(out); }
`);
    const exe = path.join(dir, "temp.exe");
    const build = child.spawnSync(process.env.CC ?? "clang", [source, "-o", exe],
      { encoding: "utf8", timeout: 30000 });
    expect(build.stderr).toBe("");
    expect(build.status).toBe(0);
    const drive = path.parse(dir).root;
    const cases = [dir + "\\日本 café\\", drive, "\\\\?\\" + drive];
    for (const temp of cases) {
      const result = child.spawnSync(exe, [], { encoding: "utf8", timeout: 5000,
        env: { ...process.env, TMP: temp, TEMP: temp } });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const want = temp === drive || temp === "\\\\?\\" + drive ? temp : temp.replace(/\\$/, "");
      expect(result.stdout.trim()).toBe(want);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 40000);
