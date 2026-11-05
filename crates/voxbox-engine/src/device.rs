//! CPAL owns the hardware callbacks; both callbacks only touch preallocated DSP
//! adapters and bounded lock-free sample queues. Each output follows its own clock.
use crate::{DeviceInfo, DeviceSelection, Devices, EngineError, EngineStatus, Result};
use cpal::{
    traits::{DeviceTrait, HostTrait, StreamTrait},
    Device, Sample, SampleFormat, SizedSample,
};
use crossbeam_queue::ArrayQueue;
use rubato::{FastFixedIn, PolynomialDegree, Resampler};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(crate) const CAPACITY: usize = 4800;
pub(crate) const TARGET: usize = 240;
#[derive(Clone)]
pub(crate) struct AudioIo {
    pub mic: Arc<ArrayQueue<f32>>,
    pub cable: Arc<ArrayQueue<f32>>,
    pub monitor: Arc<ArrayQueue<f32>>,
    pub failed: Arc<AtomicBool>,
    pub running: Arc<AtomicBool>,
    pub active: Arc<AtomicBool>,
}
impl AudioIo {
    pub fn new() -> Self {
        Self {
            mic: Arc::new(ArrayQueue::new(CAPACITY)),
            cable: Arc::new(ArrayQueue::new(CAPACITY)),
            monitor: Arc::new(ArrayQueue::new(CAPACITY)),
            failed: Arc::new(AtomicBool::new(false)),
            running: Arc::new(AtomicBool::new(false)),
            active: Arc::new(AtomicBool::new(false)),
        }
    }
    pub fn clear(&self) {
        for queue in [&self.mic, &self.cable, &self.monitor] {
            while queue.pop().is_some() {}
        }
    }
}
pub(crate) fn is_cable(name: &str) -> bool {
    name.to_ascii_lowercase().contains("cable input")
}
fn name(device: &Device) -> String {
    device
        .description()
        .map(|d| d.name().to_owned())
        .unwrap_or_else(|_| device.to_string())
}
pub(crate) fn enumerate() -> Devices {
    let host = cpal::default_host();
    let default_input = host.default_input_device();
    let default_output = host.default_output_device();
    let collect =
        |devices: std::result::Result<cpal::DevicesFiltered<cpal::Devices>, cpal::Error>,
         default: Option<Device>| {
            devices
                .map(|devices| {
                    devices
                        .map(|d| {
                            let n = name(&d);
                            DeviceInfo {
                                id: n.clone(),
                                is_cable: is_cable(&n),
                                name: n,
                                is_default: default.as_ref() == Some(&d),
                            }
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
    Devices {
        inputs: collect(host.input_devices(), default_input),
        outputs: collect(host.output_devices(), default_output),
    }
}
pub(crate) fn downmix<T: Sample>(frame: &[T]) -> f32
where
    f32: cpal::FromSample<T>,
{
    if frame.is_empty() {
        0.0
    } else {
        frame.iter().map(|s| s.to_sample::<f32>()).sum::<f32>() / frame.len() as f32
    }
}
fn stream_error(error: impl std::fmt::Display) -> EngineError {
    EngineError::Stream(error.to_string())
}

pub(crate) struct Streams {
    _streams: Vec<cpal::Stream>,
    pub status: EngineStatus,
}
impl Streams {
    pub fn open(selection: &DeviceSelection, io: &AudioIo) -> Result<Self> {
        let host = cpal::default_host();
        let cable_found = host
            .output_devices()
            .map_err(stream_error)?
            .any(|d| is_cable(&name(&d)));
        let input = match &selection.input {
            Some(id) => host
                .input_devices()
                .map_err(stream_error)?
                .find(|d| name(d) == *id),
            None => host.default_input_device(),
        }
        .ok_or_else(|| {
            EngineError::DeviceNotFound(
                selection
                    .input
                    .clone()
                    .unwrap_or_else(|| "microphone par défaut".into()),
            )
        })?;
        let cable = match &selection.cable {
            Some(id) => Some(
                host.output_devices()
                    .map_err(stream_error)?
                    .find(|d| name(d) == *id)
                    .ok_or_else(|| EngineError::DeviceNotFound(id.clone()))?,
            ),
            None => host
                .output_devices()
                .map_err(stream_error)?
                .find(|d| is_cable(&name(d))),
        };
        let monitor = match &selection.monitor {
            Some(id) => Some(
                host.output_devices()
                    .map_err(stream_error)?
                    .find(|d| name(d) == *id)
                    .ok_or_else(|| EngineError::DeviceNotFound(id.clone()))?,
            ),
            None => host.default_output_device().filter(|d| !is_cable(&name(d))),
        };
        if monitor.as_ref().is_some_and(|m| cable.as_ref() == Some(m)) {
            return Err(stream_error(
                "La sortie casque doit être différente de CABLE Input.",
            ));
        }
        if cable.is_none() && monitor.is_none() {
            return Err(EngineError::DeviceNotFound("sortie audio".into()));
        }
        let input_config = input.default_input_config().map_err(stream_error)?;
        let mut streams = Vec::with_capacity(3);
        let (stream, input_buffer_ms) = input_stream(&input, input_config, io)?;
        streams.push(stream);
        let mut output_buffer_ms = 0;
        if let Some(device) = &cable {
            let (stream, ms) = output_stream(
                device,
                device.default_output_config().map_err(stream_error)?,
                Arc::clone(&io.cable),
                io,
            )?;
            output_buffer_ms = ms;
            streams.push(stream);
        }
        if let Some(device) = &monitor {
            let (stream, _) = output_stream(
                device,
                device.default_output_config().map_err(stream_error)?,
                Arc::clone(&io.monitor),
                io,
            )?;
            streams.push(stream);
        }
        io.clear();
        io.failed.store(false, Ordering::Release);
        for stream in &streams {
            stream.play().map_err(stream_error)?;
        }
        Ok(Self {
            _streams: streams,
            status: EngineStatus {
                running: true,
                input_name: Some(name(&input)),
                cable_name: cable.as_ref().map(name),
                monitor_name: monitor.as_ref().map(name),
                cable_found,
                latency_ms: input_buffer_ms.max(10) + 5 + 2 + output_buffer_ms,
            },
        })
    }
}

fn config(supported: &cpal::SupportedStreamConfig) -> (cpal::StreamConfig, u32) {
    let mut config = supported.config();
    let requested = (config.sample_rate / 200).max(1);
    let frames = match supported.buffer_size() {
        cpal::SupportedBufferSize::Range { min, max } => requested.clamp(*min, *max),
        cpal::SupportedBufferSize::Unknown => requested,
    };
    // CPAL's WASAPI default config exposes its shared-mode period as a fixed
    // buffer range. Respect it rather than claiming an unsupported 5 ms period.
    config.buffer_size = cpal::BufferSize::Fixed(frames);
    let ms = (frames * 1000).div_ceil(config.sample_rate);
    (config, ms)
}
struct Converter {
    resampler: FastFixedIn<f32>,
    input: Vec<f32>,
    filled: usize,
    output: Vec<Vec<f32>>,
    produced: usize,
    position: usize,
}
impl Converter {
    fn new(ratio: f64, chunk: usize) -> Result<Self> {
        let resampler = FastFixedIn::new(ratio, 1.01, PolynomialDegree::Cubic, chunk, 1)
            .map_err(stream_error)?;
        let output = resampler.output_buffer_allocate(true);
        let mut converter = Self {
            resampler,
            input: vec![0.0; chunk],
            filled: 0,
            output,
            produced: 0,
            position: 0,
        };
        // Prime polynomial history before callbacks begin: FastFixedIn's first
        // conversion emits a short block. Without this, 480 graph samples need
        // an entire extra hardware callback even at exactly 48 kHz.
        if !converter.convert() {
            return Err(stream_error("Échec d’initialisation du rééchantillonneur."));
        }
        converter.produced = 0;
        converter.position = 0;
        Ok(converter)
    }
    fn convert(&mut self) -> bool {
        match self
            .resampler
            .process_into_buffer(&[&self.input[..]], &mut self.output, None)
        {
            Ok((_, count)) => {
                self.produced = count;
                self.position = 0;
                true
            }
            Err(_) => {
                self.produced = 0;
                false
            }
        }
    }
}
fn failure(io: &AudioIo) -> impl FnMut(cpal::Error) + Send + 'static {
    let failed = Arc::clone(&io.failed);
    let running = Arc::clone(&io.running);
    move |_| {
        // Do not format/allocate inside the backend's error callback.
        failed.store(true, Ordering::Release);
        running.store(false, Ordering::Release);
    }
}
fn input_stream(
    device: &Device,
    supported: cpal::SupportedStreamConfig,
    io: &AudioIo,
) -> Result<(cpal::Stream, u32)> {
    let (config, ms) = config(&supported);
    macro_rules! build {
        ($ty:ty) => {
            input_typed::<$ty>(device, config, io).map(|s| (s, ms))
        };
    }
    match supported.sample_format() {
        SampleFormat::F32 => build!(f32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::I8 => build!(i8),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I64 => build!(i64),
        SampleFormat::U8 => build!(u8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::U24 => build!(cpal::U24),
        SampleFormat::U32 => build!(u32),
        SampleFormat::U64 => build!(u64),
        other => Err(stream_error(format!(
            "Format de microphone non pris en charge : {other}"
        ))),
    }
}
fn capture_chunk(rate: u32) -> usize {
    let (mut a, mut b) = (rate, 48_000);
    while b != 0 {
        (a, b) = (b, a % b);
    }
    let quantum = (rate / a).max(1);
    // An integral resampling quantum keeps 44.1 kHz callbacks aligned with
    // 480-sample blocks instead of withholding fractional tails for another period.
    let desired = (rate / 200).max(1);
    (quantum * (desired / quantum).max(1)).min(desired) as usize
}
fn input_typed<T>(device: &Device, config: cpal::StreamConfig, io: &AudioIo) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    let mut converter = Converter::new(
        48_000.0 / config.sample_rate as f64,
        capture_chunk(config.sample_rate),
    )?;
    let channels = config.channels as usize;
    let queue = Arc::clone(&io.mic);
    let failed = Arc::clone(&io.failed);
    device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                for frame in data.chunks_exact(channels) {
                    let sample = downmix(frame);
                    converter.input[converter.filled] =
                        if sample.is_finite() { sample } else { 0.0 };
                    converter.filled += 1;
                    if converter.filled == converter.input.len() {
                        converter.filled = 0;
                        if !converter.convert() {
                            failed.store(true, Ordering::Release);
                        }
                        for sample in &converter.output[0][..converter.produced] {
                            let _ = queue.force_push(*sample);
                        }
                    }
                }
            },
            failure(io),
            None,
        )
        .map_err(stream_error)
}
fn output_stream(
    device: &Device,
    supported: cpal::SupportedStreamConfig,
    queue: Arc<ArrayQueue<f32>>,
    io: &AudioIo,
) -> Result<(cpal::Stream, u32)> {
    let (config, ms) = config(&supported);
    macro_rules! build {
        ($ty:ty) => {
            output_typed::<$ty>(device, config, queue, io).map(|s| (s, ms))
        };
    }
    match supported.sample_format() {
        SampleFormat::F32 => build!(f32),
        SampleFormat::F64 => build!(f64),
        SampleFormat::I8 => build!(i8),
        SampleFormat::I16 => build!(i16),
        SampleFormat::I24 => build!(cpal::I24),
        SampleFormat::I32 => build!(i32),
        SampleFormat::I64 => build!(i64),
        SampleFormat::U8 => build!(u8),
        SampleFormat::U16 => build!(u16),
        SampleFormat::U24 => build!(cpal::U24),
        SampleFormat::U32 => build!(u32),
        SampleFormat::U64 => build!(u64),
        other => Err(stream_error(format!(
            "Format de sortie non pris en charge : {other}"
        ))),
    }
}
fn output_typed<T>(
    device: &Device,
    config: cpal::StreamConfig,
    queue: Arc<ArrayQueue<f32>>,
    io: &AudioIo,
) -> Result<cpal::Stream>
where
    T: SizedSample + cpal::FromSample<f32>,
{
    let mut converter = Converter::new(config.sample_rate as f64 / 48_000.0, 240)?;
    let channels = config.channels as usize;
    let failed = Arc::clone(&io.failed);
    let mut primed = false;
    device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                for frame in data.chunks_exact_mut(channels) {
                    if !primed {
                        if queue.len() < TARGET {
                            frame.fill(T::from_sample(0.0));
                            continue;
                        }
                        primed = true;
                    }
                    if converter.position == converter.produced {
                        // A stalled device must catch up rather than play old microphone audio.
                        let queued = queue.len();
                        if queued > 1440 {
                            for _ in 0..queued.saturating_sub(TARGET).min(CAPACITY) {
                                let _ = queue.pop();
                            }
                        }
                        let occupancy = queue.len();
                        let correction = (1.0 - (occupancy as f64 - TARGET as f64) * 0.000002)
                            .clamp(0.998, 1.002);
                        if converter
                            .resampler
                            .set_resample_ratio_relative(correction, true)
                            .is_err()
                        {
                            failed.store(true, Ordering::Release);
                        }
                        for sample in &mut converter.input {
                            *sample = queue.pop().unwrap_or(0.0);
                        }
                        if !converter.convert() {
                            failed.store(true, Ordering::Release);
                        }
                        if occupancy == 0 {
                            primed = false;
                        }
                    }
                    let sample = if converter.position < converter.produced {
                        let sample = converter.output[0][converter.position];
                        converter.position += 1;
                        sample
                    } else {
                        0.0
                    };
                    frame.fill(T::from_sample(sample.clamp(-1.0, 1.0)));
                }
            },
            failure(io),
            None,
        )
        .map_err(stream_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn capture_resampling_preserves_callback_duration_from_the_first_block() {
        for rate in [8_000, 44_100, 48_000, 96_000] {
            let chunk = capture_chunk(rate);
            let mut converter = Converter::new(48_000.0 / rate as f64, chunk).unwrap();
            converter.input.fill(0.25);
            let mut produced = 0;
            for _ in 0..(rate as usize / 100 / chunk) {
                assert!(converter.convert());
                produced += converter.produced;
            }
            assert_eq!(
                produced, 480,
                "first 10 ms at {rate} Hz must not wait for another device callback"
            );
            assert!((converter.output[0][converter.produced - 1] - 0.25).abs() < 1e-5);
        }
    }
    #[test]
    fn cable_name_and_channel_mix() {
        assert!(is_cable("CABLE Input (VB-Audio Virtual Cable)"));
        assert!(is_cable("cable INPUT"));
        assert!(!is_cable("CABLE Output (VB-Audio Virtual Cable)"));
        assert_eq!(downmix(&[0.5, -0.5]), 0.0);
        assert!((downmix(&[0.3; 6]) - 0.3).abs() < 1e-6);
        assert_eq!(downmix::<f32>(&[]), 0.0);
        assert_eq!(downmix(&[16384i16, -16384i16]), 0.0);
        assert_eq!(downmix(&[16384i16; 2]), 0.5);
    }
}
