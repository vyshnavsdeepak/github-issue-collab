use ratatui::{
    Frame,
    layout::{Constraint, Direction, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState},
};

use crate::app::{App, Mode, ToastLevel, AddStep};

const SPINNER: [&str; 10] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

pub fn draw(f: &mut Frame, app: &App) {
    let area = f.area();

    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // Header
            Constraint::Min(5),    // Table
            Constraint::Length(3), // Footer
        ])
        .split(area);

    draw_header(f, app, chunks[0]);
    draw_table(f, app, chunks[1]);
    draw_footer(f, app, chunks[2]);

    draw_toasts(f, app, area);

    match &app.mode {
        Mode::Detail { scroll } => draw_detail_panel(f, app, area, *scroll),
        Mode::SelectIssue { selected } => draw_issue_picker(f, app, area, *selected),
        Mode::EditPersona { .. } => draw_edit_persona(f, app, area),
        Mode::AddPersona { step, input } => draw_add_persona(f, app, area, step, input),
        Mode::Normal => {}
    }
}

fn draw_header(f: &mut Frame, app: &App, area: Rect) {
    let issue_text = match app.issue_num {
        Some(n) => {
            let title: String = app.issue_title.chars().take(40).collect();
            format!("#{n} {title}")
        }
        None => "(no issue selected)".to_string(),
    };

    let active = app.active_count();
    let done = app.done_count();

    let spinner = SPINNER[(app.frame as usize) % SPINNER.len()];
    let active_span = if active > 0 {
        Span::styled(
            format!("{spinner} {active} active"),
            Style::default().fg(Color::Green),
        )
    } else {
        Span::styled("0 active", Style::default().fg(Color::DarkGray))
    };

    let line = Line::from(vec![
        Span::styled(" Issue: ", Style::default().fg(Color::DarkGray)),
        Span::styled(issue_text, Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD)),
        Span::raw("  │  "),
        active_span,
        Span::raw("  "),
        Span::styled(
            format!("{done} done"),
            Style::default().fg(Color::Green),
        ),
        Span::raw("  │  Session: "),
        Span::styled(
            app.config.session.as_str(),
            Style::default().fg(Color::Yellow),
        ),
    ]);

    let block = Block::default()
        .title(" Discussion TUI ")
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));

    let para = Paragraph::new(line).block(block);
    f.render_widget(para, area);
}

fn draw_table(f: &mut Frame, app: &App, area: Rect) {
    let header_cells = ["PERSONA", "STATUS", "LAST OUTPUT"]
        .iter()
        .map(|h| {
            Cell::from(*h).style(Style::default().fg(Color::Cyan).add_modifier(Modifier::BOLD))
        });
    let header = Row::new(header_cells).height(1).bottom_margin(0);

    let rows: Vec<Row> = app
        .personas
        .iter()
        .enumerate()
        .map(|(i, ps)| {
            let is_selected = i == app.selected;
            let style = if is_selected {
                Style::default()
                    .bg(Color::DarkGray)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };

            let marker = if is_selected { "▶" } else { " " };
            let name_cell = format!("{} {} {}", marker, ps.persona.emoji, ps.persona.name);
            let status_cell = status_icon(&ps.status);
            let output_cell = ps.last_output.clone();

            Row::new(vec![
                Cell::from(name_cell).style(style),
                Cell::from(status_cell).style(status_style(&ps.status).patch(style)),
                Cell::from(output_cell).style(style),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [
            Constraint::Length(22),
            Constraint::Length(14),
            Constraint::Min(30),
        ],
    )
    .header(header)
    .block(
        Block::default()
            .borders(Borders::ALL)
            .title(" Personas ")
            .border_style(Style::default().fg(Color::Blue)),
    );

    let mut state = TableState::default();
    f.render_stateful_widget(table, area, &mut state);
}

fn draw_footer(f: &mut Frame, app: &App, area: Rect) {
    let (title, content) = match &app.mode {
        Mode::Normal => {
            let hint = " [i] Issue  [r] Run All  [R] Run One  [d] Detail  [e] Edit  [n] New  [D] Delete  [q] Quit";
            (hint.to_string(), String::new())
        }
        Mode::SelectIssue { .. } => (
            " Issue Picker ".to_string(),
            " [j/k] navigate  [Enter] select  [Esc] cancel".to_string(),
        ),
        Mode::Detail { .. } => (
            " Detail View ".to_string(),
            " [j/k] scroll  [Esc] close".to_string(),
        ),
        Mode::EditPersona { .. } => (
            " Edit Persona Prompt ".to_string(),
            format!(" > {}_ (Enter=save, Esc=cancel)", &app.edit_buffer.chars().rev().take(60).collect::<String>().chars().rev().collect::<String>()),
        ),
        Mode::AddPersona { step, input } => {
            let prompt = match step {
                AddStep::Name => "Persona name",
                AddStep::Emoji => "Emoji (Enter to skip)",
                AddStep::Prompt => "System prompt",
            };
            (
                format!(" Add Persona — {prompt} "),
                format!(" > {input}_"),
            )
        }
    };

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Blue));

    let para = Paragraph::new(content).block(block);
    f.render_widget(para, area);
}

fn draw_detail_panel(f: &mut Frame, app: &App, area: Rect, scroll: usize) {
    let width = (area.width * 9 / 10).max(20);
    let height = (area.height * 4 / 5).max(10);
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    let rect = Rect { x, y, width, height };

    f.render_widget(Clear, rect);

    let ps = app.personas.get(app.selected);
    let name = ps.map(|p| format!("{} {}", p.persona.emoji, p.persona.name)).unwrap_or_else(|| "—".to_string());
    let status = ps.map(|p| p.status.as_str()).unwrap_or("—");

    let content_height = height.saturating_sub(2) as usize;
    let body_lines = content_height.saturating_sub(1);

    let mut lines: Vec<Line> = app
        .detail_content
        .iter()
        .skip(scroll)
        .take(body_lines)
        .map(|l| Line::from(Span::raw(l.as_str())))
        .collect();

    lines.push(Line::from(Span::styled(
        "[j/k] scroll  [Esc] close",
        Style::default().fg(Color::DarkGray),
    )));

    let title = format!(" {name} │ {status} ");
    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Yellow));

    let para = Paragraph::new(lines).block(block);
    f.render_widget(para, rect);
}

