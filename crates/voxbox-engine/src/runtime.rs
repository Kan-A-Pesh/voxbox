use crate::{
    device::{AudioIo, Streams},
    graph::{Command, Graph, Settings, Voice, BLOCK},
    manager::{Backend, Manager},
    DeviceSelection, EngineError, EngineStatus, EventSink, Result,
};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
use voxbox_dsp::EffectSpec;
use voxbox_rvc::RvcStream;

enum Message {
    Devices(DeviceSelection, mpsc::Sender<Result<()>>),
    /// The selection the app has saved: what automatic restarts aim for.
    Target(DeviceSelection),
    Audio(Command),
    Shutdown,
}
/// Real hardware behind the device manager.
struct CpalBackend<'a> {
    io: &'a AudioIo,
    worker: &'a AudioWorker,
}
impl Backend for CpalBackend<'_> {
    type Streams = Streams;
    fn open(&mut self, selection: &DeviceSelection) -> Result<Streams> {
        self.io.clear();
        let opened = Streams::open(selection, self.io);
        if opened.is_err() {
            self.io.clear();
        }
        opened
    }
    fn close(&mut self, streams: Streams) {
        self.worker.pause();
        drop(streams);
        self.io.clear();
    }
    fn resume(&mut self) {
        self.io
            .running
            .store(!self.io.failed.load(Ordering::Acquire), Ordering::Release);
    }
    fn status_of(&self, streams: &Streams) -> EngineStatus {
        streams.status.clone()
    }
    fn available(&self, selection: &DeviceSelection) -> bool {
        crate::device::selection_available(selection)
    }
    fn now(&self) -> Instant {
        Instant::now()
    }
    fn confirm_started(&mut self) -> bool {
        let deadline = Instant::now() + crate::recovery::PROBATION;
        while Instant::now() < deadline {
            if self.io.failed.load(Ordering::Acquire) {
                return false;
            }
            thread::sleep(Duration::from_millis(25));
        }
        !self.io.failed.load(Ordering::Acquire)
    }
    fn healthy(&self) -> bool {
        !self.io.failed.load(Ordering::Acquire)
    }
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
            last_error: None,
            restarting: false,
            fallback: false,
            revision: 0,
        }));
        let (sender, receiver) = mpsc::channel();
        let (ready_tx, ready_rx) = mpsc::channel();
        let thread_settings = Arc::clone(&settings);
        let thread_io = io.clone();
        let thread_status = Arc::clone(&status);
        let manager = thread::Builder::new()
            .name("voxbox-control".into())
            .spawn(move || {
                let (mut graph, mut control) = Graph::new(thread_settings);
                let stopped = Arc::new(AtomicBool::new(false));
                let worker_stop = Arc::clone(&stopped);
                let worker_io = thread_io.clone();
                let worker =
                    match thread::Builder::new()
                        .name("voxbox-audio".into())
                        .spawn(move || {
                            let _scheduling = crate::scheduling::AudioSchedule::new();
                            graph.prepare_thread();
                            let mut mic = [0.0; BLOCK];
                            let mut cable = [0.0; BLOCK];
                            let mut monitor = [0.0; BLOCK];
                            while !worker_stop.load(Ordering::Acquire) {
                                if !worker_io.running.load(Ordering::Acquire)
                                    || worker_io.mic.len() < BLOCK
                                {
                                    thread::sleep(Duration::from_millis(1));
                                    continue;
                                }
                                worker_io.active.store(true, Ordering::SeqCst);
                                if !worker_io.running.load(Ordering::SeqCst) {
                                    worker_io.active.store(false, Ordering::SeqCst);
                                    continue;
                                }
                                for sample in &mut mic {
                                    *sample = worker_io.mic.pop().unwrap_or(0.0);
                                }
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
                        Err(error) => {
                            let _ = ready_tx.send(Err(EngineError::Stream(error.to_string())));
                            return;
                        }
                    };
                let worker = AudioWorker {
                    handle: Some(worker),
                    stopped,
                    running: Arc::clone(&thread_io.running),
                    active: Arc::clone(&thread_io.active),
                };
                let mut devices_manager = Manager::new(
                    CpalBackend {
                        io: &thread_io,
                        worker: &worker,
                    },
                    devices,
                );
                // Status is published before the events that announce it, so a UI
                // reacting to an event always reads the matching status.
                // Only when something changed: the loop runs every millisecond.
                let mut published_revision = None;
                let mut publish = |m: &mut Manager<CpalBackend<'_>>| {
                    if published_revision != Some(m.status().revision) {
                        *thread_status.lock().expect("status poisoned") = m.status().clone();
                        published_revision = Some(m.status().revision);
                    }
                    for event in m.take_events() {
                        events(event);
                    }
                };
                devices_manager.start();
                publish(&mut devices_manager);
                let _ = ready_tx.send(Ok(()));
                let mut pending = VecDeque::new();
                loop {
                    match receiver.recv_timeout(Duration::from_millis(1)) {
                        Ok(Message::Shutdown) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Ok(Message::Audio(command)) => pending.push_back(command),
                        Ok(Message::Target(selection)) => devices_manager.set_target(selection),
                        Ok(Message::Devices(selection, reply)) => {
                            let result = devices_manager.request(selection);
                            publish(&mut devices_manager);
                            let _ = reply.send(result);
                        }
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if worker.is_finished() {
                        thread_io.running.store(false, Ordering::Release);
                        devices_manager.worker_died();
                        publish(&mut devices_manager);
                        break;
                    }
                    control.reclaim();
                    while let Some(command) = pending.pop_front() {
                        if let Err(command) = control.send(command) {
                            pending.push_front(command);
                            break;
                        }
                    }
                    while let Some(event) = control.event() {
                        events(event.into_event());
                    }
                    if thread_io.failed.swap(false, Ordering::AcqRel)
                        && devices_manager.has_streams()
                    {
                        thread_io.running.store(false, Ordering::Release);
                        devices_manager.lost();
                    }
                    devices_manager.tick();
                    publish(&mut devices_manager);
                }
                thread_io.running.store(false, Ordering::Release);
                drop(devices_manager);
                // Graph resources and RVC workers are joined/reclaimed here, including
                // during unwinding if an EventSink callback panics.
                drop(worker);
                control.reclaim();
            })
            .map_err(|error| EngineError::Stream(error.to_string()))?;
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
    pub fn set_target(&self, selection: DeviceSelection) {
        if self.sender.send(Message::Target(selection)).is_err() {
            tracing::error!("Le moteur audio est arrêté ; la cible de relance a été ignorée");
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
