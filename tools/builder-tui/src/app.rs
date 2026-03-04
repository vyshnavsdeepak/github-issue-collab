use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyModifiers, MouseEvent, MouseEventKind};
use tokio::sync::{mpsc, watch};

use crate::poller::WorkerState;

const LOG_CAP: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    Send,      // typing a prompt for the selected worker
    Broadcast, // typing a prompt for all idle workers
    Command,   // free-form builder command (`:` key)
}

#[derive(Clone, Debug)]
pub enum ToastLevel {
    Info,
    Success,
    Warning,
    Error,
}

#[derive(Clone, Debug)]
pub struct Toast {
    pub message: String,
    pub level: ToastLevel,
    pub expires_at: Instant,
}

pub struct App {
    pub session: String,
    pub workers: Vec<WorkerState>,
    pub selected: usize,
    pub mode: Mode,
    pub input: String,
    pub status_msg: String,
    pub last_refresh: Instant,
    pub logs: VecDeque<String>,
    pub show_logs: bool,
    pub next_scan_at: Option<Instant>,
    pub toasts: Vec<Toast>,
    pub frame: u64,
    pub is_polling: Arc<AtomicBool>,
    prev_worker_states: HashMap<String, String>,
    rx: watch::Receiver<Vec<WorkerState>>,
    log_rx: Option<mpsc::UnboundedReceiver<String>>,
    cmd_tx: Option<mpsc::UnboundedSender<String>>,
}

impl App {
    pub fn new(
        session: String,
        rx: watch::Receiver<Vec<WorkerState>>,
        log_rx: Option<mpsc::UnboundedReceiver<String>>,
        is_polling: Arc<AtomicBool>,
        cmd_tx: Option<mpsc::UnboundedSender<String>>,
    ) -> Self {
        Self {
            session,
            workers: Vec::new(),
            selected: 0,
            mode: Mode::Normal,
            input: String::new(),
            status_msg: String::new(),
            last_refresh: Instant::now(),
            logs: VecDeque::with_capacity(LOG_CAP),
            show_logs: false,
            next_scan_at: None,
            toasts: Vec::new(),
            frame: 0,
            is_polling,
            prev_worker_states: HashMap::new(),
            rx,
            log_rx,
            cmd_tx,
        }
    }