fn draw_issue_picker(f: &mut Frame, app: &App, area: Rect, selected: usize) {
    let width = (area.width * 4 / 5).max(40).min(area.width.saturating_sub(4));
    let height = (area.height * 3 / 4).max(10).min(area.height.saturating_sub(4));
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    let rect = Rect { x, y, width, height };

    f.render_widget(Clear, rect);

    if app.issues_loading {
        let para = Paragraph::new("Loading issues...").block(
            Block::default()
                .title(" Select Issue ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan)),
        );
        f.render_widget(para, rect);
        return;
    }

    if app.issues.is_empty() {
        let para = Paragraph::new("No open issues found").block(
            Block::default()
                .title(" Select Issue ")
                .borders(Borders::ALL)
                .border_style(Style::default().fg(Color::Cyan)),
        );
        f.render_widget(para, rect);
        return;
    }

    let visible_height = height.saturating_sub(2) as usize;
    let scroll = compute_scroll(selected, app.issues.len(), visible_height);

    let rows: Vec<Row> = app
        .issues
        .iter()
        .enumerate()
        .skip(scroll)
        .take(visible_height)
        .map(|(i, (num, title))| {
            let is_sel = i == selected;
            let style = if is_sel {
                Style::default().bg(Color::DarkGray).add_modifier(Modifier::BOLD)
            } else {
                Style::default()
            };
            let marker = if is_sel { "▶" } else { " " };
            let max_title = (width as usize).saturating_sub(12);
            let title_trimmed: String = title.chars().take(max_title).collect();
            Row::new(vec![
                Cell::from(format!("{marker} #{num}")).style(style),
                Cell::from(title_trimmed).style(style),
            ])
        })
        .collect();

    let table = Table::new(
        rows,
        [Constraint::Length(10), Constraint::Min(20)],
    )
    .block(
        Block::default()
            .title(format!(" Select Issue ({} open) ", app.issues.len()))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(Color::Cyan)),
    );

    let mut state = TableState::default();
    f.render_stateful_widget(table, rect, &mut state);
}

fn draw_edit_persona(f: &mut Frame, app: &App, area: Rect) {
    let width = (area.width * 4 / 5).max(40).min(area.width.saturating_sub(4));
    let height = (area.height * 3 / 4).max(10).min(area.height.saturating_sub(4));
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    let rect = Rect { x, y, width, height };

    f.render_widget(Clear, rect);

    let ps = app.personas.get(app.selected);
    let name = ps.map(|p| format!("{} {}", p.persona.emoji, p.persona.name)).unwrap_or_default();

    // Word-wrap the edit buffer to fit the width
    let inner_width = (width.saturating_sub(2)) as usize;
    let wrapped = wrap_text(&app.edit_buffer, inner_width);

    let mut lines: Vec<Line> = wrapped
        .iter()
        .map(|l| Line::from(Span::raw(l.as_str())))
        .collect();
    lines.push(Line::from(Span::styled(
        "Enter=save  Esc=cancel",
        Style::default().fg(Color::DarkGray),
    )));

    let block = Block::default()
        .title(format!(" Edit: {name} "))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Magenta));

    let para = Paragraph::new(lines).block(block);
    f.render_widget(para, rect);
}

