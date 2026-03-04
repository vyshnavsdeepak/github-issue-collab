SESSION := github-proj-leads-discussion

build:
	cargo build --release

run: build
	./target/release/discussion-tui

restart: build
	/opt/homebrew/bin/tmux send-keys -t "$(SESSION):6" "q" ""
	sleep 1
	/opt/homebrew/bin/tmux send-keys -t "$(SESSION):6" "$(CURDIR)/target/release/discussion-tui" Enter
