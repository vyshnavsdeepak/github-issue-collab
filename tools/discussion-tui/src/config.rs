use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Persona {
    pub name: String,
    pub emoji: String,
    pub system_prompt: String,
}

#[derive(Debug, Clone)]
pub struct Config {
    pub session: String,
    pub repo: String,
    pub tmux: String,
    pub personas_file: String,
}

impl Default for Config {
    fn default() -> Self {
        // personas.json lives alongside the binary
        let personas_file = std::env::current_exe()
            .ok()
            .and_then(|p| p.parent().map(|d| d.join("personas.json")))
            .unwrap_or_else(|| PathBuf::from("personas.json"))
            .to_string_lossy()
            .to_string();

        Self {
            session: "github-discussion".to_string(),
            repo: "vyshnavsdeepak/github-issue-collab".to_string(),
            tmux: "/opt/homebrew/bin/tmux".to_string(),
            personas_file,
        }
    }
}

pub fn default_personas() -> Vec<Persona> {
    vec![
        Persona {
            name: "Product Lead".to_string(),
            emoji: "📋".to_string(),
            system_prompt: "You are a pragmatic product lead. You prioritize user value and business impact. You write clear specs, drive decisions, and focus on what matters most. When reviewing a GitHub issue, give concrete product feedback: clarify requirements, prioritize, and identify success criteria.".to_string(),
        },
        Persona {
            name: "Designer".to_string(),
            emoji: "🎨".to_string(),
            system_prompt: "You are a UX designer focused on clarity, workflow, and visual feedback. When reviewing a GitHub issue, give feedback on user experience: information hierarchy, interaction patterns, accessibility, and visual design considerations.".to_string(),
        },
        Persona {
            name: "Engineer".to_string(),
            emoji: "🔧".to_string(),
            system_prompt: "You are a senior software engineer. You focus on feasibility, architecture, and technical debt. When reviewing a GitHub issue, give technical feedback: implementation approach, potential pitfalls, performance implications, and suggested architecture.".to_string(),
        },
        Persona {
            name: "QA/Skeptic".to_string(),
            emoji: "🔍".to_string(),
            system_prompt: "You are a QA engineer and skeptic. You find edge cases, ask hard questions, and identify what breaks. When reviewing a GitHub issue, give critical feedback: what could go wrong, missing requirements, ambiguous specs, and test scenarios that need to be covered.".to_string(),
        },
    ]
}

pub fn load_personas(path: &str) -> Vec<Persona> {
    match std::fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|_| default_personas()),
        Err(_) => {
            let defaults = default_personas();
            save_personas(path, &defaults);
            defaults
        }
    }
}

pub fn save_personas(path: &str, personas: &[Persona]) {
    if let Ok(json) = serde_json::to_string_pretty(personas) {
        let _ = std::fs::write(path, json);
    }
}

pub fn persona_slug(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

pub fn persona_window_name(name: &str) -> String {
    format!("persona-{}", persona_slug(name))
}
