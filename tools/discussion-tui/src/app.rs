use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyModifiers, MouseEvent, MouseEventKind};
use tokio::sync::{mpsc, watch};

use crate::config::{Config, Persona, load_personas, persona_window_name, save_personas};
use crate::runner::RunRequest;

const LOG_CAP: usize = 200;

#[derive(Debug, Clone, PartialEq)]
pub enum Mode {
    Normal,
    SelectIssue { selected: usize },
    Detail { scroll: usize },
    EditPersona { cursor: usize },
    AddPersona { step: AddStep, input: String },
}

#[derive(Debug, Clone, PartialEq)]
pub enum AddStep {
    Name,
    Emoji,
    Prompt,
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

#[derive(Clone, Debug)]
pub struct PersonaState {
    pub persona: Persona,
    pub window_name: String,
    pub status: String, // "idle" | "active" | "done" | "no-window"
    pub last_output: String,
}

pub struct App {
    pub config: Arc<Config>,
    pub personas: Vec<PersonaState>,
    pub selected: usize,
    pub mode: Mode,
    pub issue_num: Option<u64>,
    pub issue_title: String,
    pub issues: Vec<(u64, String)>,
    pub logs: VecDeque<String>,
    pub toasts: Vec<Toast>,
    pub detail_content: Vec<String>,
    pub frame: u64,
    pub issues_loading: bool,
    rx: watch::Receiver<Vec<PersonaState>>,
    log_rx: mpsc::UnboundedReceiver<String>,
    run_tx: mpsc::UnboundedSender<RunRequest>,
    // Temp state for EditPersona
    pub edit_buffer: String,
    // Temp state for AddPersona
    pub add_name: String,
    pub add_emoji: String,
    pub add_prompt: String,
}

impl App {
    pub fn new(
        config: Arc<Config>,
        rx: watch::Receiver<Vec<PersonaState>>,
        log_rx: mpsc::UnboundedReceiver<String>,
        run_tx: mpsc::UnboundedSender<RunRequest>,
    ) -> Self {
        let personas = load_personas(&config.personas_file)
            .into_iter()
            .map(|p| {
                let window_name = persona_window_name(&p.name);
                PersonaState {
                    persona: p,
                    window_name,
                    status: "no-window".to_string(),
                    last_output: String::new(),
                }
            })
            .collect();

        Self {
            config,
            personas,
            selected: 0,
            mode: Mode::Normal,
            issue_num: None,
            issue_title: String::new(),
            issues: Vec::new(),
            logs: VecDeque::with_capacity(LOG_CAP),
            toasts: Vec::new(),
            detail_content: Vec::new(),
            frame: 0,
            issues_loading: false,
            rx,
            log_rx,
            run_tx,
            edit_buffer: String::new(),
            add_name: String::new(),
            add_emoji: String::new(),
            add_prompt: String::new(),
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
        if self.toasts.len() > 10 {
            self.toasts.remove(0);
        }
    }

    pub fn tick(&mut self) {
        self.frame = self.frame.wrapping_add(1);

        // Expire toasts
        let now = Instant::now();
        self.toasts.retain(|t| t.expires_at > now);

        // Pick up poller updates
        if self.rx.has_changed().unwrap_or(false) {
            let new_states = self.rx.borrow_and_update().clone();
            self.personas = new_states;
            if !self.personas.is_empty() && self.selected >= self.personas.len() {
                self.selected = self.personas.len() - 1;
            }
        }

        // Drain log channel
        let mut messages = Vec::new();
        while let Ok(msg) = self.log_rx.try_recv() {
            messages.push(msg);
        }
        for msg in messages {
            if let Some(rest) = msg.strip_prefix("__TOAST_") {
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
                    }
                }
            } else if msg == "__ISSUES_LOADED__" {
                self.issues_loading = false;
            } else {
                if self.logs.len() >= LOG_CAP {
                    self.logs.pop_front();
                }
                self.logs.push_back(msg);
            }
        }
    }

    pub fn handle_key(&mut self, code: KeyCode, modifiers: KeyModifiers) -> bool {
        match self.mode.clone() {
            Mode::Normal => self.handle_normal_key(code, modifiers),
            Mode::SelectIssue { selected } => self.handle_issue_key(code, selected),
            Mode::Detail { scroll } => self.handle_detail_key(code, scroll),
            Mode::EditPersona { cursor } => self.handle_edit_persona_key(code, cursor),
            Mode::AddPersona { step, input } => self.handle_add_persona_key(code, step, input),
        }
    }

