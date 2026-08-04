use adobepy_broker::{run_broker, BrokerConfig};
use adobepy_protocol::HostKind;
use anyhow::{bail, Context, Result};
use clap::{Args, Parser, Subcommand, ValueEnum};
use serde_json::json;
use std::env;
use std::fs;
use std::io::ErrorKind;
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug, Parser)]
#[command(name = "adobepy")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Debug, Subcommand)]
enum Commands {
    Broker(BrokerArgs),
    Doctor(DoctorArgs),
    InstallBridge(InstallBridgeArgs),
    Repl(ReplArgs),
}

#[derive(Debug, Args)]
struct BrokerArgs {
    #[arg(long, default_value = "127.0.0.1:47391")]
    bind: SocketAddr,
    #[arg(long, env = "ADOBEPY_TOKEN")]
    token: Option<String>,
    #[arg(long, default_value_t = 30_000)]
    default_timeout_ms: u64,
}

#[derive(Debug, Args)]
struct DoctorArgs {
    #[arg(long, default_value = "127.0.0.1:47391")]
    broker: SocketAddr,
    #[arg(long, env = "ADOBEPY_PYTHON")]
    python: Option<PathBuf>,
    #[arg(long, env = "ADOBEPY_PYTHON_HOME")]
    python_home: Option<PathBuf>,
    #[arg(long)]
    json: bool,
}

#[derive(Debug, Args)]
struct InstallBridgeArgs {
    host: String,
    #[arg(long)]
    dest: PathBuf,
    #[arg(long, value_enum, default_value_t = BridgeInstallKind::Auto)]
    kind: BridgeInstallKind,
    #[arg(long, env = "ADOBEPY_BROKER_URL")]
    broker_url: Option<String>,
    #[arg(long, env = "ADOBEPY_TOKEN")]
    token: String,
    #[arg(long, default_value = "default")]
    target: String,
    #[arg(long, help = "Print machine-readable installation metadata")]
    json: bool,
}

#[derive(Debug, Clone, Copy, ValueEnum)]
enum BridgeInstallKind {
    Auto,
    Uxp,
    Cep,
}

#[derive(Debug, Args)]
struct ReplArgs {
    #[arg(long, default_value = "photoshop")]
    host: String,
    #[arg(long, default_value = "http://127.0.0.1:47391")]
    broker_url: String,
    #[arg(long, env = "ADOBEPY_TOKEN")]
    token: String,
    #[arg(long, env = "ADOBEPY_PYTHON")]
    python: Option<PathBuf>,
    #[arg(long, env = "ADOBEPY_PYTHON_HOME")]
    python_home: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt().init();
    match Cli::parse().command {
        Commands::Broker(args) => {
            let token = args
                .token
                .unwrap_or_else(|| format!("dev-{}", Uuid::new_v4().simple()));
            eprintln!("ADOBEPY_TOKEN={token}");
            run_broker(BrokerConfig {
                bind: args.bind,
                token,
                default_timeout_ms: args.default_timeout_ms,
            })
            .await
        }
        Commands::Doctor(args) => doctor(args),
        Commands::InstallBridge(args) => install_bridge(args),
        Commands::Repl(args) => repl(args),
    }
}

fn doctor(args: DoctorArgs) -> Result<()> {
    let repo_root = find_repo_root();
    let checks = vec![
        json!({"name": "broker_port", "ok": TcpStream::connect_timeout(&args.broker, Duration::from_millis(250)).is_ok(), "detail": args.broker.to_string()}),
        python_runtime_check(
            repo_root.as_deref(),
            args.python.as_deref(),
            args.python_home.as_deref(),
        ),
        command_check("node", &["--version"]),
        command_check("npm", &["--version"]),
        json!({"name": "bridge_templates", "ok": repo_root.as_ref().is_some_and(|root| root.join("bridges").is_dir()), "detail": repo_root.as_ref().map(|path| path.display().to_string()).unwrap_or_else(|| "repository root not found".to_owned())}),
    ];
    if args.json {
        println!("{}", serde_json::to_string_pretty(&checks)?);
    } else {
        for check in checks {
            let ok = check["ok"].as_bool().unwrap_or(false);
            println!(
                "{:>4}  {:<18} {}",
                if ok { "ok" } else { "warn" },
                check["name"].as_str().unwrap_or("unknown"),
                check["detail"].as_str().unwrap_or("")
            );
        }
    }
    Ok(())
}

fn command_check(program: &str, args: &[&str]) -> serde_json::Value {
    match run_command(program, args) {
        Ok(output) => {
            let detail = String::from_utf8_lossy(if output.stdout.is_empty() {
                &output.stderr
            } else {
                &output.stdout
            })
            .trim()
            .to_owned();
            json!({"name": program, "ok": output.status.success(), "detail": detail})
        }
        Err(error) => json!({"name": program, "ok": false, "detail": error.to_string()}),
    }
}