fn draw_add_persona(f: &mut Frame, _app: &App, area: Rect, step: &AddStep, input: &str) {
    let width = 60u16.min(area.width.saturating_sub(4));
    let height = 5u16;
    let x = area.x + (area.width.saturating_sub(width)) / 2;
    let y = area.y + (area.height.saturating_sub(height)) / 2;
    let rect = Rect { x, y, width, height };

    f.render_widget(Clear, rect);

    let (title, hint) = match step {
        AddStep::Name => (" Add Persona — Name ", "Enter the persona name"),
        AddStep::Emoji => (" Add Persona — Emoji ", "Enter emoji (or Enter to skip)"),
        AddStep::Prompt => (" Add Persona — System Prompt ", "Describe this persona's role and perspective"),
    };

    let lines = vec![
        Line::from(Span::styled(hint, Style::default().fg(Color::DarkGray))),
        Line::from(format!("> {input}_")),
        Line::from(Span::styled("Enter=next  Esc=cancel", Style::default().fg(Color::DarkGray))),
    ];

    let block = Block::default()
        .title(title)
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Green));

    let para = Paragraph::new(lines).block(block);
    f.render_widget(para, rect);
}

fn draw_toasts(f: &mut Frame, app: &App, area: Rect) {
    if app.toasts.is_empty() {
        return;
    }

    const TOAST_WIDTH: u16 = 44;
    const TOAST_HEIGHT: u16 = 3;
    const MAX_VISIBLE: usize = 4;

    let visible: Vec<_> = app.toasts.iter().rev().take(MAX_VISIBLE).collect();
    let total_height = visible.len() as u16 * TOAST_HEIGHT;
    if area.width < TOAST_WIDTH + 2 || area.height < total_height + 2 {
        return;
    }

    let start_x = area.right().saturating_sub(TOAST_WIDTH + 1);
    let start_y = area.y + 1;

    for (i, toast) in visible.iter().enumerate() {
        let y = start_y + i as u16 * TOAST_HEIGHT;
        if y + TOAST_HEIGHT > area.bottom() {
            break;
        }

        let toast_rect = Rect {
            x: start_x,
            y,
            width: TOAST_WIDTH,
            height: TOAST_HEIGHT,
        };

        let (icon, border_color, title) = match toast.level {
            ToastLevel::Success => ("✅", Color::Green, "Done"),
            ToastLevel::Info => ("ℹ", Color::Cyan, "Info"),
            ToastLevel::Warning => ("⚠", Color::Yellow, "Warning"),
            ToastLevel::Error => ("✗", Color::Red, "Error"),
        };

        let max_msg_width = (TOAST_WIDTH as usize).saturating_sub(4);
        let msg: String = toast.message.chars().take(max_msg_width).collect();

        let block = Block::default()
            .title(format!(" {icon} {title} "))
            .borders(Borders::ALL)
            .border_style(Style::default().fg(border_color));

        let para = Paragraph::new(msg).block(block);
        f.render_widget(para, toast_rect);
    }
}

fn status_icon(status: &str) -> String {
    match status {
        "active" => "🟢 active".to_string(),
        "idle" => "🟡 idle".to_string(),
        "done" => "✅ done".to_string(),
        "no-window" => "👻 no-window".to_string(),
        _ => "❓ unknown".to_string(),
    }
}

fn status_style(status: &str) -> Style {
    match status {
        "active" => Style::default().fg(Color::Green),
        "idle" => Style::default().fg(Color::Yellow),
        "done" => Style::default().fg(Color::Gray),
        "no-window" => Style::default().fg(Color::DarkGray),
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

fn wrap_text(text: &str, width: usize) -> Vec<String> {
    if width == 0 {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        if current.is_empty() {
            current.push_str(word);
        } else if current.len() + 1 + word.len() <= width {
            current.push(' ');
            current.push_str(word);
        } else {
            lines.push(current.clone());
            current = word.to_string();
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}
