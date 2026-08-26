fn main() -> anyhow::Result<()> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if arguments.as_slice() == ["--version"] {
        println!("adobepy-bootstrap-helper/1");
        return Ok(());
    }
    if arguments.as_slice() == ["--ordinary-panic"] {
        adobepy_broker::bootstrap_transaction::install_sensitive_panic_hook();
        panic!("ORDINARY_PANIC_HOOK_MARKER");
    }
    if let [flag, millis] = arguments.as_slice() {
        if flag == "--hold-ms" {
            let millis = millis.parse::<u64>()?;
            std::thread::sleep(std::time::Duration::from_millis(millis));
            return Ok(());
        }
    }
    if !arguments.is_empty() {
        anyhow::bail!("unsupported bootstrap helper arguments");
    }
    adobepy_broker::run_bootstrap_helper_stdio()
}
