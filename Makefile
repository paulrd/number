SHELL := /bin/bash
FDEV ?= $(HOME)/.local/bin/fdev
FREENET ?= $(HOME)/.local/bin/freenet
WS_PORT ?= 7510
UI := ui
CONTRACT := contract
DELEGATE := delegate

.PHONY: all build check test contract delegate ui dev node publish-delegate verify-merge e2e-offline e2e-gateway clean

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
	cd $(CONTRACT) && cargo run --example gen_corpus -- /tmp/opencode/number-corpus
	$(FDEV) verify-merge \
	  --wasm $(CONTRACT)/target/wasm32-unknown-unknown/release/number_contract.wasm \
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
	rm -rf $(UI)/dist $(UI)/node_modules
	rm -f $(UI)/contract_code_hash*.json $(UI)/contract_code_hash.txt \
	      $(UI)/delegate_key*.json $(UI)/delegate_key.txt $(UI)/public/number_contract.wasm
