# Windows variant of tests/io/get_env.bend: HOME is not a standard Windows
# environment variable; PATH is. The absent-variable check is unchanged.
# io (io_get_env): the environment surface: get_env answers Result --
# Done for a set variable, Fail (ENOENT) for an unset one. PATH's
# value is machine-local, so the test prints only which branch
# answered, matching on the Result instead of IO.try-ing it.
import Base

law report:
  for tag : String
  for r   : Result<&1, &1, (U32 & String), String>
  IO(Unit)

def report(tag, r):
  match r:
    case Done{value}:
      IO.print(String.append(tag, "=set"))
    case Fail{error}:
      (code, message) = error
      IO.print(String.append(tag, "=unset"))

law main:
  IO(U32)

def main():
  do IO<U32>:
    a : Result<&1, &1, (U32 & String), String> <- IO.get_env("PATH")
    x : Unit <- report("PATH", a)
    b : Result<&1, &1, (U32 & String), String> <- IO.get_env("BEND_TEST_NO_SUCH_VAR_09AF")
    y : Unit <- report("BEND_TEST_NO_SUCH_VAR_09AF", b)
    return 0

#|PATH=set
#|BEND_TEST_NO_SUCH_VAR_09AF=unset
