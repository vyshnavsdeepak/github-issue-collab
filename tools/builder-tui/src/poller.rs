use std::collections::HashMap;
use tokio::sync::watch;

#[derive(Debug, Clone, serde::Deserialize, Default)]
pub struct BuilderStatus {
    #[serde(default)]
    pub prs: HashMap<String, String>, // window_name -> PR number
}

#[derive(Debug, Clone)]
pub struct WorkerState {
    pub window_index: usize,
    pub window_name: String,
    pub status: String,  // "active" | "idle" | "shell" | "done" | "unknown"
    pub pr: Option<String>,
    pub last_output: String,
}

pub async fn run(session: String, interval_secs: u64, tx: watch::Sender<Vec<WorkerState>>) {
    loop {
        let states = poll_session(&session);
        let _ = tx.send(states);
        tokio::time::sleep(tokio::time::Duration::from_secs(interval_secs)).await;
    }
}

fn poll_session(session: &str) -> Vec<WorkerState> {
    // Load builder-status.json if present
    let builder_status = load_builder_status();

    // List windows
    let Ok(out) = std::process::Command::new("/opt/homebrew/bin/tmux")
        .args(["list-windows", "-t", session, "-F", "#{window_index} #{window_name}"])
        .output()
    else {
        return Vec::new();
    };

    let windows_text = String::from_utf8_lossy(&out.stdout);
    let mut states = Vec::new();

    for line in windows_text.lines() {
        let mut parts = line.splitn(2, ' ');
        let Some(idx_str) = parts.next() else { continue };
        let Some(name) = parts.next() else { continue };
        let Ok(idx) = idx_str.parse::<usize>() else { continue };

        let pane_content = capture_pane(session, idx);
        let last_output = last_nonempty_line(&pane_content);

        let pr = builder_status.prs.get(name).cloned();

        let status = classify_state(&pane_content, pr.is_some());

        states.push(WorkerState {
            window_index: idx,
            window_name: name.to_string(),
            status,
            pr,
            last_output,
        });
    }

    states
}

fn capture_pane(session: &str, window_index: usize) -> String {
    let target = format!("{}:{}", session, window_index);
    let Ok(out) = std::process::Command::new("/opt/homebrew/bin/tmux")
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

fn classify_state(pane: &str, has_pr: bool) -> String {
    let spinner_words = ["Crunching", "Brewing", "Baking", "Cogitating", "Thinking", "Analyzing"];
    let is_active = spinner_words.iter().any(|w| pane.contains(w));

    let has_bypass = pane.contains("bypass permissions on");
    let is_shell = pane.lines().rev().take(5).any(|l| {
        let t = l.trim();
        t.starts_with("vyshnav@") || t.starts_with(">> ") || t == ">>"
    });
    let is_sleeping = pane.contains("Sleeping ");
    let has_posted = pane.contains("posted a comment");

    if is_active {
        "active".to_string()
    } else if has_posted {
        "posted".to_string()
    } else if is_sleeping {
        "sleeping".to_string()
    } else if has_bypass && has_pr {
        "done".to_string()
    } else if has_bypass {
        "idle".to_string()
    } else if is_shell && has_pr {
        "done".to_string()
    } else if is_shell {
        // Distinguish queued (never launched Claude) from shell (crashed after running)
        let has_claude_trace = pane.contains("claude") || pane.contains("Implement");
        if has_claude_trace {
            "shell".to_string()
        } else {
            "queued".to_string()
        }
    } else {
        "unknown".to_string()
    }
}

fn load_builder_status() -> BuilderStatus {
    let path = "/tmp/builder-status.json";
    let Ok(content) = std::fs::read_to_string(path) else {
        return BuilderStatus::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}
