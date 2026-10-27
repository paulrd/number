SHELL := /bin/bash
FDEV ?= $(HOME)/.local/bin/fdev
FREENET ?= $(HOME)/.local/bin/freenet
UI := ui
CONTRACT := contract
DELEGATE := delegate

.PHONY: all build check test contract delegate ui dev node publish-delegate verify-merge clean

all: build

build:
	FDEV=$(FDEV) ./scripts/build.sh
	cd $(UI) && npm run build

check:
	cd $(CONTRACT) && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
	cd $(DELEGATE) && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
	cd $(UI) && npm run build && npm test

contract:
	cd $(CONTRACT) && CARGO_TARGET_DIR=$$PWD/target $(FDEV) build --features contract

delegate:
	cd $(DELEGATE) && CARGO_TARGET_DIR=$$PWD/target $(FDEV) build --package-type delegate

ui:
	cd $(UI) && npm run build

dev:
	cd $(UI) && npm run dev

# Local node on the default ports (7509 WS API, 31337 network).
# Use `freenet local` for a loopback-only node; see the local-dev skill.
node:
	$(FREENET) local

# Publish the delegate to the node the UI talks to (default port 7509).
publish-delegate:
	$(FDEV) publish --code $(DELEGATE)/build/freenet/number-delegate delegate

# Merge-law corpus check (contract crate example generates it).
verify-merge: contract
	rm -rf /tmp/opencode/number-corpus
	cd $(CONTRACT) && cargo run --example gen_corpus -- /tmp/opencode/number-corpus
	$(FDEV) verify-merge \
	  --wasm $(CONTRACT)/target/wasm32-unknown-unknown/release/number_contract.wasm \
	  --params /tmp/opencode/number-corpus/params.bin \
	  --state /tmp/opencode/number-corpus/s1.bin \
	  --state /tmp/opencode/number-corpus/s2.bin \
	  --state /tmp/opencode/number-corpus/s3.bin \
	  --transition /tmp/opencode/number-corpus/s1.bin /tmp/opencode/number-corpus/s2.bin \
	  --transition /tmp/opencode/number-corpus/s2.bin /tmp/opencode/number-corpus/s3.bin

clean:
	cd $(CONTRACT) && cargo clean
	cd $(DELEGATE) && cargo clean
	rm -rf $(UI)/dist $(UI)/node_modules
	rm -f $(UI)/contract_code_hash*.json $(UI)/contract_code_hash.txt \
	      $(UI)/delegate_key*.json $(UI)/delegate_key.txt $(UI)/public/number_contract.wasm
