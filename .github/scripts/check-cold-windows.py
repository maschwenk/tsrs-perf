"""Compare fresh native compiler runs against a recorded TypeScript Go oracle."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


LIB = """
interface Array<T> { length: number; [n: number]: T }
interface ReadonlyArray<T> { readonly length: number; readonly [n: number]: T }
interface Boolean {} interface Function {} interface CallableFunction {}
interface NewableFunction {} interface IArguments {} interface Number {}
interface Object {} interface RegExp {} interface String {}
""".strip()

MODEL = (
    "/** fenêtre 🪟\r\n * début\u2028 * 終\u2029 */\r\n"
    "export interface Cell<T> { get value(): T; set value(v: T) }\r\n"
    "export type Append<T extends readonly unknown[]> = [first: string, ...T, last: number];\r\n"
    "export const name = 'éclair 🧁';\r\n"
)
ENTRY = (
    "import { type Cell, type Append, name } from './modèle.js';\r\n"
    "export const cell: Cell<string> = { value: name };\r\n"
    "export const tuple: Append<[flag: boolean]> = [name, true, 7];\r\n"
)
BAD = "const label = 'é🍋'; const count: number = label;\r\n"


def file_sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_case(compiler, root, case, flags, fast):
    src = root / "src"
    src.mkdir(parents=True)
    (root / "lib.d.ts").write_bytes(LIB.encode("utf-8"))
    (src / "modèle.ts").write_bytes(MODEL.encode("utf-8"))
    (src / "entry.ts").write_bytes(ENTRY.encode("utf-8"))
    if case == "diagnostic":
        (src / "error.ts").write_bytes(BAD.encode("utf-8"))
    config = {"compilerOptions": {
        "noLib": True, "types": [], "strict": True, "target": "es2022",
        "module": "esnext", "moduleResolution": "bundler", "newLine": "crlf",
        "rootDir": "src", "outDir": "out",
    }, "include": ["lib.d.ts", "src/**/*.ts"]}
    (root / "tsconfig.json").write_text(json.dumps(config), encoding="utf-8")
    env = dict(os.environ, TSRS_FAST=str(int(fast)))
    proc = subprocess.run([compiler, "-p", ".", "--pretty", "false", "--incremental",
                           "false", *flags], cwd=root, env=env, capture_output=True, timeout=60)
    output = {p.relative_to(root / "out").as_posix(): file_sha(p)
              for p in sorted((root / "out").rglob("*")) if p.is_file()}
    return {"exit": proc.returncode, "stdout": proc.stdout.decode("utf-8").replace("\r\n", "\n"),
            "stderr": proc.stderr.decode("utf-8").replace("\r\n", "\n"), "files": output}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("compiler", type=Path)
    parser.add_argument("oracle", type=Path)
    parser.add_argument("--record", action="store_true")
    args = parser.parse_args()
    compiler = args.compiler.resolve(strict=True)
    cases = {"check": ["--noEmit"], "diagnostic": ["--noEmit"],
             "declarations": ["--declaration", "--emitDeclarationOnly", "--declarationMap"],
             "full": ["--declaration", "--declarationMap", "--sourceMap", "--inlineSources"]}
    expected = {} if args.record else json.loads(args.oracle.read_text(encoding="utf-8"))
    with tempfile.TemporaryDirectory(prefix="tsrs-compiler-") as temporary:
        for fast in ([False] if args.record else [False, True]):
            for name, flags in cases.items():
                result = run_case(compiler, Path(temporary) / f"{name}-{int(fast)}", name, flags, fast)
                if args.record:
                    expected[name] = result
                    assert result["exit"] == (2 if name == "diagnostic" else 0)
                    assert len(result["files"]) == {"check": 0, "diagnostic": 0, "declarations": 4, "full": 8}[name]
                    assert name != "diagnostic" or "TS2322" in result["stdout"]
                elif result != expected[name]:
                    raise SystemExit(f"Mismatch in {name}, fast {fast}:\n"
                                     + json.dumps({"observed": result, "expected": expected[name]},
                                                  ensure_ascii=False, indent=2))
                print(f"{name} fast={int(fast)} exit={result['exit']} files={len(result['files'])}")
    if args.record:
        args.oracle.write_bytes((json.dumps(expected, indent=2, ensure_ascii=False) + "\n").encode("utf-8"))


if __name__ == "__main__":
    main()
