mod app;
mod builder;
mod config;
mod github;
mod monitor;
mod poller;
mod ui;

use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::Duration;

use app::App;
use config::Config;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use monitor::BackoffState;
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::{Mutex, mpsc, watch};

fn parse_args() -> Config {
    let mut config = Config::default();
    let mut args = std::env::args().skip(1);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" | "-s" => {
                if let Some(v) = args.next() { config.session = v; }
            }
            "--interval" | "-n" => {
                if let Some(v) = args.next() {
                    if let Ok(n) = v.parse() { config.interval_secs = n; }
                }
            }
            "--repo" => {
                if let Some(v) = args.next() { config.repo = v; }
            }
            "--repo-root" => {
                if let Some(v) = args.next() { config.repo_root = v; }
            }
            "--discussion" => {
                if let Some(v) = args.next() {
                    if let Ok(n) = v.parse() { config.discussion_issue = n; }
                }
            }
            "--builder-sleep" => {
                if let Some(v) = args.next() {
                    if let Ok(n) = v.parse() { config.builder_sleep_secs = n; }
                }
            }
            "--max-concurrent" => {
                if let Some(v) = args.next() {
                    if let Ok(n) = v.parse() { config.max_concurrent = n; }
                }
            }
            "--no-builder" => {
                config.run_builder = false;
            }
            _ => {}
        }
    }

    config
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = parse_args();

    if config.run_builder && config.repo_root.is_empty() {
        eprintln!(
            "Error: --repo-root or REPO_ROOT env var required for builder mode.\n\
             Use --no-builder to run in TUI-only mode."
        );
        std::process::exit(1);
    }

    let config = Arc::new(config);

    // Shared polling indicator (set by poller, read by UI)
    let is_polling = Arc::new(AtomicBool::new(false));

    // Merged log channel: both poller and builder write here, App reads
    let (log_tx, log_rx) = mpsc::unbounded_channel::<String>();

    // Channel: poller -> App (worker states)
    let (worker_tx, worker_rx) = watch::channel(Vec::new());

    // Spawn background poller
    {
        let session = config.session.clone();
        let interval = config.interval_secs;
        let repo_root = config.repo_root.clone();
        let is_polling = Arc::clone(&is_polling);
        let log_tx = log_tx.clone();
        tokio::spawn(async move {
            poller::run(session, interval, worker_tx, log_tx, repo_root, is_polling).await;
        });
    }

    // Command channel: App -> builder
    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<String>();

    // Optional builder task
    let cmd_tx_for_app = if config.run_builder {
        let config_clone = Arc::clone(&config);
        let backoff = Arc::new(Mutex::new(BackoffState::new()));
        tokio::spawn(async move {
            builder::run(config_clone, log_tx, backoff, cmd_rx).await;
        });
        Some(cmd_tx)
    } else {
        None
    };

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(
        config.session.clone(),
        worker_rx,
        Some(log_rx),
        is_polling,
        cmd_tx_for_app,
    );

    loop {
        terminal.draw(|f| ui::draw(f, &app))?;

        if event::poll(Duration::from_millis(100))? {
            match event::read()? {
                Event::Key(key) if key.kind == KeyEventKind::Press => {
                    let quit = app.handle_key(key.code, key.modifiers);
                    if quit {
                        break;
                    }
                }
                Event::Mouse(mouse) => {
                    app.handle_mouse(mouse);
                }
                _ => {}
            }
        }

        app.tick();
    }

    // Restore terminal
    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    Ok(())
}