fn run_command(program: &str, args: &[&str]) -> std::io::Result<std::process::Output> {
    let result = Command::new(program)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    if cfg!(windows) && matches!(result, Err(ref error) if error.kind() == ErrorKind::NotFound) {
        return Command::new(format!("{program}.cmd"))
            .args(args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output();
    }
    result
}

fn python_runtime_check(
    repo_root: Option<&Path>,
    explicit_python: Option<&Path>,
    python_home: Option<&Path>,
) -> serde_json::Value {
    let runtime = match (repo_root, explicit_python, python_home) {
        (Some(root), _, _) => resolve_python_runtime(root, explicit_python, python_home),
        (None, Some(python), _) => validate_python_command(python),
        (None, None, Some(home)) => find_python_in_home(home),
        (None, None, None) => Ok(PathBuf::from("python")),
    };
    match runtime {
        Ok(program) => match Command::new(&program)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .output()
        {
            Ok(output) => {
                json!({"name": "python_runtime", "ok": output.status.success(), "detail": program.display().to_string()})
            }
            Err(error) => {
                json!({"name": "python_runtime", "ok": false, "detail": error.to_string()})
            }
        },
        Err(error) => json!({"name": "python_runtime", "ok": false, "detail": error.to_string()}),
    }
}

fn install_bridge(args: InstallBridgeArgs) -> Result<()> {
    if args.token.trim().is_empty() {
        bail!("ADOBEPY_TOKEN is required; pass --token or set ADOBEPY_TOKEN to the broker token");
    }
    let host: HostKind = args.host.parse()?;
    let kind = match args.kind {
        BridgeInstallKind::Auto => match host {
            HostKind::Photoshop | HostKind::InDesign | HostKind::Premiere => BridgeInstallKind::Uxp,
            HostKind::AfterEffects | HostKind::Illustrator => BridgeInstallKind::Cep,
            _ => bail!("no default bridge template is available for {host} yet"),
        },
        explicit => explicit,
    };
    let root = find_repo_root().context("could not find repository root containing bridges/")?;
    let source = match kind {
        BridgeInstallKind::Auto => unreachable!(),
        BridgeInstallKind::Uxp => root.join("bridges").join("uxp").join(host.as_str()),
        BridgeInstallKind::Cep => root.join("bridges").join("cep").join(host.as_str()),
    };
    copy_dir_all(&source, &args.dest)?;
    write_bridge_config(
        &args.dest,
        host,
        args.broker_url.as_deref(),
        &args.token,
        &args.target,
    )?;
    if args.json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "success": true,
                "host": host.as_str(),
                "kind": format!("{kind:?}").to_lowercase(),
                "destination": args.dest.display().to_string(),
                "config": args.dest.join("adobepy.config.js").display().to_string(),
                "token_configured": true,
            }))?
        );
    } else {
        println!(
            "installed bridge template for {host} to {} (token configured)",
            args.dest.display()
        );
    }
    Ok(())
}

fn write_bridge_config(
    dest: &Path,
    host: HostKind,
    broker_url: Option<&str>,
    token: &str,
    target: &str,
) -> Result<()> {
    fs::write(
        dest.join("adobepy.config.js"),
        bridge_config_js(host, broker_url, token, target)?,
    )?;
    Ok(())
}

fn bridge_config_js(
    host: HostKind,
    broker_url: Option<&str>,
    token: &str,
    target: &str,
) -> Result<String> {
    let broker_url = serde_json::to_string(&bridge_websocket_url(host, broker_url))?;
    let token = serde_json::to_string(token)?;
    let target = serde_json::to_string(target)?;
    Ok(format!("(function(){{var config={{brokerUrl:{broker_url},token:{token},target:{target}}};globalThis.__ADOBEPY_BROKER_URL=globalThis.__ADOBEPY_BROKER_URL||config.brokerUrl;globalThis.__ADOBEPY_TOKEN=globalThis.__ADOBEPY_TOKEN||config.token;globalThis.__ADOBEPY_TARGET=globalThis.__ADOBEPY_TARGET||config.target;}}());\n"))
}

fn bridge_websocket_url(host: HostKind, broker_url: Option<&str>) -> String {
    let Some(url) = broker_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return format!("ws://127.0.0.1:47391/v1/bridge/{}/ws", host.as_str());
    };
    let converted = if let Some(rest) = url.strip_prefix("http://") {
        format!("ws://{rest}")
    } else if let Some(rest) = url.strip_prefix("https://") {
        format!("wss://{rest}")
    } else {
        url.to_owned()
    };
    if converted.contains("/v1/bridge/") {
        converted
    } else {
        format!(
            "{}/v1/bridge/{}/ws",
            converted.trim_end_matches('/'),
            host.as_str()
        )
    }
}

