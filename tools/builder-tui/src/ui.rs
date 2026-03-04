use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Paragraph, Row, Table, TableState},
};

use crate::app::{App, Mode};

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(4), // Header (2 content lines + 2 borders)
            Constraint::Min(5),    // Content (table + optional log)
            Constraint::Length(3), // Footer / input
        ])
        .split(area);

    draw_header(f, app, chunks[0]);

    if app.show_logs {
        let content = Layout::default()
            .direction(Direction::Vertical)
            .constraints([Constraint::Percentage(65), Constraint::Percentage(35)])
            .split(chunks[1]);
        draw_table(f, app, content[0]);
        draw_logs(f, app, content[1]);
    } else {
        draw_table(f, app, chunks[1]);
    }

    draw_footer(f, app, chunks[2]);
}

fn draw_header(f: &mut Frame, app: &App, area: Rect) {
    let backoff = app.backoff_status();
    let refresh_ago = {
        let secs = app.last_refresh_secs();
        if secs < 60 {
            format!("{secs}s ago")
        } else {
            format!("{}m ago", secs / 60)
        }
    };
    let next_scan = match app.next_scan_remaining_secs() {
        Some(s) if s > 0 => format!("{s}s"),
        Some(_) => "now".to_string(),
        None => "—".to_string(),
    };

    let text = vec![
        Line::from(vec![
            Span::styled(
                format!(" Session: {} ", app.session),
                Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD),
            ),
            Span::raw("│ "),
            Span::styled(
                format!("Workers: {} ", app.workers.len()),
                Style::default().fg(Color::White),
            ),
            Span::raw("│ "),
            Span::styled(
                format!("Active: {} ", app.active_count()),
                Style::default().fg(Color::Green),
            ),
            Span::raw("│ "),
            Span::styled(
                format!("Idle: {} ", app.idle_count()),
                Style::default().fg(Color::Yellow),
            ),
            Span::raw("│ "),
            Span::styled(
                format!("Queued: {} ", app.queued_count()),
                Style::default().fg(Color::DarkGray),
            ),
        ]),
        Line::from(vec![
            Span::raw(format!(" Backoff: {backoff}")),
            Span::raw("   "),
            Span::raw(format!("Last scan: {refresh_ago}")),
            Span::raw("   "),
            Span::styled(
                format!("Next scan: {next_scan}"),
                Style::default().fg(Color::Cyan),
            ),
        ]),
    ];

    let block = Block::default()
        .title(" Builder Control Panel ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));

    let para = Paragraph::new(text).block(block);
    f.render_widget(para, area);
}

fn draw_table(f: &mut Frame, app: &App, area: Rect) {
    let header_cells = ["ISSUE", "STATE", "PR", "LAST OUTPUT"]
        .iter()
        .map(|h| {
            Cell::from(*h)
                .style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        });
    let header = Row::new(header_cells).height(1).bottom_margin(0);

    let rows: Vec<Row> = app
        .workers
        .iter()
        .enumerate()
        .map(|(i, w)| {
            let is_selected = i == app.selected;
            let style = if is_selected {
                Style::default()
                    .bg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };

            let marker = if is_selected { "▶" } else { " " };
            let issue_cell = format!("{} {}", marker, w.window_name);
            let state_cell = status_icon(&w.status);
            let pr_cell = w.pr.as_deref().unwrap_or("—").to_string();
            let output_cell = w.last_output.clone();

            Row::new(vec![
                Cell::from(issue_cell).style(style),
                Cell::from(state_cell).style(status_style(&w.status).patch(style)),
                Cell::from(pr_cell).style(style),
                Cell::from(output_cell).style(style),
            ])
        })
        .collect();

    let visible_height = area.height.saturating_sub(3) as usize;
    let scroll_offset = compute_scroll(app.selected, app.workers.len(), visible_height);

    let visible_rows: Vec<Row> = rows
        .into_iter()
        .skip(scroll_offset)
        .take(visible_height)
        .collect();

    let scroll_hint = if app.workers.len() > visible_height {
        format!(" {} rows (j/k or scroll)", app.workers.len())
    } else {
        String::new()
    };

    let table = Table::new(
        visible_rows,
        [
            Constraint::Length(14),
            Constraint::Length(12),
            Constraint::Length(8),
            Constraint::Min(20),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(format!(" Workers{scroll_hint} "))
            .border_style(Style::default().fg(Color::Blue)),
    )
    .row_highlight_style(Style::default().add_modifier(Modifier::BOLD));

    let mut state = TableState::default();
    f.render_stateful_widget(table, area, &mut state);
}

fn draw_logs(f: &mut Frame, app: &App, area: Rect) {
    let visible_lines = area.height.saturating_sub(2) as usize;
    let total = app.logs.len();
    let skip = total.saturating_sub(visible_lines);

    let lines: Vec<Line> = app
        .logs
        .iter()
        .skip(skip)
        .map(|l| Line::from(Span::raw(l.as_str())))
        .collect();

    let para = Paragraph::new(lines).block(
        Block::default()
            .title(" Builder Log ")
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Blue)),
    );
    f.render_widget(para, area);
}

fn draw_footer(f: &mut Frame, app: &App, area: Rect) {
    let (title, content) = match &app.mode {
        Mode::Normal => {
            let hint = " [s] Send  [i] Interrupt  [b] Broadcast  [r] Refresh  [l] Log  [q] Quit";
            let msg = if app.status_msg.is_empty() {
                hint.to_string()
            } else {
                format!("{hint}\n {}", app.status_msg)
            };
            ("Controls".to_string(), msg)
        }
        Mode::Send => {
            let worker_name = app
                .workers
                .get(app.selected)
                .map(|w| w.window_name.as_str())
                .unwrap_or("?");
            (
                format!("Send to {worker_name}"),
                format!(" > {}_", app.input),
            )
        }
        Mode::Broadcast => (
            "Broadcast to idle workers".to_string(),
            format!(" > {}_", app.input),
        ),
    };

    let block = Block::default()
        .title(format!(" {title} "))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));

    let para = Paragraph::new(content).block(block);
    f.render_widget(para, area);
}

fn status_icon(status: &str) -> String {
    match status {
        "active" => "🟢 active".to_string(),
        "idle" => "🟡 idle".to_string(),
        "shell" => "🔴 shell".to_string(),
        "done" => "✅ done".to_string(),
        "queued" => "⏳ queued".to_string(),
        "sleeping" => "💤 sleeping".to_string(),
        "posted" => "✅ posted".to_string(),
        _ => "❓ unknown".to_string(),
    }
}

fn status_style(status: &str) -> Style {
    match status {
        "active" => Style::default().fg(Color::Green),
        "idle" => Style::default().fg(Color::Yellow),
        "shell" => Style::default().fg(Color::Red),
        "done" => Style::default().fg(Color::Gray),
        "queued" => Style::default().fg(Color::DarkGray),
        "sleeping" => Style::default().fg(Color::Blue),
        "posted" => Style::default().fg(Color::Cyan),
        _ => Style::default(),
    }
}

fn compute_scroll(selected: usize, total: usize, visible: usize) -> usize {
    if total <= visible {
        return 0;
    }
    if selected < visible / 2 {
        0
    } else if selected + visible / 2 >= total {
        total - visible
    } else {
        selected - visible / 2
    }
}
