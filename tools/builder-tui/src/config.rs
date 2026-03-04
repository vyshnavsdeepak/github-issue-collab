#[derive(Debug, Clone)]
pub struct Config {
    pub session: String,
    pub interval_secs: u64,
    pub repo: String,
    pub repo_root: String,
    pub discussion_issue: u64,
    pub builder_sleep_secs: u64,
    pub max_concurrent: usize,
    pub run_builder: bool,
    pub tmux: String,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            session: "github-builder".to_string(),
            interval_secs: 5,
            repo: "vyshnavsdeepak/github-issue-collab".to_string(),
            repo_root: std::env::var("REPO_ROOT").unwrap_or_default(),
            discussion_issue: 3,
            builder_sleep_secs: 300,
            max_concurrent: 10,
            run_builder: true,
            tmux: "/opt/homebrew/bin/tmux".to_string(),
        }
    }
}