fn repl(args: ReplArgs) -> Result<()> {
    let host: HostKind = args.host.parse()?;
    let root = find_repo_root().context("could not find repository root")?;
    let python =
        resolve_python_runtime(&root, args.python.as_deref(), args.python_home.as_deref())?;
    let python_path = root.join("python");
    let bootstrap = if host == HostKind::Photoshop {
        format!("from adobe import photoshop\nps = photoshop.connect(broker_url={:?}, token={:?})\nprint('Connected handle: ps')", args.broker_url, args.token)
    } else {
        format!("from adobe.core import connect\nsession = connect({:?}, broker_url={:?}, token={:?})\nprint('Connected handle: session')", host.as_str(), args.broker_url, args.token)
    };
    let existing = env::var_os("PYTHONPATH").unwrap_or_default();
    let mut paths = vec![python_path];
    paths.extend(env::split_paths(&existing));
    let status = Command::new(python)
        .arg("-i")
        .arg("-c")
        .arg(bootstrap)
        .env("PYTHONPATH", env::join_paths(paths)?)
        .status()?;
    if !status.success() {
        bail!("python repl exited with {status}");
    }
    Ok(())
}

fn resolve_python_runtime(
    repo_root: &Path,
    explicit_python: Option<&Path>,
    python_home: Option<&Path>,
) -> Result<PathBuf> {
    if let Some(python) = explicit_python {
        return validate_python_command(python);
    }
    if let Some(home) = python_home {
        return find_python_in_home(home);
    }
    for home in [
        repo_root.join(".adobepy").join("python"),
        repo_root.join(".python"),
    ] {
        if home.is_dir() {
            return find_python_in_home(&home);
        }
    }
    Ok(PathBuf::from("python"))
}

fn validate_python_command(python: &Path) -> Result<PathBuf> {
    if python.components().count() == 1 || python.is_file() {
        Ok(python.to_path_buf())
    } else {
        bail!("python executable does not exist: {}", python.display())
    }
}

fn find_python_in_home(home: &Path) -> Result<PathBuf> {
    let candidates = if cfg!(windows) {
        vec![
            home.join("python.exe"),
            home.join("Scripts").join("python.exe"),
            home.join("bin").join("python.exe"),
        ]
    } else {
        vec![
            home.join("bin").join("python3"),
            home.join("bin").join("python"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .with_context(|| {
            format!(
                "python home {} does not contain a Python executable",
                home.display()
            )
        })
}

fn find_repo_root() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(cwd) = env::current_dir() {
        candidates.push(cwd);
    }
    if let Ok(exe) = env::current_exe() {
        if let Some(parent) = exe.parent() {
            candidates.push(parent.to_path_buf());
        }
    }
    for start in candidates {
        for ancestor in start.ancestors() {
            if ancestor.join("bridges").is_dir() && ancestor.join("python").is_dir() {
                return Some(ancestor.to_path_buf());
            }
        }
    }
    None
}

fn copy_dir_all(source: &Path, dest: &Path) -> Result<()> {
    let source_root = fs::canonicalize(source)?;
    let dest_root = resolve_destination_root(dest)?;
    if dest_root == source_root || dest_root.starts_with(&source_root) {
        bail!(
            "bridge install destination must not be inside the source template: {}",
            dest.display()
        );
    }
    copy_dir_all_inner(&source_root, dest)
}

fn resolve_destination_root(dest: &Path) -> Result<PathBuf> {
    let mut current = dest;
    let mut missing = Vec::new();
    loop {
        if current.exists() {
            let mut resolved = fs::canonicalize(current)?;
            for part in missing.iter().rev() {
                resolved.push(part);
            }
            return Ok(resolved);
        }
        missing.push(
            current
                .file_name()
                .context("bridge install destination must name a directory")?
                .to_os_string(),
        );
        current = current.parent().unwrap_or_else(|| Path::new("."));
    }
}

fn copy_dir_all_inner(source: &Path, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let to = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all_inner(&entry.path(), &to)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), to)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn websocket_url_and_config() {
        assert_eq!(
            bridge_websocket_url(HostKind::Photoshop, None),
            "ws://127.0.0.1:47391/v1/bridge/photoshop/ws"
        );
        assert_eq!(
            bridge_websocket_url(HostKind::Premiere, Some("https://broker")),
            "wss://broker/v1/bridge/premiere/ws"
        );
        assert!(
            bridge_config_js(HostKind::InDesign, Some("http://x"), "tok", "layout")
                .unwrap()
                .contains("__ADOBEPY_TARGET")
        );
    }
}
