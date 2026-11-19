//! Fixed BM1370 job ownership, shared by firmware and the host study.
//! External synchronization must cover insert/snapshot/clear/is_current. A returned
//! snapshot owns its data, so hashing/network I/O can happen after releasing a lock.

const SLOTS: usize = 16;
const EXTRA_CAP: usize = 32;

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    InvalidSlot,
    JobIdTooLong,
    EmbeddedNul,
    ExtraTooLong,
    BufferTooSmall,
    GenerationExhausted,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Job<const ID: usize> {
    header: [u8; 80], // Canonical serialized header; preserves existing mining conventions.
    version_mask: u32,
    pool_difficulty: u32,
    id_len: u16,
    extra_len: u8,
    reserved: u8,
    id: [u8; ID],
    extra: [u8; EXTRA_CAP],
}
impl<const ID: usize> Job<ID> {
    const EMPTY: Self = Self {
        header: [0; 80],
        version_mask: 0,
        pool_difficulty: 0,
        id_len: 0,
        extra_len: 0,
        reserved: 0,
        id: [0; ID],
        extra: [0; EXTRA_CAP],
    };
}

#[repr(C)]
#[derive(Clone, Copy)]
struct Slot<const ID: usize> {
    job: Job<ID>,
    generation: u32,
    valid: u32,
}
impl<const ID: usize> Slot<ID> {
    const EMPTY: Self = Self {
        job: Job::EMPTY,
        generation: 0,
        valid: 0,
    };
}

#[repr(C)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Token {
    pub epoch: u32,
    pub generation: u32,
    pub raw_slot: u32,
}

#[derive(Clone, Copy)]
pub struct Snapshot<const ID: usize> {
    token: Token,
    job: Job<ID>,
}
impl<const ID: usize> Snapshot<ID> {
    pub fn token(&self) -> Token {
        self.token
    }
    pub fn header(&self) -> &[u8; 80] {
        &self.job.header
    }
    pub fn version_mask(&self) -> u32 {
        self.job.version_mask
    }
    pub fn pool_difficulty(&self) -> u32 {
        self.job.pool_difficulty
    }
    pub fn job_id(&self) -> &[u8] {
        &self.job.id[..usize::from(self.job.id_len)]
    }
    pub fn extranonce2(&self) -> &[u8] {
        &self.job.extra[..usize::from(self.job.extra_len)]
    }

    /// Copy into legacy C submission buffers without truncation. Both buffers are
    /// left unchanged when too small. Return lengths excluding trailing NUL.
    pub fn submission(&self, id: &mut [u8], extra_hex: &mut [u8]) -> Result<(usize, usize), Error> {
        let id_length = usize::from(self.job.id_len);
        let extra_length = usize::from(self.job.extra_len) * 2;
        if id.len() <= id_length || extra_hex.len() <= extra_length {
            return Err(Error::BufferTooSmall);
        }
        id[..id_length].copy_from_slice(self.job_id());
        id[id_length] = 0;
        const HEX: &[u8; 16] = b"0123456789abcdef";
        for (index, byte) in self.extranonce2().iter().copied().enumerate() {
            extra_hex[index * 2] = HEX[usize::from(byte >> 4)];
            extra_hex[index * 2 + 1] = HEX[usize::from(byte & 15)];
        }
        extra_hex[extra_length] = 0;
        Ok((id_length, extra_length))
    }
}

#[repr(C)]
pub struct JobBook<const ID: usize> {
    slots: [Slot<ID>; SLOTS],
    epoch: u32,
}

// Compile-time budget checks also run when this study is built for Xtensa.
const _: [(); 4164] = [(); core::mem::size_of::<JobBook<128>>()];
const _: [(); 6212] = [(); core::mem::size_of::<JobBook<256>>()];

