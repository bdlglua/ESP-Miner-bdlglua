//! Experimental transaction reader. No allocator, runtime, crypto or ESP-IDF bindings.
#![no_std]

#[cfg(feature = "fixed-jobs")]
mod jobbook;
#[cfg(feature = "fixed-jobs")]
mod jobstore;

#[cfg(feature = "asic-protocol")]
mod bm1370;
#[cfg(feature = "protocol-bench")]
mod bm1370_legacy;

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo<'_>) -> ! {
    unsafe extern "C" {
        fn abort() -> !;
    }
    // A programming fault must stop the firmware, never spin on a mining task.
    unsafe { abort() }
}

#[repr(C)]
#[derive(Debug, Default, PartialEq)]
pub struct Layout {
    script_len: usize,
    script_end: usize,
    tag_start: usize,
    total: u64,
    height: u32,
}

struct Cursor<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Cursor<'a> {
    fn take(&mut self, length: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(length)?;
        let value = self.bytes.get(self.pos..end)?;
        self.pos = end;
        Some(value)
    }

    fn integer(&mut self, length: usize) -> Option<u64> {
        Some(
            self.take(length)?
                .iter()
                .enumerate()
                .fold(0, |n, (i, b)| n | u64::from(*b) << (8 * i)),
        )
    }

    fn compact(&mut self) -> Option<u64> {
        let prefix = self.take(1)?[0];
        let (length, minimum) = match prefix {
            0xfd => (2, 0xfd),
            0xfe => (4, 0x10000),
            0xff => (8, 0x100000000),
            n => return Some(u64::from(n)),
        };
        let value = self.integer(length)?;
        (value >= minimum).then_some(value)
    }

    fn length(&mut self) -> Option<usize> {
        usize::try_from(self.compact()?).ok()
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.pos
    }
}

fn parse(
    tx: &[u8],
    split: usize,
    extra: usize,
    peercoin: bool,
    mut output: impl FnMut(u64, &[u8]),
) -> Option<Layout> {
    let extra_end = split.checked_add(extra)?;
    let mut c = Cursor { bytes: tx, pos: 0 };
    let version = c.integer(4)?;
    if peercoin && version < 3 {
        c.take(4)?; // Peercoin v1/v2 nTime.
    }
    let witness = tx.get(c.pos..c.pos + 2) == Some(&[0, 1][..]);
    if witness {
        c.take(2)?;
    }
    if c.compact()? != 1 || c.take(32)?.iter().any(|b| *b != 0) || c.take(4)? != [0xff; 4] {
        return None;
    }
    let script_len = c.length()?;
    if !(2..=100).contains(&script_len) {
        return None;
    }
    let script_start = c.pos;
    let script = c.take(script_len)?;
    let script_end = c.pos;
    if split < script_start || extra_end > script_end {
        return None;
    }
    let height_len = usize::from(script[0]);
    if !(1..=5).contains(&height_len) {
        return None;
    }
    let height_bytes = script.get(1..1 + height_len)?;
    if height_bytes[height_len - 1] & 0x80 != 0 {
        return None;
    }
    let height = height_bytes
        .iter()
        .enumerate()
        .fold(0u64, |n, (i, b)| n | u64::from(*b) << (8 * i));
    let tag_start = script_start + 1 + height_len;
    if height == 0 || height > i32::MAX as u64 || tag_start > split {
        return None;
    }
    c.take(4)?; // Sequence.
    let outputs = c.compact()?;
    if outputs == 0 || outputs > (c.remaining() / 9) as u64 {
        return None;
    }
    let mut total = 0u64;
    for _ in 0..outputs {
        let value = c.integer(8)?;
        total = total.checked_add(value)?;
        if total > i64::MAX as u64 {
            return None;
        }
        let length = c.length()?;
        output(value, c.take(length)?);
    }
    if witness {
        let items = c.compact()?;
        if items > c.remaining() as u64 {
            return None;
        }
        for _ in 0..items {
            let length = c.length()?;
            c.take(length)?;
        }
    }
    if c.remaining() != 4 {
        return None;
    }
    Some(Layout {
        script_len,
        script_end,
        tag_start,
        total,
        height: height as u32,
    })
}

type Output = unsafe extern "C" fn(*mut core::ffi::c_void, u64, *const u8, usize);

/// # Safety
/// `tx` must name `length` readable bytes; `layout` must be writable and disjoint.
/// The callback must not mutate the transaction, unwind, or retain its script pointer.
/// It can run before a later validation failure: the caller must discard partial outputs.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn coinbase_rs_parse(
    tx: *const u8,
    length: usize,
    split: usize,
    extra: usize,
    peercoin: u8,
    layout: *mut Layout,
    output: Option<Output>,
    context: *mut core::ffi::c_void,
) -> i32 {
    unsafe {
        if tx.is_null() || layout.is_null() || length > isize::MAX as usize {
            return 0;
        }
        let bytes = core::slice::from_raw_parts(tx, length);
        match parse(bytes, split, extra, peercoin != 0, |value, script| {
            if let Some(emit) = output {
                emit(context, value, script.as_ptr(), script.len());
            }
        }) {
            Some(value) => {
                layout.write(value);
                1
            }
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_size_boundaries() {
        for (data, expected) in [
            (&[0xfc][..], Some(252)),
            (&[0xfd, 0xfd, 0], Some(253)),
            (&[0xfd, 1, 0], None),
            (&[0xfe, 0, 0, 1, 0], Some(65536)),
            (&[0xfe, 0xff, 0xff, 0, 0], None),
            (&[0xff, 0, 0, 0, 0, 1, 0, 0, 0], Some(1 << 32)),
            (&[0xff, 0, 0, 0, 0, 0, 0, 0, 0], None),
        ] {
            assert_eq!(
                Cursor {
                    bytes: data,
                    pos: 0
                }
                .compact(),
                expected
            );
            for length in 0..data.len() {
                assert_eq!(
                    Cursor {
                        bytes: &data[..length],
                        pos: 0
                    }
                    .compact(),
                    None
                );
            }
        }
    }

    #[test]
    fn impossible_offsets_and_empty_input() {
        assert!(parse(&[], 0, 0, false, |_, _| {}).is_none());
        assert!(parse(&[0; 64], usize::MAX, 1, true, |_, _| {}).is_none());
    }
}