    fn handle_normal_key(&mut self, code: KeyCode, _modifiers: KeyModifiers) -> bool {
        match code {
            KeyCode::Char('q') => return true,
            KeyCode::Char('j') | KeyCode::Down => self.select_next(),
            KeyCode::Char('k') | KeyCode::Up => self.select_prev(),
            KeyCode::Char('i') => {
                // Open issue picker
                self.issues_loading = true;
                self.issues.clear();
                self.mode = Mode::SelectIssue { selected: 0 };
                // Fetch issues async via a background task — we signal via log
                let config = Arc::clone(&self.config);
                let log_tx = self.run_tx.clone();
                // Use a separate channel trick: fetch in background task, post results as toast
                // We'll fetch synchronously for simplicity since it's quick
                let repo = config.repo.clone();
                let rt = tokio::runtime::Handle::current();
                let issues_clone = {
                    let repo2 = repo.clone();
                    rt.block_on(async move {
                        crate::github::list_open_issues(&repo2).await.unwrap_or_default()
                    })
                };
                self.issues = issues_clone;
                self.issues_loading = false;
                let _ = log_tx; // silence warning
            }
            KeyCode::Char('r') => {
                if let Some(issue_num) = self.issue_num {
                    let _ = self.run_tx.send(RunRequest::All { issue_num });
                    self.push_toast("Launching all personas...", ToastLevel::Info);
                } else {
                    self.push_toast("No issue selected — press [i] first", ToastLevel::Warning);
                }
            }
            KeyCode::Char('R') => {
                if let Some(issue_num) = self.issue_num {
                    if let Some(ps) = self.personas.get(self.selected) {
                        let _ = self.run_tx.send(RunRequest::One {
                            window_name: ps.window_name.clone(),
                            issue_num,
                        });
                        self.push_toast(
                            &format!("Launching {} on #{}...", ps.persona.name, issue_num),
                            ToastLevel::Info,
                        );
                    }
                } else {
                    self.push_toast("No issue selected — press [i] first", ToastLevel::Warning);
                }
            }
            KeyCode::Char('d') | KeyCode::Enter => {
                self.detail_content = self.capture_pane_content();
                self.mode = Mode::Detail { scroll: 0 };
            }
            KeyCode::Char('e') => {
                if let Some(ps) = self.personas.get(self.selected) {
                    self.edit_buffer = ps.persona.system_prompt.clone();
                    self.mode = Mode::EditPersona { cursor: self.edit_buffer.len() };
                }
            }
            KeyCode::Char('n') => {
                self.add_name.clear();
                self.add_emoji.clear();
                self.add_prompt.clear();
                self.mode = Mode::AddPersona {
                    step: AddStep::Name,
                    input: String::new(),
                };
            }
            KeyCode::Char('D') => {
                self.delete_selected_persona();
            }
            _ => {}
        }
        false
    }

    fn handle_issue_key(&mut self, code: KeyCode, selected: usize) -> bool {
        match code {
            KeyCode::Char('j') | KeyCode::Down => {
                let new_sel = if selected + 1 < self.issues.len() {
                    selected + 1
                } else {
                    selected
                };
                self.mode = Mode::SelectIssue { selected: new_sel };
            }
            KeyCode::Char('k') | KeyCode::Up => {
                let new_sel = selected.saturating_sub(1);
                self.mode = Mode::SelectIssue { selected: new_sel };
            }
            KeyCode::Enter => {
                if let Some((num, title)) = self.issues.get(selected) {
                    self.issue_num = Some(*num);
                    self.issue_title = title.clone();
                    self.push_toast(&format!("Selected issue #{num}"), ToastLevel::Info);
                }
                self.mode = Mode::Normal;
            }
            KeyCode::Esc => {
                self.mode = Mode::Normal;
            }
            _ => {}
        }
        false
    }

    fn handle_detail_key(&mut self, code: KeyCode, scroll: usize) -> bool {
        match code {
            KeyCode::Char('j') | KeyCode::Down => {
                self.mode = Mode::Detail {
                    scroll: scroll.saturating_add(1),
                };
            }
            KeyCode::Char('k') | KeyCode::Up => {
                self.mode = Mode::Detail {
                    scroll: scroll.saturating_sub(1),
                };
            }
            KeyCode::Esc | KeyCode::Char('q') => {
                self.mode = Mode::Normal;
            }
            _ => {}
        }
        false
    }

