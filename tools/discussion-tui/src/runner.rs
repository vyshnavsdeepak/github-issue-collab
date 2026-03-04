use std::sync::Arc;

use tokio::sync::mpsc;

use crate::config::{Config, Persona, persona_slug, persona_window_name};
use crate::github::get_issue_thread;

pub enum RunRequest {
    All { issue_num: u64 },
    One { window_name: String, issue_num: u64 },
}

pub async fn dispatch(
    config: Arc<Config>,
    mut run_rx: mpsc::UnboundedReceiver<RunRequest>,
    log_tx: mpsc::UnboundedSender<String>,
) {
    while let Some(req) = run_rx.recv().await {
        match req {
            RunRequest::All { issue_num } => {
                let thread = match get_issue_thread(&config.repo, issue_num).await {
                    Ok(t) => t,
                    Err(e) => {
                        let _ = log_tx.send(format!("__TOAST_ERROR_Failed to fetch issue #{issue_num}: {e}__"));
                        continue;
                    }
                };

                // Load current personas from file
                let personas = crate::config::load_personas(&config.personas_file);
                let _ = log_tx.send(format!(
                    "__TOAST_INFO_Running {} personas on #{}__",
                    personas.len(),
                    issue_num
                ));

                for persona in personas {
                    let cfg = Arc::clone(&config);
                    let thread_clone = thread.clone();
                    let log_tx2 = log_tx.clone();
                    tokio::spawn(async move {
                        run_persona(cfg, persona, issue_num, &thread_clone, log_tx2).await;
                    });
                }
            }
            RunRequest::One {
                window_name,
                issue_num,
            } => {
                let thread = match get_issue_thread(&config.repo, issue_num).await {
                    Ok(t) => t,
                    Err(e) => {
                        let _ = log_tx.send(format!("__TOAST_ERROR_Failed to fetch issue #{issue_num}: {e}__"));
                        continue;
                    }
                };

                let personas = crate::config::load_personas(&config.personas_file);
                let persona = personas
                    .into_iter()
                    .find(|p| persona_window_name(&p.name) == window_name);

                if let Some(persona) = persona {
                    let cfg = Arc::clone(&config);
                    let log_tx2 = log_tx.clone();
                    tokio::spawn(async move {
                        run_persona(cfg, persona, issue_num, &thread, log_tx2).await;
                    });
                } else {
                    let _ = log_tx.send(format!(
                        "__TOAST_WARNING_No persona found for window {window_name}__"
                    ));
                }
            }
        }
    }
}

async fn run_persona(
    config: Arc<Config>,
    persona: Persona,
    issue_num: u64,
    thread: &str,
    log_tx: mpsc::UnboundedSender<String>,
) {
    let window = persona_window_name(&persona.name);
    let slug = persona_slug(&persona.name);
    let out_file = format!("/tmp/discussion-{slug}-{issue_num}.txt");

    let _ = log_tx.send(format!(
        "__TOAST_INFO_Starting {} on #{}__",
        persona.emoji, issue_num
    ));

    // Ensure session exists (ok if already exists)
    let _ = std::process::Command::new(&config.tmux)
        .args(["new-session", "-d", "-s", &config.session])
        .output();

    // Kill old window if it exists (ignore errors)
    let _ = std::process::Command::new(&config.tmux)
        .args([
            "kill-window",
            "-t",
            &format!("{}:{window}", config.session),
        ])
        .output();

    // Create new window
    let new_win_result = std::process::Command::new(&config.tmux)
        .args([
            "new-window",
            "-t",
            &config.session,
            "-n",
            &window,
        ])
        .output();

    if new_win_result.is_err() {
        let _ = log_tx.send(format!(
            "__TOAST_ERROR_Failed to create tmux window for {}__",
            persona.name
        ));
        return;
    }

    let prompt = build_prompt(&persona, issue_num, thread);
    let escaped = prompt.replace('\'', "'\\''");

    let cmd = format!(
        "unset CLAUDECODE && claude --dangerously-skip-permissions --print '{escaped}' | tee '{out_file}' && gh issue comment {issue_num} --repo {repo} --body-file '{out_file}'",
        repo = config.repo
    );

    let target = format!("{}:{window}", config.session);
    let _ = std::process::Command::new(&config.tmux)
        .args(["send-keys", "-t", &target, &cmd, "Enter"])
        .output();

    let _ = log_tx.send(format!(
        "{} {} launched for #{}",
        persona.emoji, persona.name, issue_num
    ));
}

fn build_prompt(persona: &Persona, issue_num: u64, thread: &str) -> String {
    format!(
        "{}\n\nGitHub issue #{}:\n\n{}\n\nWrite your response as a GitHub comment (markdown). Be concise. Output ONLY the comment body.",
        persona.system_prompt, issue_num, thread
    )
}
