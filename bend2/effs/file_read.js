// File
// ====

function file_read(file, max) {
  return io_file_read(file, max, null, false);
}

function file_read_bytes(file, max) {
  return io_file_read(file, max, null, true);
}

function file_read_at(file, offset, max) {
  return io_file_read(file, max, Number(offset), true);
}
