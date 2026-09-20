# Running Bend on Windows

The canonical fixtures `tests/io/get_env.bend`, `tcp_send_slow_peer.bend`,
and `nul_bytes.bend` retain their original Unix behavior and expectations.
The local gate selects three explicit fixtures from `gates/windows/io/` only
on Windows: `get_env` checks PATH instead of HOME, and `tcp_send_slow_peer`
prepares a private nonempty file instead of opening `/etc/hosts`. The latter
verifies the exact bytes read with the original 500 ms time limit; preparation
happens before the network workload starts. `nul_bytes` recognizes EILSEQ as
42 in the Windows CRT or 84 in the JS effect; the original inputs, rejection
checks and golden output stay the same. Other fixtures already using
`IO.temp_dir()` are unchanged.

Run these fixtures through `bun gates/local.ts --filter io_get_env` or
`--filter io_tcp_send_slow_peer`. The gate prints each Windows selection and
records it in the `variants` field of its `--report` JSON output. It copies
the selected fixture unchanged to its private workspace; it does not rewrite
source text or golden output. `gates/test.ts` continues to use the canonical
fixtures for the Unix cluster, even when launched from a Windows machine.

This checkout supports the checker and JavaScript runtime on Windows. The
Windows launcher needs Bun; networking uses Bun's FFI to call Windows Winsock.
It has been tested on Windows x64 with Bun 1.4.2.

From PowerShell in the repository root:

```powershell
.\bend.cmd demos/io_hello_world/main.bend
.\bend.cmd demos/proof_insertion_sort/PROOF.bend
.\bend.cmd tests/io/tcp_spawn.bend
```

The launcher searches for `bun.exe` on PATH, then in `%USERPROFILE%\.bun\bin`,
then in this checkout's `.tmp\bun-windows-x64` (the local downloaded runtime).
You can select another installation explicitly:

```powershell
$env:BEND_BUN = 'C:\path to Bun\bun.exe'
.\bend.cmd --version
```

The launcher preserves your current directory, arguments, and exit status.
It does not install software or modify PATH. The `.tmp` runtime is ignored by
Git; another checkout needs its own Bun installation.

To emit JavaScript, then run it using the local Bun runtime:

```powershell
.\bend.cmd demos/io_hello_world/main.bend -o hello.js
.\.tmp\bun-windows-x64\bun.exe hello.js
```

Use your installed `bun` instead when it is on PATH. File operations and timers
use cross-platform JavaScript APIs. Networking supports the existing IPv4
TCP/UDP interface, nonblocking connects, concurrent computations, and polling.
It requires Bun even for emitted JavaScript. File errors use host errno codes;
socket failures retain Winsock codes, with the scheduler's would-block and
connect-in-progress cases translated internally.

Standalone native `.exe` compilation, native windows/audio, DNS, and TLS are
outside this JavaScript port. `bend update` still uses the upstream Unix
installer; keep this source checkout and its Bun installation updated separately.

Run the Windows regression suite:

```powershell
.\.tmp\bun-windows-x64\bun.exe test tools/windows-paths.test.ts tools/windows-io.test.ts
```

The IO tests execute existing Bend fixtures directly and as emitted JavaScript.
Their Unix fixture paths are redirected to temporary directories. They cover
binary and Unicode files, append and error behavior, positional reads without
moving the file cursor, timer ordering, concurrent TCP clients, TCP backpressure,
UDP polling and truncation, and invalid addresses/ports.