    pub fn push_toast(&mut self, msg: &str, level: ToastLevel) {
        let duration = match level {
            ToastLevel::Info | ToastLevel::Success => Duration::from_secs(4),
            ToastLevel::Warning => Duration::from_secs(6),
            ToastLevel::Error => Duration::from_secs(8),
        };
        self.toasts.push(Toast {
            message: msg.to_string(),
            level,
            expires_at: Instant::now() + duration,
        });
        // Keep at most 10 toasts queued
        if self.toasts.len() > 10 {
            self.toasts.remove(0);
        }
    }

    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);

        // Expire old toasts
        let now = Instant::now();
        self.toasts.retain(|t| t.expires_at > now);

        // Pick up latest worker state from poller
        if self.rx.has_changed().unwrap_or(false) {
            let new_workers = self.rx.borrow_and_update().clone();

            // Detect state transitions and emit auto-toasts
            for w in &new_workers {
                if let Some(prev_status) = self.prev_worker_states.get(&w.window_name) {
                    if prev_status != &w.status {
                        let toast = match (prev_status.as_str(), w.status.as_str()) {
                            (prev, "active") if prev != "active" => {
                                Some((format!("{} started working", w.window_name), ToastLevel::Info))
                            }
                            ("active", "done") => {
                                Some((format!("{} has a PR!", w.window_name), ToastLevel::Success))
                            }
                            ("shell", "idle") => {
                                Some((format!("{} Claude relaunched", w.window_name), ToastLevel::Info))
                            }
                            (_, "no-window") => {
                                Some((format!("{} window lost", w.window_name), ToastLevel::Warning))
                            }
                            _ => None,
                        };
                        if let Some((msg, level)) = toast {
                            self.push_toast(&msg, level);
                        }
                    }
                }
            }

            // Update prev states
            self.prev_worker_states.clear();
            for w in &new_workers {
                self.prev_worker_states.insert(w.window_name.clone(), w.status.clone());
            }

            self.workers = new_workers;
            self.last_refresh = Instant::now();

            if !self.workers.is_empty() && self.selected >= self.workers.len() {
                self.selected = self.workers.len() - 1;
            }
        }

        // Drain builder log channel — collect first to avoid borrow issues
        let messages: Vec<String> = if let Some(rx) = &mut self.log_rx {
            let mut buf = Vec::new();
            while let Ok(msg) = rx.try_recv() {
                buf.push(msg);
            }
            buf
        } else {
            Vec::new()
        };

        for msg in messages {
            if let Some(rest) = msg.strip_prefix("__NEXT_SCAN_") {
                if let Some(secs_str) = rest.strip_suffix("__") {
                    if let Ok(secs) = secs_str.parse::<u64>() {
                        self.next_scan_at = Some(Instant::now() + Duration::from_secs(secs));
                    }
                }
            } else if let Some(rest) = msg.strip_prefix("__TOAST_") {
                // Format: __TOAST_<LEVEL>_<message>__
                if let Some(body) = rest.strip_suffix("__") {
                    let parsed = if let Some(m) = body.strip_prefix("INFO_") {
                        Some((ToastLevel::Info, m.to_string()))
                    } else if let Some(m) = body.strip_prefix("SUCCESS_") {
                        Some((ToastLevel::Success, m.to_string()))
                    } else if let Some(m) = body.strip_prefix("WARNING_") {
                        Some((ToastLevel::Warning, m.to_string()))
                    } else if let Some(m) = body.strip_prefix("ERROR_") {
                        Some((ToastLevel::Error, m.to_string()))
                    } else {
                        None
                    };
                    if let Some((level, message)) = parsed {
                        self.push_toast(&message, level);
                    } else {
                        if self.logs.len() >= LOG_CAP {
                            self.logs.pop_front();
                        }
                        self.logs.push_back(msg);
                    }
                }
            } else {
                if self.logs.len() >= LOG_CAP {
                    self.logs.pop_front();
                }
                self.logs.push_back(msg);
            }
        }
    }

    /// Returns true if we should quit
    pub fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) -> bool {
        match &self.mode {
            Mode::Normal => self.handle_normal_key(code, modifiers),
            Mode::Send | Mode::Broadcast | Mode::Command => self.handle_input_key(code),
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
                    self.status_msg =
                        "Send prompt to selected worker (Enter to send, Esc to cancel)".into();
                }
            }
            KeyCode::Char('i') => self.interrupt_selected(),
            KeyCode::Char('b') => {
                self.mode = Mode::Broadcast;
                self.input.clear();
                self.status_msg =
                    "Broadcast to all idle workers (Enter to send, Esc to cancel)".into();
            }
            KeyCode::Char('r') => {
                self.status_msg = "Refreshing…".into();
            }
            KeyCode::Char('l') => {
                self.show_logs = !self.show_logs;
            }
            KeyCode::Char(':') => {
                self.mode = Mode::Command;
                self.input.clear();
                self.status_msg = "Builder command (Enter to send, Esc to cancel)".into();
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
                    Mode::Command => self.execute_command(&text),
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

    fn execute_command(&mut self, text: &str) {
        if text.is_empty() {
            return;
        }
        let preview: String = text.chars().take(40).collect();
        if let Some(tx) = &self.cmd_tx {
            let _ = tx.send(text.to_string());
            self.status_msg = format!("Command sent: {preview}");
            self.push_toast(&format!("Command: {preview}"), ToastLevel::Info);
        } else {
            self.status_msg = "Builder not running (--no-builder)".into();
        }
    }

    // ─── Helpers for UI ───────────────────────────────────────────────────────

    pub fn active_count(&self) -> usize {
        self.workers.iter().filter(|w| w.status == "active").count()
    }

    pub fn idle_count(&self) -> usize {
        self.workers.iter().filter(|w| w.status == "idle").count()
    }

    pub fn queued_count(&self) -> usize {
        self.workers.iter().filter(|w| w.status == "queued").count()
    }

    pub fn last_refresh_secs(&self) -> u64 {
        self.last_refresh.elapsed().as_secs()
    }

    pub fn next_scan_remaining_secs(&self) -> Option<u64> {
        self.next_scan_at.map(|at| {
            at.saturating_duration_since(Instant::now()).as_secs()
        })
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
                return format!("{remaining}s remaining");
            }
        }
        "none".to_string()
    }
}
