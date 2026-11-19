//! Host harness for the production fixed-capacity BM1370 job book.
#![no_std]
#[path = "../../../components/stratum/rust/src/jobbook.rs"]
mod jobbook;
pub use jobbook::*;
