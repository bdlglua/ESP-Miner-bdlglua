//! ESP-Miner BM1370 wire compatibility adapter for pinned bm13xx-protocol.
//! No allocation or UART access. See tools/RUST_BM1370_FR.md for byte order/id rules.
use bm13xx_protocol::response::{Response, ResponseType};
use crc::{Algorithm, Crc};

const CRC5: Crc<u8> = Crc::<u8>::new(&Algorithm {
    width: 5,
    poly: 0x05,
    init: 0x1f,
    refin: false,
    refout: false,
    xorout: 0,
    check: 0,
    residue: 0,
});
const fn crc16_table() -> [u16; 256] {
    let mut table = [0; 256];
    let mut n = 0;
    while n < 256 {
        let mut value = (n as u16) << 8;
        let mut bit = 0;
        while bit < 8 {
            value = (value << 1) ^ if value & 0x8000 != 0 { 0x1021 } else { 0 };
            bit += 1;
        }
        table[n] = value;
        n += 1;
    }
    table
}
static CRC16_TABLE: [u16; 256] = crc16_table();

#[inline(always)]
fn crc16_byte(sum: u16, byte: u8) -> u16 {
    CRC16_TABLE[((sum >> 8) as u8 ^ byte) as usize] ^ (sum << 8)
}

fn crc16_fast(data: &[u8]) -> u16 {
    let mut sum = 0xffff;
    let (blocks, tail) = data.as_chunks::<4>();
    for &[a, b, c, d] in blocks {
        sum = crc16_byte(sum, a);
        sum = crc16_byte(sum, b);
        sum = crc16_byte(sum, c);
        sum = crc16_byte(sum, d);
    }
    for &byte in tail {
        sum = crc16_byte(sum, byte);
    }
    sum
}

#[repr(C)]
#[derive(Default)]
pub struct WireResponse {
    nonce: u32,
    value: u32,
    version_bits: u32,
    is_job: u8,
    job_id: u8,
    small_core_id: u8,
    core_id: u8,
    asic_address: u8,
    register_address: u8,
}

fn frame_size(header: u8, length: usize) -> Option<usize> {
    if header == 0x21 {
        return (length == 82).then_some(88);
    }
    if header & 0xec != 0x40 || length != (if header & 3 == 1 { 6 } else { 2 }) {
        return None;
    }
    Some(length + 5)
}

fn encode_into(header: u8, payload: &[u8], output: &mut [u8]) -> Option<usize> {
    let size = frame_size(header, payload.len())?;
    let frame = output.get_mut(..size)?;
    frame[..4].copy_from_slice(&[0x55, 0xaa, header, (size - 2) as u8]);
    // The caller already supplies ESP-Miner's wire payload. Copy it once:
    // no display-order conversion, temporary frame or overwritten CRC.
    frame[4..4 + payload.len()].copy_from_slice(payload);
    if header == 0x21 {
        let sum = crc16_fast(&frame[2..size - 2]);
        frame[size - 2..].copy_from_slice(&sum.to_be_bytes());
    } else {
        frame[size - 1] = CRC5.checksum(&frame[2..size - 1]);
    }
    Some(size)
}

fn decode(frame: &[u8; 11]) -> Option<WireResponse> {
    let parsed = Response::parse_version(frame, 16).ok()?;
    let mut output = WireResponse::default();
    match parsed {
        ResponseType::Reg(r) => {
            output.value = r.reg_value;
            output.asic_address = r.chip_addr;
            output.register_address = r.reg_addr;
        }
        ResponseType::JobVer(j) => {
            output.is_job = 1;
            output.nonce = j.nonce;
            // Existing C indexes 16 slots by bits 7:4 of response byte 7. The
            // upstream parser also incorporates a bit of byte 6; keep C semantics.
            output.job_id = ((j.job_id & 15) << 3) as u8;
            output.small_core_id = j.small_core_id as u8;
            output.version_bits = j.version_bit;
            let nonce_be = u32::from_be_bytes(frame[2..6].try_into().ok()?);
            output.core_id = (nonce_be >> 25) as u8;
            output.asic_address = (nonce_be >> 17) as u8;
        }
        ResponseType::Job(_) => return None,
    }
    Some(output)
}

unsafe fn borrowed<'a>(data: *const u8, length: usize) -> Option<&'a [u8]> {
    unsafe {
        if length == 0 {
            return Some(&[]);
        }
        if data.is_null() || length > isize::MAX as usize {
            return None;
        }
        Some(core::slice::from_raw_parts(data, length))
    }
}

/// # Safety
/// Caller owns readable payload and disjoint writable output of the given sizes.
/// No pointers are retained. Failure leaves output untouched.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_rs_encode(
    header: u8,
    payload: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
) -> usize {
    unsafe {
        if payload.is_null() || output.is_null() {
            return 0;
        }
        let Some(size) = frame_size(header, length) else {
            return 0;
        };
        if size > capacity {
            return 0;
        }
        let Some(bytes) = borrowed(payload, length) else {
            return 0;
        };
        let destination = core::slice::from_raw_parts_mut(output, size);
        encode_into(header, bytes, destination).unwrap_or(0)
    }
}

/// # Safety
/// Caller owns readable frame and disjoint writable output; no pointers retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_rs_decode(
    frame: *const u8,
    length: usize,
    output: *mut WireResponse,
) -> i32 {
    unsafe {
        if output.is_null() || length != 11 {
            return 0;
        }
        let Some(bytes) = borrowed(frame, length) else {
            return 0;
        };
        let Ok(array) = bytes.try_into() else {
            return 0;
        };
        let Some(value) = decode(array) else {
            return 0;
        };
        output.write(value);
        1
    }
}

/// # Safety
/// `data` must point to `length` readable bytes (null permitted only for zero length).
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_rs_crc5(data: *const u8, length: usize) -> u8 {
    unsafe { borrowed(data, length).map_or(0, |bytes| CRC5.checksum(bytes)) }
}

/// # Safety
/// Same borrowing contract as `bm1370_rs_crc5`. Initial value is FFFF.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_rs_crc16(data: *const u8, length: usize) -> u16 {
    unsafe { borrowed(data, length).map_or(0, crc16_fast) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_protocol_vectors() {
        assert_eq!(crc16_fast(b"123456789"), 0x29b1);
        let mut frame = [0; 88];
        let n = encode_into(0x53, &[0, 0], &mut frame).unwrap();
        assert_eq!(&frame[..n], &[0x55, 0xaa, 0x53, 5, 0, 0, 3]);
        let response = decode(&[
            0xaa, 0x55, 0x07, 0x35, 0xcd, 0xcf, 0x02, 0x5e, 0, 0x2e, 0x96,
        ])
        .unwrap();
        assert_eq!(response.nonce, 0xcfcd3507);
        assert_eq!(response.job_id, 40);
        assert_eq!(response.small_core_id, 14);
        assert_eq!(response.version_bits, 0x5c000);
    }
}
