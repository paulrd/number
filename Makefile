SHELL := /bin/bash
FDEV ?= $(HOME)/.local/bin/fdev
FREENET ?= $(HOME)/.local/bin/freenet

# Ports and node directories. Every node-facing target takes its port from
# here, and every fdev invocation passes --port explicitly: fdev defaults to
# 7509, which on a dev box may be an SSH forward or a system service rather
# than the node this project is using.
WS_PORT ?= 7510
NETWORK_PORT ?= 31337
NODE_ROOT ?= /tmp/opencode/number-node
ISOLATED_WS_PORT ?= 7511
ISOLATED_NETWORK_PORT ?= 31338
ISOLATED_NODE_ROOT ?= /tmp/opencode/number-node-isolated

BUILD_DIR ?= .build
UI := ui
CONTRACT := contract
DELEGATE := delegate
CONTRACT_WASM := $(BUILD_DIR)/contract/wasm32-unknown-unknown/release/number_contract.wasm

.PHONY: all build wasm contract delegate check check-artifacts record-artifacts test ui dev node node-isolated publish-delegate verify-merge e2e-offline e2e-gateway clean

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
	cd $(UI) && FREENET_NODE_URL=http://127.0.0.1:$(WS_PORT) npm run dev

# Loopback-only node on WS_PORT (default 7510) with its own data/config/log
# dirs. `freenet local` is the right mode for this app: the UI does its own
# contract PUT/GET, and the delegate only holds and signs (it issues no
# contract requests, which local mode would not service).
node:
	mkdir -p $(NODE_ROOT)/data $(NODE_ROOT)/config $(NODE_ROOT)/logs
	$(FREENET) local \
	  --ws-api-port $(WS_PORT) \
	  --network-port $(NETWORK_PORT) \
	  --data-dir $(NODE_ROOT)/data \
	  --config-dir $(NODE_ROOT)/config \
	  --log-dir $(NODE_ROOT)/logs

# A second node on its own port and dirs, so publishing and migration tests
# cannot touch the node the UI and dev server use.
node-isolated:
	mkdir -p $(ISOLATED_NODE_ROOT)/data $(ISOLATED_NODE_ROOT)/config $(ISOLATED_NODE_ROOT)/logs
	$(FREENET) local \
	  --ws-api-port $(ISOLATED_WS_PORT) \
	  --network-port $(ISOLATED_NETWORK_PORT) \
	  --data-dir $(ISOLATED_NODE_ROOT)/data \
	  --config-dir $(ISOLATED_NODE_ROOT)/config \
	  --log-dir $(ISOLATED_NODE_ROOT)/logs

# Publish the delegate to the node the UI talks to, pinned to the webapp id in
# delegate/webapp_contract_id.txt. Re-running this with a changed id/code
# re-keys the delegate and starts a fresh owner identity (board).
publish-delegate: build
	$(FDEV) --port $(WS_PORT) publish \
	  --code $(DELEGATE)/build/freenet/number_delegate \
	  --parameters $(DELEGATE)/webapp_contract_id.bin \
	  delegate

# Merge-law check: generated bundle carries states, deltas, summaries and
# transitions, so every law (including the delta laws) generates cases; the
# script fails if any law is left with nothing to check.
verify-merge: contract
	FDEV="$(FDEV)" ./scripts/verify-merge.sh "$(CONTRACT_WASM)"

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
	      $(UI)/public/number_contract.wasm $(UI)/public/number_delegate.wasm