    fn handle_edit_persona_key(&mut self, code: KeyCode, cursor: usize) -> bool {
        match code {
            KeyCode::Esc => {
                self.edit_buffer.clear();
                self.mode = Mode::Normal;
            }
            KeyCode::Enter => {
                // Save
                let new_prompt = self.edit_buffer.clone();
                if let Some(ps) = self.personas.get_mut(self.selected) {
                    ps.persona.system_prompt = new_prompt;
                }
                self.persist_personas();
                self.edit_buffer.clear();
                self.mode = Mode::Normal;
                self.push_toast("Persona prompt saved", ToastLevel::Success);
            }
            KeyCode::Backspace => {
                if !self.edit_buffer.is_empty() {
                    self.edit_buffer.pop();
                    let new_cursor = self.edit_buffer.len();
                    self.mode = Mode::EditPersona { cursor: new_cursor };
                }
            }
            KeyCode::Char(c) => {
                self.edit_buffer.push(c);
                let new_cursor = self.edit_buffer.len();
                self.mode = Mode::EditPersona { cursor: new_cursor };
            }
            _ => {
                let _ = cursor;
            }
        }
        false
    }

    fn handle_add_persona_key(&mut self, code: KeyCode, step: AddStep, input: String) -> bool {
        match code {
            KeyCode::Esc => {
                self.mode = Mode::Normal;
            }
            KeyCode::Enter => {
                match step {
                    AddStep::Name => {
                        if !input.is_empty() {
                            self.add_name = input.clone();
                            self.mode = Mode::AddPersona {
                                step: AddStep::Emoji,
                                input: String::new(),
                            };
                        }
                    }
                    AddStep::Emoji => {
                        self.add_emoji = if input.is_empty() {
                            "🤖".to_string()
                        } else {
                            input.clone()
                        };
                        self.mode = Mode::AddPersona {
                            step: AddStep::Prompt,
                            input: String::new(),
                        };
                    }
                    AddStep::Prompt => {
                        let new_persona = Persona {
                            name: self.add_name.clone(),
                            emoji: self.add_emoji.clone(),
                            system_prompt: input.clone(),
                        };
                        let window_name = persona_window_name(&new_persona.name);
                        self.personas.push(PersonaState {
                            persona: new_persona,
                            window_name,
                            status: "no-window".to_string(),
                            last_output: String::new(),
                        });
                        self.persist_personas();
                        self.mode = Mode::Normal;
                        self.push_toast(&format!("Added persona {}", self.add_name), ToastLevel::Success);
                    }
                }
            }
            KeyCode::Backspace => {
                let mut new_input = input;
                new_input.pop();
                self.mode = Mode::AddPersona { step, input: new_input };
            }
            KeyCode::Char(c) => {
                let mut new_input = input;
                new_input.push(c);
                self.mode = Mode::AddPersona { step, input: new_input };
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
        if !self.personas.is_empty() && self.selected + 1 < self.personas.len() {
            self.selected += 1;
        }
    }

    fn select_prev(&mut self) {
        if self.selected > 0 {
            self.selected -= 1;
        }
    }

    fn delete_selected_persona(&mut self) {
        if self.personas.is_empty() {
            return;
        }
        let name = self.personas[self.selected].persona.name.clone();
        self.personas.remove(self.selected);
        if self.selected >= self.personas.len() && self.selected > 0 {
            self.selected -= 1;
        }
        self.persist_personas();
        self.push_toast(&format!("Deleted persona {name}"), ToastLevel::Warning);
    }

    fn persist_personas(&self) {
        let personas: Vec<Persona> = self.personas.iter().map(|ps| ps.persona.clone()).collect();
        save_personas(&self.config.personas_file, &personas);
    }

    fn capture_pane_content(&self) -> Vec<String> {
        let Some(ps) = self.personas.get(self.selected) else {
            return vec!["No persona selected".to_string()];
        };

        let target = format!("{}:{}", self.config.session, ps.window_name);
        let out = std::process::Command::new(&self.config.tmux)
            .args(["capture-pane", "-t", &target, "-p", "-S", "-50"])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_else(|| "(no pane content)\n".to_string());

        out.lines().map(|l| l.to_string()).collect()
    }

    pub fn active_count(&self) -> usize {
        self.personas.iter().filter(|p| p.status == "active").count()
    }

    pub fn done_count(&self) -> usize {
        self.personas.iter().filter(|p| p.status == "done").count()
    }
}
