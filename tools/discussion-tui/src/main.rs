mod app;
mod config;
mod github;
mod poller;
mod runner;
mod ui;

use std::sync::Arc;
use std::time::Duration;

use app::App;
use config::Config;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::{mpsc, watch};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Arc::new(Config::default());

    // Load initial personas
    let personas = config::load_personas(&config.personas_file);

    // Poller -> App channel
    let (persona_tx, persona_rx) = watch::channel(Vec::new());

    // Log channel (runner -> App)
    let (log_tx, log_rx) = mpsc::unbounded_channel::<String>();

    // Run request channel (App -> runner)
    let (run_tx, run_rx) = mpsc::unbounded_channel::<runner::RunRequest>();

    // Spawn poller
    {
        let session = config.session.clone();
        let tmux = config.tmux.clone();
        let personas_clone = personas.clone();
        tokio::spawn(async move {
            poller::run(session, tmux, personas_clone, persona_tx).await;
        });
    }

    // Spawn runner
    {
        let cfg = Arc::clone(&config);
        let log_tx2 = log_tx.clone();
        tokio::spawn(async move {
            runner::dispatch(cfg, run_rx, log_tx2).await;
        });
    }

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(Arc::clone(&config), persona_rx, log_rx, run_tx);

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