impl<const ID: usize> Default for JobBook<ID> {
    fn default() -> Self {
        Self::new()
    }
}
impl<const ID: usize> JobBook<ID> {
    pub const fn new() -> Self {
        Self {
            slots: [Slot::EMPTY; SLOTS],
            epoch: 0,
        }
    }
    fn index(raw: u8) -> Result<usize, Error> {
        if raw >= 128 || raw & 7 != 0 {
            return Err(Error::InvalidSlot);
        }
        Ok(usize::from(raw >> 3))
    }

    pub fn insert(
        &mut self,
        raw_slot: u8,
        header: [u8; 80],
        version_mask: u32,
        pool_difficulty: u32,
        id: &str,
        extranonce2: &[u8],
    ) -> Result<Token, Error> {
        let index = Self::index(raw_slot)?;
        if id.len() > ID || id.len() > u16::MAX as usize {
            return Err(Error::JobIdTooLong);
        }
        if id.as_bytes().contains(&0) {
            return Err(Error::EmbeddedNul);
        }
        if extranonce2.len() > EXTRA_CAP {
            return Err(Error::ExtraTooLong);
        }
        let generation = self.slots[index]
            .generation
            .checked_add(1)
            .ok_or(Error::GenerationExhausted)?;
        let mut job = Job::EMPTY;
        job.header = header;
        job.version_mask = version_mask;
        job.pool_difficulty = pool_difficulty;
        job.id_len = id.len() as u16;
        job.extra_len = extranonce2.len() as u8;
        job.id[..id.len()].copy_from_slice(id.as_bytes());
        job.extra[..extranonce2.len()].copy_from_slice(extranonce2);
        self.slots[index] = Slot {
            job,
            generation,
            valid: 1,
        };
        Ok(Token {
            epoch: self.epoch,
            generation,
            raw_slot: u32::from(raw_slot),
        })
    }

    pub fn snapshot(&self, raw_slot: u8) -> Option<Snapshot<ID>> {
        let slot = self.slots.get(Self::index(raw_slot).ok()?)?;
        if slot.valid == 0 {
            return None;
        }
        Some(Snapshot {
            job: slot.job,
            token: Token {
                epoch: self.epoch,
                generation: slot.generation,
                raw_slot: u32::from(raw_slot),
            },
        })
    }

