// Frozen pre-optimization baseline, built only by the protocol-bench feature.
//! ESP-Miner BM1370 wire compatibility adapter for pinned bm13xx-protocol.
//! No allocation or UART access. See tools/RUST_BM1370_FR.md for byte order/id rules.
use bm13xx_protocol::{
    command::{Command, Destination},
    response::{Response, ResponseType},
};
use crc::{Algorithm, CRC_16_IBM_3740, Crc};

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
const CRC16: Crc<u16> = Crc::<u16>::new(&CRC_16_IBM_3740);

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

fn word_swapped(bytes: &[u8]) -> Option<[u8; 32]> {
    let mut hash: [u8; 32] = bytes.try_into().ok()?;
    for word in hash.as_chunks_mut::<4>().0 {
        word.reverse();
    }
    Some(hash)
}

fn encode(header: u8, payload: &[u8]) -> Option<([u8; 88], usize)> {
    let mut frame = [0; 88];
    if header == 0x21 {
        if payload.len() != 82 {
            return None;
        }
        let le = |range: core::ops::Range<usize>| -> Option<u32> {
            Some(u32::from_le_bytes(payload.get(range)?.try_into().ok()?))
        };
        // C already stores hashes in wire word order. Upstream takes display
        // order and swaps each word; invert that transform before calling it.
        frame = Command::job_header(
            payload[0] >> 3,
            le(6..10)?,
            le(10..14)?,
            word_swapped(&payload[14..46])?,
            word_swapped(&payload[46..78])?,
            le(78..82)?,
        );
        // Preserve ESP-Miner's BM1370 length (86, upstream default is 54), raw
        // job slot, midstate byte and starting nonce. Recompute the CRC afterward.
        frame[3] = 86;
        frame[4..10].copy_from_slice(&payload[..6]);
        let crc = CRC16.checksum(&frame[2..86]);
        frame[86..88].copy_from_slice(&crc.to_be_bytes());
        return Some((frame, 88));
    }
    if header & 0xec != 0x40 || payload.len() != (if header & 3 == 1 { 6 } else { 2 }) {
        return None;
    }
    let destination = if header & 0x10 != 0 {
        Destination::All
    } else {
        Destination::Chip(payload[0])
    };
    let length = match header & 3 {
        0 => {
            frame[..7].copy_from_slice(&Command::set_chip_addr(payload[0]));
            7
        }
        1 => {
            let value = u32::from_be_bytes(payload[2..6].try_into().ok()?);
            frame[..11].copy_from_slice(&Command::write_reg(payload[1], value, destination));
            11
        }
        2 => {
            frame[..7].copy_from_slice(&Command::read_reg(payload[1], destination));
            7
        }
        _ => {
            frame[..7].copy_from_slice(&Command::chain_inactive());
            7
        }
    };
    // Retain the exact caller-supplied group/address/padding bits, including
    // nonzero addresses on a broadcast, which upstream otherwise normalizes.
    frame[2] = header;
    frame[4..6].copy_from_slice(&payload[..2]);
    frame[length - 1] = CRC5.checksum(&frame[2..length - 1]);
    Some((frame, length))
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
pub unsafe extern "C" fn bm1370_legacy_encode(
    header: u8,
    payload: *const u8,
    length: usize,
    output: *mut u8,
    capacity: usize,
) -> usize {
    unsafe {
        if payload.is_null() || output.is_null() || length > 82 {
            return 0;
        }
        let Some(bytes) = borrowed(payload, length) else {
            return 0;
        };
        let Some((frame, size)) = encode(header, bytes) else {
            return 0;
        };
        if size > capacity {
            return 0;
        }
        core::ptr::copy_nonoverlapping(frame.as_ptr(), output, size);
        size
    }
}

/// # Safety
/// Caller owns readable frame and disjoint writable output; no pointers retained.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_legacy_decode(
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
pub unsafe extern "C" fn bm1370_legacy_crc5(data: *const u8, length: usize) -> u8 {
    unsafe { borrowed(data, length).map_or(0, |bytes| CRC5.checksum(bytes)) }
}

/// # Safety
/// Same borrowing contract as `bm1370_legacy_crc5`. Initial value is FFFF.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bm1370_legacy_crc16(data: *const u8, length: usize) -> u16 {
    unsafe { borrowed(data, length).map_or(0, |bytes| CRC16.checksum(bytes)) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fixed_protocol_vectors() {
        assert_eq!(CRC16.checksum(b"123456789"), 0x29b1);
        let (frame, n) = encode(0x53, &[0, 0]).unwrap();
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
