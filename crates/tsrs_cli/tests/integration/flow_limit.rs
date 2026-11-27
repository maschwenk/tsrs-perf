use std::process::Command;

#[test]
fn flow_limit_keeps_user_errors_without_changing_default_library_members() {
    let dir = std::env::temp_dir().join(format!("tsrs-library-flow-limit-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let mut source = String::from("const data = [];\n");
    source.push_str(&"data[0] = 0;\n".repeat(2001));
    source.push_str(
        "interface Base { value: number }\ninterface Broken extends Base { value: string }\n",
    );
    std::fs::write(dir.join("mixed.ts"), source).unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_tsrs"))
        .current_dir(&dir)
        .args([
            "--fast",
            "--checkers",
            "4",
            "--strict",
            "--target",
            "es2015",
            "--noEmit",
            "--pretty",
            "false",
            "mixed.ts",
        ])
        .output()
        .unwrap();
    std::fs::remove_dir_all(dir).unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(output.stderr.is_empty(), "{}", String::from_utf8_lossy(&output.stderr));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap().replace("\r\n", "\n"),
        concat!(
            "mixed.ts(1,1): error TS2563: The containing function or module body is too large for control flow analysis.\n",
            "mixed.ts(2004,11): error TS2430: Interface 'Broken' incorrectly extends interface 'Base'.\n",
            "  Types of property 'value' are incompatible.\n",
            "    Type 'string' is not assignable to type 'number'.\n",
        )
    );
}
