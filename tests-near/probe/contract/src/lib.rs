// NB0 probe contract — spec §2 (handoff/P5-NEAR-SPEC.md).
//
// Minimal near-sdk 5.x contract used only to test whether a wasm built by
// Rust 1.98.1 for wasm32-unknown-unknown is accepted by the sandboxed NEAR
// VM (protocol 86, near-sandbox 2.13.4). It carries no swap-desk logic.
//
// `Contract` derives `Default` so the near-sdk-generated method wrapper can
// fall back to a default value when no state has been written to the
// account yet (`env::state_read().unwrap_or_default()`), which lets the
// probe call `ping` right after a bare `sandbox_patch_state` code deploy —
// no separate state record and no init call needed.
use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct Contract {
    greeting: String,
}

#[near]
impl Contract {
    /// View method. Returns the stored greeting, or "pong" when the
    /// contract has never been initialized (fresh/default state) — this is
    /// the call the probe uses to prove the deployed wasm actually runs.
    pub fn ping(&self) -> String {
        if self.greeting.is_empty() {
            "pong".to_string()
        } else {
            self.greeting.clone()
        }
    }

    /// Call method, exercised only if the probe needs to prove a state
    /// write path works too; not required for the keyless view-only check.
    pub fn set_greeting(&mut self, greeting: String) {
        self.greeting = greeting;
    }
}
