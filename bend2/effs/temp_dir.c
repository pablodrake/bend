// IO
// ==

// The directory for temporary files, without a trailing separator except
// at a root. Windows paths are UTF-16; io_str always receives UTF-8.
#ifdef _WIN32
#include <windows.h>
#endif

Term io_temp_dir_run(Env e, Term* f, IoWork* w) {
#ifdef _WIN32
  DWORD cap = MAX_PATH + 1;
  WCHAR* path = io_mem(malloc(cap * sizeof(WCHAR)));
  DWORD n;
  for (;;) {
    n = GetTempPathW(cap, path);
    if (n == 0) err_fail("GetTempPathW failed");
    if (n < cap) break;
    cap = n + 1;
    path = io_mem(realloc(path, cap * sizeof(WCHAR)));
  }
  while (n > 1 && (path[n - 1] == '\\' || path[n - 1] == '/')) {
    // C:\ and \\?\C:\ are roots; C: instead means the drive's current dir.
    if ((n == 3 && path[1] == ':')
      || (n == 7 && path[0] == '\\' && path[1] == '\\'
        && path[2] == '?' && path[3] == '\\' && path[5] == ':')) break;
    n -= 1;
  }
  int bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
    path, (int)n, NULL, 0, NULL, NULL);
  if (bytes == 0) err_fail("temporary path is not valid Unicode");
  char* text = io_mem(malloc((size_t)bytes));
  if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
      path, (int)n, text, bytes, NULL, NULL) != bytes) {
    err_fail("temporary path conversion failed");
  }
  Term out = io_str(e, text, (u64)bytes);
  free(text);
  free(path);
  return out;
#else
  const char* dir = getenv("TMPDIR");
  if (dir == NULL || dir[0] == '\0') {
    dir = "/tmp";
  }
  size_t n = strlen(dir);
  while (n > 1 && dir[n - 1] == '/') {
    n -= 1;
  }
  return io_str(e, dir, n);
#endif
}

static void __attribute__((constructor)) io_temp_dir_use(void) {
  io_eff(CID_IO_TEMP_DIR, io_temp_dir_run, 0);
}
