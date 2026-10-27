SHELL := /bin/bash
FDEV ?= $(HOME)/.local/bin/fdev
FREENET ?= $(HOME)/.local/bin/freenet
WS_PORT ?= 7510
BUILD_DIR ?= .build
UI := ui
CONTRACT := contract
DELEGATE := delegate
CONTRACT_WASM := $(BUILD_DIR)/contract/wasm32-unknown-unknown/release/number_contract.wasm

.PHONY: all build wasm contract delegate check check-artifacts record-artifacts test ui dev node publish-delegate verify-merge e2e-offline e2e-gateway clean

all: build

# Canonical, reproducible build (frozen path remap + --locked) plus the UI.
build:
	FDEV=$(FDEV) ./scripts/build.sh --target-dir $(BUILD_DIR)
	cd $(UI) && npm run build

# WASMs only. `--no-ui` skips node/npm, so CI targets stay dependency-free.
wasm:
	FDEV=$(FDEV) ./scripts/build.sh --target-dir $(BUILD_DIR) --no-ui

contract:
	FDEV=$(FDEV) ./scripts/build.sh --target-dir $(BUILD_DIR) --crate contract --no-ui

delegate:
	FDEV=$(FDEV) ./scripts/build.sh --target-dir $(BUILD_DIR) --crate delegate --no-ui

check:
	cd $(CONTRACT) && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
	cd $(DELEGATE) && cargo fmt --check && cargo clippy --all-targets --locked -- -D warnings && cargo test --locked
	cd $(UI) && npm run build && npm test

# Byte-equality gate: a fresh reproducible build must match published/.
check-artifacts:
	./scripts/check-artifacts.sh

# Record the current build as the published artifact set (refuses to orphan a
# generation that is missing from ui/src/migrations.ts).
record-artifacts:
	FDEV=$(FDEV) ./scripts/record-artifacts.sh

ui:
	cd $(UI) && npm run build

dev:
	cd $(UI) && npm run dev

# Local node on the default ports (7509 WS API, 31337 network).
# Use `freenet local` for a loopback-only node; see the local-dev skill.
node:
	$(FREENET) local

# Publish the delegate to the node the UI talks to, pinned to the webapp id in
# delegate/webapp_contract_id.txt. Re-running this with a changed id/code
# re-keys the delegate and starts a fresh owner identity (board).
publish-delegate: build
	$(FDEV) --port $(WS_PORT) publish \
	  --code $(DELEGATE)/build/freenet/number_delegate \
	  --parameters $(DELEGATE)/webapp_contract_id.bin \
	  delegate

# Merge-law corpus check (contract crate example generates it).
verify-merge: contract
	rm -rf /tmp/opencode/number-corpus
	cd $(CONTRACT) && cargo run --locked --example gen_corpus -- /tmp/opencode/number-corpus
	$(FDEV) verify-merge \
	  --wasm $(CONTRACT_WASM) \
	  --params /tmp/opencode/number-corpus/params.bin \
	  --state /tmp/opencode/number-corpus/s1.bin \
	  --state /tmp/opencode/number-corpus/s2.bin \
	  --state /tmp/opencode/number-corpus/s3.bin \
	  --transition /tmp/opencode/number-corpus/s1.bin /tmp/opencode/number-corpus/s2.bin \
	  --transition /tmp/opencode/number-corpus/s2.bin /tmp/opencode/number-corpus/s3.bin

# Offline browser smoke: real built UI + mock backend, no Freenet node.
e2e-offline:
	cd $(UI) && npm run test:e2e:offline

# Gateway smoke: set FREENET_BASE_URL to a /v1/contract/web/<id>/ URL.
e2e-gateway:
	@[ -n "$$FREENET_BASE_URL" ] || { echo "set FREENET_BASE_URL to the gateway webapp URL" >&2; exit 1; }
	cd $(UI) && npm run test:e2e:gateway

clean:
	cd $(CONTRACT) && cargo clean
	cd $(DELEGATE) && cargo clean
	rm -rf $(BUILD_DIR) $(UI)/dist $(UI)/node_modules
	rm -f $(UI)/contract_code_hash*.json $(UI)/contract_code_hash.txt \
	      $(UI)/delegate_key*.json $(UI)/delegate_key.txt \
	      $(UI)/delegate_code_hash*.json $(UI)/delegate_code_hash.txt \
	      $(UI)/public/number_contract.wasm
