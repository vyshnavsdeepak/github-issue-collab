mod app;
mod poller;
mod ui;

use std::time::Duration;

use app::App;
use crossterm::{
    event::{self, DisableMouseCapture, EnableMouseCapture, Event, KeyEventKind},
    execute,
    terminal::{EnterAlternateScreen, LeaveAlternateScreen, disable_raw_mode, enable_raw_mode},
};
use ratatui::{Terminal, backend::CrosstermBackend};
use tokio::sync::watch;

#[derive(Debug)]
struct Args {
    session: String,
    interval: u64,
}

fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let mut session = "github-builder".to_string();
    let mut interval = 5u64;

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--session" | "-s" => {
                if let Some(v) = args.next() {
                    session = v;
                }
            }
            "--interval" | "-n" => {
                if let Some(v) = args.next() {
                    if let Ok(n) = v.parse() {
                        interval = n;
                    }
                }
            }
            _ => {}
        }
    }

    Args { session, interval }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = parse_args();

    // Channel: poller -> main thread
    let (tx, rx) = watch::channel(Vec::new());

    // Spawn background poller
    let session_clone = args.session.clone();
    tokio::spawn(async move {
        poller::run(session_clone, args.interval, tx).await;
    });

    // Setup terminal
    enable_raw_mode()?;
    let mut stdout = std::io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let mut app = App::new(args.session, rx);

    loop {
        terminal.draw(|f| ui::draw(f, &app))?;

        // Poll for events with a short timeout so we refresh periodically
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

        // Pick up latest state from poller
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
