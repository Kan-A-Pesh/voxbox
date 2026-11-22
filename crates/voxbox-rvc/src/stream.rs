use crate::queue::SampleQueue;
use crate::{audio, inference::Synthesizer, Result, RvcError, RvcParams, RvcRuntime};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const CAPACITY: usize = 192000;
const CONTEXT: usize = 7680; // 160 ms left context, already captured, adds no lookahead.

fn normalize(p: RvcParams) -> RvcParams {
    RvcParams {
        pitch_semitones: if p.pitch_semitones.is_finite() {
            p.pitch_semitones.clamp(-48.0, 48.0)
        } else {
            0.0
        },
        index_rate: if p.index_rate.is_finite() {
            p.index_rate.clamp(0.0, 1.0)
        } else {
            0.0
        },
        block_ms: (p.block_ms.clamp(100, 1000) / 10) * 10,
        crossfade_ms: (p.crossfade_ms.min(p.block_ms.clamp(100, 1000)) / 10) * 10,
    }
}
struct Controls {
    values: AtomicU64,
    timing: AtomicU64,
}
impl Controls {
    fn new(p: RvcParams) -> Self {
        let s = Self {
            values: AtomicU64::new(0),
            timing: AtomicU64::new(0),
        };
        s.set(p);
        s
    }
    fn set(&self, p: RvcParams) {
        let p = normalize(p);
        self.values.store(
            u64::from(p.pitch_semitones.to_bits()) | (u64::from(p.index_rate.to_bits()) << 32),
            Ordering::Release,
        );
        self.timing.store(
            u64::from(p.block_ms) | (u64::from(p.crossfade_ms) << 32),
            Ordering::Release,
        );
    }
    fn get(&self) -> RvcParams {
        let v = self.values.load(Ordering::Acquire);
        let t = self.timing.load(Ordering::Acquire);
        RvcParams {
            pitch_semitones: f32::from_bits(v as u32),
            index_rate: f32::from_bits((v >> 32) as u32),
            block_ms: t as u32,
            crossfade_ms: (t >> 32) as u32,
        }
    }
}
struct Shared {
    input: SampleQueue,
    output: SampleQueue,
    controls: Controls,
    stop: AtomicBool,
    dropped: AtomicU64,
    compute_ms: AtomicU32,
}

/// Bounded lock-free audio queues. Only the worker allocates or calls ONNX.
/// Destroy on a control thread: Drop joins the inference worker.
/// Called with a French reason when the inference worker stops.
pub type ErrorHandler = Box<dyn FnOnce(String) + Send + 'static>;

