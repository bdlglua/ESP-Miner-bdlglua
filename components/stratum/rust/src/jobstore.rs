//! C ABI. Every entry point must be serialized by bm1370_jobs_lock in C.
use crate::jobbook::{JobBook, Token};
use core::{ptr, slice, str};

const ID_CAP: usize = 256;
static mut JOBS: JobBook<ID_CAP> = JobBook::new();

#[repr(C)]
pub struct Data {
    header: [u8; 80],
    version_mask: u32,
    difficulty: u32,
    id: [u8; 257],
    extra: [u8; 65],
    token: Token,
}
const _: [(); 424] = [(); core::mem::size_of::<Data>()];

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_jobs_rs_epoch() -> u32 {
    unsafe { (*ptr::addr_of!(JOBS)).epoch() }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_jobs_rs_clear() -> i32 {
    unsafe { i32::from((*ptr::addr_of_mut!(JOBS)).clear().is_ok()) }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_jobs_rs_insert(
    raw: u8,
    epoch: u32,
    header: *const u8,
    mask: u32,
    difficulty: u32,
    id: *const u8,
    id_len: usize,
    extra_hex: *const u8,
    extra_len: usize,
) -> i32 {
    unsafe {
        if epoch != (*ptr::addr_of!(JOBS)).epoch() {
            return 0;
        }
        if header.is_null()
            || id.is_null()
            || extra_hex.is_null()
            || id_len > ID_CAP
            || extra_len > 64
            || extra_len & 1 != 0
        {
            return -1;
        }
        let Ok(id) = str::from_utf8(slice::from_raw_parts(id, id_len)) else {
            return -1;
        };
        let mut extra = [0; 32];
        let hex = slice::from_raw_parts(extra_hex, extra_len);
        let digit = |b| match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        };
        for (n, pair) in hex.as_chunks::<2>().0.iter().enumerate() {
            let (Some(a), Some(b)) = (digit(pair[0]), digit(pair[1])) else {
                return -1;
            };
            extra[n] = a * 16 + b;
        }
        match (*ptr::addr_of_mut!(JOBS)).insert(
            raw,
            *(header.cast::<[u8; 80]>()),
            mask,
            difficulty,
            id,
            &extra[..extra_len / 2],
        ) {
            Ok(_) => 1,
            Err(_) => -1,
        }
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_jobs_rs_read(raw: u8, output: *mut Data) -> i32 {
    unsafe {
        if output.is_null() {
            return 0;
        }
        let Some(saved) = (*ptr::addr_of!(JOBS)).snapshot(raw) else {
            return 0;
        };
        let mut data = Data {
            header: *saved.header(),
            version_mask: saved.version_mask(),
            difficulty: saved.pool_difficulty(),
            id: [0; 257],
            extra: [0; 65],
            token: saved.token(),
        };
        if saved.submission(&mut data.id, &mut data.extra).is_err() {
            return 0;
        }
        output.write(data);
        1
    }
}

#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_jobs_rs_current(token: *const Token) -> i32 {
    unsafe {
        if token.is_null() {
            return 0;
        }
        i32::from((*ptr::addr_of!(JOBS)).is_current(token.read()))
    }
}
