use anyhow::{Context, Result, bail};
use tokio::process::Command;

pub async fn run_gh(args: &[&str]) -> Result<String> {
    let out = Command::new("gh")
        .args(args)
        .output()
        .await
        .context("gh command failed")?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        bail!("{}", stderr);
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

pub async fn list_open_issues(repo: &str) -> Result<Vec<(u64, String)>> {
    let out = run_gh(&[
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "open",
        "--json",
        "number,title",
        "-q",
        r##".[] | "#\(.number): \(.title)""##,
    ])
    .await?;

    let mut result = Vec::new();
    for line in out.lines() {
        if let Some(rest) = line.trim().strip_prefix('#') {
            let mut parts = rest.splitn(2, ": ");
            if let (Some(num_str), Some(title)) = (parts.next(), parts.next()) {
                if let Ok(num) = num_str.parse::<u64>() {
                    result.push((num, title.to_string()));
                }
            }
        }
    }
    Ok(result)
}

pub async fn get_issue_thread(repo: &str, issue_num: u64) -> Result<String> {
    let num = issue_num.to_string();
    let jq = r#""=== ISSUE ===\nTitle: " + .title + "\n\n" + .body + "\n\n=== COMMENTS ===\n" + (.comments | map(.author.login + ": " + .body) | join("\n---\n"))"#;
    run_gh(&[
        "issue",
        "view",
        &num,
        "--repo",
        repo,
        "--comments",
        "--json",
        "title,body,comments",
        "-q",
        jq,
    ])
    .await
}

pub async fn post_comment(repo: &str, issue_num: u64, body: &str) -> Result<()> {
    let num = issue_num.to_string();
    run_gh(&[
        "issue",
        "comment",
        &num,
        "--repo",
        repo,
        "--body",
        body,
    ])
    .await?;
    Ok(())
}
