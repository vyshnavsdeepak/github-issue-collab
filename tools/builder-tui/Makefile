TMUX    := /opt/homebrew/bin/tmux
SESSION := github-proj-leads-discussion
WINDOW  := 5
TARGET  := ./target/release/builder-tui

.PHONY: build run restart bounce

build:
	cargo build --release

run: build
	$(TARGET)

restart: build
	$(TMUX) send-keys -t "$(SESSION):$(WINDOW)" "q" ""
	sleep 1
	$(TMUX) send-keys -t "$(SESSION):$(WINDOW)" "$(CURDIR)/$(TARGET)" Enter

bounce: restart