pub struct RvcStream {
    shared: Arc<Shared>,
    worker: Option<JoinHandle<()>>,
}
impl RvcStream {
    /// `on_error` runs once, on the inference worker thread (never the audio
    /// thread), if inference stops; the stream then only yields silence.
    pub fn start(
        runtime: &RvcRuntime,
        model_dir: &Path,
        params: RvcParams,
        on_error: ErrorHandler,
    ) -> Result<Self> {
        if !model_dir.is_dir() {
            return Err(RvcError::ModelNotFound(model_dir.to_path_buf()));
        }
        let mut synth = Synthesizer::load(model_dir, runtime.backend().backend)?;
        let networks = Arc::clone(&runtime.networks);
        Self::spawn(params, on_error, move |input, p| {
            networks
                .lock()
                .map_err(|_| RvcError::Onnx("sessions partagées interrompues".into()))?
                .convert(&mut synth, input, p)
        })
    }
    fn spawn<F>(params: RvcParams, on_error: ErrorHandler, mut convert: F) -> Result<Self>
    where
        F: FnMut(&[f32], RvcParams) -> Result<Vec<f32>> + Send + 'static,
    {
        let shared = Arc::new(Shared {
            input: SampleQueue::new(CAPACITY),
            output: SampleQueue::new(CAPACITY),
            controls: Controls::new(params),
            stop: AtomicBool::new(false),
            dropped: AtomicU64::new(0),
            compute_ms: AtomicU32::new(0),
        });
        let state = Arc::clone(&shared);
        let worker = thread::Builder::new()
            .name("voxbox-rvc".into())
            .spawn(move || {
                let mut schedule = Scheduler::new(params);
                let mut dropped = 0;
                while !state.stop.load(Ordering::Acquire) {
                    let p = state.controls.get();
                    let now_dropped = state.dropped.load(Ordering::Acquire);
                    if now_dropped != dropped {
                        schedule = Scheduler::new(p);
                        dropped = now_dropped;
                    }
                    schedule.configure(p);
                    for _ in 0..CAPACITY {
                        if let Some(sample) = state.input.pop() {
                            schedule.feed(sample);
                        } else {
                            break;
                        }
                    }
                    let Some(window) = schedule.window() else {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    };
                    let start = Instant::now();
                    let result = convert(&window, p);
                    state.compute_ms.store(
                        start
                            .elapsed()
                            .as_millis()
                            .saturating_add(1)
                            .min(u128::from(u32::MAX)) as u32,
                        Ordering::Relaxed,
                    );
                    match result {
                        Ok(mut converted) => {
                            if converted.len() != window.len() {
                                tracing::error!("longueur de bloc RVC incorrecte");
                                on_error("longueur de bloc RVC incorrecte".into());
                                break;
                            }
                            for sample in schedule.finish(&mut converted) {
                                state.output.force_push(sample);
                            }
                        }
                        Err(e) => {
                            tracing::error!(error=%e,"inférence RVC arrêtée");
                            on_error(e.to_string());
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            shared,
            worker: Some(worker),
        })
    }
    /// No allocation, mutex, system call or wait; excess input replaces oldest samples.
    pub fn push(&self, input: &[f32]) {
        for &sample in input {
            let sample = if sample.is_finite() { sample } else { 0.0 };
            if self.shared.input.force_push(sample) {
                self.shared.dropped.fetch_add(1, Ordering::Release);
            }
        }
    }
    /// Writes available converted samples; the caller pads the remainder with silence.
    pub fn pop(&self, out: &mut [f32]) -> usize {
        let mut count = 0;
        for value in out {
            if let Some(sample) = self.shared.output.pop() {
                *value = sample;
                count += 1;
            } else {
                break;
            }
        }
        count
    }
    pub fn set_params(&self, params: RvcParams) {
        self.shared.controls.set(params);
    }
    /// Conservative current latency: capture window + measured inference/lock wait +
    /// queued input/output. Before first inference, compute time is still unknown.
    pub fn latency_ms(&self) -> u32 {
        let p = self.shared.controls.get();
        p.block_ms
            + p.crossfade_ms
            + self.shared.compute_ms.load(Ordering::Relaxed)
            + ((self.shared.input.len() + self.shared.output.len()) / 48) as u32
            + 1
    }
}
impl Drop for RvcStream {
    fn drop(&mut self) {
        self.shared.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            if worker.join().is_err() {
                tracing::error!("worker RVC interrompu");
            }
        }
    }
}

struct Scheduler {
    pending: std::collections::VecDeque<f32>,
    history: Vec<f32>,
    tail: Vec<f32>,
    step: usize,
    overlap: usize,
}
impl Scheduler {
    fn new(p: RvcParams) -> Self {
        let p = normalize(p);
        Self {
            pending: std::collections::VecDeque::new(),
            history: vec![0.0; CONTEXT],
            tail: Vec::new(),
            step: p.block_ms as usize * 48,
            overlap: p.crossfade_ms as usize * 48,
        }
    }
    fn configure(&mut self, p: RvcParams) {
        let p = normalize(p);
        if self.step != p.block_ms as usize * 48 || self.overlap != p.crossfade_ms as usize * 48 {
            *self = Self::new(p);
        }
    }
    fn feed(&mut self, sample: f32) {
        self.pending.push_back(sample);
        // Bound stale work even if the producer did not overflow the transport.
        if self.pending.len() > self.step + self.overlap + self.step {
            self.pending.pop_front();
            self.tail.clear();
        }
    }
    fn window(&mut self) -> Option<Vec<f32>> {
        let len = self.step + self.overlap;
        if self.pending.len() < len {
            return None;
        }
        // Process freshest complete window after overload, rather than growing latency.
        while self.pending.len() >= len + self.step {
            self.pending.drain(..self.step);
            self.tail.clear();
            self.history.fill(0.0);
        }
        let mut window = self.history.clone();
        window.extend(self.pending.iter().take(len));
        Some(window)
    }
    fn finish(&mut self, converted: &mut [f32]) -> Vec<f32> {
        let current = &mut converted[CONTEXT..];
        audio::blend_head(current, &self.tail);
        let out = current[..self.step].to_vec();
        self.tail = current[self.step..self.step + self.overlap].to_vec();
        let drained: Vec<_> = self.pending.drain(..self.step).collect();
        self.history.extend(drained);
        self.history.drain(..self.history.len() - CONTEXT);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    thread_local! {
        static TRACK:std::cell::Cell<bool>=const {std::cell::Cell::new(false)};
        static ALLOCS:std::cell::Cell<usize>=const {std::cell::Cell::new(0)};
    }
    struct Allocator;
    // Track only the calling test/audio thread, excluding the inference worker.
    unsafe impl std::alloc::GlobalAlloc for Allocator {
        unsafe fn alloc(&self, layout: std::alloc::Layout) -> *mut u8 {
            if TRACK.try_with(|t| t.get()).unwrap_or(false) {
                let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
            }
            unsafe { std::alloc::System.alloc(layout) }
        }
        unsafe fn dealloc(&self, p: *mut u8, layout: std::alloc::Layout) {
            unsafe { std::alloc::System.dealloc(p, layout) }
        }
        unsafe fn realloc(&self, p: *mut u8, layout: std::alloc::Layout, size: usize) -> *mut u8 {
            if TRACK.try_with(|t| t.get()).unwrap_or(false) {
                let _ = ALLOCS.try_with(|c| c.set(c.get() + 1));
            }
            unsafe { std::alloc::System.realloc(p, layout, size) }
        }
    }
    #[global_allocator]
    static ALLOCATOR: Allocator = Allocator;
    #[test]
    fn callback_does_not_allocate() {
        let stream = RvcStream::spawn(RvcParams::default(), Box::new(|_| {}), |input, _| {
            Ok(input.to_vec())
        })
        .unwrap();
        let input = [0.0; 480];
        let mut output = [0.0; 480];
        ALLOCS.with(|c| c.set(0));
        TRACK.with(|t| t.set(true));
        for _ in 0..500 {
            stream.push(&input);
            stream.pop(&mut output);
            stream.set_params(RvcParams::default());
            let _ = stream.latency_ms();
        }
        TRACK.with(|t| t.set(false));
        assert_eq!(ALLOCS.with(|c| c.get()), 0);
    }
    #[test]
    fn scheduler_overlap_and_reconfiguration() {
        let p = RvcParams {
            block_ms: 100,
            crossfade_ms: 20,
            ..RvcParams::default()
        };
        let mut s = Scheduler::new(p);
        for _ in 0..5759 {
            s.feed(0.5);
        }
        assert!(s.window().is_none());
        s.feed(0.5);
        let mut window = s.window().unwrap();
        assert_eq!(window.len(), CONTEXT + 5760);
        let out = s.finish(&mut window);
        assert_eq!(out.len(), 4800);
        assert_eq!(s.pending.len(), 960);
        for _ in 0..4800 {
            s.feed(0.5);
        }
        let mut window = s.window().unwrap();
        assert!(s
            .finish(&mut window)
            .iter()
            .all(|x| (*x - 0.5).abs() < 1e-6));
        s.configure(RvcParams { block_ms: 200, ..p });
        assert!(s.window().is_none());
        assert!(s.tail.is_empty());
    }
    #[test]
    fn slow_worker_never_blocks_and_transport_drops_oldest() {
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let (resume_tx, resume_rx) = std::sync::mpsc::channel();
        let stream = RvcStream::spawn(
            RvcParams {
                block_ms: 100,
                crossfade_ms: 0,
                ..RvcParams::default()
            },
            Box::new(|_| {}),
            move |input, _| {
                entered_tx.send(()).unwrap();
                resume_rx.recv().unwrap();
                Ok(input.to_vec())
            },
        )
        .unwrap();
        stream.push(&[0.0; 4800]);
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for i in 0..CAPACITY + 480 {
            stream.push(&[i as f32]);
        }
        assert_eq!(stream.shared.input.len(), CAPACITY);
        assert_eq!(stream.shared.input.pop(), Some(480.0));
        assert_eq!(stream.shared.dropped.load(Ordering::Relaxed), 480);
        assert_eq!(stream.pop(&mut [0.0; 480]), 0);
        stream.shared.stop.store(true, Ordering::Release);
        resume_tx.send(()).unwrap();
        drop(stream);
    }
    #[test]
    fn parameter_boundaries() {
        let p = normalize(RvcParams {
            pitch_semitones: f32::NAN,
            index_rate: f32::INFINITY,
            block_ms: 0,
            crossfade_ms: u32::MAX,
        });
        assert_eq!(p.block_ms, 100);
        assert_eq!(p.crossfade_ms, 100);
        assert_eq!(p.pitch_semitones, 0.0);
    }

    #[test]
    fn inference_failure_is_reported_once_off_the_audio_thread() {
        let (tx, rx) = std::sync::mpsc::channel();
        let stream = RvcStream::spawn(
            RvcParams::default(),
            Box::new(move |message| {
                let _ = tx.send((message, thread::current().name().map(str::to_owned)));
            }),
            |_, _| Err(RvcError::Onnx("GPU perdu".into())),
        )
        .unwrap();
        stream.push(&vec![0.1; 48_000]);
        let (message, thread_name) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("error reported");
        assert!(message.contains("GPU perdu"), "{message}");
        assert_eq!(thread_name.as_deref(), Some("voxbox-rvc"));
        assert!(
            rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "reported once"
        );
        let mut out = [1.0; 480];
        assert_eq!(stream.pop(&mut out), 0, "a failed stream yields nothing");
    }
}
