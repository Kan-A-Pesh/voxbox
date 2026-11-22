use crate::{
    device::{AudioIo, Streams},
    graph::{Command, Graph, Settings, Voice, BLOCK},
    DeviceSelection, EngineError, EngineEvent, EngineStatus, EventSink, Result,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use voxbox_dsp::EffectSpec;
use voxbox_rvc::RvcStream;

enum Message {
    Devices(DeviceSelection, mpsc::Sender<Result<()>>),
    Audio(Command),
    Shutdown,
}
pub(crate) struct Runtime {
    sender: mpsc::Sender<Message>,
    manager: Option<JoinHandle<()>>,
    pub settings: Arc<Settings>,
    status: Arc<Mutex<EngineStatus>>,
    io: AudioIo,
}
struct AudioWorker {
    handle: Option<JoinHandle<Graph>>,
    stopped: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    active: Arc<AtomicBool>,
}
impl AudioWorker {
    fn pause(&self) {
        self.running.store(false, Ordering::SeqCst);
        // Only a control thread waits. The worker publishes a quiescent block
        // boundary before old hardware queues can be cleared/reused.
        while self.active.load(Ordering::SeqCst) && !self.is_finished() {
            thread::yield_now();
        }
    }
    fn is_finished(&self) -> bool {
        self.handle.as_ref().is_none_or(JoinHandle::is_finished)
    }
}
impl Drop for AudioWorker {
    fn drop(&mut self) {
        self.running.store(false, Ordering::Release);
        self.stopped.store(true, Ordering::Release);
        if let Some(handle) = self.handle.take() {
            if let Ok(graph) = handle.join() {
                drop(graph);
            } else {
                tracing::error!("Le thread de traitement audio a échoué");
            }
        }
    }
}
impl Runtime {
    pub fn start(devices: DeviceSelection, events: EventSink) -> Result<Self> {
        let settings = Arc::new(Settings::default());
        let io = AudioIo::new();
        let status = Arc::new(Mutex::new(EngineStatus {
            running: false,
            input_name: None,
            cable_name: None,
            monitor_name: None,
            cable_found: false,
            latency_ms: 0,
        }));
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_settings = Arc::clone(&settings);
        let thread_io = io.clone();
        let thread_status = Arc::clone(&status);
        let manager = thread::Builder::new().name("voxbox-control".into()).spawn(move || {
            // A saved device that disappeared (USB headset unplugged) must not keep
            // the app from starting: fall back to the system defaults, and if even
            // those fail start without streams so Réglages can pick new devices.
            // Selection the open streams were built from: restored if a later
            // device change fails, so a bad pick never leaves the app silent.
            let mut active_selection = Some(devices.clone());
            let mut streams = match Streams::open(&devices, &thread_io) {
                Ok(streams) => Some(streams),
                Err(error) => {
                    thread_io.clear();
                    let fallback = DeviceSelection::default();
                    let retried = if devices == fallback { None } else { Streams::open(&fallback, &thread_io).ok() };
                    let message = match &retried {
                        Some(_) => format!("{error}. Les périphériques par défaut du système sont utilisés : vérifiez-les dans Réglages."),
                        None => format!("{error}. Choisissez vos périphériques dans Réglages."),
                    };
                    tracing::warn!("{message}");
                    events(EngineEvent::DeviceError { message });
                    if retried.is_none() {
                        thread_io.clear();
                    }
                    active_selection = retried.as_ref().map(|_| fallback);
                    retried
                }
            };
            let (mut graph, mut control) = Graph::new(thread_settings);
            let stopped = Arc::new(AtomicBool::new(false));
            let worker_stop = Arc::clone(&stopped);
            let worker_io = thread_io.clone();
            let worker = match thread::Builder::new().name("voxbox-audio".into()).spawn(move || {
                let _scheduling = crate::scheduling::AudioSchedule::new();
                graph.prepare_thread();
                let mut mic = [0.0; BLOCK];
                let mut cable = [0.0; BLOCK];
                let mut monitor = [0.0; BLOCK];
                while !worker_stop.load(Ordering::Acquire) {
                    if !worker_io.running.load(Ordering::Acquire) || worker_io.mic.len() < BLOCK {
                        thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    worker_io.active.store(true, Ordering::SeqCst);
                    if !worker_io.running.load(Ordering::SeqCst) {
                        worker_io.active.store(false, Ordering::SeqCst);
                        continue;
                    }
                    for sample in &mut mic { *sample = worker_io.mic.pop().unwrap_or(0.0); }
                    graph.process(&mic, &mut cable, &mut monitor);
                    for (c, m) in cable.into_iter().zip(monitor) {
                        let _ = worker_io.cable.force_push(c);
                        let _ = worker_io.monitor.force_push(m);
                    }
                    worker_io.active.store(false, Ordering::SeqCst);
                }
                // Join returns ownership; delay buffers, RVC worker and sound Arcs
                // are destroyed by the control thread, never the audio worker.
                graph
            }) {
                Ok(worker) => worker,
                Err(error) => { let _ = ready_tx.send(Err(EngineError::Stream(error.to_string()))); return; }
            };
            let worker = AudioWorker { handle: Some(worker), stopped, running: Arc::clone(&thread_io.running), active: Arc::clone(&thread_io.active) };
            if let Some(streams) = &streams { *thread_status.lock().expect("status poisoned") = streams.status.clone(); }
            thread_io.running.store(!thread_io.failed.load(Ordering::Acquire), Ordering::Release);
            let _ = ready_tx.send(Ok(()));
            let mut pending = VecDeque::new();
            loop {
                match receiver.recv_timeout(Duration::from_millis(1)) {
                    Ok(Message::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Ok(Message::Audio(command)) => pending.push_back(command),
                    Ok(Message::Devices(selection, reply)) => {
                        worker.pause();
                        drop(streams.take());
                        thread_io.clear();
                        match Streams::open(&selection, &thread_io) {
                            Ok(opened) => {
                                *thread_status.lock().expect("status poisoned") = opened.status.clone();
                                streams = Some(opened);
                                active_selection = Some(selection);
                                thread_io.running.store(!thread_io.failed.load(Ordering::Acquire), Ordering::Release);
                                let _ = reply.send(Ok(()));
                            }
                            Err(error) => {
                                thread_io.clear();
                                let restored = active_selection.as_ref().and_then(|previous| Streams::open(previous, &thread_io).ok());
                                let message = match restored {
                                    Some(opened) => {
                                        *thread_status.lock().expect("status poisoned") = opened.status.clone();
                                        streams = Some(opened);
                                        thread_io.running.store(!thread_io.failed.load(Ordering::Acquire), Ordering::Release);
                                        format!("{error}. Les périphériques précédents restent utilisés.")
                                    }
                                    None => {
                                        thread_io.clear();
                                        active_selection = None;
                                        thread_status.lock().expect("status poisoned").running = false;
                                        error.to_string()
                                    }
                                };
                                events(EngineEvent::DeviceError { message });
                                let _ = reply.send(Err(error));
                            }
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                }
                if worker.is_finished() {
                    thread_io.running.store(false, Ordering::Release);
                    thread_status.lock().expect("status poisoned").running = false;
                    events(EngineEvent::DeviceError { message: "Le traitement audio s’est arrêté de manière inattendue.".into() });
                    break;
                }
                control.reclaim();
                while let Some(command) = pending.pop_front() {
                    if let Err(command) = control.send(command) { pending.push_front(command); break; }
                }
                while let Some(event) = control.event() { events(event.into_event()); }
                if thread_io.failed.swap(false, Ordering::AcqRel) {
                    thread_io.running.store(false, Ordering::Release);
                    thread_status.lock().expect("status poisoned").running = false;
                    events(EngineEvent::DeviceError { message: "Le périphérique audio a été déconnecté ou le flux a échoué. Sélectionnez à nouveau vos périphériques.".into() });
                    drop(streams.take());
                }
            }
            thread_io.running.store(false, Ordering::Release);
            drop(streams.take());
            // Graph resources and RVC workers are joined/reclaimed here, including
            // during unwinding if an EventSink callback panics.
            drop(worker);
            control.reclaim();
        }).map_err(|error| EngineError::Stream(error.to_string()))?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self {
                sender,
                manager: Some(manager),
                settings,
                status,
                io,
            }),
            Ok(Err(error)) => {
                let _ = manager.join();
                Err(error)
            }
            Err(error) => {
                let _ = manager.join();
                Err(EngineError::Stream(error.to_string()))
            }
        }
    }
    pub fn set_devices(&self, selection: DeviceSelection) -> Result<()> {
        let (tx, rx) = mpsc::channel();
        self.sender
            .send(Message::Devices(selection, tx))
            .map_err(|e| EngineError::Stream(e.to_string()))?;
        rx.recv().map_err(|e| EngineError::Stream(e.to_string()))?
    }
    pub fn status(&self) -> EngineStatus {
        let mut status = self.status.lock().expect("status poisoned").clone();
        status.running &=
            self.io.running.load(Ordering::Acquire) && !self.io.failed.load(Ordering::Acquire);
        status.latency_ms += self.settings.latency_ms.load(Ordering::Relaxed);
        status
    }
    pub fn command(&self, command: Command) {
        if self.sender.send(Message::Audio(command)).is_err() {
            tracing::error!("Le moteur audio est arrêté ; la commande a été refusée");
        }
    }
    pub fn voice(&self, effects: &[EffectSpec], ai: Option<RvcStream>) {
        self.command(Command::Voice(Voice::new(effects, ai)));
    }
}
impl Drop for Runtime {
    fn drop(&mut self) {
        let _ = self.sender.send(Message::Shutdown);
        if let Some(manager) = self.manager.take() {
            let _ = manager.join();
        }
    }
}
