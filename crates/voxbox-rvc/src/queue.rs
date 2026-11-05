use std::sync::atomic::{AtomicU64, Ordering};

/// Single producer / single consumer, overwrite-oldest sample transport.
/// Each slot atomically couples an f32 with a sequence tag, so a preempted
/// producer cannot make the consumer wait on an unpublished slot. No CAS loops,
/// backoff, locks or OS calls. Queue roles must each have exactly one thread.
pub(crate) struct SampleQueue {
    slots: Box<[AtomicU64]>,
    write: AtomicU64,
    read: AtomicU64,
}
impl SampleQueue {
    pub(crate) fn new(capacity: usize) -> Self {
        assert!(capacity > 0 && capacity < u32::MAX as usize);
        Self {
            slots: (0..capacity).map(|_| AtomicU64::new(u64::MAX)).collect(),
            write: AtomicU64::new(0),
            read: AtomicU64::new(0),
        }
    }
    /// Producer only. Returns true when this write overwrites unread audio.
    pub(crate) fn force_push(&self, sample: f32) -> bool {
        let sequence = self.write.load(Ordering::Relaxed);
        let dropped =
            sequence.saturating_sub(self.read.load(Ordering::Acquire)) >= self.slots.len() as u64;
        let tagged = ((sequence as u32 as u64) << 32) | u64::from(sample.to_bits());
        self.slots[sequence as usize % self.slots.len()].store(tagged, Ordering::Release);
        self.write.store(sequence + 1, Ordering::Release);
        dropped
    }
    /// Consumer only. A racing overwrite returns None rather than waiting.
    pub(crate) fn pop(&self) -> Option<f32> {
        let end = self.write.load(Ordering::Acquire);
        let position = self
            .read
            .load(Ordering::Relaxed)
            .max(end.saturating_sub(self.slots.len() as u64));
        if position >= end {
            return None;
        }
        let tagged = self.slots[position as usize % self.slots.len()].load(Ordering::Acquire);
        if (tagged >> 32) as u32 != position as u32 {
            return None;
        }
        self.read.store(position + 1, Ordering::Release);
        Some(f32::from_bits(tagged as u32))
    }
    pub(crate) fn len(&self) -> usize {
        self.write
            .load(Ordering::Acquire)
            .saturating_sub(self.read.load(Ordering::Acquire))
            .min(self.slots.len() as u64) as usize
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn overwrite_and_wrap() {
        let queue = SampleQueue::new(3);
        for i in 0..5 {
            assert_eq!(queue.force_push(i as f32), i >= 3);
        }
        assert_eq!(queue.len(), 3);
        assert_eq!(queue.pop(), Some(2.0));
        assert_eq!(queue.pop(), Some(3.0));
        assert_eq!(queue.pop(), Some(4.0));
        assert_eq!(queue.pop(), None);
        for i in 5..10 {
            queue.force_push(i as f32);
            assert_eq!(queue.pop(), Some(i as f32));
        }
    }
    #[test]
    fn preempted_producer_does_not_stall_consumer() {
        let queue = SampleQueue::new(1);
        queue.force_push(1.0);
        // Simulate producer publishing a new slot before advancing its write cursor.
        queue.slots[0].store(
            (1_u64 << 32) | u64::from(2.0_f32.to_bits()),
            Ordering::Release,
        );
        assert_eq!(queue.pop(), None);
        queue.write.store(2, Ordering::Release);
        assert_eq!(queue.pop(), Some(2.0));
    }
    #[test]
    fn threaded_overwrite_preserves_order() {
        let queue = std::sync::Arc::new(SampleQueue::new(128));
        let producer = std::sync::Arc::clone(&queue);
        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let finished = std::sync::Arc::clone(&done);
        let handle = std::thread::spawn(move || {
            for i in 1..100000 {
                producer.force_push(i as f32);
            }
            finished.store(true, Ordering::Release);
        });
        let mut last = 0.0;
        while !done.load(Ordering::Acquire) || queue.len() > 0 {
            if let Some(value) = queue.pop() {
                assert!(value > last, "{value} follows {last}");
                last = value;
            }
        }
        handle.join().unwrap();
        assert_eq!(last, 99999.0);
    }
}
