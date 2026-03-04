use crossterm::event::{KeyCode, KeyModifiers, MouseEvent, MouseEventKind};
use tokio::sync::watch;

use crate::poller::WorkerState;

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    Send,      // typing a prompt for the selected worker
    Broadcast, // typing a prompt for all idle workers
}

pub struct App {
    pub session: String,
    pub workers: Vec<WorkerState>,
    pub selected: usize,
    pub mode: Mode,
    pub input: String,
    pub status_msg: String,
    pub last_refresh: std::time::Instant,
    rx: watch::Receiver<Vec<WorkerState>>,
}

impl App {
    pub fn new(session: String, rx: watch::Receiver<Vec<WorkerState>>) -> Self {
        Self {
            session,
            workers: Vec::new(),
            selected: 0,
            mode: Mode::Normal,
            input: String::new(),
            status_msg: String::new(),
            last_refresh: std::time::Instant::now(),
            rx,
        }
    }

    pub fn tick(&mut self) {
        // Check if poller has new state
        if self.rx.has_changed().unwrap_or(false) {
            let new_workers = self.rx.borrow_and_update().clone();
            self.workers = new_workers;
            self.last_refresh = std::time::Instant::now();

            // Clamp selection
            if !self.workers.is_empty() && self.selected >= self.workers.len() {
                self.selected = self.workers.len() - 1;
            }
        }
    }

    /// Returns true if we should quit
    pub fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) -> bool {
        match &self.mode {
            Mode::Normal => self.handle_normal_key(code, modifiers),
            Mode::Send | Mode::Broadcast => self.handle_input_key(code),
        }
    }

    fn handle_normal_key(&mut self, code: KeyCode, _modifiers: KeyModifiers) -> bool {
        match code {
            KeyCode::Char('q') | KeyCode::Esc => return true,
            KeyCode::Char('j') | KeyCode::Down => self.select_next(),
            KeyCode::Char('k') | KeyCode::Up => self.select_prev(),
            KeyCode::Char('s') => {
                if !self.workers.is_empty() {
                    self.mode = Mode::Send;
                    self.input.clear();
                    self.status_msg = "Send prompt to selected worker (Enter to send, Esc to cancel)".into();
                }
            }
            KeyCode::Char('i') => self.interrupt_selected(),
            KeyCode::Char('b') => {
                self.mode = Mode::Broadcast;
                self.input.clear();
                self.status_msg = "Broadcast to all idle workers (Enter to send, Esc to cancel)".into();
            }
            KeyCode::Char('r') => {
                self.status_msg = "Refreshing…".into();
            }
            _ => {}
        }
        false
    }

    fn handle_input_key(&mut self, code: KeyCode) -> bool {
        match code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
                self.input.clear();
                self.status_msg.clear();
            }
            KeyCode::Enter => {
                let text = self.input.clone();
                match &self.mode {
                    Mode::Send => self.send_to_selected(&text),
                    Mode::Broadcast => self.broadcast(&text),
                    Mode::Normal => {}
                }
                self.mode = Mode::Normal;
                self.input.clear();
            }
            KeyCode::Backspace => {
                self.input.pop();
            }
            KeyCode::Char(c) => {
                self.input.push(c);
            }
            _ => {}
        }
        false
    }

    pub fn handle_mouse(&mut self, event: MouseEvent) {
        match event.kind {
            MouseEventKind::ScrollDown => self.select_next(),
            MouseEventKind::ScrollUp => self.select_prev(),
            _ => {}
        }
    }

    fn select_next(&mut self) {
        if self.workers.is_empty() {
            return;
        }
        if self.selected + 1 < self.workers.len() {
            self.selected += 1;
        }
    }

    fn select_prev(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    fn interrupt_selected(&mut self) {
        if let Some(w) = self.workers.get(self.selected) {
            let target = format!("{}:{}", self.session, w.window_index);
            let result = std::process::Command::new("/opt/homebrew/bin/tmux")
                .args(["send-keys", "-t", &target, "C-c", ""])
                .output();
            match result {
                Ok(_) => self.status_msg = format!("Sent C-c to window {}", w.window_name),
                Err(e) => self.status_msg = format!("Error: {e}"),
            }
        }
    }

    fn send_to_selected(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        if let Some(w) = self.workers.get(self.selected) {
            let target = format!("{}:{}", self.session, w.window_index);
            let result = std::process::Command::new("/opt/homebrew/bin/tmux")
                .args(["send-keys", "-t", &target, text, "Enter"])
                .output();
            match result {
                Ok(_) => self.status_msg = format!("Sent to window {}", w.window_name),
                Err(e) => self.status_msg = format!("Error: {e}"),
            }
        }
    }

    fn broadcast(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let idle_windows: Vec<(usize, String)> = self
            .workers
            .iter()
            .filter(|w| w.status == "idle")
            .map(|w| (w.window_index, w.window_name.clone()))
            .collect();

        let count = idle_windows.len();
        let mut errors = 0usize;
        for (idx, _name) in idle_windows {
            let target = format!("{}:{}", self.session, idx);
            if std::process::Command::new("/opt/homebrew/bin/tmux")
                .args(["send-keys", "-t", &target, text, "Enter"])
                .output()
                .is_err()
            {
                errors += 1;
            }
        }
        if errors == 0 {
            self.status_msg = format!("Broadcast to {count} idle workers");
        } else {
            self.status_msg = format!("Broadcast done ({errors} errors)");
        }
    }

    // Helpers for UI
    pub fn active_count(&self) -> usize {
        self.workers.iter().filter(|w| w.status == "active").count()
    }

    pub fn idle_count(&self) -> usize {
        self.workers.iter().filter(|w| w.status == "idle").count()
    }

    pub fn last_refresh_secs(&self) -> u64 {
        self.last_refresh.elapsed().as_secs()
    }

    pub fn backoff_status(&self) -> String {
        let path = std::path::Path::new("/tmp/rl-backoff-until.txt");
        if let Ok(content) = std::fs::read_to_string(path) {
            let ts: i64 = content.trim().parse().unwrap_or(0);
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs() as i64;
            let remaining = ts - now;
            if remaining > 0 {
                return format!("{}s remaining", remaining);
            }
        }
        "none".to_string()
    }
}
