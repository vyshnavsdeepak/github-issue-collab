use tokio::sync::watch;

use crate::app::PersonaState;
use crate::config::{Persona, persona_window_name};

pub async fn run(
    session: String,
    tmux: String,
    personas: Vec<Persona>,
    tx: watch::Sender<Vec<PersonaState>>,
) {
    loop {
        let states = poll_persona_states(&session, &tmux, &personas);
        let _ = tx.send(states);
        tokio::time::sleep(tokio::time::Duration::from_secs(2)).await;
    }
}

fn poll_persona_states(session: &str, tmux: &str, personas: &[Persona]) -> Vec<PersonaState> {
    // Get list of existing windows
    let window_names = list_windows(session, tmux);

    personas
        .iter()
        .map(|p| {
            let window_name = persona_window_name(&p.name);
            if !window_names.contains(&window_name) {
                return PersonaState {
                    persona: p.clone(),
                    window_name,
                    status: "no-window".to_string(),
                    last_output: String::new(),
                };
            }

            let pane = capture_pane(session, tmux, &window_name);
            let last_output = last_nonempty_line(&pane);
            let status = classify_state(&pane);

            PersonaState {
                persona: p.clone(),
                window_name,
                status,
                last_output,
            }
        })
        .collect()
}

fn list_windows(session: &str, tmux: &str) -> Vec<String> {
    let Ok(out) = std::process::Command::new(tmux)
        .args(["list-windows", "-t", session, "-F", "#{window_name}"])
        .output()
    else {
        return Vec::new();
    };

    String::from_utf8_lossy(&out.stdout)
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect()
}

fn capture_pane(session: &str, tmux: &str, window_name: &str) -> String {
    let target = format!("{}:{}", session, window_name);
    let Ok(out) = std::process::Command::new(tmux)
        .args(["capture-pane", "-t", &target, "-p"])
        .output()
    else {
        return String::new();
    };
    String::from_utf8_lossy(&out.stdout).to_string()
}

fn last_nonempty_line(content: &str) -> String {
    content
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("")
        .trim()
        .chars()
        .take(80)
        .collect()
}

fn classify_state(pane: &str) -> String {
    let spinner_words = [
        "Crunching",
        "Brewing",
        "Baking",
        "Cogitating",
        "Thinking",
        "Analyzing",
    ];
    let is_active = spinner_words.iter().any(|w| pane.contains(w));

    let has_bypass = pane.contains("bypass permissions on");
    let is_shell = pane.lines().rev().take(5).any(|l| {
        let t = l.trim();
        t.starts_with("vyshnav@") || t.starts_with(">> ") || t == ">>"
    });
    let has_posted = pane.contains("comment") && pane.contains("created");

    if is_active {
        "active".to_string()
    } else if has_posted {
        "done".to_string()
    } else if has_bypass {
        "idle".to_string()
    } else if is_shell {
        "idle".to_string()
    } else {
        "idle".to_string()
    }
}
