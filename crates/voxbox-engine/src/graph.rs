//! Device-free, bounded 10 ms graph. Construct resources on the control thread;
//! `process` only moves ownership into the reclamation queue, never destroys it.
use crate::{DecodedSound, EngineEvent};
use nnnoiseless::DenoiseState;
use rtrb::{Consumer, Producer, RingBuffer};
use std::sync::{
    atomic::{AtomicBool, AtomicU32, Ordering},
    Arc,
};
use voxbox_dsp::{EffectSpec, VoiceChain};
use voxbox_rvc::RvcStream;

pub const BLOCK: usize = 480;
pub const MAX_SOUNDS: usize = 64;
const QUEUE: usize = 256;

pub(crate) fn level(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

pub struct Settings {
    pub voice: AtomicBool,
    pub monitor: AtomicBool,
    pub noise: AtomicBool,
    pub ptt: AtomicBool,
    pub pressed: AtomicBool,
    pub cable_volume: AtomicU32,
    pub monitor_volume: AtomicU32,
    pub latency_ms: AtomicU32,
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            voice: AtomicBool::new(false),
            monitor: AtomicBool::new(false),
            noise: AtomicBool::new(false),
            ptt: AtomicBool::new(false),
            pressed: AtomicBool::new(false),
            cable_volume: AtomicU32::new(1.0f32.to_bits()),
            monitor_volume: AtomicU32::new(1.0f32.to_bits()),
            latency_ms: AtomicU32::new(0),
        }
    }
}