    pub fn is_current(&self, token: Token) -> bool {
        self.snapshot(u8::try_from(token.raw_slot).unwrap_or(255))
            .is_some_and(|snapshot| snapshot.token == token)
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn clear(&mut self) -> Result<(), Error> {
        let epoch = self
            .epoch
            .checked_add(1)
            .ok_or(Error::GenerationExhausted)?;
        for slot in &mut self.slots {
            slot.valid = 0;
        }
        self.epoch = epoch;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    extern crate std;
    use super::*;
    use std::sync::{Arc, Mutex};
    use std::thread;

    #[test]
    fn reuse_is_bounded_and_snapshots_own_their_strings() {
        let mut book = JobBook::<256>::new();
        let first = book
            .insert(24, [1; 80], 0x1fffe000, 2048, "old", &[0, 0xab])
            .unwrap();
        let saved = book.snapshot(24).unwrap();
        for n in 0..100_000u32 {
            let raw = (((n + 1) * 3 % 16) * 8) as u8;
            let header = [n as u8; 80];
            let token = book
                .insert(raw, header, 0, n, "new", &n.to_le_bytes())
                .unwrap();
            let current = book.snapshot(raw).unwrap();
            assert!(book.is_current(token));
            assert_eq!(current.header(), &header);
            assert_eq!(current.extranonce2(), &n.to_le_bytes());
        }
        assert!(!book.is_current(first));
        assert_eq!(saved.job_id(), b"old");
        let mut id = [0xaa; 257];
        let mut extra = [0xaa; 65];
        assert_eq!(saved.submission(&mut id, &mut extra), Ok((3, 4)));
        assert_eq!(&id[..4], b"old\0");
        assert_eq!(&extra[..5], b"00ab\0");
    }

    #[test]
    fn overflows_never_replace_existing_work_or_truncate_submission() {
        let mut book = JobBook::<4>::new();
        let token = book
            .insert(0, [3; 80], 0, 256, "good", &[0xff; 32])
            .unwrap();
        assert_eq!(
            book.insert(0, [0; 80], 0, 0, "longer", &[]),
            Err(Error::JobIdTooLong)
        );
        assert_eq!(
            book.insert(0, [0; 80], 0, 0, "a\0b", &[]),
            Err(Error::EmbeddedNul)
        );
        assert_eq!(
            book.insert(0, [0; 80], 0, 0, "ok", &[0; 33]),
            Err(Error::ExtraTooLong)
        );
        assert!(book.is_current(token));
        let saved = book.snapshot(0).unwrap();
        let mut id = [0xa5; 4];
        let mut extra = [0xa5; 65];
        assert_eq!(
            saved.submission(&mut id, &mut extra),
            Err(Error::BufferTooSmall)
        );
        assert_eq!(id, [0xa5; 4]);
        assert_eq!(extra, [0xa5; 65]);
        let mut id = [0xa5; 5];
        let mut extra = [0xa5; 64];
        assert_eq!(
            saved.submission(&mut id, &mut extra),
            Err(Error::BufferTooSmall)
        );
        assert_eq!(id, [0xa5; 5]);
    }

    #[test]
    fn every_wire_id_and_clean_jobs_epoch() {
        let mut book = JobBook::<128>::new();
        for raw in 0..=255u8 {
            let result = book.insert(raw, [raw; 80], 0, 1, "id", &[]);
            assert_eq!(result.is_ok(), raw < 128 && raw & 7 == 0);
        }
        let snapshot = book.snapshot(120).unwrap();
        book.clear().unwrap();
        assert!(!book.is_current(snapshot.token()));
        assert!((0..128).all(|raw| book.snapshot(raw).is_none()));
        let newer = book.insert(120, [0; 80], 0, 1, "id", &[]).unwrap();
        assert_ne!(snapshot.token(), newer);
        book.epoch = u32::MAX;
        assert_eq!(book.clear(), Err(Error::GenerationExhausted));
        assert!(book.snapshot(120).is_some());
    }

    #[test]
    fn concurrent_producer_reader_and_cleaner_use_owned_snapshots() {
        let book = Arc::new(Mutex::new(JobBook::<256>::new()));
        let producer = book.clone();
        let writer = thread::spawn(move || {
            for n in 0..30_000u32 {
                producer
                    .lock()
                    .unwrap()
                    .insert(
                        ((n % 16) * 8) as u8,
                        [n as u8; 80],
                        0,
                        n,
                        "job",
                        &n.to_le_bytes(),
                    )
                    .unwrap();
            }
        });
        let cleaner = book.clone();
        let resetter = thread::spawn(move || {
            for _ in 0..1000 {
                cleaner.lock().unwrap().clear().unwrap();
            }
        });
        for n in 0..30_000u32 {
            let snapshot = book.lock().unwrap().snapshot(((n % 16) * 8) as u8);
            if let Some(saved) = snapshot {
                // No reference into the book survives the mutex; replacement is safe.
                let value = u32::from_le_bytes(saved.extranonce2().try_into().unwrap());
                assert_eq!(saved.header(), &[value as u8; 80]);
                assert_eq!(saved.pool_difficulty(), value);
            }
        }
        writer.join().unwrap();
        resetter.join().unwrap();
    }

    #[test]
    fn utf8_capacity_and_static_budget() {
        let mut book = JobBook::<4>::new();
        assert!(book.insert(0, [0; 80], 0, 1, "éé", &[]).is_ok());
        assert_eq!(
            book.insert(0, [0; 80], 0, 1, "ééa", &[]),
            Err(Error::JobIdTooLong)
        );
        assert_eq!(core::mem::size_of::<JobBook<128>>(), 4164);
        assert_eq!(core::mem::size_of::<JobBook<256>>(), 6212);
    }
}
