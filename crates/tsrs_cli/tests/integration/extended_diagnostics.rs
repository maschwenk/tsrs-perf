use std::path::Path;
use std::process::Command;

#[test]
fn extended_diagnostics_preserves_the_ordered_checker_counters() {
    let project = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../testdata/regressions/shared-member-layout-accessors");
    let output = Command::new(env!("CARGO_BIN_EXE_tsrs"))
        .current_dir(project)
        .args(["--fast", "--singleThreaded", "--extendedDiagnostics"])
        .output()
        .unwrap();
    assert!(output.status.success(), "{output:?}");
    let stdout = String::from_utf8(output.stdout).unwrap();
    let (_, counters) = stdout.split_once("\nLazy member tables:").unwrap();
    let counters = format!("Lazy member tables:{counters}");
    let rows: Vec<_> = counters
        .lines()
        .map(|line| {
            let (label, value) = line.rsplit_once(':').unwrap();
            (label, value.trim().parse::<u64>().unwrap())
        })
        .collect();
    assert_eq!(
        rows.iter().map(|(label, _)| *label).collect::<Vec<_>>(),
        [
            "Lazy member tables",
            "Lazy member tables resolved in full",
            "Lazy table declared members",
            "Lazy table members instantiated",
            "Lazy member lookups",
            "Lazy signature queries",
            "Lazy index info queries",
            "Lazy every-property queries",
            "Lazy mapped tables",
            "Lazy mapped tables resolved in full",
            "Lazy mapped members created",
            "Lazy mapped member lookups",
            "Lazy mapped index info queries",
            "Mapped signature early returns",
            "somePropertyReducesToNever skips",
            "Lazy tuple tables",
            "Lazy tuple tables resolved in full",
            "Conditional composite mappers avoided",
            "Augmented property cache copies avoided",
            "Augmented lookups served by the other cache",
            "Existence-only property queries",
            "Existence answers from an uninstantiated member",
            "Lazy property-order lists requested",
            "Empty-object queries answered by lazy tables",
        ]
    );
    assert!(rows[0].1 > 0);
}