pub struct Voice {
    chain: VoiceChain,
    ai: Option<RvcStream>,
}
impl Voice {
    pub fn new(effects: &[EffectSpec], ai: Option<RvcStream>) -> Box<Self> {
        Box::new(Self {
            chain: VoiceChain::new(effects),
            ai,
        })
    }
    fn process(&mut self, mic: &[f32; BLOCK], out: &mut [f32; BLOCK]) {
        if let Some(ai) = &self.ai {
            ai.push(mic);
            out.fill(0.0);
            let count = ai.pop(out).min(BLOCK);
            out[count..].fill(0.0);
        } else {
            out.copy_from_slice(mic);
        }
        self.chain.process(out);
    }
    fn latency(&self) -> u32 {
        (self.chain.latency_samples() as u32).div_ceil(48)
            + self.ai.as_ref().map_or(0, RvcStream::latency_ms)
    }
}
pub struct Sound {
    id: Arc<str>,
    data: DecodedSound,
    position: usize,
    volume: f32,
    looped: bool,
    ended: bool,
}
pub enum Command {
    Voice(Box<Voice>),
    Play(Option<Sound>),
    Stop(String),
    StopAll,
}
impl Command {
    pub fn play(id: &str, data: DecodedSound, volume: f32, looped: bool) -> Self {
        Self::Play(Some(Sound {
            id: id.into(),
            data,
            position: 0,
            volume: level(volume),
            looped,
            ended: false,
        }))
    }
}
/// Events retain an Arc owned by a live/retired sound. Formatting happens off-thread.
pub enum GraphEvent {
    Meter(f32, f32),
    Progress(Arc<str>, u32, u32),
    Ended(Arc<str>),
}
impl GraphEvent {
    pub fn into_event(self) -> EngineEvent {
        match self {
            Self::Meter(input_db, output_db) => EngineEvent::Meter {
                input_db,
                output_db,
            },
            Self::Progress(id, position_ms, duration_ms) => EngineEvent::SoundProgress {
                id: id.to_string(),
                position_ms,
                duration_ms,
            },
            Self::Ended(id) => EngineEvent::SoundEnded { id: id.to_string() },
        }
    }
}
pub struct Control {
    commands: Producer<Command>,
    retired: Consumer<Command>,
    events: Consumer<GraphEvent>,
}
impl Control {
    /// A full queue returns ownership to the control thread for a later retry.
    pub fn send(&mut self, command: Command) -> std::result::Result<(), Command> {
        self.commands
            .push(command)
            .map_err(|rtrb::PushError::Full(command)| command)
    }
    pub fn reclaim(&mut self) {
        while let Ok(command) = self.retired.pop() {
            drop(command);
        }
    }
    pub fn event(&mut self) -> Option<GraphEvent> {
        self.events.pop().ok()
    }
}
pub struct Graph {
    pub settings: Arc<Settings>,
    commands: Consumer<Command>,
    retired: Producer<Command>,
    events: Producer<GraphEvent>,
    voice: Box<Voice>,
    previous: Option<Box<Voice>>,
    fade: usize,
    wet: f32,
    denoise: Box<DenoiseState<'static>>,
    sounds: [Option<Sound>; MAX_SOUNDS],
    blocks: u64,
}
impl Graph {
    pub fn new(settings: Arc<Settings>) -> (Self, Control) {
        let (command_tx, commands) = RingBuffer::new(QUEUE);
        let (retired, retired_rx) = RingBuffer::new(QUEUE);
        let (events, event_rx) = RingBuffer::new(QUEUE);
        let mut graph = Self {
            settings,
            commands,
            retired,
            events,
            voice: Voice::new(&[], None),
            previous: None,
            fade: 0,
            wet: 0.0,
            denoise: DenoiseState::new(),
            sounds: std::array::from_fn(|_| None),
            blocks: 0,
        };
        graph.prepare_thread();
        (
            graph,
            Control {
                commands: command_tx,
                retired: retired_rx,
                events: event_rx,
            },
        )
    }
    /// Call once after moving the graph to its processing thread, before starting
    /// the hardware. nnnoiseless/easyfft cache FFT plans and scratch in TLS.
    pub fn prepare_thread(&mut self) {
        let input = std::array::from_fn::<_, BLOCK, _>(|i| (i as f32 * 0.1).sin() * 2000.0);
        let mut output = [0.0; BLOCK];
        self.denoise.process_frame(&mut output, &input);
        for _ in 0..4 {
            self.denoise.process_frame(&mut output, &[0.0; BLOCK]);
        }
    }
    fn retire(&mut self, command: Command) {
        // All callers reserve space before taking ownership. Never drop a failed push here.
        assert!(
            self.retired.push(command).is_ok(),
            "reclamation capacity must be reserved"
        );
    }
    fn ended(&mut self, index: usize) {
        if self.retired.slots() == 0 || self.events.slots() < 2 {
            return;
        }
        if let Some(sound) = self.sounds[index].take() {
            let _ = self.events.push(GraphEvent::Progress(
                Arc::clone(&sound.id),
                (sound.position / 48) as u32,
                sound.data.duration_ms,
            ));
            let _ = self.events.push(GraphEvent::Ended(Arc::clone(&sound.id)));
            self.retire(Command::Play(Some(sound)));
        }
    }
    fn controls(&mut self) {
        // Bounded work even if the producer is continuously sending commands.
        for _ in 0..32 {
            if self.retired.slots() < MAX_SOUNDS + 3 || self.events.slots() < MAX_SOUNDS * 2 + 1 {
                break;
            }
            let Ok(mut command) = self.commands.pop() else {
                break;
            };
            match &mut command {
                Command::Voice(voice) => {
                    if let Some(old) = self.previous.take() {
                        self.retire(Command::Voice(old));
                    }
                    std::mem::swap(&mut self.voice, voice);
                    // Keep the old chain alive through a 10 ms transition.
                    if let Command::Voice(old) = command {
                        self.previous = Some(old);
                    }
                    self.fade = BLOCK;
                    continue;
                }
                Command::Play(sound) => {
                    if let Some(new) = sound.as_ref() {
                        let slot = self
                            .sounds
                            .iter()
                            .position(|s| s.as_ref().is_some_and(|s| s.id == new.id))
                            .or_else(|| self.sounds.iter().position(Option::is_none));
                        if let Some(index) = slot {
                            // Replaying is a restart, not an ended event for the same UI id.
                            std::mem::swap(&mut self.sounds[index], sound);
                        } else {
                            let _ = self.events.push(GraphEvent::Ended(Arc::clone(&new.id)));
                        }
                    }
                }
                Command::Stop(id) => {
                    for i in 0..MAX_SOUNDS {
                        if self.sounds[i].as_ref().is_some_and(|s| &*s.id == id) {
                            self.ended(i);
                        }
                    }
                }
                Command::StopAll => {
                    for i in 0..MAX_SOUNDS {
                        self.ended(i);
                    }
                }
            }
            self.retire(command);
        }
    }
    pub fn process(
        &mut self,
        mic: &[f32; BLOCK],
        cable: &mut [f32; BLOCK],
        monitor: &mut [f32; BLOCK],
    ) {
        self.controls();
        let voice_on = self.settings.voice.load(Ordering::Relaxed);
        let gate = !self.settings.ptt.load(Ordering::Relaxed)
            || self.settings.pressed.load(Ordering::Relaxed);
        let mut clean = *mic;
        if self.settings.noise.load(Ordering::Relaxed) {
            let mut scaled = [0.0; BLOCK];
            for (out, input) in scaled.iter_mut().zip(mic) {
                *out = (input * 32768.0).clamp(-32768.0, 32767.0);
            }
            self.denoise.process_frame(&mut clean, &scaled);
            for out in &mut clean {
                *out /= 32768.0;
            }
        }
        if !gate {
            clean.fill(0.0);
        }
        let mut wet = [0.0; BLOCK];
        let mut old = [0.0; BLOCK];
        if voice_on || self.wet > 0.0 {
            self.voice.process(&clean, &mut wet);
            if self.fade > 0 {
                if let Some(previous) = &mut self.previous {
                    previous.process(&clean, &mut old);
                }
            }
        }
        let hear = self.settings.monitor.load(Ordering::Relaxed);
        for i in 0..BLOCK {
            let target = if voice_on { 1.0 } else { 0.0 };
            self.wet += (target - self.wet).clamp(-1.0 / BLOCK as f32, 1.0 / BLOCK as f32);
            let changed = if self.fade > 0 {
                let blend = 1.0 - self.fade as f32 / BLOCK as f32;
                self.fade -= 1;
                old[i] + (wet[i] - old[i]) * blend
            } else {
                wet[i]
            };
            let voice = if gate {
                clean[i] + (changed - clean[i]) * self.wet
            } else {
                0.0
            };
            cable[i] = voice;
            monitor[i] = if hear { voice } else { 0.0 };
        }
        if self.fade == 0 && self.retired.slots() > 0 {
            if let Some(previous) = self.previous.take() {
                self.retire(Command::Voice(previous));
            }
        }
        let cable_level = f32::from_bits(self.settings.cable_volume.load(Ordering::Relaxed));
        let monitor_level = f32::from_bits(self.settings.monitor_volume.load(Ordering::Relaxed));
        for sound in self.sounds.iter_mut().flatten() {
            if sound.ended {
                continue;
            }
            for i in 0..BLOCK {
                if sound.position == sound.data.samples.len() {
                    if sound.looped && !sound.data.samples.is_empty() {
                        sound.position = 0;
                    } else {
                        sound.ended = true;
                        break;
                    }
                }
                let sample = sound.data.samples[sound.position] * sound.volume;
                cable[i] += sample * cable_level;
                monitor[i] += sample * monitor_level;
                sound.position += 1;
            }
            if !sound.looped && sound.position == sound.data.samples.len() {
                sound.ended = true;
            }
        }
        for (c, m) in cable.iter_mut().zip(monitor.iter_mut()) {
            *c = c.clamp(-1.0, 1.0);
            *m = m.clamp(-1.0, 1.0);
        }
        self.blocks += 1;
        // Three blocks gives 33 Hz (bounded UI event traffic).
        if self.blocks.is_multiple_of(3) {
            if self.events.slots() > 0 {
                let _ = self.events.push(GraphEvent::Meter(dbfs(mic), dbfs(cable)));
            }
            for sound in self.sounds.iter().flatten() {
                if self.events.slots() > 0 {
                    let _ = self.events.push(GraphEvent::Progress(
                        Arc::clone(&sound.id),
                        (sound.position / 48) as u32,
                        sound.data.duration_ms,
                    ));
                }
            }
        }
        for i in 0..MAX_SOUNDS {
            if self.sounds[i].as_ref().is_some_and(|s| s.ended) {
                self.ended(i);
            }
        }
        self.settings.latency_ms.store(
            (if voice_on { self.voice.latency() } else { 0 })
                + if self.settings.noise.load(Ordering::Relaxed) {
                    10
                } else {
                    0
                },
            Ordering::Relaxed,
        );
    }
}
pub fn dbfs(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return -60.0;
    }
    let power = samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32;
    (10.0 * power.max(1e-6).log10()).max(-60.0)
}
