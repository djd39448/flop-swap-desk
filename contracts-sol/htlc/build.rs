//! Emits the configured USDC mint as a compile-time constant.
//!
//! The mint is chosen at BUILD time from the environment variable `FLOP_SOL_USDC_MINT`
//! (a base58 public key). It is compiled into the program, so it is covered by the reviewed
//! `.so` sha256 that the desk pins: there is no init instruction, no config account and no
//! first-caller-wins race. When the variable is unset the build uses the keyless localnet mock
//! mint `base58(sha256("flop-swap-desk:sol-mock-usdc:v1"))`.
use std::{env, fs, path::Path};

const DEFAULT_MINT: &str = "91cjWuWZvm24ttxccaWHkAcXQcDw1jce4PNqknzRNSMz";
const ALPHABET: &[u8] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

fn decode(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    let leading = s.bytes().take_while(|&c| c == b'1').count();
    let mut bytes: Vec<u8> = Vec::new(); // little-endian big number
    for c in s.bytes() {
        let mut carry = ALPHABET
            .iter()
            .position(|&a| a == c)
            .unwrap_or_else(|| panic!("FLOP_SOL_USDC_MINT: invalid base58 character")) as u32;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    let total = leading + bytes.len();
    assert!(total == 32, "FLOP_SOL_USDC_MINT: must decode to exactly 32 bytes (got {total})");
    for (i, b) in bytes.iter().enumerate() {
        out[32 - 1 - i] = *b;
    }
    out
}

fn main() {
    println!("cargo:rerun-if-env-changed=FLOP_SOL_USDC_MINT");
    println!("cargo:rerun-if-changed=build.rs");
    let s = env::var("FLOP_SOL_USDC_MINT").unwrap_or_else(|_| DEFAULT_MINT.to_string());
    let bytes = decode(s.trim());
    let list: Vec<String> = bytes.iter().map(|b| b.to_string()).collect();
    let src = format!("pub const USDC_MINT_BYTES: [u8; 32] = [{}];\n", list.join(", "));
    let dest = Path::new(&env::var("OUT_DIR").unwrap()).join("usdc_mint.rs");
    fs::write(dest, src).unwrap();
}
