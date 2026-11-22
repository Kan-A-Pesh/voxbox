//! Set up outside the processing loop. Windows otherwise rounds a 1 ms sleep
//! to its coarser timer period on some systems.
#[cfg(windows)]
pub(crate) struct AudioSchedule {
    period: bool,
    task: Option<windows::Win32::Foundation::HANDLE>,
}
#[cfg(windows)]
impl AudioSchedule {
    pub fn new() -> Self {
        use windows::{
            core::w,
            Win32::{Media::timeBeginPeriod, System::Threading::AvSetMmThreadCharacteristicsW},
        };
        // SAFETY: a matching timeEndPeriod is issued by this guard; task_index
        // points to a live local and the task name is a static NUL-terminated string.
        let period = unsafe { timeBeginPeriod(1) } == 0;
        let mut task_index = 0;
        // SAFETY: task_index is writable and w! supplies the required wide string.
        let task = match unsafe { AvSetMmThreadCharacteristicsW(w!("Pro Audio"), &mut task_index) }
        {
            Ok(handle) => Some(handle),
            Err(error) => {
                tracing::warn!(%error, "MMCSS indisponible ; priorité audio normale");
                None
            }
        };
        if !period {
            tracing::warn!("La résolution de minuterie de 1 ms est indisponible");
        }
        Self { period, task }
    }
}
#[cfg(windows)]
impl Drop for AudioSchedule {
    fn drop(&mut self) {
        use windows::Win32::{
            Media::timeEndPeriod, System::Threading::AvRevertMmThreadCharacteristics,
        };
        if let Some(task) = self.task {
            // SAFETY: this guard owns the registration and remains on the thread
            // which created it. This is an MMCSS registration, not a CloseHandle handle.
            if let Err(error) = unsafe { AvRevertMmThreadCharacteristics(task) } {
                tracing::warn!(%error, "Échec de restauration de la priorité audio");
            }
        }
        if self.period {
            // SAFETY: balances the successful timeBeginPeriod(1) above.
            if unsafe { timeEndPeriod(1) } != 0 {
                tracing::warn!("Échec de restauration de la minuterie Windows");
            }
        }
    }
}
#[cfg(not(windows))]
pub(crate) struct AudioSchedule;
#[cfg(not(windows))]
impl AudioSchedule {
    pub fn new() -> Self {
        Self
    }
}
